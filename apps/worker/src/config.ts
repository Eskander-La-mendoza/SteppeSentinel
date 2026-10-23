import { z } from "zod";

export const config = z.object({
  DATABASE_URL: z.string().default("postgresql://pasturevision:pasturevision@localhost:5432/pasturevision"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  COPERNICUS_CLIENT_ID: z.string().optional(),
  COPERNICUS_CLIENT_SECRET: z.string().optional(),
  COPERNICUS_TIMEOUT_MS: z.coerce.number().default(30_000),
  MAX_RASTER_BYTES: z.coerce.number().default(52_428_800),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2)
}).parse(process.env);
