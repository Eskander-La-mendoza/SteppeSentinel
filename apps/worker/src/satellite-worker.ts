import { createHash } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { CopernicusClient, chooseBestCandidates } from "@pasturevision/satellite";
import { NDVI_CLASSES, type PastureGeometry } from "@pasturevision/shared";
import { pool, setJobProgress, setJobState, type JobProgressDetail } from "./db.js";
import { config } from "./config.js";
import { makeDemoGrid, ndmiColor, rgbaPng } from "./demo.js";
import { compositeProcessTiffs, gridToGeoTiff } from "./gdal.js";
import { runPostSpectralAnalysis } from "./post-spectral-analysis.js";
import type { Redis } from "ioredis";

const MONTHS = [5, 6, 7, 8, 9];
const DEMO_DATES: Record<number, number> = { 5: 14, 6: 12, 7: 17, 8: 9, 9: 15 };
const MONTHLY_COMPOSITE_SCENES = 5;
const MONTH_NAMES: Record<number, string> = { 5: "Май", 6: "Июнь", 7: "Июль", 8: "Август", 9: "Сентябрь" };
type ProgressReporter = (progress: number, detail: JobProgressDetail) => Promise<void>;

function createProgressReporter(job: Job): ProgressReporter {
  const processingJobId = String(job.data.processingJobId);
  let lastProgress = typeof job.progress === "number" ? job.progress : 0;
  return async (progress, detail) => {
    const normalized = Math.max(lastProgress, Math.max(0, Math.min(100, Math.round(progress))));
    lastProgress = normalized;
    await Promise.all([
      job.updateProgress(normalized),
      setJobProgress(processingJobId, normalized, detail)
    ]);
  };
}

async function pasture(id: string) {
  const result = await pool.query("SELECT id,area_ha,ST_AsGeoJSON(geometry)::json AS geometry FROM pastures WHERE id=$1", [id]);
  if (!result.rows[0]) throw new Error("Пастбище не найдено");
  return result.rows[0] as { id: string; area_ha: number; geometry: PastureGeometry };
}

