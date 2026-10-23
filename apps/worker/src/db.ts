import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 8 });

export interface JobProgressDetail {
  phase: string;
  message: string;
  month?: number;
  completedMonths?: number;
  totalMonths?: number;
  checkedCandidates?: number;
  totalCandidates?: number;
}

export async function setJobProgress(id: string, progress: number, progressDetail: JobProgressDetail) {
  await pool.query(
    `UPDATE processing_jobs SET status='active',progress=$2,result=$3,error_message=NULL,
     started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1`,
    [id, progress, JSON.stringify({ progressDetail })]
  );
}

export async function setJobState(id: string, status: "active" | "completed" | "failed", details: { progress?: number | null; result?: unknown; error?: string } = {}) {
  await pool.query(
    `UPDATE processing_jobs SET status=$2,progress=COALESCE($3,progress),result=COALESCE($4,result),error_message=$5,
     started_at=CASE WHEN $2='active' THEN COALESCE(started_at,now()) ELSE started_at END,
     completed_at=CASE WHEN $2 IN ('completed','failed') THEN now() ELSE completed_at END WHERE id=$1`,
    [id, status, details.progress ?? null, details.result ? JSON.stringify(details.result) : null, details.error ?? null]
  );
}
