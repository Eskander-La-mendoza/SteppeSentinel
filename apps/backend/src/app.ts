import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { env } from "./env.js";
import { apiErrorHandler, router } from "./routes.js";
import { openApiDocument } from "./openapi.js";
import { mapTileHandler } from "./map-tiles.js";
import { requireAuth } from "./auth.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(pinoHttp());
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  app.get("/api/openapi.json", (_req, res) => res.json(openApiDocument));
  // MapLibre requests many small tiles while panning, so tiles have their own
  // validated proxy outside the general API rate limit.
  app.get("/api/map/tiles/:provider/:z/:x/:y", requireAuth, mapTileHandler);
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false }), router);
  app.use(apiErrorHandler);
  return app;
}
