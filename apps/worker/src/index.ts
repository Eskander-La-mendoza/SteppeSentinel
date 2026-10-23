import { Redis } from "ioredis";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startSatelliteWorker } from "./satellite-worker.js";
import { startMlWorker } from "./ml-worker.js";

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const workers = [startSatelliteWorker(connection), startMlWorker(connection)];
for (const worker of workers) worker.on("failed", (job, error) => console.error(JSON.stringify({level:"error",queue:worker.name,jobId:job?.id,message:error.message})));
console.log(JSON.stringify({level:"info",message:"PastureVision workers started",concurrency:config.WORKER_CONCURRENCY}));

async function shutdown(){await Promise.all(workers.map((worker)=>worker.close()));await connection.quit();await pool.end();process.exit(0);}
process.on("SIGTERM",()=>void shutdown()); process.on("SIGINT",()=>void shutdown());
