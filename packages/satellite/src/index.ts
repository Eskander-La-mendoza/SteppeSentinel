import area from "@turf/area";
import { feature, featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import union from "@turf/union";
import { geometryBbox } from "@pasturevision/gis";
import type { PastureGeometry } from "@pasturevision/shared";

export const CDSE_ENDPOINTS = {
  token: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  catalog: "https://sh.dataspace.copernicus.eu/catalog/v1/search",
  process: "https://sh.dataspace.copernicus.eu/process/v1",
  statistics: "https://sh.dataspace.copernicus.eu/statistics/v1"
} as const;

export class CopernicusError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
    this.name = "CopernicusError";
  }
}

interface TokenResponse { access_token: string; expires_in: number }
export interface CatalogFeature {
  id: string;
  type: "Feature";
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox?: [number, number, number, number];
  properties: { datetime: string; "eo:cloud_cover"?: number; [key: string]: unknown };
}

export interface SceneCandidate {
  productId: string;
  acquisitionDate: string;
  sceneCloudPercentage: number | null;
  aoiCloudPercentage: number;
  validCoveragePercentage: number;
  geographicCoveragePercentage: number;
  feature: CatalogFeature;
}

export interface SearchOptions {
  preferredCloudPercentage?: number;
  minimumValidCoverage?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CandidateSearchProgress) => void | Promise<void>;
}

export interface CandidateSearchProgress {
  phase: "catalog" | "quality-batch" | "quality";
  checkedCandidates: number;
  totalCandidates: number;
}

export interface QualityStatistics {
  cloud: number;
  valid: number;
}

interface StatisticsInterval {
  interval?: { from?: string; to?: string };
  outputs?: {
    quality?: {
      bands?: {
        cloud?: { stats?: { mean?: number } };
        valid?: { stats?: { mean?: number } };
      };
    };
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CopernicusClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs = 30_000
  ) {
    if (!clientId || !clientSecret) throw new CopernicusError("Copernicus credentials are not configured", 401);
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    const response = await this.fetchWithRetry(CDSE_ENDPOINTS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    }, false);
    const payload = await response.json() as TokenResponse;
    this.token = { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
    return payload.access_token;
  }

  private async fetchWithRetry(url: string, init: RequestInit, authenticate = true): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const token = authenticate ? await this.getToken() : null;
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: { ...init.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }
        });
        if (response.ok) return response;
        const detail = (await response.text()).slice(0, 500);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 3) throw new CopernicusError(`Copernicus ${response.status}: ${detail}`, response.status, retryable);
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (error instanceof CopernicusError && !error.retryable) throw error;
        if (attempt === 3) break;
        await delay(500 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (lastError instanceof CopernicusError) throw lastError;
    throw new CopernicusError(lastError instanceof Error ? lastError.message : "Copernicus request failed", undefined, true);
  }

  async catalogSearch(geometry: PastureGeometry, from: string, to: string): Promise<CatalogFeature[]> {
    const response = await this.fetchWithRetry(CDSE_ENDPOINTS.catalog, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/geo+json" },
      body: JSON.stringify({
        collections: ["sentinel-2-l2a"],
        intersects: geometry,
        datetime: `${from}/${to}`,
        limit: 100,
        fields: { include: ["id", "geometry", "bbox", "properties.datetime", "properties.eo:cloud_cover"] }
      })
    });
    const payload = await response.json() as { features?: CatalogFeature[] };
    return payload.features ?? [];
  }

  async statisticsRange(geometry: PastureGeometry, from: string, to: string): Promise<Map<string, QualityStatistics>> {
    const response = await this.fetchWithRetry(CDSE_ENDPOINTS.statistics, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildStatisticsRequest(geometry, from, to))
    });
    return parseQualityStatistics(await response.json());
  }

  async statistics(geometry: PastureGeometry, date: string): Promise<QualityStatistics> {
    const from = new Date(date);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 1);
    const values = await this.statisticsRange(geometry, from.toISOString(), to.toISOString());
    return values.get(from.toISOString().slice(0, 10)) ?? { cloud: 100, valid: 0 };
  }

  async processNdvi(geometry: PastureGeometry, date: string): Promise<ArrayBuffer> {
    const response = await this.fetchWithRetry(CDSE_ENDPOINTS.process, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "image/tiff" },
      body: JSON.stringify(buildNdviProcessRequest(geometry, date))
    });
    return response.arrayBuffer();
  }

  async findMonthlyCandidates(geometry: PastureGeometry, year: number, month: number, options: SearchOptions = {}): Promise<SceneCandidate[]> {
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();
    await options.onProgress?.({ phase: "catalog", checkedCandidates: 0, totalCandidates: 0 });
    const features = await this.catalogSearch(geometry, from, to);
    const groupedByDate = Object.values(features.reduce<Record<string, CatalogFeature[]>>((groups, item) => {
      const day = item.properties.datetime.slice(0, 10);
      (groups[day] ??= []).push(item);
      return groups;
    }, {}));
    const mosaics = groupedByDate.map((items) => {
      const merged = items.length === 1 ? feature(items[0]!.geometry) : union(featureCollection(items.map((item) => feature(item.geometry))));
      const first = items[0]!;
      return {
        ...first,
        id: items.map((item) => item.id).join(","),
        geometry: (merged?.geometry ?? first.geometry) as GeoJSON.Polygon | GeoJSON.MultiPolygon,
        properties: { ...first.properties, mosaicProductIds: items.map((item) => item.id) }
      } satisfies CatalogFeature;
    });
    const withCoverage = mosaics
      .map((item) => ({ item, coverage: geographicCoverage(geometry, item.geometry) }))
      .filter(({ coverage }) => coverage >= 99.5);
    const result: SceneCandidate[] = [];
    await options.onProgress?.({ phase: "quality-batch", checkedCandidates: 0, totalCandidates: withCoverage.length });
    const qualityByDate = withCoverage.length > 0
      ? await this.statisticsRange(geometry, from, to)
      : new Map<string, QualityStatistics>();
    for (const { item, coverage } of withCoverage) {
      const quality = qualityByDate.get(item.properties.datetime.slice(0, 10)) ?? { cloud: 100, valid: 0 };
      result.push({
        productId: item.id,
        acquisitionDate: item.properties.datetime,
        sceneCloudPercentage: item.properties["eo:cloud_cover"] ?? null,
        aoiCloudPercentage: quality.cloud,
        validCoveragePercentage: quality.valid,
        geographicCoveragePercentage: coverage,
        feature: item
      });
      await options.onProgress?.({ phase: "quality", checkedCandidates: result.length, totalCandidates: withCoverage.length });
    }
    return result.sort(candidateComparator(year, month));
  }
}

