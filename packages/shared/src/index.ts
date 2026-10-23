import { z } from "zod";

export const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const linearRingSchema = z.array(positionSchema).min(4).refine(
  (ring) => ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1],
  "A linear ring must be closed"
);

export const polygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(linearRingSchema).min(1)
});

export const multiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(linearRingSchema).min(1)).min(1)
});

export const geometrySchema = z.union([polygonSchema, multiPolygonSchema]);
export type PastureGeometry = z.infer<typeof geometrySchema>;

export const createPastureSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(""),
  geometry: geometrySchema
});
export const updatePastureSchema = createPastureSchema.partial();

export const monitoringYearSchema = z.object({
  year: z.number().int().min(2017).max(new Date().getUTCFullYear()),
  preferredCloudPercentage: z.number().min(0).max(100).default(10),
  minimumValidCoverage: z.number().min(0).max(100).default(90)
});

export const annotationSchema = z.object({
  pastureId: z.string().uuid(),
  observationId: z.string().uuid(),
  classId: z.string().min(1).max(64),
  geometry: geometrySchema
});

export const trainingSchema = z.object({
  datasetId: z.string().uuid(),
  name: z.string().min(2).max(120),
  numberOfTrees: z.number().int().min(10).max(1000).default(100),
  maxDepth: z.number().int().min(2).max(64).optional(),
  seed: z.number().int().default(42),
  featureNames: z.array(z.enum(["B02", "B03", "B04", "B08", "B11", "B12", "NDVI", "NDMI"])).min(2)
});

export const predictionSchema = z.object({
  observationId: z.string().uuid(),
  modelId: z.string().uuid()
});

export const NDVI_CLASSES = [
  { id: 1, name: "Очень низкий", min: -1, max: 0.15, color: "#dc3c3c" },
  { id: 2, name: "Низкий", min: 0.15, max: 0.30, color: "#ec8b2c" },
  { id: 3, name: "Средний", min: 0.30, max: 0.45, color: "#e4c844" },
  { id: 4, name: "Хороший", min: 0.45, max: 0.60, color: "#7fbf58" },
  { id: 5, name: "Очень хороший", min: 0.60, max: 1.01, color: "#247a4b" }
] as const;

export const ML_CLASSES = [
  { id: "dense_vegetation", name: "Плотная растительность", color: "#14532d" },
  { id: "sparse_vegetation", name: "Разреженная растительность", color: "#65a30d" },
  { id: "bare_soil", name: "Оголённая почва", color: "#b45309" },
  { id: "water", name: "Вода", color: "#2563eb" },
  { id: "other", name: "Другой тип поверхности", color: "#64748b" }
] as const;

export type JobStatus = "queued" | "active" | "completed" | "failed";
export type ObservationStatus = "PROCESSING" | "READY" | "NO_SUITABLE_IMAGE" | "FAILED";

export interface Pasture {
  id: string;
  name: string;
  description: string;
  geometry: PastureGeometry;
  areaHa: number;
  createdAt: string;
  updatedAt: string;
}

export interface NdviObservation {
  id: string;
  pastureId: string;
  year: number;
  month: number;
  acquisitionDate: string | null;
  ndviMean: number | null;
  ndviMedian: number | null;
  ndviP10: number | null;
  ndviP90: number | null;
  ndviMin: number | null;
  ndviMax: number | null;
  ndviStd: number | null;
  ndmiMean: number | null;
  ndmiMedian: number | null;
  ndmiMin: number | null;
  ndmiMax: number | null;
  ndmiStd: number | null;
  vegetationNdviMean: number | null;
  vegetationNdviMedian: number | null;
  vegetationNdviP10: number | null;
  vegetationNdviP90: number | null;
  vegetationCoveragePercentage: number | null;
  compositeSceneCount: number;
  compositeMethod: string;
  sourceSceneIds: string[];
  sourceAcquisitionDates: string[];
  cloudPercentage: number | null;
  validCoveragePercentage: number | null;
  status: ObservationStatus;
  processingVersion: number;
  isSynthetic: boolean;
  bbox: [number, number, number, number] | null;
  visualizationUrl?: string;
}

export interface PostSpectralCluster {
  id: string;
  name: string;
  color: string;
  interpretation: string;
  sampleCount: number;
  percentage: number;
  centroid: Record<string, number>;
  monthlyPercentages: Record<string, number>;
}

export interface PostSpectralAnalysisResult {
  version: number;
  generatedAt: string;
  method: {
    name: string;
    supervised: false;
    description: string;
  };
  quality: {
    monthsUsed: number;
    expectedMonths: number;
    validCoverageMean: number;
    cloudMean: number;
    minimumPixelsPerScene: number;
    confidence: number;
    confidenceLevel: "low" | "medium" | "high";
  };
  seasonal: Array<{
    observationId: string;
    month: number;
    acquisitionDate: string;
    ndviMean: number;
    ndmiMean: number;
    ndviStd: number;
    ndmiStd: number;
    validPixels: number;
  }>;
  indicators: {
    spectralConditionScore: number;
    vegetationShare: number;
    denseVegetationShare: number;
    drySignalShare: number;
    bareSoilSignalShare: number;
    ndviSeasonChange: number;
    ndmiSeasonChange: number;
  };
  reflectanceMeans: Record<string, number>;
  clusters: PostSpectralCluster[];
  conclusion: {
    code: string;
    title: string;
    summary: string;
    evidence: string[];
    limitations: string[];
  };
}

export interface PostSpectralAnalysis {
  id: string;
  pastureId: string;
  year: number;
  status: "PROCESSING" | "READY" | "FAILED";
  algorithm: string;
  featureSchema: string[];
  observationIds: string[];
  sampleCount: number;
  clusterCount: number;
  confidence: number | null;
  result: PostSpectralAnalysisResult | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
