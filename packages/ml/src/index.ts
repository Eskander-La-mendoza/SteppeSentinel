import { RandomForestClassifier } from "ml-random-forest";

export type FeatureName = "B02" | "B03" | "B04" | "B08" | "B11" | "B12" | "NDVI" | "NDMI";
export type PostSpectralFeatureName = FeatureName | "NDWI" | "BSI";
export interface SpectralPixel { B02: number; B03: number; B04: number; B08: number; B11: number; B12: number; valid: boolean }
export interface TrainingSample { features: Record<FeatureName, number>; label: string; spatialGroup: string }
export interface PostSpectralSample {
  month: number;
  features: Record<PostSpectralFeatureName, number>;
}

export const POST_SPECTRAL_FEATURES: PostSpectralFeatureName[] = ["B02", "B03", "B04", "B08", "B11", "B12", "NDVI", "NDMI", "NDWI", "BSI"];

export function calculateNdvi(nir: number, red: number): number | null {
  const denominator = nir + red;
  return denominator === 0 || !Number.isFinite(denominator) ? null : (nir - red) / denominator;
}

export function calculateNdmi(nir: number, swir: number): number | null {
  const denominator = nir + swir;
  return denominator === 0 || !Number.isFinite(denominator) ? null : (nir - swir) / denominator;
}

export function extractFeatures(pixel: SpectralPixel): Record<FeatureName, number> | null {
  if (!pixel.valid) return null;
  const NDVI = calculateNdvi(pixel.B08, pixel.B04);
  const NDMI = calculateNdmi(pixel.B08, pixel.B11);
  if (NDVI === null || NDMI === null) return null;
  return { B02: pixel.B02, B03: pixel.B03, B04: pixel.B04, B08: pixel.B08, B11: pixel.B11, B12: pixel.B12, NDVI, NDMI };
}

function normalizedDifference(left: number, right: number): number {
  const denominator = left + right;
  return denominator === 0 || !Number.isFinite(denominator) ? 0 : (left - right) / denominator;
}

export function extractPostSpectralFeatures(pixel: SpectralPixel): Record<PostSpectralFeatureName, number> | null {
  const base = extractFeatures(pixel);
  if (!base) return null;
  const NDWI = normalizedDifference(pixel.B03, pixel.B08);
  const bsiLeft = pixel.B11 + pixel.B04;
  const bsiRight = pixel.B08 + pixel.B02;
  const BSI = normalizedDifference(bsiLeft, bsiRight);
  return { ...base, NDWI, BSI };
}

export interface SpectralCluster {
  id: string;
  sampleCount: number;
  percentage: number;
  interpretation: "water_or_shadow" | "bare_soil" | "sparse_vegetation" | "active_dry" | "active_moderate" | "active_moist";
  name: string;
  color: string;
  centroid: Record<PostSpectralFeatureName, number>;
  monthlyPercentages: Record<string, number>;
}

const CLUSTER_PRESENTATION: Record<SpectralCluster["interpretation"], { name: string; color: string }> = {
  water_or_shadow: { name: "Вода или глубокая тень", color: "#2563eb" },
  bare_soil: { name: "Оголённая или слабопокрытая почва", color: "#b45309" },
  sparse_vegetation: { name: "Разреженная растительность", color: "#a3a30b" },
  active_dry: { name: "Активная растительность · сухой сигнал", color: "#65a30d" },
  active_moderate: { name: "Активная растительность · умеренная влажность", color: "#16a34a" },
  active_moist: { name: "Активная растительность · влажный сигнал", color: "#047857" }
};

function interpretCentroid(centroid: Record<PostSpectralFeatureName, number>): SpectralCluster["interpretation"] {
  if (centroid.NDWI > 0.1 && centroid.NDVI < 0.12 && centroid.B08 < 0.18) return "water_or_shadow";
  if (centroid.NDVI < 0.25 && centroid.BSI > -0.02) return "bare_soil";
  if (centroid.NDVI < 0.45) return "sparse_vegetation";
  if (centroid.NDMI < 0.05) return "active_dry";
  if (centroid.NDMI < 0.2) return "active_moderate";
  return "active_moist";
}