export function parseQualityStatistics(payload: unknown): Map<string, QualityStatistics> {
  const result = new Map<string, QualityStatistics>();
  const intervals = (payload as { data?: StatisticsInterval[] } | null)?.data;
  if (!Array.isArray(intervals)) return result;

  for (const item of intervals) {
    const date = item.interval?.from?.slice(0, 10);
    const cloudMean = item.outputs?.quality?.bands?.cloud?.stats?.mean;
    const validMean = item.outputs?.quality?.bands?.valid?.stats?.mean;
    if (!date || cloudMean == null || validMean == null) continue;
    const cloud = Number(cloudMean) * 100;
    const valid = Number(validMean) * 100;
    if (!Number.isFinite(cloud) || !Number.isFinite(valid)) continue;
    result.set(date, {
      cloud: Math.max(0, Math.min(100, cloud)),
      valid: Math.max(0, Math.min(100, valid))
    });
  }
  return result;
}

export function geographicCoverage(aoi: PastureGeometry, footprint: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  const aoiFeature = feature(aoi);
  const overlap = intersect(featureCollection([aoiFeature as any, feature(footprint) as any]));
  return overlap ? Math.min(100, area(overlap) / area(aoiFeature) * 100) : 0;
}

export function candidateComparator(year: number, month: number) {
  const middle = Date.UTC(year, month - 1, 15);
  return (a: SceneCandidate, b: SceneCandidate) =>
    b.validCoveragePercentage - a.validCoveragePercentage ||
    a.aoiCloudPercentage - b.aoiCloudPercentage ||
    Math.abs(new Date(a.acquisitionDate).getTime() - middle) - Math.abs(new Date(b.acquisitionDate).getTime() - middle);
}

export function chooseBestCandidate(candidates: SceneCandidate[], minimumValid = 90, maximumCloud = 10): SceneCandidate | null {
  return chooseBestCandidates(candidates, minimumValid, maximumCloud, 1)[0] ?? null;
}

export function chooseBestCandidates(
  candidates: SceneCandidate[],
  minimumValid = 90,
  maximumCloud = 10,
  limit = 5
): SceneCandidate[] {
  return candidates.filter((candidate) =>
    candidate.geographicCoveragePercentage >= 99.5 &&
    candidate.validCoveragePercentage >= minimumValid &&
    candidate.aoiCloudPercentage < maximumCloud
  ).slice(0, Math.max(1, limit));
}

