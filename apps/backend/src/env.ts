import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEMO_MODE: z.string().default("true").transform((value) => value === "true"),
  DATABASE_URL: z.string().default("postgresql://pasturevision:pasturevision@localhost:5432/pasturevision"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SECURE: z.string().default("false").transform((value) => value === "true"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ADMIN_NAME: z.string().min(2).max(80).default("Администратор"),
  COPERNICUS_CLIENT_ID: z.string().optional(),
  COPERNICUS_CLIENT_SECRET: z.string().optional(),
  MAX_POLYGON_AREA_HA: z.coerce.number().positive().default(250_000),
  MAX_GEOMETRY_POINTS: z.coerce.number().int().positive().default(5_000),
  MAX_RASTER_BYTES: z.coerce.number().int().positive().default(52_428_800)
});

export const env = schema.parse(process.env);
