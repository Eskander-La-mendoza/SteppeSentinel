import type { NdviObservation, Pasture, PostSpectralAnalysis } from "@pasturevision/shared";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: response.statusText }));
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("steppe-sentinel:unauthorized"));
    throw new ApiError(payload.message ?? `HTTP ${response.status}`, response.status, payload.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const queries = {
  pastures: () => api<Pasture[]>("/pastures"),
  observations: (pastureId: string, year?: number) => api<NdviObservation[]>(`/pastures/${pastureId}/ndvi${year === undefined ? "" : `?year=${year}`}`),
  spectralAnalysis: (pastureId: string, year: number) => api<PostSpectralAnalysis | null>(`/pastures/${pastureId}/spectral-analysis?year=${year}`),
  job: (jobId: string) => api<JobState>(`/jobs/${jobId}`)
};

export interface JobProgressDetail {
  phase: string;
  message: string;
  month?: number;
  completedMonths?: number;
  totalMonths?: number;
  checkedCandidates?: number;
  totalCandidates?: number;
}

export interface JobState { id: string; jobType: string; status: "queued"|"active"|"completed"|"failed"; progress: number|null; result: any; errorMessage: string|null }
export const assetUrl = (path: string) => `${API_BASE}${path}`;
