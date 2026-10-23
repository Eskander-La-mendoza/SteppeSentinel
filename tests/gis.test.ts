import { describe, expect, it } from "vitest";
import { areaHa, countPoints, geometryBbox, normalizeMultiPolygon, validateGeometry } from "../packages/gis/src/index.js";

const polygon = { type: "Polygon" as const, coordinates: [[[69.05,54.72],[69.18,54.72],[69.18,54.80],[69.05,54.80],[69.05,54.72]]] };
describe("GIS geometry",()=>{
  it("normalizes GeoJSON and calculates geodesic area",()=>{expect(normalizeMultiPolygon(polygon).type).toBe("MultiPolygon");expect(areaHa(polygon)).toBeGreaterThan(5000);expect(countPoints(polygon)).toBe(5);expect(geometryBbox(polygon)).toEqual([69.05,54.72,69.18,54.8]);});
  it("rejects a self-intersecting polygon",()=>{expect(()=>validateGeometry({type:"Polygon",coordinates:[[[0,0],[1,1],[0,1],[1,0],[0,0]]]})).toThrow(/самопересечения|невалидна/i);});
});
