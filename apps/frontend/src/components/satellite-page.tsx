"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Cloud, Orbit, ShieldCheck } from "lucide-react";
import { Page } from "./page";
import { Badge, Card, Empty, Select } from "./ui";
import { api, queries } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function SatellitePage() {
  const year = new Date().getFullYear();
  const { t, monthName, formatDate, formatNumber } = useI18n();
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const [id, setId] = useState("");
  const selected = id || pastures.data?.[0]?.id || "";
  const candidates = useQuery({ queryKey: ["candidates", selected, year], queryFn: () => api<any[]>(`/pastures/${selected}/satellite/candidates?year=${year}`), enabled: Boolean(selected) });

  return <Page
    eyebrow="Sentinel-2 L2A"
    title={t("Спутниковые наблюдения")}
    description={t("Кандидаты отбираются по фактическому покрытию AOI и облачности внутри полигона по SCL, а не только по метаданным сцены.")}
    actions={<Select className="w-full sm:w-64" value={selected} onChange={(event) => setId(event.target.value)}>{(pastures.data ?? []).map((pasture) => <option key={pasture.id} value={pasture.id}>{pasture.name}</option>)}</Select>}
  >
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <Info icon={Orbit} title={t("Источник")} value="Sentinel-2 Level-2A" />
      <Info icon={ShieldCheck} title={t("Минимум валидных пикселей")} value="90%" />
      <Info icon={Cloud} title={t("Облачность в AOI")} value="< 10%" />
    </div>
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><h2 className="text-sm font-bold">{t("Кандидаты за {{year}} год", { year })}</h2><p className="mt-1 text-xs text-slate-500">{t("Выбранная сцена отмечена для каждого месяца.")}</p></div>
      {candidates.data?.length ? <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3">{t("Месяц / дата")}</th><th className="px-4 py-3">Product ID</th><th className="px-4 py-3">Scene cloud</th><th className="px-4 py-3">AOI cloud</th><th className="px-4 py-3">{t("Валидное покрытие")}</th><th className="px-4 py-3">{t("Статус")}</th></tr></thead><tbody className="divide-y divide-slate-100">{candidates.data.map((item) => <tr key={item.id} className="text-xs"><td className="px-5 py-3"><b>{monthName(item.month)}</b><p className="mt-0.5 text-[10px] text-slate-500">{formatDate(item.acquisitionDate)}</p></td><td className="max-w-72 truncate px-4 py-3 font-mono text-[10px] text-slate-500">{item.productId}</td><td className="px-4 py-3">{formatNumber(item.sceneCloudPercentage, 1)}%</td><td className="px-4 py-3 font-semibold">{formatNumber(item.aoiCloudPercentage, 1)}%</td><td className="px-4 py-3"><div className="flex items-center gap-2"><span className="w-14">{formatNumber(item.validCoveragePercentage, 1)}%</span><div className="h-1.5 w-16 rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${item.validCoveragePercentage}%` }} /></div></div></td><td className="px-4 py-3">{item.selected ? <Badge tone="green"><Check size={11} />{t("Выбрано")}</Badge> : <Badge>{t("Кандидат")}</Badge>}</td></tr>)}</tbody></table></div> : <div className="p-5"><Empty title={t("Кандидатов пока нет")} description={t("Откройте карту, выберите год и запустите поиск Sentinel-2.")} /></div>}
    </Card>
  </Page>;
}

function Info({ icon: Icon, title, value }: { icon: any; title: string; value: string }) {
  return <Card className="flex items-center gap-3 p-4"><div className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700"><Icon size={17} /></div><div className="min-w-0"><p className="text-[10px] text-slate-500">{title}</p><p className="truncate text-sm font-bold">{value}</p></div></Card>;
}
