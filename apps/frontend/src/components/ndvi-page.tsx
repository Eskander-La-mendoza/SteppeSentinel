"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, CloudSun, Droplets, Gauge, Info, Waves } from "lucide-react";
import { GisMap, type RasterLayer } from "./gis-map";
import { Page } from "./page";
import { Badge, Card, Empty, Select } from "./ui";
import { api, queries } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

const layerLabels: Record<RasterLayer, string> = { ndvi: "NDVI", ndmi: "NDMI", rgb: "RGB" };

export function NdviPage() {
  const { t, formatDate, formatNumber, monthName, translateRuntime } = useI18n();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [pid, setPid] = useState("");
  const [id, setId] = useState("");
  const [layer, setLayer] = useState<RasterLayer>("ndvi");
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const pasture = pastures.data?.find((item) => item.id === (pid || pastures.data?.[0]?.id)) ?? null;
  const observations = useQuery({
    queryKey: ["observations", pasture?.id, year],
    queryFn: () => queries.observations(pasture!.id, year),
    enabled: Boolean(pasture)
  });
  const ready = useMemo(() => {
    const seen = new Set<number>();
    return (observations.data ?? []).filter((item) => {
      if (item.status !== "READY" || seen.has(item.month)) return false;
      seen.add(item.month);
      return true;
    });
  }, [observations.data]);
  const observation = ready.find((item) => item.id === (id || ready[0]?.id)) ?? null;
  const classes = useQuery({
    queryKey: ["classes", observation?.id],
    queryFn: () => api<any[]>(`/ndvi/${observation!.id}/classes`),
    enabled: Boolean(observation)
  });
  const classData = (classes.data ?? []).map((item) => ({ ...item, name: translateRuntime(item.name) }));

  return (
    <Page
      eyebrow="Sentinel-2 Spectral Indices"
      title={t("NDVI и NDMI по пастбищу")}
      description={t("Карта показывает рассчитанные пиксели Sentinel-2 с разрешением около 10 метров, сезонную растительность и влажность покрова.")}
      actions={<><Select className="min-w-0 flex-1 sm:w-56 sm:flex-none" value={pasture?.id ?? ""} onChange={(event) => { setPid(event.target.value); setId(""); }}>{(pastures.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select className="w-28" value={year} onChange={(event) => { setYear(Number(event.target.value)); setId(""); }}>{Array.from({ length: Math.max(1, currentYear - 2016) }, (_, index) => currentYear - index).map((value) => <option key={value} value={value}>{value}</option>)}</Select><Select className="w-full sm:w-52" value={observation?.id ?? ""} onChange={(event) => setId(event.target.value)}>{ready.map((item) => <option key={item.id} value={item.id}>{monthName(item.month)} · {item.compositeSceneCount > 1 ? `${item.compositeSceneCount} ${t("снимков")}` : formatDate(item.acquisitionDate)}</option>)}</Select></>}
    >
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div><h2 className="text-sm font-bold">{t("Геопривязанный слой {{layer}}", { layer: layerLabels[layer] })}</h2><p className="mt-0.5 text-[10px] text-slate-500">{t("Sentinel-2 · около 10 м · прозрачность вне полигона")}</p></div>
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(Object.keys(layerLabels) as RasterLayer[]).map((item) => <button key={item} onClick={() => setLayer(item)} className={`rounded-md px-3 py-1.5 text-[10px] font-bold ${layer === item ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500"}`}>{layerLabels[item]}</button>)}
            </div>
            {observation?.isSynthetic && <Badge tone="amber">SYNTHETIC</Badge>}
          </div>
          {pasture ? <GisMap className="h-[400px] sm:h-[510px]" pastures={[pasture]} selected={pasture} observation={observation} rasterLayer={layer} opacity={0.85} /> : <div className="p-6"><Empty title={t("Нет территории")} description={t("Сначала создайте пастбище на карте.")} /></div>}
        </Card>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Metric icon={Activity} label={t("NDVI всего участка")} value={formatNumber(observation?.ndviMean, 3)} />
            <Metric icon={Gauge} label={t("Медиана · P10–P90")} value={observation?.ndviMedian == null ? "—" : `${formatNumber(observation.ndviMedian, 2)} · ${formatNumber(observation.ndviP10, 2)}–${formatNumber(observation.ndviP90, 2)}`} />
            <Metric icon={Activity} label={t("NDVI растительности")} value={formatNumber(observation?.vegetationNdviMean, 3)} />
            <Metric icon={Gauge} label={t("Медиана растительности")} value={formatNumber(observation?.vegetationNdviMedian, 3)} />
            <Metric icon={Droplets} label={t("Средний NDMI")} value={formatNumber(observation?.ndmiMean, 3)} />
            <Metric icon={Waves} label={t("Медиана NDMI")} value={formatNumber(observation?.ndmiMedian, 3)} />
            <Metric icon={CloudSun} label={t("Снимков в композите")} value={observation ? String(observation.compositeSceneCount) : "—"} />
            <Metric icon={Waves} label={t("Растительный покров")} value={observation?.vegetationCoveragePercentage == null ? "—" : `${formatNumber(observation.vegetationCoveragePercentage, 1)}%`} />
          </div>

          {observation?.compositeMethod === "median-reflectance" && <Card className="border-emerald-100 bg-emerald-50 p-3 text-[10px] leading-5 text-emerald-800"><b>{t("Медианный месячный композит.")}</b> {t("Использовано дат: {{count}}.", { count: observation.compositeSceneCount })} {t("Вода, тёмная поверхность, облака, тени, снег и неопределённые SCL-пиксели исключены. NDVI растительности рассчитан отдельно только по классу SCL 4.")}</Card>}

          {layer === "ndvi" && <Card className="p-4"><h2 className="text-sm font-bold">{t("Площадь классов NDVI")}</h2><p className="mt-1 text-[10px] text-slate-500">{t("Гектары по диапазонам состояния растительности")}</p><div className="mt-3 h-48"><ResponsiveContainer width="100%" height="100%"><BarChart data={classData} layout="vertical" margin={{ left: 25, right: 10 }}><CartesianGrid horizontal={false} stroke="#e2e8f0" /><XAxis type="number" tick={{ fontSize: 9 }} axisLine={false} /><YAxis dataKey="name" type="category" width={95} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip /><Bar dataKey="areaHa" name={t("га")} radius={[0, 4, 4, 0]} fill="#059669" /></BarChart></ResponsiveContainer></div><div className="mt-2 space-y-1.5">{classData.map((item) => <div key={item.classId} className="flex items-center text-[10px]"><span className="mr-2 size-2 rounded-full" style={{ background: item.color }} /><span className="flex-1 text-slate-600">{item.name}</span><b>{formatNumber(item.percentage, 1)}%</b></div>)}</div></Card>}

          {layer === "ndmi" && <Card className="p-4"><h2 className="text-sm font-bold">{t("Шкала влажности NDMI")}</h2><div className="mt-3 h-3 rounded-full bg-gradient-to-r from-[#a6611a] via-[#f5f5f5] to-[#018571]" /><div className="mt-2 flex justify-between text-[10px] text-slate-500"><span>{t("−1 · сухо")}</span><span>0</span><span>{t("+1 · влажно")}</span></div><p className="mt-4 text-[10px] leading-5 text-slate-600">{t("NDMI показывает относительное содержание влаги в растительном покрове. Сравнивайте значения одного пастбища между месяцами.")}</p></Card>}

          {layer === "rgb" && <Card className="p-4"><h2 className="text-sm font-bold">{t("Естественные цвета Sentinel-2")}</h2><p className="mt-2 text-[10px] leading-5 text-slate-600">{t("RGB нужен для визуальной проверки границ, облаков и соответствия индексных слоёв реальному снимку.")}</p></Card>}

          <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-[10px] leading-5 text-blue-800"><div className="mb-1 flex items-center gap-2 font-bold"><Info size={14} />{t("Что рассчитано")}</div>{t("NDVI характеризует зелёную растительность, NDMI — её относительную влажность. Клик по интерактивной карте показывает значение конкретного пикселя.")}</div>
        </div>
      </div>
    </Page>
  );
}

function Metric({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return <Card className="p-3"><Icon size={15} className="text-emerald-600" /><p className="mt-2 text-[10px] text-slate-500">{label}</p><p className="mt-0.5 text-lg font-bold">{value}</p></Card>;
}
