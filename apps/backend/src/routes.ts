import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z, ZodError } from "zod";
import { annotationSchema, createPastureSchema, monitoringYearSchema, NDVI_CLASSES, predictionSchema, trainingSchema, updatePastureSchema } from "@pasturevision/shared";
import { areaHa, normalizeMultiPolygon, validateGeometry } from "@pasturevision/gis";
import { pool, transaction } from "./db.js";
import { env } from "./env.js";
import { createSession, destroySession, hashPassword, publicUser, requireAdmin, requireAuth, verifyPassword, type AuthUser } from "./auth.js";
import { createPasture, createProcessingJob, getPasture, mapObservation, mapPasture } from "./repositories.js";
import { enqueue, mlQueue, satelliteQueue } from "./queues.js";

export const router = Router();
const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.get("/status", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", mode: env.DEMO_MODE ? "demo" : "real", copernicusConfigured: Boolean(env.COPERNICUS_CLIENT_ID && env.COPERNICUS_CLIENT_SECRET) });
}));

const passwordSchema = z.string().min(10, "Пароль должен содержать не менее 10 символов").max(128).regex(/\p{L}/u, "Добавьте букву").regex(/\d/, "Добавьте цифру");
const registrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: passwordSchema
});
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128)
});
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

router.post("/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const input = registrationSchema.parse(req.body);
  const passwordHash = await hashPassword(input.password);
  try {
    const result = await pool.query(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'CLIENT')
       RETURNING id,name,email,role,is_active,created_at`,
      [input.name, input.email, passwordHash]
    );
    await createSession(req, res, result.rows[0].id);
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (error: any) {
    if (error?.code === "23505") return void res.status(409).json({ code: "EMAIL_EXISTS", message: "Пользователь с таким email уже зарегистрирован" });
    throw error;
  }
}));

router.post("/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const result = await pool.query("SELECT id,name,email,password_hash,role,is_active,created_at FROM users WHERE lower(email)=lower($1)", [input.email]);
  const row = result.rows[0];
  if (!row || !await verifyPassword(input.password, row.password_hash)) return void res.status(401).json({ code: "INVALID_CREDENTIALS", message: "Неверный email или пароль" });
  if (!row.is_active) return void res.status(403).json({ code: "USER_BLOCKED", message: "Учётная запись заблокирована администратором" });
  await pool.query("DELETE FROM auth_sessions WHERE user_id=$1 AND expires_at<=now()", [row.id]);
  await createSession(req, res, row.id);
  await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [row.id]);
  res.json({ user: publicUser(row) });
}));

router.post("/auth/logout", asyncRoute(async (req, res) => {
  await destroySession(req, res);
  res.status(204).end();
}));

router.get("/auth/me", requireAuth, asyncRoute(async (_req, res) => {
  res.json({ user: res.locals.user });
}));

router.use(requireAuth);

router.get("/admin/users", requireAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ search: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const pattern = input.search ? `%${input.search}%` : null;
  const [users, summary] = await Promise.all([
    pool.query(
      `SELECT id,name,email,role,is_active AS "isActive",last_login_at AS "lastLoginAt",created_at AS "createdAt",updated_at AS "updatedAt",
        COUNT(*) OVER()::int AS total
       FROM users WHERE ($1::text IS NULL OR name ILIKE $1 OR email ILIKE $1)
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [pattern, input.limit, input.offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE is_active)::int AS active,COUNT(*) FILTER (WHERE role='ADMIN')::int AS admins,COUNT(*) FILTER (WHERE role='CLIENT')::int AS clients FROM users`)
  ]);
  res.json({ users: users.rows.map(({ total: _total, ...user }) => user), total: users.rows[0]?.total ?? 0, summary: summary.rows[0] });
}));

router.patch("/admin/users/:id", requireAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(80).optional(), role: z.enum(["ADMIN", "CLIENT"]).optional(), isActive: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0, "Нет изменений").parse(req.body);
  const actor = res.locals.user as AuthUser;
  if (actor.id === req.params.id && input.isActive === false) return void res.status(422).json({ code: "SELF_DEACTIVATION", message: "Нельзя заблокировать собственную учётную запись" });

  const user = await transaction(async (client) => {
    const existingResult = await client.query("SELECT id,name,email,role,is_active,created_at FROM users WHERE id=$1 FOR UPDATE", [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) return null;
    const removesActiveAdmin = existing.role === "ADMIN" && existing.is_active && (input.role === "CLIENT" || input.isActive === false);
    if (removesActiveAdmin) {
      const others = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='ADMIN' AND is_active=true AND id<>$1", [existing.id]);
      if (others.rows[0].count === 0) {
        const conflict = new Error("Нельзя удалить роль или заблокировать последнего активного администратора");
        (conflict as any).statusCode = 422;
        throw conflict;
      }
    }
    const updated = await client.query(
      `UPDATE users SET name=COALESCE($2,name),role=COALESCE($3,role),is_active=COALESCE($4,is_active)
       WHERE id=$1 RETURNING id,name,email,role,is_active,created_at`,
      [existing.id, input.name ?? null, input.role ?? null, input.isActive ?? null]
    );
    if (input.isActive === false) await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [existing.id]);
    return publicUser(updated.rows[0]);
  });
  if (!user) return void res.status(404).json({ code: "NOT_FOUND", message: "Пользователь не найден" });
  res.json({ user });
}));

router.get("/pastures", asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, name, description, ST_AsGeoJSON(geometry) AS geometry, area_ha, created_at, updated_at FROM pastures ORDER BY created_at DESC");
  res.json(result.rows.map(mapPasture));
}));

router.post("/pastures", asyncRoute(async (req, res) => {
  const input = createPastureSchema.parse(req.body);
  const geometry = validateGeometry(input.geometry, { maxAreaHa: env.MAX_POLYGON_AREA_HA, maxPoints: env.MAX_GEOMETRY_POINTS });
  const pasture = await createPasture(pool, { ...input, geometry });
  res.status(201).json(pasture);
}));

router.get("/pastures/:id", asyncRoute(async (req, res) => {
  const pasture = await getPasture(pool, String(req.params.id));
  if (!pasture) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  res.json(pasture);
}));

router.patch("/pastures/:id", asyncRoute(async (req, res) => {
  const input = updatePastureSchema.parse(req.body);
  const existing = await getPasture(pool, String(req.params.id));
  if (!existing) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  const geometry = input.geometry ? normalizeMultiPolygon(validateGeometry(input.geometry, { maxAreaHa: env.MAX_POLYGON_AREA_HA, maxPoints: env.MAX_GEOMETRY_POINTS })) : existing.geometry;
  const result = await pool.query(
    `UPDATE pastures SET name=$2, description=$3, geometry=ST_SetSRID(ST_GeomFromGeoJSON($4),4326), area_ha=ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($4),4326)::geography)/10000
     WHERE id=$1 RETURNING id,name,description,ST_AsGeoJSON(geometry) AS geometry,area_ha,created_at,updated_at`,
    [req.params.id, input.name ?? existing.name, input.description ?? existing.description, JSON.stringify(geometry)]
  );
  res.json(mapPasture(result.rows[0]));
}));

router.delete("/pastures/:id", asyncRoute(async (req, res) => {
  const result = await pool.query("DELETE FROM pastures WHERE id=$1 RETURNING id", [req.params.id]);
  if (!result.rowCount) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  res.status(204).end();
}));

router.post("/pastures/:id/satellite/search", asyncRoute(async (req, res) => {
  const options = monitoringYearSchema.parse(req.body);
  if (!await getPasture(pool, String(req.params.id))) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  if (!env.DEMO_MODE && !(env.COPERNICUS_CLIENT_ID && env.COPERNICUS_CLIENT_SECRET)) return void res.status(503).json({ code: "COPERNICUS_NOT_CONFIGURED", message: "Настройте серверные Copernicus credentials" });
  const job = await createProcessingJob(pool, String(req.params.id), "satellite-search");
  await enqueue(satelliteQueue, job.id, "satellite-search", { pastureId: req.params.id, ...options, demoMode: env.DEMO_MODE });
  res.status(202).json({ jobId: job.id, status: "queued", mode: env.DEMO_MODE ? "demo" : "real" });
}));

router.get("/pastures/:id/satellite/candidates", asyncRoute(async (req, res) => {
  const year = z.coerce.number().int().optional().parse(req.query.year);
  const result = await pool.query(
    `SELECT id,product_id AS "productId",satellite,acquisition_date AS "acquisitionDate",month,cloud_cover AS "sceneCloudPercentage",
      aoi_cloud_percentage AS "aoiCloudPercentage",valid_coverage_percentage AS "validCoveragePercentage",
      geographic_coverage_percentage AS "geographicCoveragePercentage",selected,metadata
     FROM satellite_scenes WHERE pasture_id=$1 AND ($2::int IS NULL OR EXTRACT(YEAR FROM acquisition_date)=$2) ORDER BY month, acquisition_date`,
    [req.params.id, year ?? null]
  );
  res.json(result.rows);
}));

router.post("/pastures/:id/ndvi/process", asyncRoute(async (req, res) => {
  const input = monitoringYearSchema.pick({ year: true }).extend({ sceneIds: z.array(z.string().uuid()).optional() }).parse(req.body);
  if (!await getPasture(pool, String(req.params.id))) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  const sceneCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM satellite_scenes WHERE pasture_id=$1 AND EXTRACT(YEAR FROM acquisition_date)=$2 AND selected=true",
    [req.params.id, input.year]
  );
  if (sceneCount.rows[0].count === 0) return void res.status(422).json({ code: "NO_SCENES", message: "Сначала выполните поиск спутниковых снимков (кнопка «Найти Sentinel-2»)" });
  const job = await createProcessingJob(pool, String(req.params.id), "ndvi-process");
  await enqueue(satelliteQueue, job.id, "ndvi-process", { pastureId: req.params.id, ...input, demoMode: env.DEMO_MODE });
  res.status(202).json({ jobId: job.id, status: "queued" });
}));

router.get("/pastures/:id/ndvi", asyncRoute(async (req, res) => {
  const year = z.coerce.number().int().optional().parse(req.query.year);
  const result = await pool.query(
    `SELECT o.*, a.bbox FROM ndvi_observations o LEFT JOIN raster_assets a ON a.observation_id=o.id AND a.asset_type='ndvi_visualization'
     WHERE o.pasture_id=$1 AND ($2::int IS NULL OR o.year=$2) ORDER BY o.year DESC,o.month,o.processing_version DESC`,
    [req.params.id, year ?? null]
  );
  res.json(result.rows.map(mapObservation));
}));

router.get("/ndvi/:id", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT o.*,a.bbox FROM ndvi_observations o LEFT JOIN raster_assets a ON a.observation_id=o.id AND a.asset_type='ndvi_visualization' WHERE o.id=$1", [req.params.id]);
  if (!result.rows[0]) return void res.status(404).json({ code: "NOT_FOUND", message: "Наблюдение не найдено" });
  res.json(mapObservation(result.rows[0]));
}));

async function sendAsset(req: any, res: any, assetType: string) {
  const result = await pool.query("SELECT mime_type,raster_data,checksum,byte_size FROM raster_assets WHERE observation_id=$1 AND asset_type=$2", [req.params.id, assetType]);
  const asset = result.rows[0];
  if (!asset) return res.status(404).json({ code: "ASSET_NOT_FOUND", message: "Растр ещё не создан" });
  res.set({ "content-type": asset.mime_type, "content-length": asset.byte_size, etag: `\"${asset.checksum}\"`, "cache-control": "private, max-age=86400" });
  if (req.headers["if-none-match"] === `\"${asset.checksum}\"`) return res.status(304).end();
  return res.end(asset.raster_data);
}
router.get("/ndvi/:id/raster", asyncRoute(async (req, res) => { await sendAsset(req, res, "ndvi_geotiff"); }));
router.get("/ndvi/:id/visualization", asyncRoute(async (req, res) => { await sendAsset(req, res, "ndvi_visualization"); }));
router.get("/ndvi/:id/ndmi/raster", asyncRoute(async (req, res) => { await sendAsset(req, res, "ndmi_geotiff"); }));
router.get("/ndvi/:id/ndmi/visualization", asyncRoute(async (req, res) => { await sendAsset(req, res, "ndmi_visualization"); }));
router.get("/ndvi/:id/rgb", asyncRoute(async (req, res) => { await sendAsset(req, res, "rgb_preview"); }));
router.get("/ndvi/:id/statistics", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT ndvi_mean,ndvi_median,ndvi_p10,ndvi_p90,ndvi_min,ndvi_max,ndvi_std,ndmi_mean,ndmi_median,ndmi_min,ndmi_max,ndmi_std,vegetation_ndvi_mean,vegetation_ndvi_median,vegetation_ndvi_p10,vegetation_ndvi_p90,vegetation_coverage_percentage,composite_scene_count,composite_method,source_scene_ids,source_acquisition_dates,cloud_percentage,valid_coverage_percentage,is_synthetic FROM ndvi_observations WHERE id=$1", [req.params.id]);
  res.json(result.rows[0] ?? null);
}));
router.get("/ndvi/:id/classes", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT class_id AS \"classId\",class_name AS name,color,area_ha AS \"areaHa\",percentage FROM ndvi_classes WHERE observation_id=$1 ORDER BY class_id", [req.params.id]);
  res.json(result.rows);
}));
router.get("/ndvi/:id/pixel", asyncRoute(async (req, res) => {
  const coordinates = z.object({ lng: z.coerce.number().min(-180).max(180), lat: z.coerce.number().min(-90).max(90), index: z.enum(["ndvi", "ndmi"]).default("ndvi") }).parse(req.query);
  const assetType = coordinates.index === "ndmi" ? "ndmi_geotiff" : "ndvi_geotiff";
  const result = await pool.query(`SELECT o.acquisition_date,o.is_synthetic,a.raster_data FROM ndvi_observations o JOIN raster_assets a ON a.observation_id=o.id AND a.asset_type=$2 WHERE o.id=$1`, [req.params.id, assetType]);
  const row = result.rows[0];
  if (!row) return void res.status(404).json({ code: "ASSET_NOT_FOUND", message: "Числовой растр не найден" });
  const directory = await mkdtemp(join(tmpdir(), "pasturevision-pixel-"));
  try {
    const path = join(directory, "ndvi.tif"); await writeFile(path, row.raster_data);
    const output = await promisify(execFile)("gdallocationinfo", ["-wgs84", "-valonly", path, String(coordinates.lng), String(coordinates.lat)]);
    const value = Number(output.stdout.trim());
    if (!Number.isFinite(value) || value < -1 || value > 1) return void res.status(404).json({ code: "NO_VALID_PIXEL", message: "В этой точке нет валидного пикселя" });
    const category = coordinates.index === "ndvi" ? (NDVI_CLASSES.find((item) => value >= item.min && value < item.max) ?? NDVI_CLASSES[0]) : null;
    res.json({ ...coordinates, value, ndvi: coordinates.index === "ndvi" ? value : undefined, ndmi: coordinates.index === "ndmi" ? value : undefined, acquisitionDate: row.acquisition_date, vegetationClass: category?.name, isSynthetic: row.is_synthetic });
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

router.get("/pastures/:id/spectral-analysis", asyncRoute(async (req, res) => {
  const year = z.coerce.number().int().optional().parse(req.query.year);
  const result = await pool.query(
    `SELECT id,pasture_id AS "pastureId",year,status,algorithm,feature_schema AS "featureSchema",
       observation_ids AS "observationIds",sample_count AS "sampleCount",cluster_count AS "clusterCount",
       confidence,result,error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"
     FROM post_spectral_analyses
     WHERE pasture_id=$1 AND ($2::int IS NULL OR year=$2)
     ORDER BY year DESC,updated_at DESC LIMIT 1`,
    [req.params.id, year ?? null]
  );
  res.json(result.rows[0] ?? null);
}));

router.post("/pastures/:id/spectral-analysis", asyncRoute(async (req, res) => {
  const input = monitoringYearSchema.pick({ year: true }).parse(req.body);
  if (!await getPasture(pool, String(req.params.id))) return void res.status(404).json({ code: "NOT_FOUND", message: "Пастбище не найдено" });
  const ready = await pool.query("SELECT COUNT(*)::int AS count FROM ndvi_observations WHERE pasture_id=$1 AND year=$2 AND status='READY'", [req.params.id, input.year]);
  if (!ready.rows[0].count) return void res.status(422).json({ code: "NO_SPECTRAL_DATA", message: "Сначала выполните обработку NDVI и NDMI" });
  const job = await createProcessingJob(pool, String(req.params.id), "spectral-analysis");
  await enqueue(satelliteQueue, job.id, "spectral-analysis", { pastureId: req.params.id, year: input.year });
  res.status(202).json({ jobId: job.id, status: "queued" });
}));

router.post("/ml/annotations", asyncRoute(async (req, res) => {
  const input = annotationSchema.parse(req.body);
  const geometry = normalizeMultiPolygon(validateGeometry(input.geometry, { maxAreaHa: env.MAX_POLYGON_AREA_HA, maxPoints: env.MAX_GEOMETRY_POINTS }));
  const result = await pool.query(
    `INSERT INTO training_annotations (pasture_id,observation_id,class_id,geometry,area_ha)
     VALUES ($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($4),4326)::geography)/10000)
     RETURNING id,pasture_id AS "pastureId",observation_id AS "observationId",class_id AS "classId",ST_AsGeoJSON(geometry)::json AS geometry,area_ha AS "areaHa",created_at AS "createdAt"`,
    [input.pastureId, input.observationId, input.classId, JSON.stringify(geometry)]
  );
  res.status(201).json(result.rows[0]);
}));
router.get("/ml/annotations", asyncRoute(async (req, res) => {
  const observationId = z.string().uuid().optional().parse(req.query.observationId);
  const result = await pool.query(`SELECT id,pasture_id AS "pastureId",observation_id AS "observationId",class_id AS "classId",ST_AsGeoJSON(geometry)::json AS geometry,area_ha AS "areaHa",created_at AS "createdAt" FROM training_annotations WHERE ($1::uuid IS NULL OR observation_id=$1) ORDER BY created_at`, [observationId ?? null]);
  res.json(result.rows);
}));
router.patch("/ml/annotations/:id", asyncRoute(async (req, res) => {
  const input = annotationSchema.pick({ classId: true, geometry: true }).partial().parse(req.body);
  const geometry = input.geometry ? normalizeMultiPolygon(validateGeometry(input.geometry)) : null;
  const result = await pool.query(`UPDATE training_annotations SET class_id=COALESCE($2,class_id),geometry=COALESCE(ST_SetSRID(ST_GeomFromGeoJSON($3),4326),geometry),area_ha=CASE WHEN $3 IS NULL THEN area_ha ELSE ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($3),4326)::geography)/10000 END WHERE id=$1 RETURNING id`, [req.params.id, input.classId ?? null, geometry ? JSON.stringify(geometry) : null]);
  if (!result.rowCount) return void res.status(404).json({ code: "NOT_FOUND" });
  res.json({ id: req.params.id, updated: true });
}));
router.delete("/ml/annotations/:id", asyncRoute(async (req, res) => { await pool.query("DELETE FROM training_annotations WHERE id=$1", [req.params.id]); res.status(204).end(); }));

router.post("/ml/datasets/build", asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2), observationIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const job = await createProcessingJob(pool, null, "dataset-build");
  await enqueue(mlQueue, job.id, "dataset-build", { ...input, demoMode: env.DEMO_MODE });
  res.status(202).json({ jobId: job.id, status: "queued" });
}));
router.post("/ml/train", asyncRoute(async (req, res) => {
  const input = trainingSchema.parse(req.body);
  const job = await createProcessingJob(pool, null, "ml-train");
  await enqueue(mlQueue, job.id, "ml-train", input);
  res.status(202).json({ jobId: job.id, status: "queued" });
}));
router.get("/ml/models", asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT id,name,algorithm,model_version AS version,feature_schema AS "featureSchema",hyperparameters,metrics,is_synthetic AS "isSynthetic",created_at AS "createdAt" FROM ml_models ORDER BY created_at DESC`);
  res.json(result.rows);
}));
router.get("/ml/models/:id", asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT id,name,algorithm,model_version AS version,feature_schema AS "featureSchema",hyperparameters,metrics,is_synthetic AS "isSynthetic",created_at AS "createdAt" FROM ml_models WHERE id=$1`, [req.params.id]);
  if (!result.rows[0]) return void res.status(404).json({ code: "NOT_FOUND" }); res.json(result.rows[0]);
}));
router.get("/ml/models/:id/metrics", asyncRoute(async (req, res) => { const result = await pool.query("SELECT metrics FROM ml_models WHERE id=$1", [req.params.id]); res.json(result.rows[0]?.metrics ?? null); }));

