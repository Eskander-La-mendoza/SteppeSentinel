import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const satelliteQueue = new Queue("satellite-processing", { connection: redis });
export const mlQueue = new Queue("machine-learning", { connection: redis });

export async function enqueue(queue: Queue, jobId: string, name: string, data: Record<string, unknown>) {
  const job = await queue.add(name, { ...data, processingJobId: jobId }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: 200
  });
  await poolUpdateQueueId(jobId, String(job.id));
  return job;
}

async function poolUpdateQueueId(processingJobId: string, queueJobId: string) {
  const { pool } = await import("./db.js");
  await pool.query("UPDATE processing_jobs SET queue_job_id = $2 WHERE id = $1", [processingJobId, queueJobId]);
}
