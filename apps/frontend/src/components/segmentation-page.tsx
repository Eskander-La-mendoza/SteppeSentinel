"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, Play, Sparkles } from "lucide-react";
import { ML_CLASSES, type NdviObservation } from "@pasturevision/shared";
import { GisMap, type RasterLayer } from "./gis-map";
import { Page } from "./page";
import { Badge, Button, Card, Empty, Progress, Select } from "./ui";
import { api, queries } from "@/lib/api";
import { formatDate, formatNumber, MONTHS } from "@/lib/utils";
import { useJob } from "@/hooks/use-job";

interface MlModel {
  id: string;
  name: string;
  algorithm: string;
  version: number;
  featureSchema?: string[];
  metrics?: { accuracy?: number; macroF1?: number };
  isSynthetic: boolean;
}

interface Prediction {
  id: string;
  statistics?: Array<{ classId: string; areaHa: number; percentage: number }>;
}

const jobLabels = {
  queued: "В очереди",
  active: "Выполняется",
  completed: "Готово",
  failed: "Ошибка"
} as const;

function newestFirst(a: NdviObservation, b: NdviObservation) {
  return b.year - a.year || b.month - a.month || b.processingVersion - a.processingVersion;
}

export function SegmentationPage() {
  const pastures = useQuery({ queryKey: ["pastures"], queryFn: queries.pastures });
  const [pid, setPid] = useState("");
  const [oid, setOid] = useState("");
  const [mid, setMid] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [rasterLayer, setRasterLayer] = useState<RasterLayer>("ndvi");

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

  const models = useQuery({ queryKey: ["models"], queryFn: () => api<MlModel[]>("/ml/models") });
  const compatibleModels = useMemo(
    () => (models.data ?? []).filter((item) => observation && Boolean(item.isSynthetic) === Boolean(observation.isSynthetic)),
    [models.data, observation]
  );
  const model = compatibleModels.find((item) => item.id === (mid || compatibleModels[0]?.id)) ?? null;
  const job = useJob(jobId);
  const runningStatus = job.data?.status === "queued" ? "queued" : job.data?.status === "active" ? "active" : null;
  const running = Boolean(runningStatus);
  const progressMessage = job.data?.result?.progressDetail?.message as string | undefined;

  useEffect(() => {
    const predictionId = job.data?.result?.predictionId as string | undefined;
    if (job.data?.status !== "completed" || !predictionId) return;
    void api<Prediction>(`/ml/predictions/${predictionId}`)
      .then(setPrediction)
      .catch((error: unknown) => setRunError(error instanceof Error ? error.message : "Не удалось загрузить результат"));
  }, [job.data?.status, job.data?.result?.predictionId]);

  const resetResult = () => {
    setJobId(null);
    setPrediction(null);
    setRunError(null);
  };

  const run = async () => {
    if (!pasture || !observation || !model) return;
    setRunError(null);
    setPrediction(null);
    try {
      const response = await api<{ jobId: string }>(`/pastures/${pasture.id}/ml/predict`, {
        method: "POST",
        body: JSON.stringify({ observationId: observation.id, modelId: model.id })
      });
      setJobId(response.jobId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Не удалось запустить сегментацию");
    }
  };

  const badge = prediction
    ? { tone: "green" as const, text: "ГОТОВО" }
    : job.data?.status === "failed"
      ? { tone: "red" as const, text: "ОШИБКА" }
      : runningStatus
        ? { tone: runningStatus === "queued" ? "amber" as const : "blue" as const, text: jobLabels[runningStatus] }
        : !observation
          ? { tone: "slate" as const, text: "НЕТ СНИМКА" }
          : !model
            ? { tone: "amber" as const, text: "НЕТ МОДЕЛИ" }
            : { tone: "blue" as const, text: "ГОТОВО К ЗАПУСКУ" };

  return (
    <Page
      eyebrow="ML Land-Cover Segmentation"
      title="AI-сегментация"
      description="Random Forest классифицирует валидные спектральные пиксели. Для реальных снимков используется только модель, обученная на реальных данных."
      actions={
        <Button disabled={!pasture || !observation || !model || running} onClick={() => void run()}>
          <Play size={15} />
          {running ? "Сегментация выполняется" : "Выполнить сегментацию"}
        </Button>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[280px_minmax(500px,1fr)_320px]">
        <Card className="p-4">
          <h2 className="text-sm font-bold">Параметры запуска</h2>
          <label className="mt-4 block text-[10px] font-bold text-slate-500">Пастбище</label>
          <Select className="mt-1" value={pasture?.id ?? ""} onChange={(event) => { setPid(event.target.value); setOid(""); setMid(""); resetResult(); }}>
            {(pastures.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>

          <label className="mt-3 block text-[10px] font-bold text-slate-500">Снимок</label>
          <Select className="mt-1" value={observation?.id ?? ""} disabled={!ready.length} onChange={(event) => { setOid(event.target.value); setMid(""); resetResult(); }}>
            {!ready.length && <option value="">Нет готовых снимков</option>}
            {ready.map((item) => <option key={item.id} value={item.id}>{item.year} · {MONTHS[item.month]} · {formatDate(item.acquisitionDate)}</option>)}
          </Select>

          <label className="mt-3 block text-[10px] font-bold text-slate-500">Совместимая модель</label>
          <Select className="mt-1" value={model?.id ?? ""} disabled={!compatibleModels.length} onChange={(event) => { setMid(event.target.value); resetResult(); }}>
            {!compatibleModels.length && <option value="">{observation?.isSynthetic ? "Нет DEMO-модели" : "Нет модели для реальных данных"}</option>}
            {compatibleModels.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
          </Select>

          {observation && <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 p-2.5 text-[10px]"><span className="text-slate-500">Источник</span><Badge tone={observation.isSynthetic ? "amber" : "green"}>{observation.isSynthetic ? "SYNTHETIC" : "SENTINEL-2"}</Badge></div>}

          {observation && !model && !models.isLoading && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[10px] leading-4 text-amber-800">Для этого {observation.isSynthetic ? "демонстрационного" : "реального"} снимка нет совместимой модели. Создайте разметку и обучите модель в <a className="font-bold underline" href="/training">AI Training Studio</a>.</div>}

          {model && <div className="mt-4 rounded-lg bg-slate-50 p-3"><div className="flex items-center gap-2 text-[11px] font-bold"><BrainCircuit size={14} className="text-emerald-600" />{model.algorithm}</div><div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><span className="text-slate-500">Accuracy</span><b className="text-right">{formatNumber(model.metrics?.accuracy, 3)}</b><span className="text-slate-500">Macro F1</span><b className="text-right">{formatNumber(model.metrics?.macroF1, 3)}</b><span className="text-slate-500">Признаков</span><b className="text-right">{model.featureSchema?.length ?? "—"}</b></div></div>}

          {job.data && job.data.status !== "completed" && <div className="mt-4"><div className="mb-2 flex justify-between text-[10px]"><span>{jobLabels[job.data.status]}</span><span>{job.data.progress ?? 0}%</span></div><Progress value={job.data.progress ?? 0} />{progressMessage && <p className="mt-2 text-[10px] leading-4 text-slate-600">{progressMessage}</p>}{job.data.errorMessage && <p className="mt-2 text-[10px] leading-4 text-red-600">{job.data.errorMessage}</p>}</div>}
          {runError && <p className="mt-3 text-[10px] leading-4 text-red-600">{runError}</p>}
        </Card>

        <Card className="relative overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3"><div><h2 className="text-sm font-bold">Классифицированная карта</h2><p className="text-[10px] text-slate-500">Спектральный слой + AI overlay</p></div><div className="flex rounded-lg bg-slate-100 p-1">{(["rgb", "ndvi", "ndmi"] as RasterLayer[]).map((item) => <button key={item} onClick={() => setRasterLayer(item)} className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase ${rasterLayer === item ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500"}`}>{item}</button>)}</div><Badge tone={badge.tone}>{badge.text}</Badge></div>
          {pasture ? <GisMap className="h-[630px]" pastures={[pasture]} selected={pasture} observation={observation} rasterLayer={rasterLayer} segmentationId={prediction?.id} opacity={0.68} /> : <Empty title="Нет территории" description="Выберите пастбище." />}
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2"><Sparkles size={16} className="text-emerald-600" /><h2 className="text-sm font-bold">Классы поверхности</h2></div>
          <div className="mt-4 space-y-3">{ML_CLASSES.map((item) => { const stat = prediction?.statistics?.find((value) => value.classId === item.id); return <div key={item.id}><div className="flex items-center text-[11px]"><span className="mr-2 size-2.5 rounded" style={{ background: item.color }} /><span className="flex-1 font-semibold">{item.name}</span><b>{formatNumber(stat?.areaHa, 1)} га</b></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${stat?.percentage ?? 0}%`, background: item.color }} /></div></div>; })}</div>
          {!prediction && <div className="mt-5"><Empty title={running ? "Идёт классификация" : "Сегментация не выполнена"} description={running ? (progressMessage ?? "Подготавливаем данные для модели.") : model ? "Параметры готовы. Запустите классификацию." : "Сначала нужна совместимая обученная модель."} /></div>}
          <div className="mt-5 rounded-lg border border-amber-100 bg-amber-50 p-3 text-[10px] leading-4 text-amber-800">Метрики модели отражают качество на тестовой разметке и не гарантируют агрономическую достоверность каждого пикселя.</div>
        </Card>
      </div>
    </Page>
  );
}