function squaredDistance(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0);
}

/**
 * Deterministic unsupervised clustering for post-spectral diagnostics.
 * It discovers groups; explicit spectral rules provide human-readable interpretations.
 */
export function clusterSpectralSamples(samples: PostSpectralSample[], requestedClusters = 3) {
  if (samples.length < 2) throw new Error("Для кластеризации нужны как минимум два валидных спектральных пикселя");
  const vectors = samples.map((sample) => POST_SPECTRAL_FEATURES.map((name) => sample.features[name]));
  const means = POST_SPECTRAL_FEATURES.map((_, featureIndex) => vectors.reduce((sum, vector) => sum + vector[featureIndex]!, 0) / vectors.length);
  const deviations = POST_SPECTRAL_FEATURES.map((_, featureIndex) => {
    const variance = vectors.reduce((sum, vector) => sum + (vector[featureIndex]! - means[featureIndex]!) ** 2, 0) / vectors.length;
    return Math.sqrt(variance) || 1;
  });
  const normalized = vectors.map((vector) => vector.map((value, index) => (value - means[index]!) / deviations[index]!));
  const uniqueVectorCount = new Set(normalized.map((vector) => vector.map((value) => value.toFixed(8)).join("|"))).size;
  const clusterCount = Math.max(1, Math.min(requestedClusters, samples.length, uniqueVectorCount));

  const centers: number[][] = [];
  const first = normalized.reduce((best, vector, index) => squaredDistance(vector, new Array(vector.length).fill(0)) < squaredDistance(normalized[best]!, new Array(vector.length).fill(0)) ? index : best, 0);
  centers.push([...normalized[first]!]);
  const chosen = new Set([first]);
  while (centers.length < clusterCount) {
    const next = normalized.reduce((best, vector, index) => {
      if (chosen.has(index)) return best;
      if (chosen.has(best)) return index;
      const distance = Math.min(...centers.map((center) => squaredDistance(vector, center)));
      const bestDistance = Math.min(...centers.map((center) => squaredDistance(normalized[best]!, center)));
      return distance > bestDistance ? index : best;
    }, 0);
    centers.push([...normalized[next]!]);
    chosen.add(next);
  }

  let assignments = new Array<number>(samples.length).fill(-1);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const nextAssignments = normalized.map((vector) => centers.reduce((best, center, index) => squaredDistance(vector, center) < squaredDistance(vector, centers[best]!) ? index : best, 0));
    const unchanged = nextAssignments.every((value, index) => value === assignments[index]);
    assignments = nextAssignments;
    if (unchanged) break;
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      const members = normalized.filter((_, index) => assignments[index] === cluster);
      if (!members.length) continue;
      centers[cluster] = POST_SPECTRAL_FEATURES.map((_, featureIndex) => members.reduce((sum, vector) => sum + vector[featureIndex]!, 0) / members.length);
    }
  }

  const rawClusters = centers.map((_, cluster) => {
    const indexes = assignments.map((value, index) => value === cluster ? index : -1).filter((index) => index >= 0);
    const centroid = Object.fromEntries(POST_SPECTRAL_FEATURES.map((name, featureIndex) => [name, indexes.reduce((sum, index) => sum + vectors[index]![featureIndex]!, 0) / Math.max(1, indexes.length)])) as Record<PostSpectralFeatureName, number>;
    return { cluster, indexes, centroid };
  }).sort((left, right) => left.centroid.NDVI - right.centroid.NDVI);

  const remap = new Map(rawClusters.map((cluster, index) => [cluster.cluster, index]));
  const orderedAssignments = assignments.map((cluster) => remap.get(cluster)!);
  const clusters: SpectralCluster[] = rawClusters.map((cluster, index) => {
    const interpretation = interpretCentroid(cluster.centroid);
    const presentation = CLUSTER_PRESENTATION[interpretation];
    const monthlyPercentages = Object.fromEntries([...new Set(samples.map((sample) => sample.month))].sort((a, b) => a - b).map((month) => {
      const monthIndexes = samples.map((sample, sampleIndex) => sample.month === month ? sampleIndex : -1).filter((sampleIndex) => sampleIndex >= 0);
      const count = monthIndexes.filter((sampleIndex) => orderedAssignments[sampleIndex] === index).length;
      return [String(month), monthIndexes.length ? count / monthIndexes.length * 100 : 0];
    }));
    return {
      id: `cluster_${index + 1}`,
      sampleCount: cluster.indexes.length,
      percentage: cluster.indexes.length / samples.length * 100,
      interpretation,
      name: presentation.name,
      color: presentation.color,
      centroid: cluster.centroid,
      monthlyPercentages
    };
  });
  return { assignments: orderedAssignments, clusters, featureNames: POST_SPECTRAL_FEATURES };
}

