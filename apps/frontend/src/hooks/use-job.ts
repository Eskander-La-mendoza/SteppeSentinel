"use client";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
export function useJob(jobId:string|null,onComplete?:()=>void){return useQuery({queryKey:["job",jobId],queryFn:()=>queries.job(jobId!),enabled:Boolean(jobId),refetchInterval:(query)=>{const status=query.state.data?.status;if(status==="completed"){onComplete?.();return false;}return status==="failed"?false:1200;}});}
