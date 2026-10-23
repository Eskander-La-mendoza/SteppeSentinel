import { createApp } from "./app.js";
import { env } from "./env.js";
import { pool } from "./db.js";
import { redis } from "./queues.js";

const server = createApp().listen(env.API_PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "Steppe Sentinel API started", port: env.API_PORT, mode: env.DEMO_MODE ? "demo" : "real" }));
});

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
  server.close();
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
