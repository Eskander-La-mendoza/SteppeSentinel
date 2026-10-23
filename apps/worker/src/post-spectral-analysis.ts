import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature, point } from "@turf/helpers";
import { geometryBbox } from "@pasturevision/gis";
import {
  POST_SPECTRAL_FEATURES,
  clusterSpectralSamples,
  extractPostSpectralFeatures,
  type PostSpectralSample,
  type SpectralPixel
} from "@pasturevision/ml";
import type { PastureGeometry, PostSpectralAnalysisResult } from "@pasturevision/shared";
import { pool } from "./db.js";
import { syntheticSpectral } from "./demo.js";
import { readSpectralGeoTiff } from "./gdal.js";

type AnalysisProgress = (progress: number, message: string) => Promise<void>;

interface ObservationRow {
  id: string;
  month: number;
  acquisition_date: string | Date;
  ndvi_mean: number | string;
  ndvi_std: number | string;
  ndmi_mean: number | string;
  ndmi_std: number | string;
  cloud_percentage: number | string;
  valid_coverage_percentage: number | string;
  is_synthetic: boolean;
  raster_data: Buffer | null;
}

const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const fixed = (value: number, digits = 3) => Number(value.toFixed(digits));
const percent = (count: number, total: number) => total ? count / total * 100 : 0;

function demoSamples(geometry: PastureGeometry, month: number): PostSpectralSample[] {
  const bbox = geometryBbox(geometry);
  const samples: PostSpectralSample[] = [];
  const size = 40;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const longitude = bbox[0] + (x + 0.5) / size * (bbox[2] - bbox[0]);
      const latitude = bbox[3] - (y + 0.5) / size * (bbox[3] - bbox[1]);
      if (!booleanPointInPolygon(point([longitude, latitude]), feature(geometry))) continue;
      const features = extractPostSpectralFeatures(syntheticSpectral(longitude, latitude, month, y * size + x));
      if (features) samples.push({ month, features });
    }
  }
  return samples;
}

async function realSamples(row: ObservationRow): Promise<PostSpectralSample[]> {
  if (!row.raster_data) throw new Error(`Для наблюдения ${row.id} отсутствует спектральный GeoTIFF`);
  const raster = await readSpectralGeoTiff(row.raster_data, 256);
  const samples: PostSpectralSample[] = [];
  const maximumPerScene = 6_000;
  const stride = Math.max(1, Math.floor(raster.coordinates.length / maximumPerScene));
  for (let index = 0; index < raster.coordinates.length; index += stride) {
    if ((raster.bands[8]?.[index] ?? 0) < 0.5) continue;
    const pixel: SpectralPixel = {
      B02: raster.bands[0]?.[index] ?? Number.NaN,
      B03: raster.bands[1]?.[index] ?? Number.NaN,
      B04: raster.bands[2]?.[index] ?? Number.NaN,
      B08: raster.bands[3]?.[index] ?? Number.NaN,
      B11: raster.bands[4]?.[index] ?? Number.NaN,
      B12: raster.bands[5]?.[index] ?? Number.NaN,
      valid: true
    };
    if ([pixel.B02, pixel.B03, pixel.B04, pixel.B08, pixel.B11, pixel.B12].some((value) => !Number.isFinite(value) || value <= -9999)) continue;
    const features = extractPostSpectralFeatures(pixel);
    if (features) samples.push({ month: row.month, features });
  }
  return samples;
}

