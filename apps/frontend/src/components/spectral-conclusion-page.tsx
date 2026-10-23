"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BrainCircuit, Droplets, Info, Layers3, RefreshCw, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { Page } from "./page";
import { Badge, Button, Card, Empty, Progress, Select } from "./ui";
import { api, queries } from "@/lib/api";
import { useJob } from "@/hooks/use-job";
import { useI18n } from "@/lib/i18n";

const confidenceLabels = { low: "Низкая", medium: "Средняя", high: "Высокая" } as const;
const confidenceTones = { low: "red", medium: "amber", high: "green" } as const;
const bands = ["B02", "B03", "B04", "B08", "B11", "B12"];

export function SpectralConclusionPage() {
  const { t, formatNumber, monthName, translateRuntime } = useI18n();
  const currentYear = new Date().getFullYear();
  const queryClient = useQueryClient();
  const [pastureId, setPastureId] = useState("");
  const [year, setYear] = useState(currentYear);
  const [jobId, setJobId] = useState<string | null>(null);
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const pasture = pastures.data?.find((item) => item.id === (pastureId || pastures.data?.[0]?.id)) ?? null;
  const analysis = useQuery({
    queryKey: ["spectral-analysis", pasture?.id, year],
    queryFn: () => queries.spectralAnalysis(pasture!.id, year),
    enabled: Boolean(pasture)
  });
  const run = useMutation({
    mutationFn: () => api<{ jobId: string }>(`/pastures/${pasture!.id}/spectral-analysis`, { method: "POST", body: JSON.stringify({ year }) }),
    onSuccess: (response) => setJobId(response.jobId)
  });
  const job = useJob(jobId);
  const running = job.data?.status === "queued" || job.data?.status === "active";
  const progressMessage = job.data?.result?.progressDetail?.message as string | undefined;
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    void queryClient.invalidateQueries({ queryKey: ["spectral-analysis", pasture?.id, year] });
  }, [job.data?.status, pasture?.id, queryClient, year]);

  const data = analysis.data?.status === "READY" ? analysis.data.result : null;
  const chart = data?.seasonal.map((item) => ({ ...item, name: monthName(item.month) })) ?? [];
  const jobError = job.data?.errorMessage ?? (run.error instanceof Error ? run.error.message : null);

  return (
    <Page
      eyebrow="Post-spectral machine learning"
      title={t("Автоматическое спектральное заключение")}
      description={t("ML без ручной разметки группирует похожие пиксели Sentinel-2, а NDVI, NDMI и отражение объясняют итоговый вывод.")}
      actions={<><Select className="min-w-0 flex-1 sm:w-56 sm:flex-none" value={pasture?.id ?? ""} onChange={(event) => { setPastureId(event.target.value); setJobId(null); }}>{(pastures.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select className="w-28" value={year} onChange={(event) => { setYear(Number(event.target.value)); setJobId(null); }}>{Array.from({ length: Math.max(1, currentYear - 2016) }, (_, index) => currentYear - index).map((value) => <option key={value} value={value}>{value}</option>)}</Select><Button className="w-full sm:w-auto" disabled={!pasture || running || run.isPending} onClick={() => run.mutate()}><RefreshCw size={15} className={running ? "animate-spin" : ""} />{data ? t("Пересчитать") : t("Рассчитать")}</Button></>}
    >
      {(running || job.data?.status === "failed") && <Card className="mb-5 p-4"><div className="mb-2 flex justify-between gap-3 text-xs"><span>{running ? translateRuntime(progressMessage) || t("Постспектральная обработка") : t("Расчёт завершился с ошибкой")}</span><b>{job.data?.progress ?? 0}%</b></div><Progress value={job.data?.progress ?? 0} />{jobError && <p className="mt-2 break-words text-xs text-red-600">{jobError}</p>}</Card>}

      {!data ? <Empty title={analysis.isLoading ? t("Загрузка заключения") : t("Заключение ещё не рассчитано")} description={t("Оно создаётся автоматически после обработки NDVI/NDMI. При необходимости нажмите «Рассчитать».")} /> : <>
        <Card className="overflow-hidden border-emerald-200">
          <div className="border-b border-emerald-100 bg-emerald-50/70 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-700 text-white"><Sparkles size={19} /></div><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-emerald-700">{t("Спектральный вывод")} · {year}</p><h2 className="mt-1 text-lg font-bold text-emerald-950 sm:text-xl">{translateRuntime(data.conclusion.title)}</h2></div></div><Badge tone={confidenceTones[data.quality.confidenceLevel]}>{t("Доверие")}: {t(confidenceLabels[data.quality.confidenceLevel])} · {data.quality.confidence}%</Badge></div>
            <p className="mt-4 max-w-4xl text-sm leading-6 text-emerald-950/75">{translateRuntime(data.conclusion.summary)}</p>
          </div>
          <div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={Activity} label={t("Спектральное состояние")} value={`${data.indicators.spectralConditionScore}/100`} note={t("не оценка пригодности")} /><Metric icon={Layers3} label={t("Растительный сигнал")} value={`${formatNumber(data.indicators.vegetationShare, 1)}%`} note={t("пиксели с NDVI ≥ 0,30")} /><Metric icon={Droplets} label={t("Изменение NDMI")} value={formatNumber(data.indicators.ndmiSeasonChange, 3)} note={t("от первого к последнему снимку")} /><Metric icon={ShieldCheck} label={t("Основание")} value={`${data.quality.monthsUsed} ${t("мес.")}`} note={`${analysis.data?.sampleCount ?? 0} ${t("спектральных образцов")}`} /></div>
        </Card>

        <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
          <Card className="p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-bold">{t("Сезонная динамика")}</h2><p className="mt-1 text-xs text-slate-500">{t("Средние NDVI и NDMI по валидным пикселям")}</p></div><Badge tone="blue">{translateRuntime(data.method.name)}</Badge></div><div className="mt-4 h-72"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} /><YAxis domain={[-0.3, 1]} axisLine={false} tickLine={false} tick={{ fontSize: 10 }} /><Tooltip /><Legend /><Line type="monotone" dataKey="ndviMean" name="NDVI" stroke="#15803d" strokeWidth={2.5} dot={{ r: 4 }} /><Line type="monotone" dataKey="ndmiMean" name="NDMI" stroke="#0284c7" strokeWidth={2.5} dot={{ r: 4 }} /></LineChart></ResponsiveContainer></div></Card>
          <Card className="p-4 sm:p-5"><div className="flex items-center gap-2"><BrainCircuit size={17} className="text-emerald-700" /><h2 className="text-sm font-bold">{t("Что именно сделал ML")}</h2></div><p className="mt-3 text-xs leading-5 text-slate-600">{translateRuntime(data.method.description)}</p><div className="mt-4 space-y-2">{data.conclusion.evidence.map((item) => <div key={item} className="flex gap-2 rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-700"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-500" />{translateRuntime(item)}</div>)}</div></Card>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
          <Card className="p-4 sm:p-5"><h2 className="text-sm font-bold">{t("Найденные спектральные группы")}</h2><p className="mt-1 text-xs text-slate-500">{t("K-means нашёл группы без меток; название получено из физических индексов их центров.")}</p><div className="mt-4 space-y-3">{data.clusters.map((cluster, index) => <div key={cluster.id} className="rounded-xl border border-slate-100 p-3"><div className="flex flex-wrap items-center gap-2"><span className="size-3 rounded-full" style={{ background: cluster.color }} /><span className="min-w-[170px] flex-1 text-xs font-bold">{t("Группа")} {index + 1} · {translateRuntime(cluster.name)}</span><b className="text-sm">{formatNumber(cluster.percentage, 1)}%</b></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${cluster.percentage}%`, background: cluster.color }} /></div><div className="mt-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4"><Value label="NDVI" value={cluster.centroid.NDVI ?? 0} /><Value label="NDMI" value={cluster.centroid.NDMI ?? 0} /><Value label="NDWI" value={cluster.centroid.NDWI ?? 0} /><Value label="BSI" value={cluster.centroid.BSI ?? 0} /></div></div>)}</div></Card>
          <Card className="p-4 sm:p-5"><h2 className="text-sm font-bold">{t("Среднее отражение")}</h2><p className="mt-1 text-xs text-slate-500">{t("Surface Reflectance по всем использованным пикселям")}</p><div className="mt-4 space-y-3">{bands.map((band) => { const value = data.reflectanceMeans[band] ?? 0; return <div key={band}><div className="flex justify-between text-[11px]"><b>{band}</b><span className="font-mono">{formatNumber(value, 3)}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.min(100, Math.max(0, value * 150))}%` }} /></div></div>; })}</div></Card>
        </div>

        <Card className="mt-5 border-amber-200 bg-amber-50/60 p-4"><div className="flex items-center gap-2 text-xs font-bold text-amber-900"><TriangleAlert size={16} />{t("Границы заключения")}</div><div className="mt-2 space-y-1">{data.conclusion.limitations.map((item) => <p key={item} className="flex gap-2 text-[11px] leading-5 text-amber-900/75"><Info size={13} className="mt-1 shrink-0" />{translateRuntime(item)}</p>)}</div></Card>
      </>}
    </Page>
  );
}

function Metric({ icon: Icon, label, value, note }: { icon: any; label: string; value: string; note: string }) { return <div className="bg-white p-4"><Icon size={16} className="text-emerald-700" /><p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-xl font-bold">{value}</p><p className="mt-1 text-[10px] text-slate-500">{note}</p></div>; }
function Value({ label, value }: { label: string; value: number }) { const { formatNumber } = useI18n(); return <div className="rounded-lg bg-slate-50 p-2"><span className="text-slate-400">{label}</span><p className="mt-0.5 font-mono font-bold">{formatNumber(value, 3)}</p></div>; }