async function satelliteSearch(job: Job, report: ProgressReporter) {
  const { pastureId, year, demoMode, preferredCloudPercentage = 10, minimumValidCoverage = 90 } = job.data;
  const target = await pasture(pastureId);
  const selected: string[] = [];
  const client = demoMode ? null : new CopernicusClient(config.COPERNICUS_CLIENT_ID!, config.COPERNICUS_CLIENT_SECRET!, config.COPERNICUS_TIMEOUT_MS);
  const monthProgress = 100 / MONTHS.length;
  const resumeMonthCount = typeof job.progress === "number"
    ? Math.min(MONTHS.length, Math.floor(job.progress / monthProgress))
    : 0;

  for (let index = 0; index < MONTHS.length; index += 1) {
    const month = MONTHS[index]!;
    const monthName = MONTH_NAMES[month]!;
    const baseProgress = index / MONTHS.length * 100;
    if (index < resumeMonthCount) {
      const existing = await pool.query(
        `SELECT id FROM satellite_scenes
         WHERE pasture_id=$1 AND month=$2 AND EXTRACT(YEAR FROM acquisition_date)=$3 AND selected=true
         ORDER BY acquisition_date`,
        [pastureId, month, year]
      );
      selected.push(...existing.rows.map((row) => row.id));
      await report(baseProgress + monthProgress, {
        phase: "resuming",
        message: `${monthName}: уже обработан, продолжаем поиск`,
        month,
        completedMonths: index + 1,
        totalMonths: MONTHS.length
      });
      continue;
    }
    await report(baseProgress + 1, {
      phase: "catalog",
      message: `${monthName}: поиск снимков в каталоге Copernicus`,
      month,
      completedMonths: index,
      totalMonths: MONTHS.length
    });

    if (demoMode) {
      await report(baseProgress + monthProgress * 0.45, {
        phase: "demo",
        message: `${monthName}: создание демонстрационного снимка`,
        month,
        completedMonths: index,
        totalMonths: MONTHS.length
      });
      const acquisition = new Date(Date.UTC(year, month - 1, DEMO_DATES[month])).toISOString();
      const productId = `SYNTHETIC_S2_L2A_${year}${String(month).padStart(2,"0")}${DEMO_DATES[month]}`;
      const cloud = Number((3.2 + month * 0.41).toFixed(2));
      const valid = Number((98.7 - month * 0.18).toFixed(2));
      const result = await pool.query(
        `INSERT INTO satellite_scenes (pasture_id,product_id,acquisition_date,month,cloud_cover,aoi_cloud_percentage,valid_coverage_percentage,geographic_coverage_percentage,selected,footprint,metadata)
         VALUES ($1,$2,$3,$4,$5,$5,$6,100,true,ST_SetSRID(ST_GeomFromGeoJSON($7),4326),$8)
         ON CONFLICT (pasture_id,product_id) DO UPDATE SET selected=true,aoi_cloud_percentage=EXCLUDED.aoi_cloud_percentage,valid_coverage_percentage=EXCLUDED.valid_coverage_percentage
         RETURNING id`,
        [pastureId, productId, acquisition, month, cloud, valid, JSON.stringify(target.geometry), JSON.stringify({ synthetic: true, source: "PastureVision deterministic demo raster" })]
      );
      selected.push(result.rows[0].id);
      await report(baseProgress + monthProgress, {
        phase: "month-complete",
        message: `${monthName}: снимок выбран`,
        month,
        completedMonths: index + 1,
        totalMonths: MONTHS.length
      });
      continue;
    }

    const candidates = await client!.findMonthlyCandidates(target.geometry, year, month, {
      onProgress: async ({ phase, checkedCandidates, totalCandidates }) => {
        const qualityFraction = totalCandidates > 0 ? checkedCandidates / totalCandidates : 0;
        await report(baseProgress + (phase === "catalog" ? 1 : phase === "quality-batch" ? 2 : 2 + qualityFraction * 15), {
          phase,
          message: phase === "catalog"
            ? `${monthName}: поиск снимков в каталоге Copernicus`
            : phase === "quality-batch"
              ? totalCandidates === 0
                ? `${monthName}: снимки с полным покрытием не найдены`
                : `${monthName}: пакетный расчёт качества для ${totalCandidates} дат`
              : `${monthName}: обработано дат — ${checkedCandidates} из ${totalCandidates}`,
          month,
          completedMonths: index,
          totalMonths: MONTHS.length,
          checkedCandidates,
          totalCandidates
        });
      }
    });
    const best = chooseBestCandidates(candidates, minimumValidCoverage, preferredCloudPercentage, MONTHLY_COMPOSITE_SCENES);
    const selectedProductIds = new Set(best.map((candidate) => candidate.productId));
    await report(baseProgress + 18, {
      phase: "saving",
      message: `${monthName}: сохранение ${candidates.length} кандидатов`,
      month,
      completedMonths: index,
      totalMonths: MONTHS.length,
      checkedCandidates: candidates.length,
      totalCandidates: candidates.length
    });
    for (const candidate of candidates) {
      const isSelected = selectedProductIds.has(candidate.productId);
      const geometry = candidate.feature.geometry.type === "Polygon" ? { type: "MultiPolygon", coordinates: [candidate.feature.geometry.coordinates] } : candidate.feature.geometry;
      const result = await pool.query(
        `INSERT INTO satellite_scenes (pasture_id,product_id,acquisition_date,month,cloud_cover,aoi_cloud_percentage,valid_coverage_percentage,geographic_coverage_percentage,selected,footprint,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ST_SetSRID(ST_GeomFromGeoJSON($10),4326),$11)
         ON CONFLICT (pasture_id,product_id) DO UPDATE SET selected=EXCLUDED.selected,aoi_cloud_percentage=EXCLUDED.aoi_cloud_percentage,valid_coverage_percentage=EXCLUDED.valid_coverage_percentage,metadata=EXCLUDED.metadata RETURNING id`,
        [pastureId, candidate.productId, candidate.acquisitionDate, month, candidate.sceneCloudPercentage, candidate.aoiCloudPercentage, candidate.validCoveragePercentage, candidate.geographicCoveragePercentage, isSelected, JSON.stringify(geometry), JSON.stringify(candidate.feature.properties)]
      );
      if (isSelected) selected.push(result.rows[0].id);
    }
    await report(baseProgress + monthProgress, {
      phase: "month-complete",
      message: best.length ? `${monthName}: отобрано дат для композита — ${best.length}` : `${monthName}: подходящие снимки не найдены`,
      month,
      completedMonths: index + 1,
      totalMonths: MONTHS.length,
      checkedCandidates: candidates.length,
      totalCandidates: candidates.length
    });
  }
  return { selectedSceneIds: selected, monthsSearched: MONTHS, mode: demoMode ? "demo" : "real" };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a,b) => a-b);
  const mean = values.reduce((sum,value) => sum + value,0) / values.length;
  const percentile = (position: number) => {
    const index = (sorted.length - 1) * position;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
  };
  return { min: sorted[0]!, max: sorted.at(-1)!, mean, median: percentile(0.5), p10: percentile(0.1), p90: percentile(0.9), std: Math.sqrt(values.reduce((sum,value) => sum + (value-mean)**2,0)/values.length) };
}

