import area from "@turf/area";
import bbox from "@turf/bbox";
import booleanValid from "@turf/boolean-valid";
import { feature } from "@turf/helpers";
import kinks from "@turf/kinks";
import { geometrySchema, type PastureGeometry } from "@pasturevision/shared";

export interface GeometryValidationOptions {
  maxPoints?: number;
  maxAreaHa?: number;
}

export function normalizeMultiPolygon(geometry: PastureGeometry): PastureGeometry & { type: "MultiPolygon" } {
  return geometry.type === "MultiPolygon"
    ? geometry
    : { type: "MultiPolygon", coordinates: [geometry.coordinates] };
}

export function countPoints(geometry: PastureGeometry): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring) => sum + ring.length, 0), 0);
}

export function areaHa(geometry: PastureGeometry): number {
  return area(feature(geometry)) / 10_000;
}

export function geometryBbox(geometry: PastureGeometry): [number, number, number, number] {
  return bbox(feature(geometry)) as [number, number, number, number];
}

export function validateGeometry(input: unknown, options: GeometryValidationOptions = {}): PastureGeometry {
  const geometry = geometrySchema.parse(input);
  const geoFeature = feature(geometry);
  if (!booleanValid(geoFeature)) throw new Error("Геометрия невалидна");
  if (kinks(geoFeature).features.length > 0) throw new Error("Полигон содержит самопересечения");
  const points = countPoints(geometry);
  if (points > (options.maxPoints ?? 5_000)) throw new Error(`Превышен лимит вершин: ${points}`);
  const hectares = areaHa(geometry);
  if (hectares <= 0) throw new Error("Площадь полигона должна быть больше нуля");
  if (hectares > (options.maxAreaHa ?? 250_000)) throw new Error(`Площадь ${hectares.toFixed(1)} га превышает лимит`);
  return geometry;
}