function makeConclusion(
  seasonal: PostSpectralAnalysisResult["seasonal"],
  samples: PostSpectralSample[],
  clusters: PostSpectralAnalysisResult["clusters"],
  confidence: number,
  areaHa: number
) {
  const first = seasonal[0]!;
  const last = seasonal.at(-1)!;
  const vegetationShare = percent(samples.filter((sample) => sample.features.NDVI >= 0.3).length, samples.length);
  const denseVegetationShare = percent(samples.filter((sample) => sample.features.NDVI >= 0.6).length, samples.length);
  const drySignalShare = percent(samples.filter((sample) => sample.features.NDMI < 0).length, samples.length);
  const bareSoilSignalShare = percent(samples.filter((sample) => sample.features.NDVI < 0.25 && sample.features.BSI > -0.02).length, samples.length);
  const ndviSeasonChange = last.ndviMean - first.ndviMean;
  const ndmiSeasonChange = last.ndmiMean - first.ndmiMean;
  const averageNdvi = mean(seasonal.map((item) => item.ndviMean));
  const averageNdmi = mean(seasonal.map((item) => item.ndmiMean));
  const seasonalVariation = Math.sqrt(mean(seasonal.map((item) => (item.ndviMean - averageNdvi) ** 2)));
  const spectralConditionScore = Math.round(100 * (
    0.45 * clamp((averageNdvi - 0.2) / 0.55) +
    0.25 * clamp((averageNdmi + 0.1) / 0.4) +
    0.2 * clamp(vegetationShare / 100) +
    0.1 * (1 - clamp(seasonalVariation / 0.25))
  ));

  let code = "moderate_cover";
  let title = "Умеренная активность растительного покрова";
  let summary = "Спектральные признаки соответствуют растительному покрову средней плотности. Рекомендуется сравнивать результат с соседними сезонами.";
  if (seasonal.length < 2 || samples.length < 30) {
    code = "insufficient_data";
    title = "Недостаточно данных для устойчивого сезонного вывода";
    summary = "Расчёт выполнен, но временной или пространственной выборки недостаточно для устойчивого заключения.";
  } else if (averageNdvi >= 0.55 && vegetationShare >= 70 && ndmiSeasonChange <= -0.05) {
    code = "active_with_drying";
    title = "Активная растительность с сезонным снижением влажности";
    summary = "Растительный покров сохраняет высокую спектральную активность, однако NDMI к концу периода снизился. На карте следует проверить локальные участки с отрицательным NDMI.";
  } else if (averageNdvi >= 0.55 && vegetationShare >= 70) {
    code = "active_stable";
    title = "Высокая активность растительного покрова";
    summary = "Большинство спектральных пикселей соответствует активной растительности; выраженного сезонного ухудшения влажности не обнаружено.";
  } else if (vegetationShare < 45 || bareSoilSignalShare > 35) {
    code = "low_or_sparse_cover";
    title = "Разреженный или неоднородный растительный покров";
    summary = "Значительная часть спектральных пикселей имеет слабый растительный либо почвенный сигнал. Необходима визуальная и полевая проверка.";
  }

  const limitations = [
    "Заключение описывает спектральное состояние поверхности, а не кормовую ценность и не допустимую нагрузку скота.",
    "Кластеры найдены без учителя; их смысл присвоен прозрачными правилами NDVI, NDMI, NDWI и BSI, а не пользовательской разметкой."
  ];
  if (areaHa < 1 || Math.min(...seasonal.map((item) => item.validPixels)) < 50) limitations.push("Полигон мал относительно пикселя Sentinel-2; пограничные и смешанные пиксели снижают пространственную точность.");

  return {
    indicators: {
      spectralConditionScore,
      vegetationShare: fixed(vegetationShare, 1),
      denseVegetationShare: fixed(denseVegetationShare, 1),
      drySignalShare: fixed(drySignalShare, 1),
      bareSoilSignalShare: fixed(bareSoilSignalShare, 1),
      ndviSeasonChange: fixed(ndviSeasonChange),
      ndmiSeasonChange: fixed(ndmiSeasonChange)
    },
    conclusion: {
      code,
      title,
      summary,
      evidence: [
        `Средний NDVI за период: ${fixed(averageNdvi)}; изменение от первого к последнему снимку: ${fixed(ndviSeasonChange)}.`,
        `Средний NDMI за период: ${fixed(averageNdmi)}; изменение от первого к последнему снимку: ${fixed(ndmiSeasonChange)}.`,
        `Растительный сигнал NDVI ≥ 0,30 занимает ${fixed(vegetationShare, 1)}% проанализированных пикселей.`,
        `Неконтролируемая ML-кластеризация выделила ${clusters.length} спектральные группы без ручных меток.`
      ],
      limitations
    }
  };
}