const QUALITY_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [
      { bands: ["SCL", "dataMask"] }
    ],
    output: [
      { id: "quality", bands: ["cloud", "valid"], sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  const cloud = [3, 8, 9, 10, 11].includes(s.SCL) ? 1 : 0;
  const validLand = [4, 5].includes(s.SCL) && s.dataMask !== 0;
  return { quality: [cloud, validLand ? 1 : 0], dataMask: [s.dataMask] };
}`;

const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [
      { bands: ["B02", "B03", "B04", "B08", "B11", "B12", "SCL", "dataMask"] }
    ],
    output: { bands: 10, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(s) {
  const validLand = [4, 5].includes(s.SCL) && s.dataMask !== 0;
  const vegetation = s.SCL === 4 && s.dataMask !== 0;
  const ndviDenominator = s.B08 + s.B04;
  const ndmiDenominator = s.B08 + s.B11;
  const ndvi = !validLand || ndviDenominator === 0 ? -9999 : (s.B08 - s.B04) / ndviDenominator;
  const ndmi = !validLand || ndmiDenominator === 0 ? -9999 : (s.B08 - s.B11) / ndmiDenominator;
  return [s.B02, s.B03, s.B04, s.B08, s.B11, s.B12, ndvi, ndmi, validLand ? 1 : 0, vegetation ? 1 : 0];
}`;

export function buildStatisticsRequest(geometry: PastureGeometry, from: string, to: string) {
  const { resx, resy } = statisticsResolution(geometry);
  return {
    input: { bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }, data: [{ type: "sentinel-2-l2a", dataFilter: { mosaickingOrder: "leastCC" } }] },
    aggregation: { timeRange: { from, to }, aggregationInterval: { of: "P1D" }, evalscript: QUALITY_EVALSCRIPT, resx, resy },
    calculations: { quality: {} }
  };
}

/**
 * Statistical API interprets resx/resy in the units of the bounds CRS.
 * Our bounds use EPSG:4326, therefore a metre target must be converted to degrees.
 * SCL is a 20 m band, so 20 m is the useful default for scene-quality statistics.
 */
export function statisticsResolution(
  geometry: PastureGeometry,
  targetResolutionMeters = 20,
  maxDimension = 2500,
  safeMaximumPixelMeters = 1000
) {
  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = geometryBbox(geometry);
  const centerLatitudeRadians = ((minLatitude + maxLatitude) / 2) * Math.PI / 180;
  const longitudeMetersPerDegree = 111_320 * Math.max(0.01, Math.abs(Math.cos(centerLatitudeRadians)));
  const latitudeMetersPerDegree = 110_574;
  const widthMeters = Math.abs(maxLongitude - minLongitude) * longitudeMetersPerDegree;
  const heightMeters = Math.abs(maxLatitude - minLatitude) * latitudeMetersPerDegree;
  const adaptiveResolutionMeters = Math.max(
    targetResolutionMeters,
    widthMeters / maxDimension,
    heightMeters / maxDimension
  );
  const resolutionMeters = Math.min(safeMaximumPixelMeters, adaptiveResolutionMeters);
  return {
    resx: resolutionMeters / longitudeMetersPerDegree,
    resy: resolutionMeters / latitudeMetersPerDegree,
    resolutionMeters,
    estimatedWidth: Math.max(1, Math.ceil(widthMeters / resolutionMeters)),
    estimatedHeight: Math.max(1, Math.ceil(heightMeters / resolutionMeters))
  };
}

export function processRasterSize(geometry: PastureGeometry, resolutionMeters = 10, maxDimension = 2500) {
  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = geometryBbox(geometry);
  const centerLatitudeRadians = ((minLatitude + maxLatitude) / 2) * Math.PI / 180;
  const widthMeters = Math.abs(maxLongitude - minLongitude) * 111_320 * Math.max(0.01, Math.cos(centerLatitudeRadians));
  const heightMeters = Math.abs(maxLatitude - minLatitude) * 110_574;
  let width = Math.max(1, Math.ceil(widthMeters / resolutionMeters));
  let height = Math.max(1, Math.ceil(heightMeters / resolutionMeters));
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  return { width, height };
}

export function buildNdviProcessRequest(geometry: PastureGeometry, date: string) {
  const from = new Date(date);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  const size = processRasterSize(geometry);
  return {
    input: { bounds: { bbox: geometryBbox(geometry), geometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } }, data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: from.toISOString(), to: to.toISOString() }, mosaickingOrder: "leastCC" } }] },
    output: { ...size, responses: [{ identifier: "default", format: { type: "image/tiff" } }] },
    evalscript: NDVI_EVALSCRIPT
  };
}