async function ndmiVisualization(values: number[], width: number, height: number) {
  const rgba = Buffer.alloc(width * height * 4);
  values.forEach((value, pixel) => {
    if (!Number.isFinite(value) || value < -1 || value > 1) return;
    const color = ndmiColor(value);
    rgba[pixel * 4] = color[0];
    rgba[pixel * 4 + 1] = color[1];
    rgba[pixel * 4 + 2] = color[2];
    rgba[pixel * 4 + 3] = 210;
  });
  return rgbaPng(rgba, width, height);
}

async function saveAsset(observationId: string, assetType: string, mime: string, data: Buffer, bbox: number[], width: number, height: number, resolution = 10) {
  if (data.byteLength > config.MAX_RASTER_BYTES) throw new Error(`Растр ${assetType} превышает лимит ${config.MAX_RASTER_BYTES} bytes`);
  const checksum = createHash("sha256").update(data).digest("hex");
  await pool.query(
    `INSERT INTO raster_assets (observation_id,asset_type,mime_type,raster_data,bbox,width,height,resolution,checksum,byte_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (observation_id,asset_type) DO UPDATE SET raster_data=EXCLUDED.raster_data,bbox=EXCLUDED.bbox,width=EXCLUDED.width,height=EXCLUDED.height,checksum=EXCLUDED.checksum,byte_size=EXCLUDED.byte_size`,
    [observationId, assetType, mime, data, JSON.stringify(bbox), width, height, resolution, checksum, data.byteLength]
  );
}

