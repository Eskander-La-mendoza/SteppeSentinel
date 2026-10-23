"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, CheckCircle2, Cloud, KeyRound, Palette, Save } from "lucide-react";
import { NDVI_CLASSES } from "@pasturevision/shared";
import { Page } from "./page";
import { Badge, Button, Card, Input } from "./ui";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function SettingsPage() {
  const { t, translateRuntime } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<any>("/settings") });
  const [cloud, setCloud] = useState(10);
  const [coverage, setCoverage] = useState(90);
  useEffect(() => {
    if (!settings.data) return;
    setCloud(settings.data.satellite?.cloudThreshold ?? 10);
    setCoverage(settings.data.satellite?.minimumValidCoverage ?? 90);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api("/settings", { method: "PATCH", body: JSON.stringify({ satellite: { ...settings.data?.satellite, cloudThreshold: cloud, minimumValidCoverage: coverage, resolution: 10 } }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

  return <Page eyebrow={t("Системные параметры")} title={t("Настройки")} description={t("Параметры отбора и спектральной обработки. Секрет Copernicus никогда не возвращается в браузер.")} actions={<Button className="w-full sm:w-auto" onClick={() => save.mutate()} disabled={save.isPending}><Save size={15} />{t("Сохранить")}</Button>}>
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="p-4 sm:p-5"><Title icon={KeyRound} title="Copernicus Data Space" detail={`OAuth2 Client Credentials · ${t("серверное хранение")}`} /><div className="mt-5 grid gap-3 sm:grid-cols-2"><Field label="Client ID" value={settings.data?.copernicusConfigured ? `•••••••• ${t("настроен")}` : t("Не настроен")} disabled /><Field label="Client Secret" value={settings.data?.copernicusConfigured ? "••••••••••••" : t("Не настроен")} disabled /></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3"><div className="flex min-w-0 items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${settings.data?.copernicusConfigured ? "bg-emerald-500" : "bg-amber-500"}`} /><div className="min-w-0"><p className="text-xs font-semibold">{settings.data?.copernicusConfigured ? t("Подключение настроено") : "Demo Mode"}</p><p className="text-[10px] text-slate-500">{t("Переменные COPERNICUS_CLIENT_ID / SECRET задаются на сервере")}</p></div></div><Badge tone={settings.data?.copernicusConfigured ? "green" : "amber"}>{settings.data?.mode?.toUpperCase()}</Badge></div></Card>
      <Card className="p-4 sm:p-5"><Title icon={Cloud} title={t("Спутниковая обработка")} detail={t("Критерии отбора ежемесячных наблюдений")} /><div className="mt-5 grid gap-4 sm:grid-cols-3"><NumberField label={t("Облачность в AOI, %")} value={cloud} onChange={setCloud} /><NumberField label={t("Валидное покрытие, %")} value={coverage} onChange={setCoverage} /><Field label={t("Разрешение")} value="10 m" disabled /></div><p className="mt-4 text-[10px] leading-5 text-slate-500">{t("Scene Cloud Cover используется для предварительной фильтрации. Итоговая облачность определяется внутри полигона по SCL.")}</p></Card>
      <Card className="p-4 sm:p-5"><Title icon={Palette} title={t("Пять уровней NDVI")} detail={t("Прозрачная пороговая классификация растительности")} /><div className="mt-5 space-y-2">{(settings.data?.ndviClasses ?? NDVI_CLASSES).map((item: any) => <div key={item.id} className="grid grid-cols-[14px_minmax(92px,1fr)_58px_58px] items-center gap-2 rounded-lg border border-slate-100 p-2 text-[10px] sm:grid-cols-[14px_1fr_70px_70px] sm:p-2.5 sm:text-[11px]"><span className="size-3 rounded" style={{ background: item.color }} /><b className="min-w-0">{translateRuntime(item.name)}</b><span className="rounded bg-slate-50 px-1 py-1 text-center font-mono sm:px-2">{item.min}</span><span className="rounded bg-slate-50 px-1 py-1 text-center font-mono sm:px-2">{item.max}</span></div>)}</div></Card>
      <Card className="p-4 sm:p-5"><Title icon={BrainCircuit} title={t("Постспектральный ML")} detail={t("Автоматически после NDVI/NDMI · без разметки")} /><div className="mt-5 grid gap-3 sm:grid-cols-3"><Field label={t("Метод")} value="K-means" disabled /><Field label={t("Признаки")} value="10" disabled /><Field label={t("Режим")} value={t("Без учителя")} disabled /></div><div className="mt-5 rounded-lg border border-blue-100 bg-blue-50 p-3 text-[10px] leading-5 text-blue-800">{t("Система использует B02, B03, B04, B08, B11, B12, NDVI, NDMI, NDWI и BSI. Кластеры находятся автоматически, а заключение содержит измеримые основания и ограничения.")}</div></Card>
    </div>
    {save.isSuccess && <div className="fixed bottom-4 left-4 right-4 z-50 flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-xs font-semibold text-white shadow-xl sm:bottom-5 sm:left-auto sm:right-5"><CheckCircle2 size={16} className="text-emerald-400" />{t("Настройки сохранены")}</div>}
  </Page>;
}

function Title({ icon: Icon, title, detail }: { icon: any; title: string; detail: string }) { return <div className="flex items-start gap-3"><div className="grid size-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700"><Icon size={17} /></div><div><h2 className="text-sm font-bold">{title}</h2><p className="mt-0.5 text-[10px] text-slate-500">{detail}</p></div></div>; }
function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) { return <label><span className="mb-1 block text-[10px] font-bold text-slate-500">{label}</span><Input {...props} /></label>; }
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <Field label={label} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />; }
