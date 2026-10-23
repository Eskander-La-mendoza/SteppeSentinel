"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NdviObservation, PastureGeometry } from "@pasturevision/shared";
import { ML_CLASSES } from "@pasturevision/shared";
import { AlertTriangle, BrainCircuit, Check, Database, PenTool, Save } from "lucide-react";
import { GisMap, type RasterLayer } from "./gis-map";
import { Page } from "./page";
import { Badge, Button, Card, Empty, Progress, Select } from "./ui";
import { api, queries } from "@/lib/api";
import { formatDate, formatNumber, MONTHS } from "@/lib/utils";
import { useJob } from "@/hooks/use-job";

function newestFirst(a: NdviObservation, b: NdviObservation) {
  return b.year - a.year || b.month - a.month || b.processingVersion - a.processingVersion;
}

export function TrainingStudio() {
  const qc = useQueryClient();
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const [pid, setPid] = useState("");
  const [oid, setOid] = useState("");
  const [classId, setClassId] = useState<string>(ML_CLASSES[0].id);
  const [geometry, setGeometry] = useState<PastureGeometry | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [modelResult, setModelResult] = useState<any>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [rasterLayer, setRasterLayer] = useState<RasterLayer>("rgb");

  const pasture = pastures.data?.find((item) => item.id === (pid || pastures.data?.[0]?.id)) ?? null;
  const observations = useQuery({
    queryKey: ["observations", pasture?.id, "all"],
    queryFn: () => queries.observations(pasture!.id),
    enabled: Boolean(pasture)
  });
  const ready = useMemo(
    () => {
      const seen = new Set<string>();
      return (observations.data ?? []).filter((item) => item.status === "READY").sort(newestFirst).filter((item) => {
        const period = `${item.year}-${item.month}`;
        if (seen.has(period)) return false;
        seen.add(period);
        return true;
      });
    },
    [observations.data]
  );
  const observation = ready.find((item) => item.id === (oid || ready[0]?.id)) ?? null;
  const annotations = useQuery({
    queryKey: ["annotations", observation?.id],
    queryFn: () => api<any[]>(`/ml/annotations?observationId=${observation!.id}`),
    enabled: Boolean(observation)
  });
  const counts = useMemo(
    () => Object.fromEntries(ML_CLASSES.map((item) => [item.id, (annotations.data ?? []).filter((annotation) => annotation.classId === item.id).length])),
    [annotations.data]
  );
  const classCount = new Set((annotations.data ?? []).map((item) => item.classId)).size;
  const canBuild = (annotations.data?.length ?? 0) >= 2 && classCount >= 2;

  const save = useMutation({
    mutationFn: () => api("/ml/annotations", {
      method: "POST",
      body: JSON.stringify({ pastureId: pasture!.id, observationId: observation!.id, classId, geometry })
    }),
    onSuccess: () => {
      setGeometry(null);
      setDrawing(false);
      setOperationError(null);
      void qc.invalidateQueries({ queryKey: ["annotations", observation?.id] });
    },
    onError: (error: Error) => setOperationError(error.message)
  });
  const job = useJob(jobId);
  const running = job.data?.status === "queued" || job.data?.status === "active";
  const progressMessage = job.data?.result?.progressDetail?.message as string | undefined;

  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const result = job.data.result;
    if (result?.datasetId) setDatasetId(result.datasetId);
    if (result?.modelId) setModelResult(result);
  }, [job.data?.status, job.data?.result]);

  const resetSource = () => {
    setGeometry(null);
    setDrawing(false);
    setJobId(null);
    setDatasetId(null);
    setModelResult(null);
    setOperationError(null);
  };

  const build = async () => {
    if (!observation) return;
    setOperationError(null);
    try {
      const result = await api<{ jobId: string }>("/ml/datasets/build", {
        method: "POST",
        body: JSON.stringify({
          name: `Training ${pasture?.name} ${observation.year}`,
          observationIds: [...new Set((annotations.data ?? []).map((item) => item.observationId))]
        })
      });
      setJobId(result.jobId);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Не удалось сформировать датасет");
    }
  };

  const train = async () => {
    if (!datasetId || !observation) return;
    setOperationError(null);
    try {
      const result = await api<{ jobId: string }>("/ml/train", {
        method: "POST",
        body: JSON.stringify({
          datasetId,
          name: `Pasture RF ${observation.year}`,
          numberOfTrees: 100,
          seed: 42,
          featureNames: ["B02", "B03", "B04", "B08", "B11", "B12", "NDVI", "NDMI"]
        })
      });
      setJobId(result.jobId);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Не удалось запустить обучение");
    }
  };

  return (
    <Page
      eyebrow="Human-in-the-loop ML"
      title="AI Training Studio"
      description="Размечайте участки на реальном Sentinel-2 снимке. Оценка модели выполняется по пространственно разделённым группам."
      actions={<Badge tone={observation?.isSynthetic ? "amber" : "green"}>{observation?.isSynthetic ? "DEMO · SYNTHETIC" : observation ? "SENTINEL-2 · REAL DATA" : "НЕТ СНИМКА"}</Badge>}
    >
      <div className="grid gap-5 xl:grid-cols-[280px_minmax(500px,1fr)_320px]">
        <Card className="p-4">
          <Step index={1} title="Источник данных" active />
          <label className="mt-4 block text-[10px] font-bold text-slate-500">Пастбище</label>
          <Select className="mt-1" value={pasture?.id ?? ""} onChange={(event) => { setPid(event.target.value); setOid(""); resetSource(); }}>
            {(pastures.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
          <label className="mt-3 block text-[10px] font-bold text-slate-500">Наблюдение</label>
          <Select className="mt-1" value={observation?.id ?? ""} disabled={!ready.length} onChange={(event) => { setOid(event.target.value); resetSource(); }}>
            {!ready.length && <option value="">Нет готовых снимков</option>}
            {ready.map((item) => <option key={item.id} value={item.id}>{item.year} · {MONTHS[item.month]} · {formatDate(item.acquisitionDate)}</option>)}
          </Select>
          <div className="my-5 border-t border-slate-100" />
          <Step index={2} title="Класс разметки" active={Boolean(observation)} />
          <div className="mt-3 space-y-1">{ML_CLASSES.map((item) => <button key={item.id} onClick={() => setClassId(item.id)} className={`flex w-full items-center gap-2 rounded-lg border p-2 text-left text-[11px] ${classId === item.id ? "border-emerald-300 bg-emerald-50" : "border-transparent hover:bg-slate-50"}`}><span className="size-3 rounded" style={{ background: item.color }} /><span className="flex-1 font-semibold">{item.name}</span><Badge>{counts[item.id]}</Badge></button>)}</div>
          <Button className="mt-4 w-full" variant={drawing ? "secondary" : "primary"} disabled={!observation} onClick={() => setDrawing(!drawing)}><PenTool size={14} />{drawing ? "Завершить рисование" : "Рисовать полигон"}</Button>
          <Button className="mt-2 w-full" disabled={!geometry || !observation || save.isPending} onClick={() => save.mutate()}><Save size={14} />Сохранить разметку</Button>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3"><div><h2 className="text-sm font-bold">Карта разметки</h2><p className="text-[10px] text-slate-500">Сравнивайте RGB, NDVI и NDMI перед разметкой</p></div><div className="flex rounded-lg bg-slate-100 p-1">{(["rgb", "ndvi", "ndmi"] as RasterLayer[]).map((item) => <button key={item} onClick={() => setRasterLayer(item)} className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase ${rasterLayer === item ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500"}`}>{item}</button>)}</div>{geometry && <Badge tone="green"><Check size={11} />Геометрия готова</Badge>}</div>
          {pasture ? <GisMap className="h-[650px]" pastures={[pasture]} selected={pasture} observation={observation} rasterLayer={rasterLayer} opacity={0.72} drawing={drawing} onGeometry={setGeometry} /> : <Empty title="Нет пастбища" description="Создайте территорию на карте." />}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <Step index={3} title="Обучающая выборка" active={Boolean(annotations.data?.length)} />
            <div className="mt-3 grid grid-cols-2 gap-2"><Mini label="Полигонов" value={String(annotations.data?.length ?? 0)} /><Mini label="Площадь" value={`${formatNumber((annotations.data ?? []).reduce((sum, item) => sum + Number(item.areaHa), 0), 1)} га`} /></div>
            {!canBuild && <div className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-2.5 text-[10px] leading-4 text-amber-800"><AlertTriangle size={15} className="shrink-0" />Нужно минимум два класса и две пространственно разделённые разметки.</div>}
            <Button className="mt-3 w-full" variant="secondary" disabled={!canBuild || running} onClick={() => void build()}><Database size={14} />Сформировать датасет</Button>
            {datasetId && <p className="mt-2 text-[10px] font-semibold text-emerald-700">Датасет сохранён · {datasetId.slice(0, 8)}</p>}
          </Card>

          <Card className="p-4">
            <Step index={4} title="Random Forest" active={Boolean(datasetId)} />
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]"><Mini label="Деревья" value="100" /><Mini label="Seed" value="42" /><Mini label="Признаки" value="8" /><Mini label="Split" value="spatial" /></div>
            <Button className="mt-3 w-full" disabled={!datasetId || running} onClick={() => void train()}><BrainCircuit size={14} />Обучить Random Forest</Button>
            {job.data && job.data.status !== "completed" && <div className="mt-3"><div className="mb-1 flex justify-between text-[10px]"><span>{job.data.status === "queued" ? "В очереди" : job.data.status === "active" ? "Выполняется" : "Ошибка"}</span><span>{job.data.progress ?? 0}%</span></div><Progress value={job.data.progress ?? 0} />{progressMessage && <p className="mt-2 text-[10px] leading-4 text-slate-600">{progressMessage}</p>}</div>}
            {(job.data?.errorMessage || operationError) && <p className="mt-2 text-[10px] leading-4 text-red-600">{job.data?.errorMessage ?? operationError}</p>}
          </Card>

          {modelResult && <Card className="border-emerald-200 bg-emerald-50/50 p-4"><p className="text-xs font-bold text-emerald-900">Модель v{modelResult.version} обучена</p><div className="mt-3 grid grid-cols-2 gap-2"><Mini label="Accuracy" value={formatNumber(modelResult.metrics.accuracy, 3)} /><Mini label="Macro F1" value={formatNumber(modelResult.metrics.macroF1, 3)} /><Mini label="Train" value={String(modelResult.metrics.trainSamples)} /><Mini label="Test" value={String(modelResult.metrics.independentTestSamples)} /></div></Card>}
        </div>
      </div>
    </Page>
  );
}

function Step({ index, title, active = false }: { index: number; title: string; active?: boolean }) {
  return <div className="flex items-center gap-2"><span className={`grid size-6 place-items-center rounded-full text-[10px] font-bold ${active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-400"}`}>{index}</span><span className="text-xs font-bold">{title}</span></div>;
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-2"><p className="text-[9px] text-slate-500">{label}</p><p className="mt-0.5 text-xs font-bold">{value}</p></div>;
}