async function processNdvi(job: Job, report: ProgressReporter) {
  const { pastureId, year, demoMode, sceneIds } = job.data;
  const target = await pasture(pastureId);
  const scenes = await pool.query(
    `SELECT * FROM satellite_scenes WHERE pasture_id=$1 AND EXTRACT(YEAR FROM acquisition_date)=$2 AND selected=true AND ($3::uuid[] IS NULL OR id=ANY($3)) ORDER BY month,acquisition_date`,
    [pastureId, year, sceneIds?.length ? sceneIds : null]
  );
  const observations: string[] = [];
  const client = demoMode ? null : new CopernicusClient(config.COPERNICUS_CLIENT_ID!, config.COPERNICUS_CLIENT_SECRET!, config.COPERNICUS_TIMEOUT_MS);
  for (let index = 0; index < MONTHS.length; index += 1) {
    const month = MONTHS[index]!;
    const monthName = MONTH_NAMES[month]!;
    const baseProgress = index / MONTHS.length * 90;
    const monthProgress = 90 / MONTHS.length;
    await report(baseProgress + 1, {
      phase: "preparing",
      message: `${monthName}: подготовка обработки NDVI`,
      month,
      completedMonths: index,
      totalMonths: MONTHS.length
    });
    const monthScenes = scenes.rows.filter((row) => row.month === month);
    const versionResult = await pool.query("SELECT COALESCE(MAX(processing_version),0)+1 AS version FROM ndvi_observations WHERE pasture_id=$1 AND year=$2 AND month=$3", [pastureId, year, month]);
    const version = versionResult.rows[0].version;
    if (!monthScenes.length) {
      await pool.query("INSERT INTO ndvi_observations (pasture_id,year,month,status,processing_version,is_synthetic) VALUES($1,$2,$3,'NO_SUITABLE_IMAGE',$4,$5)", [pastureId, year, month, version, demoMode]);
      await report(baseProgress + monthProgress, {
        phase: "month-complete",
        message: `${monthName}: нет подходящего снимка`,
        month,
        completedMonths: index + 1,
        totalMonths: MONTHS.length
      });
      continue;
    }
    const representativeScene = monthScenes[Math.floor(monthScenes.length / 2)]!;
    const meanCloud = monthScenes.reduce((sum, scene) => sum + Number(scene.aoi_cloud_percentage ?? 0), 0) / monthScenes.length;
    const meanCoverage = monthScenes.reduce((sum, scene) => sum + Number(scene.valid_coverage_percentage ?? 0), 0) / monthScenes.length;
    const sourceSceneIds = monthScenes.map((scene) => scene.id);
    const sourceDates = monthScenes.map((scene) => scene.acquisition_date);
    const observationResult = await pool.query(
      `INSERT INTO ndvi_observations (pasture_id,scene_id,year,month,acquisition_date,cloud_percentage,valid_coverage_percentage,status,processing_version,is_synthetic,composite_scene_count,composite_method,source_scene_ids,source_acquisition_dates)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PROCESSING',$8,$9,$10,$11,$12,$13) RETURNING id`,
      [pastureId, representativeScene.id, year, month, representativeScene.acquisition_date, meanCloud, meanCoverage, version, demoMode, monthScenes.length, monthScenes.length > 1 ? "median-reflectance" : "single-scene", sourceSceneIds, sourceDates]
    );
    const observationId = observationResult.rows[0].id;
    try {
      let values: number[] = [], ndmiValues: number[] = [], vegetationValues: number[] = [], bbox: [number,number,number,number] = [0,0,0,0], width = 0, height = 0;
      let ndviTiff: Buffer<ArrayBufferLike> = Buffer.alloc(0), ndmiTiff: Buffer<ArrayBufferLike> = Buffer.alloc(0), visual: Buffer<ArrayBufferLike> = Buffer.alloc(0), ndmiVisual: Buffer<ArrayBufferLike> = Buffer.alloc(0), mask: Buffer<ArrayBufferLike> = Buffer.alloc(0), rgb: Buffer<ArrayBufferLike> = Buffer.alloc(0), spectral: Buffer<ArrayBufferLike> | null = null;
      let vegetationMask: Buffer<ArrayBufferLike> | null = null;
      let classCounts: Map<number,number>;
      if (demoMode) {
        await report(baseProgress + 5, {
          phase: "generating",
          message: `${monthName}: формирование демонстрационного растра`,
          month,
          completedMonths: index,
          totalMonths: MONTHS.length
        });
        const grid = makeDemoGrid(target.geometry, month);
        values = grid.validValues; ndmiValues = grid.validNdmiValues; vegetationValues = grid.validValues.filter((value) => value >= 0.3); bbox = grid.bbox; width = grid.width; height = grid.height; classCounts = grid.classCounts;
        ndviTiff = await gridToGeoTiff(grid);
        ndmiTiff = await gridToGeoTiff({ width, height, bbox, values: grid.ndmiValues });
        visual = await rgbaPng(grid.rgba, width, height);
        ndmiVisual = await rgbaPng(grid.ndmiRgba, width, height);
        mask = await gridToGeoTiff({ width, height, bbox, values: Float32Array.from(grid.values, (value) => value === -9999 ? 0 : 1) });
        rgb = visual;
      } else {
        await report(baseProgress + 4, {
          phase: "downloading",
          message: `${monthName}: загрузка спектральных данных Sentinel-2`,
          month,
          completedMonths: index,
          totalMonths: MONTHS.length
        });
        const sourceRasters: Buffer[] = [];
        for (let sourceIndex = 0; sourceIndex < monthScenes.length; sourceIndex += 1) {
          const scene = monthScenes[sourceIndex]!;
          await report(baseProgress + 4 + (sourceIndex / monthScenes.length) * 6, {
            phase: "downloading",
            message: `${monthName}: загрузка снимка ${sourceIndex + 1}/${monthScenes.length}`,
            month,
            completedMonths: index,
            totalMonths: MONTHS.length
          });
          sourceRasters.push(Buffer.from(await client!.processNdvi(target.geometry, scene.acquisition_date)));
        }
        await report(baseProgress + 10, {
          phase: "decoding",
          message: `${monthName}: декодирование GeoTIFF`,
          month,
          completedMonths: index,
          totalMonths: MONTHS.length
        });
        const processed = await compositeProcessTiffs(sourceRasters);
        ({ values, ndmiValues, vegetationValues, bbox, width, height, ndvi: ndviTiff, ndmi: ndmiTiff, rgb, mask, vegetationMask, spectral } = processed);
        const rgba = Buffer.alloc(width * height * 4);
        classCounts = new Map();
        processed.allValues.forEach((value, pixel) => { if (!Number.isFinite(value) || value < -1 || value > 1) return; const item = NDVI_CLASSES.find((entry) => value >= entry.min && value < entry.max) ?? NDVI_CLASSES[0]; classCounts.set(item.id,(classCounts.get(item.id)??0)+1); const c=item.color.slice(1); rgba[pixel*4]=parseInt(c.slice(0,2),16); rgba[pixel*4+1]=parseInt(c.slice(2,4),16); rgba[pixel*4+2]=parseInt(c.slice(4,6),16); rgba[pixel*4+3]=210; });
        visual = await rgbaPng(rgba, width, height);
        ndmiVisual = await ndmiVisualization(processed.allNdmiValues, width, height);
      }
      if (!values.length) throw new Error("Нет валидных пикселей NDVI");
      if (!ndmiValues.length) throw new Error("Нет валидных пикселей NDMI");
      await report(baseProgress + 15, {
        phase: "statistics",
        message: `${monthName}: расчёт статистики и классов NDVI`,
        month,
        completedMonths: index,
        totalMonths: MONTHS.length
      });
      const stats = summarize(values);
      const ndmiStats = summarize(ndmiValues);
      const vegetationStats = vegetationValues.length ? summarize(vegetationValues) : null;
      const vegetationCoveragePercentage = values.length ? vegetationValues.length / values.length * 100 : null;
      await report(baseProgress + 17, {
        phase: "saving",
        message: `${monthName}: сохранение растров и результатов`,
        month,
        completedMonths: index,
        totalMonths: MONTHS.length
      });
      await saveAsset(observationId,"ndvi_geotiff","image/tiff",ndviTiff,bbox,width,height);
      await saveAsset(observationId,"ndvi_visualization","image/png",visual,bbox,width,height);
      await saveAsset(observationId,"ndmi_geotiff","image/tiff",ndmiTiff,bbox,width,height);
      await saveAsset(observationId,"ndmi_visualization","image/png",ndmiVisual,bbox,width,height);
      await saveAsset(observationId,"valid_mask","image/tiff",mask,bbox,width,height);
      if (vegetationMask) await saveAsset(observationId,"vegetation_mask","image/tiff",vegetationMask,bbox,width,height);
      await saveAsset(observationId,"rgb_preview","image/png",rgb,bbox,width,height);
      if (spectral) await saveAsset(observationId,"spectral_geotiff","image/tiff",spectral,bbox,width,height);
      await pool.query(
        "UPDATE ndvi_observations SET ndvi_mean=$2,ndvi_median=$3,ndvi_min=$4,ndvi_max=$5,ndvi_std=$6,ndmi_mean=$7,ndmi_median=$8,ndmi_min=$9,ndmi_max=$10,ndmi_std=$11,ndvi_p10=$12,ndvi_p90=$13,vegetation_ndvi_mean=$14,vegetation_ndvi_median=$15,vegetation_ndvi_p10=$16,vegetation_ndvi_p90=$17,vegetation_coverage_percentage=$18,status='READY' WHERE id=$1",
        [observationId,stats.mean,stats.median,stats.min,stats.max,stats.std,ndmiStats.mean,ndmiStats.median,ndmiStats.min,ndmiStats.max,ndmiStats.std,stats.p10,stats.p90,vegetationStats?.mean ?? null,vegetationStats?.median ?? null,vegetationStats?.p10 ?? null,vegetationStats?.p90 ?? null,vegetationCoveragePercentage]
      );
      for (const category of NDVI_CLASSES) {
        const count = classCounts.get(category.id) ?? 0; const percentage = count / values.length * 100;
        await pool.query("INSERT INTO ndvi_classes(observation_id,class_name,class_id,color,area_ha,percentage) VALUES($1,$2,$3,$4,$5,$6)", [observationId,category.name,category.id,category.color,Number(target.area_ha)*percentage/100,percentage]);
      }
      observations.push(observationId);
    } catch (error) {
      await pool.query("UPDATE ndvi_observations SET status='FAILED',error_message=$2 WHERE id=$1", [observationId,error instanceof Error?error.message:String(error)]);
      throw error;
    }
    await report(baseProgress + monthProgress, {
      phase: "month-complete",
      message: `${monthName}: NDVI рассчитан`,
      month,
      completedMonths: index + 1,
      totalMonths: MONTHS.length
    });
  }
  const analysis = observations.length
    ? await runPostSpectralAnalysis(pastureId, year, async (progress, message) => report(90 + progress * 0.09, {
        phase: "post-spectral-ml",
        message,
        completedMonths: MONTHS.length,
        totalMonths: MONTHS.length
      }))
    : null;
  return { observationIds: observations, analysis, mode: demoMode ? "demo" : "real" };
}

