import type { NextConfig } from "next";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const mapLibreDist = path.join(path.dirname(require.resolve("maplibre-gl/package.json")), "dist");
const mapLibrePublic = path.join(appDirectory, "public", "maplibre");
mkdirSync(mapLibrePublic, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(path.join(mapLibreDist, file), path.join(mapLibrePublic, file));
}

const noStore = [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" }];
const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@pasturevision/shared"],
  async headers() {
    return ["/map", "/ndvi", "/training", "/segmentation"].map((source) => ({ source, headers: noStore }));
  }
};
export default nextConfig;
