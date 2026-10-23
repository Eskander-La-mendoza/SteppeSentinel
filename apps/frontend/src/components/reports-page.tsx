"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileChartColumn, FileImage, Map as MapIcon, Sparkles } from "lucide-react";
import { Page } from "./page";
import { Badge, Button, Card, Empty, Select } from "./ui";
import { API_BASE, queries } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function ReportsPage() {
  const { t, formatDate, formatNumber, monthName } = useI18n();
  const year = new Date().getFullYear();
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const [pastureId, setPastureId] = useState("");
  const pasture = pastures.data?.find((item) => item.id === (pastureId || pastures.data?.[0]?.id)) ?? null;
  const observations = useQuery({ queryKey: ["observations", pasture?.id, year], queryFn: () => queries.observations(pasture!.id, year), enabled: Boolean(pasture) });
  const ready = useMemo(() => {
    const seen = new Set<number>();
    return (observations.data ?? []).filter((item) => {
      if (item.status !== "READY" || seen.has(item.month)) return false;
      seen.add(item.month);
      return true;
    });
  }, [observations.data]);
  const synthetic = ready.length > 0 && ready.every((item) => item.isSynthetic);
  const downloadGeoJson = () => {
    if (!pasture) return;
    const blob = new Blob([JSON.stringify({ type: "Feature", properties: { id: pasture.id, name: pasture.name, areaHa: pasture.areaHa }, geometry: pasture.geometry }, null, 2)], { type: "application/geo+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${pasture.name}.geojson`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return <Page eyebrow="Analytics & export" title={t("Отчёты и выгрузки")} description={t("Файлы формируются из сохранённых результатов PostgreSQL — повторное обращение к Copernicus не требуется.")} actions={<Select className="w-full sm:w-64" value={pasture?.id ?? ""} onChange={(event) => setPastureId(event.target.value)}>{(pastures.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}>
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
      <Card className="p-4 sm:p-5">{pasture ? <><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{t("Спектральный отчёт")}</p><h2 className="mt-1 text-xl font-bold">{pasture.name}</h2><p className="mt-1 text-xs text-slate-500">{formatNumber(pasture.areaHa, 2)} {t("га")} · {monthName(5)}–{monthName(9)} {year}</p></div>{ready.length > 0 && <Badge tone={synthetic ? "amber" : "green"}>{synthetic ? "SYNTHETIC" : "REAL SENTINEL-2"}</Badge>}</div><div className="mt-6 overflow-x-auto rounded-lg border border-slate-200"><table className="min-w-[580px] w-full text-left"><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-2">{t("Период")}</th><th className="px-3 py-2">NDVI</th><th className="px-3 py-2">NDMI</th><th className="px-3 py-2">Cloud</th><th className="px-3 py-2">Coverage</th></tr></thead><tbody className="divide-y divide-slate-100">{ready.map((item) => <tr key={item.id} className="text-[11px]"><td className="px-3 py-2.5"><b>{monthName(item.month)}</b><span className="ml-2 text-slate-400">{formatDate(item.acquisitionDate)}</span></td><td className="px-3 py-2.5 font-mono font-bold">{formatNumber(item.ndviMean, 3)}</td><td className="px-3 py-2.5 font-mono font-bold">{formatNumber(item.ndmiMean, 3)}</td><td className="px-3 py-2.5">{formatNumber(item.cloudPercentage, 1)}%</td><td className="px-3 py-2.5">{formatNumber(item.validCoveragePercentage, 1)}%</td></tr>)}</tbody></table></div><div className="mt-5 rounded-lg bg-slate-50 p-3 text-[10px] leading-5 text-slate-600"><b>{t("Интерпретация.")}</b> {t("Индексы характеризуют спектральное состояние покрова. Автоматическое ML-заключение объясняет найденные группы, но не заменяет полевую оценку кормовой ценности.")}</div></> : <Empty title={t("Нет территории")} description={t("Создайте пастбище, чтобы сформировать отчёт.")} />}</Card>
      <div className="space-y-4"><Export icon={MapIcon} title={t("Границы пастбища")} detail="GeoJSON · EPSG:4326" action={<Button variant="secondary" onClick={downloadGeoJson} disabled={!pasture}><Download size={14} />GeoJSON</Button>} /><Export icon={FileChartColumn} title={t("Сезонная статистика")} detail={`CSV · ${monthName(5)}–${monthName(9)}`} action={<a className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700" href={pasture ? `${API_BASE}/reports/${pasture.id}.csv` : "#"}><Download size={14} />CSV</a>} /><Export icon={FileImage} title="NDVI GeoTIFF" detail="Float32 · 10 m · georeferenced" action={<Select className="w-full sm:w-40" onChange={(event) => { if (event.target.value) location.href = `${API_BASE}/ndvi/${event.target.value}/raster`; }}><option value="">{t("Выбрать месяц")}</option>{ready.map((item) => <option key={item.id} value={item.id}>{monthName(item.month)}</option>)}</Select>} /><Export icon={Sparkles} title={t("ML-заключение")} detail={t("Кластеры, динамика и основания")} action={<Link className="inline-flex h-9 items-center rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50" href="/conclusion">{t("Открыть")}</Link>} /></div>
    </div>
  </Page>;
}

function Export({ icon: Icon, title, detail, action }: { icon: any; title: string; detail: string; action: React.ReactNode }) { return <Card className="flex flex-wrap items-center gap-3 p-4 sm:gap-4"><div className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon size={20} /></div><div className="min-w-[130px] flex-1"><p className="text-sm font-bold">{title}</p><p className="mt-0.5 text-[10px] text-slate-500">{detail}</p></div>{action}</Card>; }
