import type { Pool, PoolClient } from "pg";
import type { PastureGeometry } from "@pasturevision/shared";
import { normalizeMultiPolygon } from "@pasturevision/gis";

type Db = Pool | PoolClient;

export function mapPasture(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    geometry: JSON.parse(row.geometry),
    areaHa: Number(row.area_ha),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getPasture(db: Db, id: string) {
  const result = await db.query("SELECT id, name, description, ST_AsGeoJSON(geometry) AS geometry, area_ha, created_at, updated_at FROM pastures WHERE id = $1", [id]);
  return result.rows[0] ? mapPasture(result.rows[0]) : null;
}

export async function createPasture(db: Db, input: { name: string; description: string; geometry: PastureGeometry }) {
  const geometry = normalizeMultiPolygon(input.geometry);
  const result = await db.query(
    `INSERT INTO pastures (name, description, geometry, area_ha)
     VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography) / 10000)
     RETURNING id, name, description, ST_AsGeoJSON(geometry) AS geometry, area_ha, created_at, updated_at`,
    [input.name, input.description, JSON.stringify(geometry)]
  );
  return mapPasture(result.rows[0]);
}

export function mapObservation(row: any) {
  return {
    id: row.id,
    pastureId: row.pasture_id,
    year: row.year,
    month: row.month,
    acquisitionDate: row.acquisition_date,
    ndviMean: row.ndvi_mean === null ? null : Number(row.ndvi_mean),
    ndviMedian: row.ndvi_median === null ? null : Number(row.ndvi_median),
    ndviP10: row.ndvi_p10 === null || row.ndvi_p10 === undefined ? null : Number(row.ndvi_p10),
    ndviP90: row.ndvi_p90 === null || row.ndvi_p90 === undefined ? null : Number(row.ndvi_p90),
    ndviMin: row.ndvi_min === null ? null : Number(row.ndvi_min),
    ndviMax: row.ndvi_max === null ? null : Number(row.ndvi_max),
    ndviStd: row.ndvi_std === null ? null : Number(row.ndvi_std),
    ndmiMean: row.ndmi_mean === null || row.ndmi_mean === undefined ? null : Number(row.ndmi_mean),
    ndmiMedian: row.ndmi_median === null || row.ndmi_median === undefined ? null : Number(row.ndmi_median),
    ndmiMin: row.ndmi_min === null || row.ndmi_min === undefined ? null : Number(row.ndmi_min),
    ndmiMax: row.ndmi_max === null || row.ndmi_max === undefined ? null : Number(row.ndmi_max),
    ndmiStd: row.ndmi_std === null || row.ndmi_std === undefined ? null : Number(row.ndmi_std),
    vegetationNdviMean: row.vegetation_ndvi_mean === null || row.vegetation_ndvi_mean === undefined ? null : Number(row.vegetation_ndvi_mean),
    vegetationNdviMedian: row.vegetation_ndvi_median === null || row.vegetation_ndvi_median === undefined ? null : Number(row.vegetation_ndvi_median),
    vegetationNdviP10: row.vegetation_ndvi_p10 === null || row.vegetation_ndvi_p10 === undefined ? null : Number(row.vegetation_ndvi_p10),
    vegetationNdviP90: row.vegetation_ndvi_p90 === null || row.vegetation_ndvi_p90 === undefined ? null : Number(row.vegetation_ndvi_p90),
    vegetationCoveragePercentage: row.vegetation_coverage_percentage === null || row.vegetation_coverage_percentage === undefined ? null : Number(row.vegetation_coverage_percentage),
    compositeSceneCount: Number(row.composite_scene_count ?? 1),
    compositeMethod: row.composite_method ?? "single-scene",
    sourceSceneIds: row.source_scene_ids ?? [],
    sourceAcquisitionDates: (row.source_acquisition_dates ?? []).map((date: string | Date) => new Date(date).toISOString()),
    cloudPercentage: row.cloud_percentage === null ? null : Number(row.cloud_percentage),
    validCoveragePercentage: row.valid_coverage_percentage === null ? null : Number(row.valid_coverage_percentage),
    status: row.status,
    processingVersion: row.processing_version,
    isSynthetic: row.is_synthetic,
    bbox: row.bbox ?? null,
    visualizationUrl: row.status === "READY" ? `/api/ndvi/${row.id}/visualization` : undefined
  };
}

export async function createProcessingJob(db: Db, pastureId: string | null, jobType: string) {
  const result = await db.query(
    "INSERT INTO processing_jobs (pasture_id, job_type, status) VALUES ($1, $2, 'queued') RETURNING *",
    [pastureId, jobType]
  );
  return result.rows[0];
}
