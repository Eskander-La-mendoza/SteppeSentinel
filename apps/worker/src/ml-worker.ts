import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Worker, type Job } from "bullmq";
import { feature, point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { RandomForestTrainingService, extractFeatures, type FeatureName, type TrainingSample } from "@pasturevision/ml";
import { geometryBbox } from "@pasturevision/gis";
import type { PastureGeometry } from "@pasturevision/shared";
import { pool, setJobProgress, setJobState } from "./db.js";
import { colorizePrediction, makeDemoGrid, rgbaPng, syntheticSpectral } from "./demo.js";
import { config } from "./config.js";
import type { Redis } from "ioredis";
import { readSpectralGeoTiff, type SpectralRaster } from "./gdal.js";

const FEATURE_NAMES: FeatureName[] = ["B02","B03","B04","B08","B11","B12","NDVI","NDMI"];
type ProgressReporter = (progress: number, phase: string, message: string) => Promise<void>;

function createProgressReporter(job: Job, processingJobId: string): ProgressReporter {
  let lastProgress = 0;
  return async (progress, phase, message) => {
    const normalized = Math.max(lastProgress, Math.min(99, Math.round(progress)));
    lastProgress = normalized;
    await Promise.all([
      job.updateProgress(normalized),
      setJobProgress(processingJobId, normalized, { phase, message })
    ]);
  };
}

function rasterFeatures(raster: SpectralRaster, index: number): Record<FeatureName, number> | null {
  if ((raster.bands[8]?.[index] ?? 0) < 0.5) return null;
  const values = raster.bands.slice(0, 8).map((band) => band[index]);
  if (values.some((value) => value === undefined || !Number.isFinite(value) || value <= -9999)) return null;
  return Object.fromEntries(FEATURE_NAMES.map((name, featureIndex) => [name, values[featureIndex]!])) as Record<FeatureName, number>;
}

async function buildDataset(job: Job, report: ProgressReporter) {
  const { name, observationIds } = job.data;
  await report(5, "dataset-load", "Загрузка сохранённой разметки");
  const result = await pool.query(
    `SELECT a.id,a.class_id,a.observation_id,ST_X(ST_Centroid(a.geometry)) AS longitude,ST_Y(ST_Centroid(a.geometry)) AS latitude,
      ST_AsGeoJSON(a.geometry)::json AS geometry,o.month,o.is_synthetic,r.raster_data
     FROM training_annotations a JOIN ndvi_observations o ON o.id=a.observation_id
     LEFT JOIN raster_assets r ON r.observation_id=o.id AND r.asset_type='spectral_geotiff'
     WHERE a.observation_id=ANY($1::uuid[])`, [observationIds]
  );
  if (result.rows.length < 2) throw new Error("Создайте как минимум две пространственно разделённые аннотации");
  const classCount = new Set(result.rows.map((row) => row.class_id)).size;
  if (classCount < 2) throw new Error("Разметьте как минимум два класса");
  const dataKinds = new Set(result.rows.map((row) => Boolean(row.is_synthetic)));
  if (dataKinds.size !== 1) throw new Error("Синтетические и реальные наблюдения нельзя смешивать в одном датасете");
  const isSynthetic = Boolean(result.rows[0].is_synthetic);
  await report(20, "dataset-features", `Извлечение признаков из ${result.rows.length} областей разметки`);
  const samples: TrainingSample[] = [];
  const rasterCache = new Map<string, SpectralRaster>();
  for (let annotationIndex = 0; annotationIndex < result.rows.length; annotationIndex += 1) {
    const annotation = result.rows[annotationIndex];
    const geometry = annotation.geometry as PastureGeometry;
    if (isSynthetic) {
      const bbox = geometryBbox(geometry);
      for (let i = 0; i < 160; i += 1) {
        const u = ((i * 73) % 157 + 0.5) / 157; const v = ((i * 101) % 163 + 0.5) / 163;
        const longitude = bbox[0] + u * (bbox[2]-bbox[0]); const latitude = bbox[1] + v * (bbox[3]-bbox[1]);
        if (!booleanPointInPolygon(point([longitude,latitude]),feature(geometry))) continue;
        const features = extractFeatures(syntheticSpectral(longitude,latitude,annotation.month,i));
        if (features) samples.push({features,label:annotation.class_id,spatialGroup:annotation.id});
      }
    } else {
      if (!annotation.raster_data) throw new Error(`Spectral GeoTIFF отсутствует для observation ${annotation.observation_id}`);
      let raster = rasterCache.get(annotation.observation_id);
      if (!raster) { raster = await readSpectralGeoTiff(annotation.raster_data); rasterCache.set(annotation.observation_id, raster); }
      let accepted = 0;
      for (let i = 0; i < raster.coordinates.length && accepted < 2_000; i += 4) {
        const coordinate = raster.coordinates[i]!;
        if (!booleanPointInPolygon(point(coordinate), feature(geometry))) continue;
        const features = rasterFeatures(raster, i);
        if (features) { samples.push({ features, label: annotation.class_id, spatialGroup: annotation.id }); accepted += 1; }
      }
    }
    await report(20 + (annotationIndex + 1) / result.rows.length * 60, "dataset-features", `Обработано областей: ${annotationIndex + 1} из ${result.rows.length}`);
  }
  if (!samples.length) throw new Error("В размеченных областях нет валидных спектральных пикселей");
  await report(88, "dataset-save", `Сохранение ${samples.length} обучающих примеров`);
  const distribution = samples.reduce<Record<string,number>>((acc,item)=>{acc[item.label]=(acc[item.label]??0)+1;return acc;},{});
  const compressed = gzipSync(Buffer.from(JSON.stringify(samples)));
  const inserted = await pool.query(
    `INSERT INTO training_datasets(name,feature_schema,sample_count,class_distribution,dataset_data,is_synthetic) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name,JSON.stringify(FEATURE_NAMES),samples.length,JSON.stringify(distribution),compressed,isSynthetic]
  );
  await report(97, "dataset-save", "Обучающая выборка готова");
  return { datasetId: inserted.rows[0].id, sampleCount: samples.length, classDistribution: distribution, isSynthetic };
}

async function train(job: Job, report: ProgressReporter) {
  const { datasetId,name,numberOfTrees,seed,featureNames } = job.data;
  await report(5, "training-load", "Загрузка обучающей выборки");
  const datasetResult = await pool.query("SELECT * FROM training_datasets WHERE id=$1",[datasetId]);
  const dataset=datasetResult.rows[0]; if(!dataset) throw new Error("Датасет не найден");
  const runResult=await pool.query("INSERT INTO ml_training_runs(dataset_id,status,parameters) VALUES($1,'active',$2) RETURNING id",[datasetId,JSON.stringify({numberOfTrees,seed,featureNames})]);
  const runId=runResult.rows[0].id;
  try {
    await report(20, "training-prepare", "Распаковка и проверка признаков");
    const samples=JSON.parse(gunzipSync(dataset.dataset_data).toString("utf8")) as TrainingSample[];
    const service=new RandomForestTrainingService();
    await report(40, "training-fit", `Обучение Random Forest: ${numberOfTrees} деревьев, ${samples.length} примеров`);
    const trained=service.train(samples,featureNames,{numberOfTrees,seed});
    await report(82, "training-save", "Сохранение модели и метрик качества");
    const versionResult=await pool.query("SELECT COALESCE(MAX(model_version),0)+1 AS version FROM ml_models WHERE name=$1",[name]);
    const modelResult=await pool.query(
      `INSERT INTO ml_models(name,model_version,model_data,feature_schema,hyperparameters,preprocessing,metrics,dataset_id,is_synthetic)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,model_version`,
      [name,versionResult.rows[0].version,Buffer.from(JSON.stringify({model:trained.serializedModel,labels:trained.labels})),JSON.stringify(featureNames),JSON.stringify({numberOfTrees,seed}),JSON.stringify({indices:["NDVI","NDMI"],invalidPixels:"SCL and dataMask"}),JSON.stringify(trained.metrics),datasetId,dataset.is_synthetic]
    );
    await pool.query("UPDATE ml_training_runs SET status='completed',model_id=$2,metrics=$3,completed_at=now() WHERE id=$1",[runId,modelResult.rows[0].id,JSON.stringify(trained.metrics)]);
    await report(97, "training-save", "Модель обучена и сохранена");
    return {modelId:modelResult.rows[0].id,version:modelResult.rows[0].model_version,metrics:trained.metrics};
  } catch(error) { await pool.query("UPDATE ml_training_runs SET status='failed',error_message=$2,completed_at=now() WHERE id=$1",[runId,error instanceof Error?error.message:String(error)]); throw error; }
}

async function predict(job: Job, report: ProgressReporter) {
  const { observationId, modelId } = job.data;
  await report(5, "prediction-load", "Загрузка снимка и обученной модели");
  const result = await pool.query(
    `SELECT o.month,o.is_synthetic,ST_AsGeoJSON(p.geometry)::json AS geometry,p.area_ha,m.model_data,m.feature_schema,
      m.is_synthetic AS model_synthetic,r.raster_data AS spectral_data
     FROM ndvi_observations o JOIN pastures p ON p.id=o.pasture_id CROSS JOIN ml_models m
     LEFT JOIN raster_assets r ON r.observation_id=o.id AND r.asset_type='spectral_geotiff'
     WHERE o.id=$1 AND m.id=$2`,
    [observationId, modelId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Наблюдение или модель не найдены");
  if (Boolean(row.is_synthetic) !== Boolean(row.model_synthetic)) throw new Error("Нельзя применять синтетическую модель к реальным данным и наоборот");

  let width: number;
  let height: number;
  let bbox: [number, number, number, number];
  let validMask: boolean[];
  let vectors: number[][];

  await report(20, "prediction-features", row.is_synthetic ? "Подготовка демонстрационных признаков" : "Чтение спектрального GeoTIFF");
  if (row.is_synthetic) {
    const grid = makeDemoGrid(row.geometry, row.month);
    width = grid.width;
    height = grid.height;
    bbox = grid.bbox;
    validMask = Array.from(grid.values, (value) => value !== -9999);
    vectors = [];
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const index = y * grid.width + x;
        if (!validMask[index]) continue;
        const longitude = grid.bbox[0] + (x + 0.5) / grid.width * (grid.bbox[2] - grid.bbox[0]);
        const latitude = grid.bbox[3] - (y + 0.5) / grid.height * (grid.bbox[3] - grid.bbox[1]);
        const features = extractFeatures(syntheticSpectral(longitude, latitude, row.month, index));
        if (features) vectors.push((row.feature_schema as FeatureName[]).map((name) => features[name]));
      }
    }
  } else {
    if (!row.spectral_data) throw new Error("Spectral GeoTIFF отсутствует для реальной сегментации");
    const raster = await readSpectralGeoTiff(row.spectral_data);
    width = raster.width;
    height = raster.height;
    bbox = raster.bbox;
    validMask = [];
    vectors = [];
    await report(42, "prediction-features", `Формирование признаков для ${width * height} пикселей`);
    for (let index = 0; index < width * height; index += 1) {
      const features = rasterFeatures(raster, index);
      validMask.push(Boolean(features));
      if (features) vectors.push((row.feature_schema as FeatureName[]).map((name) => features[name]));
    }
  }
  if (!vectors.length) throw new Error("На снимке нет валидных пикселей для классификации");

  await report(62, "prediction-model", `Классификация ${vectors.length} валидных пикселей`);
  const stored = JSON.parse(row.model_data.toString("utf8"));
  const service = new RandomForestTrainingService();
  const forest = service.load(stored.model);
  const predictions = forest.predict(vectors).map((index: number) => stored.labels[index] ?? "other");

  await report(78, "prediction-render", "Формирование цветной карты классов");
  const colored = colorizePrediction(predictions, validMask, width, height);
  const png = await rgbaPng(colored.rgba, width, height);
  const statistics = [...colored.counts].map(([classId, count]) => ({
    classId,
    pixels: count,
    percentage: count / predictions.length * 100,
    areaHa: Number(row.area_ha) * count / predictions.length
  }));

  await report(90, "prediction-save", "Сохранение карты и статистики классов");
  const prediction = await pool.query(
    "INSERT INTO ml_predictions(model_id,observation_id,statistics) VALUES($1,$2,$3) ON CONFLICT(model_id,observation_id) DO UPDATE SET statistics=EXCLUDED.statistics,created_at=now() RETURNING id",
    [modelId, observationId, JSON.stringify(statistics)]
  );
  const predictionId = prediction.rows[0].id;
  const checksum = createHash("sha256").update(png).digest("hex");
  const asset = await pool.query(
    `INSERT INTO raster_assets(observation_id,prediction_id,asset_type,mime_type,raster_data,bbox,width,height,resolution,checksum,byte_size)
     VALUES(NULL,$1,'ml_segmentation','image/png',$2,$3,$4,$5,10,$6,$7) RETURNING id`,
    [predictionId, png, JSON.stringify(bbox), width, height, checksum, png.byteLength]
  );
  await pool.query("UPDATE ml_predictions SET segmentation_asset_id=$2 WHERE id=$1", [predictionId, asset.rows[0].id]);
  await report(97, "prediction-save", "Сегментация готова");
  return { predictionId, statistics, isSynthetic: Boolean(row.is_synthetic) };
}

export function startMlWorker(connection: Redis) {
  return new Worker("machine-learning", async (job) => {
    const processingJobId = job.data.processingJobId;
    const report = createProgressReporter(job, processingJobId);
    await report(1, "starting", "Запуск ML-задачи");
    try {
      let result;
      if (job.name === "dataset-build") result = await buildDataset(job, report);
      else if (job.name === "ml-train") result = await train(job, report);
      else result = await predict(job, report);
      await setJobState(processingJobId, "completed", { progress: 100, result });
      return result;
    } catch (error) {
      await setJobState(processingJobId, "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, { connection, concurrency: 1 });
}