router.post("/pastures/:id/ml/predict", asyncRoute(async (req, res) => {
  const input = predictionSchema.parse(req.body);
  const compatibility = await pool.query(
    `SELECT o.is_synthetic AS "observationSynthetic",m.is_synthetic AS "modelSynthetic",
      EXISTS(SELECT 1 FROM raster_assets r WHERE r.observation_id=o.id AND r.asset_type='spectral_geotiff') AS "spectralAvailable"
     FROM ndvi_observations o CROSS JOIN ml_models m
     WHERE o.id=$1 AND m.id=$2 AND o.pasture_id=$3 AND o.status='READY'`,
    [input.observationId, input.modelId, req.params.id]
  );
  const selected = compatibility.rows[0];
  if (!selected) return void res.status(404).json({ code: "ML_INPUT_NOT_FOUND", message: "Готовый снимок или обученная модель не найдены" });
  if (Boolean(selected.observationSynthetic) !== Boolean(selected.modelSynthetic)) {
    return void res.status(422).json({ code: "INCOMPATIBLE_MODEL", message: "Модель и снимок должны быть обучены и созданы на данных одного типа: реальные с реальными, демонстрационные с демонстрационными" });
  }
  if (!selected.observationSynthetic && !selected.spectralAvailable) {
    return void res.status(422).json({ code: "SPECTRAL_DATA_MISSING", message: "Для снимка отсутствует спектральный GeoTIFF. Повторите NDVI-обработку" });
  }
  const job = await createProcessingJob(pool, String(req.params.id), "ml-predict");
  await enqueue(mlQueue, job.id, "ml-predict", { pastureId: req.params.id, ...input, demoMode: env.DEMO_MODE });
  res.status(202).json({ jobId: job.id, status: "queued" });
}));
router.get("/ml/predictions/:id", asyncRoute(async (req, res) => { const result = await pool.query("SELECT * FROM ml_predictions WHERE id=$1", [req.params.id]); res.json(result.rows[0] ?? null); }));
router.get("/ml/predictions/:id/visualization", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT a.mime_type,a.raster_data,a.checksum,a.byte_size FROM ml_predictions p JOIN raster_assets a ON a.id=p.segmentation_asset_id WHERE p.id=$1", [req.params.id]);
  const asset = result.rows[0]; if (!asset) return void res.status(404).json({ code: "ASSET_NOT_FOUND" });
  res.set({ "content-type": asset.mime_type, "content-length": asset.byte_size, etag: asset.checksum }); res.end(asset.raster_data);
}));
router.get("/ml/predictions/:id/statistics", asyncRoute(async (req, res) => { const result = await pool.query("SELECT statistics FROM ml_predictions WHERE id=$1", [req.params.id]); res.json(result.rows[0]?.statistics ?? null); }));