export function spatialSplit(samples: TrainingSample[], testFraction = 0.25) {
  const groups = [...new Set(samples.map((sample) => sample.spatialGroup))].sort();
  if (groups.length < 2) throw new Error("Для независимой оценки нужны как минимум две пространственно разделённые области");
  const testCount = Math.max(1, Math.floor(groups.length * testFraction));
  const testGroups = new Set(groups.slice(-testCount));
  return {
    train: samples.filter((sample) => !testGroups.has(sample.spatialGroup)),
    test: samples.filter((sample) => testGroups.has(sample.spatialGroup))
  };
}

function metricSummary(actual: string[], predicted: string[]) {
  const labels = [...new Set([...actual, ...predicted])].sort();
  const matrix = labels.map((label) => labels.map((predictedLabel) => actual.reduce((count, value, index) => count + (value === label && predicted[index] === predictedLabel ? 1 : 0), 0)));
  const perClass = labels.map((label, index) => {
    const tp = matrix[index]?.[index] ?? 0;
    const fp = matrix.reduce((sum, row, rowIndex) => sum + (rowIndex === index ? 0 : row[index] ?? 0), 0);
    const fn = (matrix[index] ?? []).reduce((sum, value, columnIndex) => sum + (columnIndex === index ? 0 : value), 0);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    return { label, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
  });
  return {
    accuracy: actual.length === 0 ? 0 : actual.filter((value, index) => value === predicted[index]).length / actual.length,
    macroF1: perClass.reduce((sum, item) => sum + item.f1, 0) / Math.max(1, perClass.length),
    labels,
    confusionMatrix: matrix,
    perClass
  };
}

export class RandomForestTrainingService {
  train(samples: TrainingSample[], featureNames: FeatureName[], options: { numberOfTrees?: number; seed?: number } = {}) {
    const split = spatialSplit(samples);
    const labels = [...new Set(samples.map((sample) => sample.label))].sort();
    if (labels.length < 2) throw new Error("Для обучения нужны примеры минимум двух классов");
    const labelToIndex = new Map(labels.map((label, index) => [label, index]));
    const vectors = (items: TrainingSample[]) => items.map((sample) => featureNames.map((name) => sample.features[name]));
    const forest = new RandomForestClassifier({ nEstimators: options.numberOfTrees ?? 100, seed: options.seed ?? 42, replacement: true, maxFeatures: Math.max(1, Math.floor(Math.sqrt(featureNames.length))) });
    forest.train(vectors(split.train), split.train.map((sample) => labelToIndex.get(sample.label)!));
    const predicted = forest.predict(vectors(split.test)).map((index) => labels[index] ?? "unknown");
    return {
      serializedModel: forest.toJSON(),
      labels,
      featureNames,
      metrics: { ...metricSummary(split.test.map((sample) => sample.label), predicted), trainSamples: split.train.length, independentTestSamples: split.test.length }
    };
  }

  load(serializedModel: unknown) { return RandomForestClassifier.load(serializedModel as any); }
}