export async function runPostSpectralAnalysis(pastureId: string, year: number, progress: AnalysisProgress) {
  const targetResult = await pool.query("SELECT area_ha,ST_AsGeoJSON(geometry)::json AS geometry FROM pastures WHERE id=$1", [pastureId]);
  const target = targetResult.rows[0] as { area_ha: number | string; geometry: PastureGeometry } | undefined;
  if (!target) throw new Error("Пастбище не найдено");
  const observationsResult = await pool.query(
    `SELECT DISTINCT ON (o.month) o.id,o.month,o.acquisition_date,o.ndvi_mean,o.ndvi_std,o.ndmi_mean,o.ndmi_std,
       o.cloud_percentage,o.valid_coverage_percentage,o.is_synthetic,r.raster_data
     FROM ndvi_observations o
     LEFT JOIN raster_assets r ON r.observation_id=o.id AND r.asset_type='spectral_geotiff'
     WHERE o.pasture_id=$1 AND o.year=$2 AND o.status='READY'
     ORDER BY o.month,o.processing_version DESC`,
    [pastureId, year]
  );
  const observations = observationsResult.rows as ObservationRow[];
  if (!observations.length) throw new Error("Сначала выполните спектральную обработку хотя бы одного снимка");

  const analysisResult = await pool.query(
    `INSERT INTO post_spectral_analyses(pasture_id,year,status,algorithm,feature_schema,observation_ids,error_message,result)
     VALUES($1,$2,'PROCESSING','K-means без учителя + спектральные правила v1',$3,$4,NULL,NULL)
     ON CONFLICT(pasture_id,year) DO UPDATE SET status='PROCESSING',algorithm=EXCLUDED.algorithm,feature_schema=EXCLUDED.feature_schema,
       observation_ids=EXCLUDED.observation_ids,error_message=NULL,result=NULL
     RETURNING id`,
    [pastureId, year, JSON.stringify(POST_SPECTRAL_FEATURES), observations.map((row) => row.id)]
  );
  const analysisId = analysisResult.rows[0].id as string;
  try {
    await progress(5, "Чтение спектральных каналов B02–B12");
    const samples: PostSpectralSample[] = [];
    const seasonal: PostSpectralAnalysisResult["seasonal"] = [];
    for (let index = 0; index < observations.length; index += 1) {
      const row = observations[index]!;
      const monthSamples = row.is_synthetic ? demoSamples(target.geometry, row.month) : await realSamples(row);
      samples.push(...monthSamples);
      seasonal.push({
        observationId: row.id,
        month: row.month,
        acquisitionDate: new Date(row.acquisition_date).toISOString(),
        ndviMean: Number(row.ndvi_mean),
        ndmiMean: Number(row.ndmi_mean),
        ndviStd: Number(row.ndvi_std),
        ndmiStd: Number(row.ndmi_std),
        validPixels: monthSamples.length
      });
      await progress(10 + (index + 1) / observations.length * 45, `Извлечены признаки за месяц ${row.month}: ${monthSamples.length} пикселей`);
    }
    if (samples.length < 2) throw new Error("Недостаточно валидных спектральных пикселей для ML-анализа");

    await progress(62, "Стандартизация признаков и неконтролируемая ML-кластеризация");
    const desiredClusters = samples.length >= 1_000 ? 4 : samples.length >= 60 ? 3 : 2;
    const clustered = clusterSpectralSamples(samples, desiredClusters);
    await progress(78, "Интерпретация кластеров по NDVI, NDMI, NDWI и BSI");

    const minimumPixels = Math.min(...seasonal.map((item) => item.validPixels));
    const validCoverageMean = mean(observations.map((row) => Number(row.valid_coverage_percentage)));
    const cloudMean = mean(observations.map((row) => Number(row.cloud_percentage)));
    const spatialSupport = clamp(minimumPixels / 100);
    let confidence = Math.round(100 * (0.4 * clamp(observations.length / 5) + 0.35 * clamp(validCoverageMean / 100) + 0.25 * spatialSupport));
    if (Number(target.area_ha) < 1 || minimumPixels < 50) confidence = Math.min(confidence, 74);
    const confidenceLevel = confidence >= 80 ? "high" : confidence >= 55 ? "medium" : "low";
    const reflectanceMeans = Object.fromEntries(["B02", "B03", "B04", "B08", "B11", "B12"].map((name) => [name, fixed(mean(samples.map((sample) => sample.features[name as keyof typeof sample.features])))]));
    const interpreted = makeConclusion(seasonal, samples, clustered.clusters, confidence, Number(target.area_ha));
    const result: PostSpectralAnalysisResult = {
      version: 1,
      generatedAt: new Date().toISOString(),
      method: {
        name: "K-means без учителя + спектральные правила v1",
        supervised: false,
        description: "ML группирует похожие спектральные пиксели без ручной разметки; физически интерпретируемые индексы формируют заключение."
      },
      quality: {
        monthsUsed: observations.length,
        expectedMonths: 5,
        validCoverageMean: fixed(validCoverageMean, 1),
        cloudMean: fixed(cloudMean, 1),
        minimumPixelsPerScene: minimumPixels,
        confidence,
        confidenceLevel
      },
      seasonal,
      indicators: interpreted.indicators,
      reflectanceMeans,
      clusters: clustered.clusters,
      conclusion: interpreted.conclusion
    };
    await progress(92, "Формирование объяснимого спектрального заключения");
    await pool.query(
      `UPDATE post_spectral_analyses SET status='READY',sample_count=$2,cluster_count=$3,confidence=$4,result=$5,error_message=NULL WHERE id=$1`,
      [analysisId, samples.length, clustered.clusters.length, confidence, JSON.stringify(result)]
    );
    await progress(100, "Постспектральное ML-заключение готово");
    return { analysisId, sampleCount: samples.length, clusterCount: clustered.clusters.length, confidence, conclusion: result.conclusion.title };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query("UPDATE post_spectral_analyses SET status='FAILED',error_message=$2 WHERE id=$1", [analysisId, message]);
    throw error;
  }
}
