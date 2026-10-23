"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PastureGeometry } from "@pasturevision/shared";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  CloudSun,
  Download,
  Hexagon,
  Layers3,
  Pencil,
  Plus,
  Radar,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Waves
} from "lucide-react";
import { GisMap } from "./gis-map";
import { Badge, Button, Card, Empty, Input, Progress, Select } from "./ui";
import { api, queries, type JobProgressDetail } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useWorkspace } from "@/lib/store";
import { useJob } from "@/hooks/use-job";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function Workspace() {
  const { t, formatDate, formatNumber, monthName, translateRuntime } = useI18n();
  const client = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<PastureGeometry | null>(null);
  const [editDraft, setEditDraft] = useState<PastureGeometry | null>(null);
  const [draftResetKey, setDraftResetKey] = useState(0);
  const [editResetKey, setEditResetKey] = useState(0);
  const [name, setName] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const {
    selectedPastureId,
    setPasture,
    selectedObservationId,
    setObservation,
    opacity,
    setOpacity,
    bottomExpanded,
    setBottomExpanded,
    editing,
    setEditing
  } = useWorkspace();

  const pasturesQuery = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const pastures = pasturesQuery.data ?? [];
  const selected = pastures.find((item) => item.id === selectedPastureId) ?? pastures[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedPastureId) setPasture(selected.id);
    if (!selected && selectedPastureId) setPasture(null);
  }, [selected?.id, selectedPastureId, setPasture]);

  const observationsQuery = useQuery({
    queryKey: ["observations", selected?.id, year],
    queryFn: () => queries.observations(selected!.id, year),
    enabled: Boolean(selected)
  });
  const observations = useMemo(
    () => (observationsQuery.data ?? []).filter((item, index, all) => all.findIndex((other) => other.month === item.month) === index),
    [observationsQuery.data]
  );
  const observation = observations.find((item) => item.id === selectedObservationId)
    ?? observations.find((item) => item.status === "READY")
    ?? null;

  useEffect(() => {
    if (observation && observation.id !== selectedObservationId) setObservation(observation.id);
    if (!observation && selectedObservationId) setObservation(null);
  }, [observation?.id, selectedObservationId, setObservation]);

  const job = useJob(jobId, () => {
    void client.invalidateQueries({ queryKey: ["observations", selected?.id, year] });
    setNotice(t("Операция завершена, данные обновлены"));
  });
  const jobRunning = job.data?.status === "queued" || job.data?.status === "active";
  const progressDetail = job.data?.result?.progressDetail as JobProgressDetail | undefined;
  const jobStatusLabel = job.data?.status === "active"
    ? job.data.jobType === "satellite-search" ? t("Поиск Sentinel-2") : t("Расчёт NDVI")
    : job.data?.status === "completed"
      ? t("Готово")
      : job.data?.status === "failed"
        ? t("Ошибка")
        : t("В очереди");

  const create = useMutation({
    mutationFn: () => api<any>("/pastures", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), description: "", geometry: draft })
    }),
    onSuccess: (pasture) => {
      void client.invalidateQueries({ queryKey: ["pastures"] });
      setPasture(pasture.id);
      setDrawing(false);
      setDraft(null);
      setName("");
    }
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/pastures/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDrawing(false);
      setDraft(null);
      setEditing(false);
      setEditDraft(null);
      setPasture(null);
      void client.invalidateQueries({ queryKey: ["pastures"] });
    }
  });

  const update = useMutation({
    mutationFn: ({ id, geometry }: { id: string; geometry: PastureGeometry }) => api<any>(`/pastures/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ geometry })
    }),
    onSuccess: () => {
      setEditing(false);
      setEditDraft(null);
      void client.invalidateQueries({ queryKey: ["pastures"] });
    }
  });

  const start = async (kind: "search" | "process") => {
    if (!selected) return;
    setNotice(null);
    try {
      const result = await api<{ jobId: string }>(
        kind === "search" ? `/pastures/${selected.id}/satellite/search` : `/pastures/${selected.id}/ndvi/process`,
        { method: "POST", body: JSON.stringify({ year }) }
      );
      setJobId(result.jobId);
    } catch (error) {
      setNotice(errorMessage(error, t("Не удалось выполнить операцию")));
    }
  };

  const beginCreate = () => {
    setEditing(false);
    setEditDraft(null);
    setDrawing(true);
    setDraft(null);
    setName("");
    setDraftResetKey((value) => value + 1);
  };
  const cancelCreate = () => {
    setDrawing(false);
    setDraft(null);
    setName("");
  };
  const resetCreate = () => {
    setDraft(null);
    setDraftResetKey((value) => value + 1);
  };
  const beginEdit = () => {
    if (!selected) return;
    setDrawing(false);
    setDraft(null);
    setEditing(true);
    setEditDraft(selected.geometry);
    setEditResetKey((value) => value + 1);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditDraft(null);
  };
  const resetEdit = () => {
    if (!selected) return;
    setEditDraft(selected.geometry);
    setEditResetKey((value) => value + 1);
  };
  const cancelGeometry = () => drawing ? cancelCreate() : cancelEdit();
  const resetGeometry = () => drawing ? resetCreate() : resetEdit();
  const deleteSelected = () => {
    if (selected && confirm(t("Удалить «{{name}}» и все связанные результаты?", { name: selected.name }))) remove.mutate(selected.id);
  };

  const chartData = observations.map((item) => ({
    month: monthName(item.month),
    ndvi: item.ndviMedian,
    vegetationNdvi: item.vegetationNdviMedian,
    range: item.ndviP10 == null || item.ndviP90 == null ? null : [item.ndviP10, item.ndviP90],
    valid: item.validCoveragePercentage
  }));
  const geometryMode = drawing || editing;

  return <div className="flex min-h-[calc(100dvh-4rem)] flex-col xl:h-[calc(100dvh-4rem)] xl:min-h-[680px] xl:overflow-hidden">
    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[278px_minmax(440px,1fr)_292px]">
      <aside className="z-10 border-b border-slate-200 bg-white p-3 xl:overflow-y-auto xl:border-b-0 xl:border-r">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="text-sm font-bold">{t("Пастбища")}</h1>
            <p className="text-[11px] text-slate-500">{pastures.length} {t("территорий")}</p>
          </div>
          <Button className="size-10 px-0" onClick={beginCreate} title={t("Создать новый полигон")}><Plus size={16}/></Button>
        </div>

        {drawing && <Card className="mb-3 border-emerald-200 bg-emerald-50/40 p-3">
          <p className="text-xs font-bold text-emerald-900">{t("Новый полигон")}</p>
          <p className="mt-1 text-[10px] leading-4 text-emerald-800/70">
            {t("Ставьте точки на карте. Двойной щелчок замыкает контур; после этого вершины можно двигать.")}
          </p>
          <Input className="mt-2" placeholder={t("Название пастбища")} value={name} onChange={(event) => setName(event.target.value)}/>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button className="col-span-2" disabled={!draft || name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>
              <Save size={14}/>{create.isPending ? t("Сохранение…") : t("Сохранить полигон")}
            </Button>
            <Button variant="secondary" onClick={resetCreate}><RotateCcw size={14}/>{t("Сбросить")}</Button>
            <Button variant="ghost" onClick={cancelCreate}>{t("Отмена")}</Button>
          </div>
          {draft && <p className="mt-2 text-[10px] font-semibold text-emerald-700">{t("Геометрия готова. Можно поправить вершины или сохранить.")}</p>}
          {create.error && <p className="mt-2 text-[10px] font-semibold text-red-600">{errorMessage(create.error, t("Не удалось выполнить операцию"))}</p>}
        </Card>}

        <div className="space-y-2">
          {pastures.map((pasture) => <button
            key={pasture.id}
            disabled={geometryMode}
            onClick={() => setPasture(pasture.id)}
            className={`w-full rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${pasture.id === selected?.id ? "border-emerald-300 bg-emerald-50/60 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
          >
            <div className="flex items-start gap-2">
              <span className={`mt-1 size-2 rounded-full ${pasture.id === selected?.id ? "bg-emerald-500" : "bg-slate-300"}`}/>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-slate-800">{pasture.name}</p>
                <p className="mt-1 text-[10px] text-slate-500">{formatNumber(pasture.areaHa, 1)} {t("га")}</p>
              </div>
            </div>
          </button>)}
        </div>
        {!pastures.length && !pasturesQuery.isLoading && <Empty title={t("Нет пастбищ")} description={t("Нарисуйте первый полигон непосредственно на карте.")}/>} 

        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{t("Период мониторинга")}</p>
          <Select value={year} disabled={geometryMode} onChange={(event) => setYear(Number(event.target.value))}>
            {Array.from({ length: Math.max(1, currentYear - 2016) }, (_, index) => currentYear - index).map((value) => <option key={value}>{value}</option>)}
          </Select>
          <Button className="mt-2 w-full" disabled={!selected || jobRunning || job.isFetching || geometryMode} onClick={() => void start("search")}><Search size={15}/>{t("Найти Sentinel-2")}</Button>
          <Button className="mt-2 w-full" variant="secondary" disabled={!selected || jobRunning || job.isFetching || geometryMode} onClick={() => void start("process")}><Radar size={15}/>{t("Построить NDVI-композит")}</Button>
          {job.data && <div className="mt-3 rounded-lg bg-slate-50 p-2.5">
            <div className="mb-2 flex justify-between text-[10px] font-semibold">
              <span>{jobStatusLabel}</span>
              <span>{job.data.progress ?? "—"}%</span>
            </div>
            <Progress value={job.data.progress ?? (job.data.status === "queued" ? 2 : 0)}/>
            {progressDetail?.message && <p className="mt-2 text-[10px] font-medium leading-4 text-slate-700">{translateRuntime(progressDetail.message)}</p>}
            {progressDetail && <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-slate-500">
              {progressDetail.totalMonths != null && <span>{t("Завершено месяцев")}: {progressDetail.completedMonths ?? 0}/{progressDetail.totalMonths}</span>}
              {(progressDetail.phase === "quality" || progressDetail.phase === "quality-batch") && progressDetail.totalCandidates != null && progressDetail.totalCandidates > 0 && <span>{progressDetail.phase === "quality-batch" ? `${t("Дат в пакете")}: ${progressDetail.totalCandidates}` : `${t("Обработано дат")}: ${progressDetail.checkedCandidates ?? 0}/${progressDetail.totalCandidates}`}</span>}
            </div>}
            {job.data.errorMessage && <p className="mt-2 text-[10px] text-red-600">{job.data.errorMessage}</p>}
          </div>}
          {notice && <p className="mt-2 text-[10px] font-medium text-emerald-700">{notice}</p>}
        </div>
        {selected && !editing && <button onClick={deleteSelected} disabled={drawing || remove.isPending} className="mt-6 flex min-h-10 items-center gap-2 text-[10px] font-semibold text-red-500 disabled:opacity-40"><Trash2 size={13}/>{t("Удалить пастбище")}</button>}
      </aside>

      <section className="relative min-h-[430px] xl:min-h-0">
        <GisMap
          pastures={pastures}
          selected={selected}
          observation={observation}
          opacity={opacity}
          drawing={drawing}
          editing={editing}
          geometryReady={Boolean(draft)}
          draftResetKey={draftResetKey}
          editResetKey={editResetKey}
          onGeometry={setDraft}
          onEditGeometry={setEditDraft}
          onResetGeometry={resetGeometry}
          onCancelGeometry={cancelGeometry}
          onSelect={setPasture}
          className="h-[430px] xl:h-full"
        />
        <div className="absolute bottom-12 right-3 w-44 rounded-lg border border-white/70 bg-white/95 p-3 shadow-xl">
          <div className="flex items-center justify-between text-[10px] font-bold text-slate-600">
            <span className="flex items-center gap-1.5"><Layers3 size={13}/>{t("Прозрачность")}</span>
            <span>{Math.round(opacity * 100)}%</span>
          </div>
          <input aria-label={`${t("Прозрачность")} NDVI`} className="mt-2 w-full accent-emerald-600" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))}/>
        </div>
      </section>

      <aside className="border-t border-slate-200 bg-white p-4 xl:overflow-y-auto xl:border-l xl:border-t-0">
        {selected ? <>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{t("Активная территория")}</p>
              <h2 className="mt-1 text-base font-bold">{selected.name}</h2>
            </div>
            <Button
              variant={editing ? "secondary" : "ghost"}
              className="size-8 px-0"
              disabled={drawing}
              onClick={editing ? cancelEdit : beginEdit}
              title={editing ? t("Отменить редактирование") : t("Редактировать полигон")}
            ><Pencil size={14}/></Button>
          </div>

          {editing && <Card className="mt-3 border-blue-200 bg-blue-50/40 p-3">
            <p className="text-xs font-bold text-blue-900">{t("Редактирование полигона")}</p>
            <p className="mt-1 text-[10px] leading-4 text-blue-800/70">
              {t("Тяните вершины или весь контур. Нажмите на середину ребра, чтобы добавить точку; выберите вершину и нажмите Delete, чтобы удалить её.")}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button className="col-span-2" disabled={!editDraft || update.isPending} onClick={() => editDraft && update.mutate({ id: selected.id, geometry: editDraft })}>
                <Save size={14}/>{update.isPending ? t("Сохранение…") : t("Сохранить изменения")}
              </Button>
              <Button variant="secondary" onClick={resetEdit}><RotateCcw size={14}/>{t("Сбросить")}</Button>
              <Button variant="ghost" onClick={cancelEdit}>{t("Отмена")}</Button>
            </div>
            <button onClick={deleteSelected} disabled={remove.isPending} className="mt-3 flex min-h-10 items-center gap-1.5 text-[10px] font-semibold text-red-600 disabled:opacity-40"><Trash2 size={13}/>{t("Удалить весь полигон")}</button>
            {update.error && <p className="mt-2 text-[10px] font-semibold text-red-600">{errorMessage(update.error, t("Не удалось выполнить операцию"))}</p>}
          </Card>}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Metric icon={Hexagon} label={t("Площадь")} value={`${formatNumber(selected.areaHa, 1)} ${t("га")}`}/>
            <Metric icon={Activity} label={t("NDVI участка")} value={formatNumber(observation?.ndviMean, 3)}/>
            <Metric icon={Activity} label={t("Медиана · P10–P90")} value={observation?.ndviMedian == null ? "—" : `${formatNumber(observation.ndviMedian, 2)} · ${formatNumber(observation.ndviP10, 2)}–${formatNumber(observation.ndviP90, 2)}`}/>
            <Metric icon={Activity} label={t("NDVI растительности")} value={formatNumber(observation?.vegetationNdviMean, 3)}/>
            <Metric icon={Waves} label={t("Растительный покров")} value={observation?.vegetationCoveragePercentage == null ? "—" : `${formatNumber(observation.vegetationCoveragePercentage, 1)}%`}/>
            <Metric icon={Layers3} label={t("Снимков в композите")} value={observation ? String(observation.compositeSceneCount) : "—"}/>
            <Metric icon={CloudSun} label={t("Облачность")} value={observation?.cloudPercentage == null ? "—" : `${formatNumber(observation.cloudPercentage, 1)}%`}/>
            <Metric icon={Waves} label={t("Валидное покрытие")} value={observation?.validCoveragePercentage == null ? "—" : `${formatNumber(observation.validCoveragePercentage, 1)}%`}/>
          </div>
          {observation?.compositeMethod === "median-reflectance" && <p className="mt-2 rounded-lg bg-emerald-50 px-2.5 py-2 text-[10px] leading-4 text-emerald-800">{t("Медианный композит по отражению B02–B12. Вода, тени, облака, снег и неопределённые SCL-пиксели исключены.")}</p>}

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-bold">{t("Наблюдения")} {year}</p>
              <Badge tone={observations.some((item) => item.isSynthetic) ? "amber" : "green"}>{observations.some((item) => item.isSynthetic) ? "SYNTHETIC" : "SENTINEL-2"}</Badge>
            </div>
            <div className="space-y-1.5">
              {[5, 6, 7, 8, 9].map((month) => {
                const item = observations.find((entry) => entry.month === month);
                return <button
                  key={month}
                  disabled={!item || item.status !== "READY" || geometryMode}
                  onClick={() => item && setObservation(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition disabled:opacity-55 ${item?.id === observation?.id ? "border-emerald-300 bg-emerald-50" : "border-slate-100 hover:bg-slate-50"}`}
                >
                  <span className={`size-2 rounded-full ${item?.status === "READY" ? "bg-emerald-500" : item?.status === "NO_SUITABLE_IMAGE" ? "bg-amber-400" : "bg-slate-300"}`}/>
                  <div className="flex-1">
                    <p className="text-[11px] font-bold">{monthName(month)}</p>
                    <p className="text-[9px] text-slate-500">{item ? item.compositeSceneCount > 1 ? `${item.compositeSceneCount} ${t("снимков")} · ${formatDate(item.sourceAcquisitionDates[0])}–${formatDate(item.sourceAcquisitionDates.at(-1) ?? null)}` : formatDate(item.acquisitionDate) : t("Не обработано")}</p>
                  </div>
                  <span className="font-mono text-[11px] font-bold text-slate-600">{formatNumber(item?.ndviMean, 2)}</span>
                </button>;
              })}
            </div>
          </div>
          {observation && <a href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api"}/ndvi/${observation.id}/raster`} className="mt-4 flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"><Download size={14}/>{t("Скачать GeoTIFF")}</a>}
        </> : <Empty title={t("Выберите территорию")} description={t("Метрики появятся после выбора пастбища.")}/>} 
      </aside>
    </div>

    <section className={`border-t border-slate-200 bg-white transition-all ${bottomExpanded ? "h-56" : "h-11"}`}>
      <button className="flex h-10 w-full items-center gap-2 px-4 text-[11px] font-bold text-slate-600" onClick={() => setBottomExpanded(!bottomExpanded)}>
        <Activity size={14} className="text-emerald-600"/>{t("Сезонная динамика медианного NDVI")}
        <span className="ml-auto">{bottomExpanded ? <ChevronDown size={15}/> : <ChevronUp size={15}/>}</span>
      </button>
      {bottomExpanded && <div className="h-[176px] px-4 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 20, left: -15, bottom: 0 }}>
            <defs><linearGradient id="ndviFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#059669" stopOpacity={0.25}/><stop offset="95%" stopColor="#059669" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false}/>
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false}/>
            <YAxis domain={[0, 1]} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false}/>
            <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 11 }}/>
            <Area type="monotone" dataKey="range" name="P10–P90" stroke="none" fill="#a7f3d0" fillOpacity={0.35} connectNulls={false}/>
            <Area type="monotone" dataKey="ndvi" name={t("Медианный NDVI участка")} stroke="#047857" strokeWidth={2.5} fill="url(#ndviFill)" connectNulls={false}/>
            <Area type="monotone" dataKey="vegetationNdvi" name={t("Медианный NDVI растительности")} stroke="#65a30d" strokeWidth={2} fillOpacity={0} connectNulls={false}/>
          </AreaChart>
        </ResponsiveContainer>
      </div>}
    </section>
  </div>;
}

function Metric({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
    <Icon size={13} className="text-emerald-600"/>
    <p className="mt-2 text-[9px] text-slate-500">{label}</p>
    <p className="mt-0.5 text-xs font-bold text-slate-800">{value}</p>
  </div>;
}
