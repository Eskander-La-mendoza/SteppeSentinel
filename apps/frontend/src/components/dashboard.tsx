"use client";

import Link from "next/link";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, BrainCircuit, CheckCircle2, CloudSun, Database, Hexagon, Map as MapIcon, Orbit, Sparkles } from "lucide-react";
import { Page } from "./page";
import { Badge, Card } from "./ui";
import { api, queries } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function Dashboard() {
  const { t, formatNumber, monthName } = useI18n();
  const year = new Date().getFullYear();
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<any>("/status") });
  const observationQueries = useQueries({ queries: (pastures.data ?? []).map((item) => ({ queryKey: ["observations", item.id, year], queryFn: () => queries.observations(item.id, year) })) });
  const analysisQueries = useQueries({ queries: (pastures.data ?? []).map((item) => ({ queryKey: ["spectral-analysis", item.id, year], queryFn: () => queries.spectralAnalysis(item.id, year) })) });
  const latest = new Map<string, any>();
  observationQueries.flatMap((query) => query.data ?? []).filter((item) => item.status === "READY").forEach((item) => {
    const key = `${item.pastureId}-${item.month}`;
    if (!latest.has(key) || item.processingVersion > latest.get(key).processingVersion) latest.set(key, item);
  });
  const observations = [...latest.values()];
  const readyAnalyses = analysisQueries.map((query) => query.data).filter((item) => item?.status === "READY");
  const latestByMonth = [5, 6, 7, 8, 9].map((month) => {
    const values = observations.filter((item) => item.month === month && item.ndviMean != null);
    return { month: monthName(month), ndvi: values.length ? values.reduce((sum, item) => sum + item.ndviMean, 0) / values.length : null };
  });
  const totalArea = (pastures.data ?? []).reduce((sum, item) => sum + item.areaHa, 0);
  const synthetic = observations.length > 0 && observations.every((item) => item.isSynthetic);

  return <Page eyebrow={t("Операционный обзор")} title={t("Состояние пастбищ")} description={t("Единая картина по территориям, сезонным наблюдениям и автоматическим спектральным заключениям.")} actions={<Link href="/map" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 sm:w-auto"><MapIcon size={15} />{t("Открыть карту")}</Link>}>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Kpi icon={Hexagon} label={t("Территории")} value={String(pastures.data?.length ?? 0)} note={`${formatNumber(totalArea, 2)} ${t("га под наблюдением")}`} /><Kpi icon={Orbit} label={t("Наблюдения")} value={String(observations.length)} note={`Sentinel-2 · ${year}`} /><Kpi icon={CloudSun} label={t("Средний NDVI")} value={formatNumber(observations.length ? observations.reduce((sum, item) => sum + (item.ndviMean ?? 0), 0) / observations.length : null, 3)} note={t("по последним версиям снимков")} /><Kpi icon={BrainCircuit} label={t("ML-заключения")} value={String(readyAnalyses.length)} note={t("без ручной разметки")} /></div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.55fr_1fr]">
      <Card className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-sm font-bold">{t("Сезонная траектория NDVI")}</h2><p className="mt-1 text-xs text-slate-500">{t("Среднее по всем территориям, май–сентябрь")}</p></div><Badge tone={synthetic ? "amber" : "green"}>{synthetic ? "SYNTHETIC" : status.data?.mode === "real" ? "REAL SENTINEL-2" : t("НЕТ ДАННЫХ")}</Badge></div><div className="mt-4 h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={latestByMonth}><defs><linearGradient id="dashFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#059669" stopOpacity=".3" /><stop offset="1" stopColor="#059669" stopOpacity="0" /></linearGradient></defs><CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" /><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#64748b" }} /><YAxis domain={[0, 1]} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "#64748b" }} /><Tooltip /><Area dataKey="ndvi" name="NDVI" stroke="#047857" strokeWidth={2.5} fill="url(#dashFill)" /></AreaChart></ResponsiveContainer></div></Card>
      <Card className="p-4 sm:p-5"><h2 className="text-sm font-bold">{t("Готовность рабочего процесса")}</h2><p className="mt-1 text-xs text-slate-500">{t("От границы участка до объяснимого вывода")}</p><div className="mt-5 space-y-4"><Step icon={CheckCircle2} done={Boolean(pastures.data?.length)} title={t("Контуры пастбищ")} detail={`${pastures.data?.length ?? 0} ${t("сохранено в PostGIS")}`} /><Step icon={Database} done={observations.length > 0} title={t("Спектральные растры")} detail={`${observations.length} ${t("снимков с NDVI и NDMI")}`} /><Step icon={Sparkles} done={readyAnalyses.length > 0} title={t("Постспектральный ML")} detail={readyAnalyses.length ? `${readyAnalyses.length} ${t("заключений готово")}` : t("Запустится после обработки снимков")} /></div></Card>
    </div>
    <div className="mt-5 grid gap-4 md:grid-cols-3"><Action href="/map" icon={MapIcon} title={t("Новая территория")} text={t("Нарисуйте и сохраните контур пастбища.")} /><Action href="/conclusion" icon={Sparkles} title={t("Открыть ML-заключение")} text={t("Посмотрите кластеры, динамику индексов и основания вывода.")} /><Action href="/reports" icon={ArrowRight} title={t("Сформировать отчёт")} text={t("Экспортируйте границы, статистику и георастры.")} /></div>
  </Page>;
}

function Kpi({ icon: Icon, label, value, note }: { icon: any; label: string; value: string; note: string }) { return <Card className="p-4"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon size={18} /></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-0.5 text-xl font-bold">{value}</p></div></div><p className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">{note}</p></Card>; }
function Step({ icon: Icon, done, title, detail }: { icon: any; done: boolean; title: string; detail: string }) { return <div className="flex items-start gap-3"><Icon size={17} className={done ? "text-emerald-600" : "text-slate-300"} /><div className="flex-1"><p className="text-xs font-semibold">{title}</p><p className="mt-0.5 text-[10px] text-slate-500">{detail}</p></div><span className={`mt-1 size-2 rounded-full ${done ? "bg-emerald-500" : "bg-slate-200"}`} /></div>; }
function Action({ href, icon: Icon, title, text }: { href: string; icon: any; title: string; text: string }) { return <Link href={href}><Card className="group h-full p-4 transition hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md"><div className="flex items-center justify-between"><div className="grid size-9 place-items-center rounded-lg bg-slate-100 text-slate-600 group-hover:bg-emerald-50 group-hover:text-emerald-700"><Icon size={17} /></div><ArrowRight size={15} className="text-slate-300 group-hover:text-emerald-600" /></div><h3 className="mt-3 text-sm font-bold">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{text}</p></Card></Link>; }
