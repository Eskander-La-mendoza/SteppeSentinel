import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RasterGrid {
  width: number;
  height: number;
  bbox: [number, number, number, number];
  values: Float32Array;
}

export interface SpectralRaster {
  width: number;
  height: number;
  bbox: [number, number, number, number];
  coordinates: Array<[number, number]>;
  bands: number[][];
}

export async function gridToGeoTiff(grid: RasterGrid): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "pasturevision-"));
  try {
    const ascii = join(directory, "grid.asc");
    const output = join(directory, "grid.tif");
    const [minX, minY, maxX, maxY] = grid.bbox;
    const rows: string[] = [
      `ncols ${grid.width}`,
      `nrows ${grid.height}`,
      `xllcorner ${minX}`,
      `yllcorner ${minY}`,
      `cellsize ${(maxX - minX) / grid.width}`,
      "NODATA_value -9999"
    ];
    for (let y = 0; y < grid.height; y += 1) {
      rows.push(Array.from(grid.values.subarray(y * grid.width, (y + 1) * grid.width)).join(" "));
    }
    await writeFile(ascii, rows.join("\n"));
    await exec("gdal_translate", ["-q", "-of", "GTiff", "-ot", "Float32", "-a_srs", "EPSG:4326", "-a_ullr", String(minX), String(maxY), String(maxX), String(minY), "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", ascii, output], { maxBuffer: 1024 * 1024 });
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function splitProcessTiff(buffer: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "pasturevision-real-"));
  try {
    const source = join(directory, "spectral.tif");
    const ndvi = join(directory, "ndvi.tif");
    const ndmi = join(directory, "ndmi.tif");
    const mask = join(directory, "mask.tif");
    const vegetationMask = join(directory, "vegetation-mask.tif");
    const xyz = join(directory, "ndvi.xyz");
    const ndmiXyz = join(directory, "ndmi.xyz");
    const vegetationXyz = join(directory, "vegetation.xyz");
    const rgb = join(directory, "rgb.png");
    await writeFile(source, buffer);
    const info = JSON.parse((await exec("gdalinfo", ["-json", "-stats", source], { maxBuffer: 10 * 1024 * 1024 })).stdout);
    const bandCount = Array.isArray(info.bands) ? info.bands.length : 0;
    await exec("gdal_translate", ["-q", "-b", "7", "-of", "GTiff", "-ot", "Float32", "-a_nodata", "-9999", "-co", "COMPRESS=DEFLATE", source, ndvi]);
    await exec("gdal_translate", ["-q", "-b", "8", "-of", "GTiff", "-ot", "Float32", "-a_nodata", "-9999", "-co", "COMPRESS=DEFLATE", source, ndmi]);
    await exec("gdal_translate", ["-q", "-b", "9", "-of", "GTiff", "-ot", "Byte", source, mask]);
    if (bandCount >= 10) await exec("gdal_translate", ["-q", "-b", "10", "-of", "GTiff", "-ot", "Byte", source, vegetationMask]);
    await exec("gdal_translate", ["-q", "-b", "7", "-of", "XYZ", source, xyz], { maxBuffer: 1024 * 1024 });
    await exec("gdal_translate", ["-q", "-b", "8", "-of", "XYZ", source, ndmiXyz], { maxBuffer: 1024 * 1024 });
    if (bandCount >= 10) await exec("gdal_translate", ["-q", "-b", "10", "-of", "XYZ", source, vegetationXyz], { maxBuffer: 1024 * 1024 });
    await exec("gdal_translate", ["-q", "-b", "4", "-b", "3", "-b", "2", "-scale", "0", "0.35", "0", "255", "-of", "PNG", source, rgb]);
    const allValues = (await readFile(xyz, "utf8")).split(/\r?\n/).map((line) => Number(line.trim().split(/\s+/)[2]));
    const allNdmiValues = (await readFile(ndmiXyz, "utf8")).split(/\r?\n/).map((line) => Number(line.trim().split(/\s+/)[2]));
    const allVegetationMask = bandCount >= 10
      ? (await readFile(vegetationXyz, "utf8")).split(/\r?\n/).map((line) => Number(line.trim().split(/\s+/)[2]))
      : allValues.map((value) => Number.isFinite(value) && value >= 0.3 && value <= 1 ? 1 : 0);
    const values = allValues.filter((value) => Number.isFinite(value) && value >= -1 && value <= 1);
    const ndmiValues = allNdmiValues.filter((value) => Number.isFinite(value) && value >= -1 && value <= 1);
    const vegetationValues = allValues.filter((value, index) => allVegetationMask[index]! >= 0.5 && Number.isFinite(value) && value >= -1 && value <= 1);
    const geo = info.geoTransform as [number, number, number, number, number, number];
    const size = info.size as [number, number];
    const bbox: [number, number, number, number] = [geo[0], geo[3] + geo[5] * size[1], geo[0] + geo[1] * size[0], geo[3]];
    return { spectral: buffer, ndvi: await readFile(ndvi), ndmi: await readFile(ndmi), mask: await readFile(mask), vegetationMask: bandCount >= 10 ? await readFile(vegetationMask) : null, rgb: await readFile(rgb), values, allValues, ndmiValues, allNdmiValues, vegetationValues, allVegetationMask, width: size[0], height: size[1], bbox };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function compositeProcessTiffs(buffers: Buffer[]) {
  if (!buffers.length) throw new Error("Для медианного композита не переданы снимки");
  if (buffers.length === 1) return splitProcessTiff(buffers[0]!);

  const directory = await mkdtemp(join(tmpdir(), "pasturevision-composite-"));
  try {
    const sources: string[] = [];
    for (let index = 0; index < buffers.length; index += 1) {
      const source = join(directory, `source-${index}.tif`);
      await writeFile(source, buffers[index]!);
      sources.push(source);
    }

    const bandFiles: string[] = [];
    const medianExpression = "where(any(M>0.5,axis=0),nanmedian(where(M>0.5,A,nan),axis=0),-9999)";
    for (let band = 1; band <= 6; band += 1) {
      const output = join(directory, `median-${band}.tif`);
      await exec("gdal_calc.py", [
        "-A", ...sources, "--A_band", String(band),
        "-M", ...sources, "--M_band", "9",
        "--calc", medianExpression,
        "--outfile", output,
        "--type", "Float32",
        "--NoDataValue", "-9999",
        "--extent", "fail",
        "--quiet",
        "--overwrite",
        "--co", "COMPRESS=DEFLATE",
        "--co", "PREDICTOR=3"
      ], { maxBuffer: 16 * 1024 * 1024 });
      bandFiles.push(output);
    }

    const ndvi = join(directory, "median-7.tif");
    await exec("gdal_calc.py", [
      "-N", bandFiles[3]!, "-R", bandFiles[2]!,
      "--calc", "where(logical_and(N>-9999,R>-9999)*(N+R!=0),(N-R)/(N+R),-9999)",
      "--outfile", ndvi, "--type", "Float32", "--NoDataValue", "-9999", "--quiet", "--overwrite",
      "--co", "COMPRESS=DEFLATE", "--co", "PREDICTOR=3"
    ], { maxBuffer: 16 * 1024 * 1024 });
    bandFiles.push(ndvi);

    const ndmi = join(directory, "median-8.tif");
    await exec("gdal_calc.py", [
      "-N", bandFiles[3]!, "-S", bandFiles[4]!,
      "--calc", "where(logical_and(N>-9999,S>-9999)*(N+S!=0),(N-S)/(N+S),-9999)",
      "--outfile", ndmi, "--type", "Float32", "--NoDataValue", "-9999", "--quiet", "--overwrite",
      "--co", "COMPRESS=DEFLATE", "--co", "PREDICTOR=3"
    ], { maxBuffer: 16 * 1024 * 1024 });
    bandFiles.push(ndmi);

    const landMask = join(directory, "median-9.tif");
    await exec("gdal_calc.py", [
      "-M", ...sources, "--M_band", "9",
      "--calc", "any(M>0.5,axis=0)",
      "--outfile", landMask, "--type", "Byte", "--NoDataValue", "0", "--extent", "fail", "--quiet", "--overwrite",
      "--co", "COMPRESS=DEFLATE"
    ], { maxBuffer: 16 * 1024 * 1024 });
    bandFiles.push(landMask);

    const vegetationMask = join(directory, "median-10.tif");
    await exec("gdal_calc.py", [
      "-M", ...sources, "--M_band", "9",
      "-V", ...sources, "--V_band", "10",
      "--calc", "where(sum(M>0.5,axis=0)>0,sum(V>0.5,axis=0)>sum(M>0.5,axis=0)/2,0)",
      "--outfile", vegetationMask, "--type", "Byte", "--NoDataValue", "0", "--extent", "fail", "--quiet", "--overwrite",
      "--co", "COMPRESS=DEFLATE"
    ], { maxBuffer: 16 * 1024 * 1024 });
    bandFiles.push(vegetationMask);

    const vrt = join(directory, "composite.vrt");
    const composite = join(directory, "composite.tif");
    await exec("gdalbuildvrt", ["-q", "-separate", vrt, ...bandFiles], { maxBuffer: 16 * 1024 * 1024 });
    await exec("gdal_translate", ["-q", "-of", "GTiff", "-ot", "Float32", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", vrt, composite], { maxBuffer: 16 * 1024 * 1024 });
    return await splitProcessTiff(await readFile(composite));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readSpectralGeoTiff(buffer: Buffer, maxDimension?: number): Promise<SpectralRaster> {
  const directory = await mkdtemp(join(tmpdir(), "pasturevision-features-"));
  try {
    const source = join(directory, "spectral.tif");
    await writeFile(source, buffer);
    let rasterPath = source;
    const sourceInfo = JSON.parse((await exec("gdalinfo", ["-json", source], { maxBuffer: 10 * 1024 * 1024 })).stdout);
    const sourceSize = sourceInfo.size as [number, number];
    if (maxDimension && Math.max(...sourceSize) > maxDimension) {
      const sampled = join(directory, "sampled.tif");
      const scale = maxDimension / Math.max(...sourceSize);
      const sampledWidth = Math.max(1, Math.round(sourceSize[0] * scale));
      const sampledHeight = Math.max(1, Math.round(sourceSize[1] * scale));
      await exec("gdal_translate", ["-q", "-outsize", String(sampledWidth), String(sampledHeight), "-r", "nearest", "-of", "GTiff", source, sampled]);
      rasterPath = sampled;
    }
    const info = rasterPath === source ? sourceInfo : JSON.parse((await exec("gdalinfo", ["-json", rasterPath], { maxBuffer: 10 * 1024 * 1024 })).stdout);
    const geo = info.geoTransform as [number, number, number, number, number, number];
    const size = info.size as [number, number];
    const bbox: [number, number, number, number] = [geo[0], geo[3] + geo[5] * size[1], geo[0] + geo[1] * size[0], geo[3]];
    const bands: number[][] = [];
    let coordinates: Array<[number, number]> = [];
    for (let band = 1; band <= 9; band += 1) {
      const path = join(directory, `band-${band}.xyz`);
      await exec("gdal_translate", ["-q", "-b", String(band), "-of", "XYZ", rasterPath, path], { maxBuffer: 16 * 1024 * 1024 });
      const rows = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/).map(Number));
      if (band === 1) coordinates = rows.map((row) => [row[0]!, row[1]!]);
      bands.push(rows.map((row) => row[2]!));
    }
    return { width: size[0], height: size[1], bbox, coordinates, bands };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