export function startSatelliteWorker(connection: Redis) {
  return new Worker("satellite-processing", async (job) => {
    const processingJobId = job.data.processingJobId;
    const report = createProgressReporter(job);
    const savedProgress = typeof job.progress === "number" ? job.progress : 0;
    await report(savedProgress, {
      phase: savedProgress > 0 ? "resuming" : "starting",
      message: savedProgress > 0
        ? `Возобновление задачи с ${savedProgress}%`
        : job.name === "satellite-search" ? "Запуск поиска Sentinel-2" : job.name === "spectral-analysis" ? "Запуск постспектрального ML-анализа" : "Запуск обработки NDVI и NDMI",
      completedMonths: Math.min(MONTHS.length, Math.floor(savedProgress / (100 / MONTHS.length))),
      totalMonths: MONTHS.length
    });
    try {
      const result = job.name === "satellite-search"
        ? await satelliteSearch(job, report)
        : job.name === "spectral-analysis"
          ? await runPostSpectralAnalysis(job.data.pastureId, job.data.year, async (progress, message) => report(progress, {
              phase: "post-spectral-ml",
              message,
              completedMonths: 0,
              totalMonths: MONTHS.length
            }))
          : await processNdvi(job, report);
      await setJobState(processingJobId,"completed",{
        progress: 100,
        result: {
          ...result,
          progressDetail: {
            phase: "completed",
            message: job.name === "satellite-search" ? "Поиск Sentinel-2 завершён" : job.name === "spectral-analysis" ? "Постспектральное ML-заключение готово" : "Спектральная обработка и ML-заключение готовы",
            completedMonths: MONTHS.length,
            totalMonths: MONTHS.length
          }
        }
      });
      return result;
    } catch (error) {
      await setJobState(processingJobId,"failed",{error:error instanceof Error?error.message:String(error)}); throw error;
    }
  }, { connection, concurrency: config.WORKER_CONCURRENCY, limiter: { max: 4, duration: 1000 } });
}
