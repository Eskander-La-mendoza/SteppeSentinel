import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature, point } from "@turf/helpers";
import sharp from "sharp";
import type { PastureGeometry } from "@pasturevision/shared";
import { NDVI_CLASSES, ML_CLASSES } from "@pasturevision/shared";
import { geometryBbox } from "@pasturevision/gis";
import type { FeatureName, SpectralPixel } from "@pasturevision/ml";
import { extractFeatures } from "@pasturevision/ml";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function mixColor(from: [number, number, number], to: [number, number, number], amount: number) {
  const t = clamp(amount, 0, 1);
  return from.map((value, index) => Math.round(value + (to[index]! - value) * t)) as [number, number, number];
}

export function ndmiColor(value: number): [number, number, number] {
  return value < 0
    ? mixColor([166, 97, 26], [245, 245, 245], value + 1)
    : mixColor([245, 245, 245], [1, 133, 113], value);
}

export function syntheticSpectral(longitude: number, latitude: number, month: number, offset = 0): SpectralPixel {
  const phase = longitude * 11.7 + latitude * 7.3 + month * 0.91 + offset * 0.017;
  const vegetation = clamp(0.52 + 0.22 * Math.sin(phase) + 0.10 * Math.cos(latitude * 19 - offset * 0.03), 0.05, 0.92);
  const moisture = clamp(0.48 + 0.16 * Math.cos(phase * 0.7 + month), 0.08, 0.9);
  const red = clamp(0.20 - vegetation * 0.13 + 0.015 * Math.sin(offset), 0.025, 0.30);
  const nir = clamp(0.19 + vegetation * 0.46, 0.12, 0.78);
  return {
    B02: clamp(red * 0.83 + 0.018, 0.02, 0.3), B03: clamp(red * 0.91 + vegetation * 0.045, 0.03, 0.38), B04: red,
    B08: nir, B11: clamp(nir * (1 - moisture * 0.48), 0.05, 0.5), B12: clamp(nir * (1 - moisture * 0.57), 0.04, 0.45), valid: true
  };
}

export function makeDemoGrid(geometry: PastureGeometry, month: number, width = 256, height = 256) {
  const bbox = geometryBbox(geometry);
  const values = new Float32Array(width * height);
  const ndmiValues = new Float32Array(width * height);
  const rgba = Buffer.alloc(width * height * 4);
  const ndmiRgba = Buffer.alloc(width * height * 4);
  const validValues: number[] = [];
  const validNdmiValues: number[] = [];
  const classCounts = new Map<number, number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const longitude = bbox[0] + (x + 0.5) / width * (bbox[2] - bbox[0]);
      const latitude = bbox[3] - (y + 0.5) / height * (bbox[3] - bbox[1]);
      const inside = booleanPointInPolygon(point([longitude, latitude]), feature(geometry));
      if (!inside) { values[index] = -9999; ndmiValues[index] = -9999; continue; }
      const features = extractFeatures(syntheticSpectral(longitude, latitude, month, index));
      const ndvi = features?.NDVI ?? -9999;
      const ndmi = features?.NDMI ?? -9999;
      values[index] = ndvi;
      ndmiValues[index] = ndmi;
      if (ndvi === -9999) continue;
      validValues.push(ndvi);
      if (ndmi !== -9999) validNdmiValues.push(ndmi);
      const category = NDVI_CLASSES.find((item) => ndvi >= item.min && ndvi < item.max) ?? NDVI_CLASSES[0];
      classCounts.set(category.id, (classCounts.get(category.id) ?? 0) + 1);
      const color = category.color.slice(1);
      rgba[index * 4] = Number.parseInt(color.slice(0, 2), 16);
      rgba[index * 4 + 1] = Number.parseInt(color.slice(2, 4), 16);
      rgba[index * 4 + 2] = Number.parseInt(color.slice(4, 6), 16);
      rgba[index * 4 + 3] = 210;
      if (ndmi !== -9999) {
        const moistureColor = ndmiColor(ndmi);
        ndmiRgba[index * 4] = moistureColor[0];
        ndmiRgba[index * 4 + 1] = moistureColor[1];
        ndmiRgba[index * 4 + 2] = moistureColor[2];
        ndmiRgba[index * 4 + 3] = 210;
      }
    }
  }
  return { width, height, bbox, values, ndmiValues, rgba, ndmiRgba, validValues, validNdmiValues, classCounts };
}

export async function rgbaPng(rgba: Buffer, width: number, height: number) {
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

export function colorizePrediction(predictions: string[], validMask: boolean[], width: number, height: number) {
  const rgba = Buffer.alloc(width * height * 4);
  let pointer = 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < validMask.length; index += 1) {
    if (!validMask[index]) continue;
    const label = predictions[pointer++] ?? "other";
    const item = ML_CLASSES.find((entry) => entry.id === label) ?? ML_CLASSES[4];
    const color = item.color.slice(1);
    rgba[index * 4] = Number.parseInt(color.slice(0, 2), 16); rgba[index * 4 + 1] = Number.parseInt(color.slice(2, 4), 16); rgba[index * 4 + 2] = Number.parseInt(color.slice(4, 6), 16); rgba[index * 4 + 3] = 205;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return { rgba, counts };
}
