import type { RequestHandler } from "express";

type TileProvider = "streets" | "satellite";

interface CachedTile {
  body: Buffer;
  contentType: string;
  etag?: string;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 512;
const TILE_TTL_MS = 60 * 60 * 1000;
const tileCache = new Map<string, CachedTile>();

function tileUrl(provider: TileProvider, z: number, x: number, y: number) {
  if (provider === "satellite") {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function remember(key: string, value: CachedTile) {
  if (tileCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = tileCache.keys().next().value;
    if (oldest) tileCache.delete(oldest);
  }
  tileCache.set(key, value);
}

export const mapTileHandler: RequestHandler = async (req, res, next) => {
  try {
    const provider = req.params.provider as TileProvider;
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const maxIndex = Number.isInteger(z) && z >= 0 && z <= 19 ? 2 ** z - 1 : -1;

    if (!(["streets", "satellite"] as const).includes(provider) ||
        !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || y < 0 || x > maxIndex || y > maxIndex) {
      res.status(400).json({ error: "Invalid map tile coordinates" });
      return;
    }

    const cacheKey = `${provider}/${z}/${x}/${y}`;
    const cached = tileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.set({
        "content-type": cached.contentType,
        "cache-control": "public, max-age=3600",
        ...(cached.etag ? { etag: cached.etag } : {}),
        "x-tile-cache": "HIT"
      });
      res.end(cached.body);
      return;
    }

    const upstream = await fetch(tileUrl(provider, z, x, y), {
      headers: { "user-agent": "PastureVision/1.0 (local GIS application)" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Basemap provider returned ${upstream.status}` });
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") ?? "image/png";
    const etag = upstream.headers.get("etag") ?? undefined;
    remember(cacheKey, { body, contentType, etag, expiresAt: Date.now() + TILE_TTL_MS });
    res.set({
      "content-type": contentType,
      "cache-control": "public, max-age=3600",
      ...(etag ? { etag } : {}),
      "x-tile-cache": "MISS"
    });
    res.end(body);
  } catch (error) {
    next(error);
  }
};
