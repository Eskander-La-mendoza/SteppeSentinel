import { describe, expect, it, vi } from "vitest";
import {
  buildNdviProcessRequest,
  buildStatisticsRequest,
  chooseBestCandidates,
  CopernicusClient,
  parseQualityStatistics,
  processRasterSize,
  statisticsResolution,
  type CatalogFeature
} from "../packages/satellite/src/index.js";
import type { PastureGeometry } from "../packages/shared/src/index.js";

const geometry: PastureGeometry = {
  type: "MultiPolygon",
  coordinates: [[[[69, 42], [69.01, 42], [69.01, 42.01], [69, 42.01], [69, 42]]]]
};

function loadEvalscript(evalscript: string) {
  return new Function(`${evalscript}\nreturn { setup, evaluatePixel };`)() as {
    setup: () => { input: Array<{ bands: string[] }> };
    evaluatePixel: (sample: Record<string, number>) => Record<string, number[]>;
  };
}

describe("Copernicus Sentinel-2 requests", () => {
  it("declares one evalscript input for the one Statistical API dataset", () => {
    const request = buildStatisticsRequest(geometry, "2025-05-01T00:00:00.000Z", "2025-05-02T00:00:00.000Z");
    const script = loadEvalscript(request.aggregation.evalscript);

    expect(request.input.data).toHaveLength(1);
    expect(request.input.data[0]?.type).toBe("sentinel-2-l2a");
    expect(script.setup().input).toHaveLength(request.input.data.length);
    expect(script.setup().input[0]?.bands).toEqual(["SCL", "dataMask"]);
    expect(request.calculations).toEqual({ quality: {} });
    expect(request.aggregation.resx).toBeLessThan(0.001);
    expect(request.aggregation.resy).toBeLessThan(0.001);
  });

  it("converts the Statistical API resolution from metres to EPSG:4326 degrees", () => {
    const largePasture: PastureGeometry = {
      type: "MultiPolygon",
      coordinates: [[[[69.497085, 55.2184684], [69.5519242, 55.2184684], [69.5519242, 55.2255289], [69.497085, 55.2255289], [69.497085, 55.2184684]]]]
    };
    const resolution = statisticsResolution(largePasture);
    expect(resolution.resolutionMeters).toBe(20);
    expect(resolution.estimatedWidth).toBeGreaterThan(170);
    expect(resolution.estimatedWidth).toBeLessThan(180);
    expect(resolution.estimatedHeight).toBeGreaterThan(35);
    expect(resolution.estimatedHeight).toBeLessThan(45);
    expect(resolution.resolutionMeters).toBeLessThan(1500);
    const request = buildStatisticsRequest(largePasture, "2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    expect(request.aggregation.resx).toBeCloseTo(resolution.resx, 12);
    expect(request.aggregation.resy).toBeCloseTo(resolution.resy, 12);
  });

  it("keeps cloudy pixels in the statistics mask so cloud and valid percentages are measurable", () => {
    const request = buildStatisticsRequest(geometry, "2025-05-01T00:00:00.000Z", "2025-05-02T00:00:00.000Z");
    const { evaluatePixel } = loadEvalscript(request.aggregation.evalscript);

    expect(evaluatePixel({ SCL: 9, dataMask: 1 })).toMatchObject({
      quality: [1, 0],
      dataMask: [1]
    });
  });

  it("parses daily quality intervals from one monthly Statistical API response", () => {
    const quality = parseQualityStatistics({
      data: [
        {
          interval: { from: "2025-05-14T00:00:00Z", to: "2025-05-15T00:00:00Z" },
          outputs: {
            quality: {
              bands: {
                cloud: { stats: { mean: 0.075 } },
                valid: { stats: { mean: 0.925 } }
              }
            }
          }
        },
        { interval: { from: "2025-05-15T00:00:00Z", to: "2025-05-16T00:00:00Z" } }
      ]
    });

    expect(quality.get("2025-05-14")).toEqual({ cloud: 7.5, valid: 92.5 });
    expect(quality.has("2025-05-15")).toBe(false);
  });

  it("uses one monthly statistics request for all candidate dates", async () => {
    const client = new CopernicusClient("client-id", "client-secret");
    const catalog: CatalogFeature[] = ["04", "14"].map((day) => ({
      id: `scene-${day}`,
      type: "Feature",
      geometry,
      properties: { datetime: `2025-05-${day}T10:00:00.000Z`, "eo:cloud_cover": 12 }
    }));
    vi.spyOn(client, "catalogSearch").mockResolvedValue(catalog);
    const statistics = vi.spyOn(client, "statisticsRange").mockResolvedValue(new Map([
      ["2025-05-04", { cloud: 8, valid: 92 }],
      ["2025-05-14", { cloud: 3, valid: 97 }]
    ]));

    const candidates = await client.findMonthlyCandidates(geometry, 2025, 5);

    expect(statistics).toHaveBeenCalledTimes(1);
    expect(statistics).toHaveBeenCalledWith(geometry, "2025-05-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.acquisitionDate).toBe("2025-05-14T10:00:00.000Z");
  });

  it("declares one evalscript input for the one Process API dataset", () => {
    const request = buildNdviProcessRequest(geometry, "2025-05-14T10:00:00.000Z");
    const script = loadEvalscript(request.evalscript);

    expect(request.input.data).toHaveLength(1);
    expect(request.input.data[0]?.type).toBe("sentinel-2-l2a");
    expect(script.setup().input).toHaveLength(request.input.data.length);
    expect(script.setup().input[0]?.bands).toEqual(["B02", "B03", "B04", "B08", "B11", "B12", "SCL", "dataMask"]);
    expect(request.output).toMatchObject(processRasterSize(geometry));
    expect(request.output.width).toBeGreaterThan(1);
    expect(request.output.height).toBeGreaterThan(1);
  });

  it("marks NDVI and NDMI invalid when SCL rejects the pixel", () => {
    const request = buildNdviProcessRequest(geometry, "2025-05-14T10:00:00.000Z");
    const { evaluatePixel } = loadEvalscript(request.evalscript);

    expect(evaluatePixel({ B02: .1, B03: .1, B04: .1, B08: .7, B11: .3, B12: .2, SCL: 9, dataMask: 1 }))
      .toEqual([.1, .1, .1, .7, .3, .2, -9999, -9999, 0, 0]);
    expect(evaluatePixel({ B02: .1, B03: .1, B04: .1, B08: .7, B11: .3, B12: .2, SCL: 6, dataMask: 1 }))
      .toEqual([.1, .1, .1, .7, .3, .2, -9999, -9999, 0, 0]);
    expect(evaluatePixel({ B02: .1, B03: .1, B04: .1, B08: .7, B11: .3, B12: .2, SCL: 4, dataMask: 1 }))
      .toEqual([.1, .1, .1, .7, .3, .2, .75, (.7 - .3) / (.7 + .3), 1, 1]);
    expect(evaluatePixel({ B02: .1, B03: .1, B04: .1, B08: .7, B11: .3, B12: .2, SCL: 5, dataMask: 1 }))
      .toEqual([.1, .1, .1, .7, .3, .2, .75, (.7 - .3) / (.7 + .3), 1, 0]);
  });

  it("selects several clean dates for a monthly median composite", () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      productId: `scene-${index}`,
      acquisitionDate: `2025-05-${String(index + 10).padStart(2, "0")}T10:00:00.000Z`,
      sceneCloudPercentage: index,
      aoiCloudPercentage: index === 6 ? 12 : index,
      validCoveragePercentage: index === 5 ? 85 : 100,
      geographicCoveragePercentage: 100,
      feature: {} as CatalogFeature
    }));

    expect(chooseBestCandidates(candidates, 90, 10, 5).map((item) => item.productId))
      .toEqual(["scene-0", "scene-1", "scene-2", "scene-3", "scene-4"]);
  });
});