router.get("/jobs/:id", asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT id,pasture_id AS "pastureId",job_type AS "jobType",status,progress,result,error_message AS "errorMessage",started_at AS "startedAt",completed_at AS "completedAt",created_at AS "createdAt" FROM processing_jobs WHERE id=$1`, [req.params.id]);
  if (!result.rows[0]) return void res.status(404).json({ code: "NOT_FOUND", message: "Задача не найдена" });
  res.json(result.rows[0]);
}));

router.get("/settings", asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT satellite,ndvi_classes AS \"ndviClasses\",ml,updated_at AS \"updatedAt\" FROM app_settings WHERE id=1");
  res.json({ ...result.rows[0], mode: env.DEMO_MODE ? "demo" : "real", copernicusConfigured: Boolean(env.COPERNICUS_CLIENT_ID && env.COPERNICUS_CLIENT_SECRET) });
}));
router.patch("/settings", asyncRoute(async (req, res) => {
  const input = z.object({ satellite: z.record(z.unknown()).optional(), ndviClasses: z.array(z.record(z.unknown())).optional(), ml: z.record(z.unknown()).optional() }).parse(req.body);
  const result = await pool.query(`UPDATE app_settings SET satellite=COALESCE($1,satellite),ndvi_classes=COALESCE($2,ndvi_classes),ml=COALESCE($3,ml),updated_at=now() WHERE id=1 RETURNING satellite,ndvi_classes AS "ndviClasses",ml,updated_at AS "updatedAt"`, [input.satellite ?? null, input.ndviClasses ?? null, input.ml ?? null]);
  res.json(result.rows[0]);
}));

router.get("/reports/:pastureId.csv", asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT year,month,acquisition_date,ndvi_mean,ndvi_median,ndvi_p10,ndvi_p90,vegetation_ndvi_mean,vegetation_ndvi_median,vegetation_ndvi_p10,vegetation_ndvi_p90,vegetation_coverage_percentage,ndmi_mean,ndmi_median,composite_scene_count,composite_method,array_to_string(source_acquisition_dates,'|') AS source_dates,cloud_percentage,valid_coverage_percentage,status,is_synthetic FROM ndvi_observations WHERE pasture_id=$1 ORDER BY year,month,processing_version", [req.params.pastureId]);
  const header = "year,month,acquisition_date,ndvi_mean,ndvi_median,ndvi_p10,ndvi_p90,vegetation_ndvi_mean,vegetation_ndvi_median,vegetation_ndvi_p10,vegetation_ndvi_p90,vegetation_coverage_percentage,ndmi_mean,ndmi_median,composite_scene_count,composite_method,source_dates,cloud_percentage,valid_coverage_percentage,status,is_synthetic";
  const lines = result.rows.map((row) => Object.values(row).map((value) => value ?? "").join(","));
  res.set({ "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=observations-${req.params.pastureId}.csv` });
  res.send(`\uFEFF${header}\n${lines.join("\n")}`);
}));

export function apiErrorHandler(error: unknown, _req: any, res: any, _next: any) {
  if (error instanceof ZodError) return res.status(422).json({ code: "VALIDATION_ERROR", message: "Проверьте входные данные", issues: error.issues });
  const message = error instanceof Error ? error.message : "Внутренняя ошибка";
  const fingerprint = createHash("sha256").update(message).digest("hex").slice(0, 8);
  const statusCode = Number((error as any)?.statusCode) || (message.includes("геометр") || message.includes("Полигон") || message.includes("Площадь") ? 422 : 500);
  res.status(statusCode).json({ code: "REQUEST_FAILED", message, fingerprint });
}
