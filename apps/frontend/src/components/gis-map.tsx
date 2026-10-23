"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import {
  TerraDraw,
  TerraDrawModeUndoRedo,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  TerraDrawSessionUndoRedo,
  TerraDrawUndoRedoKeyboardShortcuts
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { NdviObservation, Pasture, PastureGeometry } from "@pasturevision/shared";
import { API_BASE, api, assetUrl } from "@/lib/api";
import { Badge } from "@/components/ui";
import { FallbackMap } from "@/components/fallback-map";
import { Crosshair, Redo2, RotateCcw, ScanLine, Undo2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    streets: {
      type: "raster",
      tiles: [`${API_BASE}/map/tiles/streets/{z}/{x}/{y}?v=5`],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    },
    satellite: {
      type: "raster",
      tiles: [`${API_BASE}/map/tiles/satellite/{z}/{x}/{y}?v=5`],
      tileSize: 256,
      attribution: "Source: Esri, Maxar, Earthstar Geographics"
    }
  },
  layers: [
    { id: "map-background", type: "background", paint: { "background-color": "#e2e8f0" } },
    { id: "base-streets", type: "raster", source: "streets" },
    { id: "base-satellite", type: "raster", source: "satellite", layout: { visibility: "none" } }
  ]
};

export type RasterLayer = "ndvi" | "ndmi" | "rgb";

function rasterAssetPath(observationId: string, layer: RasterLayer) {
  if (layer === "ndmi") return `/ndvi/${observationId}/ndmi/visualization`;
  if (layer === "rgb") return `/ndvi/${observationId}/rgb`;
  return `/ndvi/${observationId}/visualization`;
}

interface Props {
  pastures: Pasture[];
  selected: Pasture | null;
  observation: NdviObservation | null;
  opacity: number;
  rasterLayer?: RasterLayer;
  segmentationId?: string | null;
  drawing?: boolean;
  editing?: boolean;
  geometryReady?: boolean;
  draftResetKey?: number;
  editResetKey?: number;
  onGeometry?: (geometry: PastureGeometry | null) => void;
  onEditGeometry?: (geometry: PastureGeometry) => void;
  onResetGeometry?: () => void;
  onCancelGeometry?: () => void;
  onSelect?: (id: string) => void;
  className?: string;
}

type DrawFeatureId = string | number;

export function GisMap({
  pastures,
  selected,
  observation,
  opacity,
  rasterLayer = "ndvi",
  segmentationId,
  drawing = false,
  editing = false,
  geometryReady = false,
  draftResetKey = 0,
  editResetKey = 0,
  onGeometry,
  onEditGeometry,
  onResetGeometry,
  onCancelGeometry,
  onSelect,
  className
}: Props) {
  const { t, formatDate, formatNumber, translateRuntime } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const draftFeatureIdRef = useRef<DrawFeatureId | null>(null);
  const editFeatureIdRef = useRef<DrawFeatureId | null>(null);
  const ignoreChangeRef = useRef(false);
  const latest = useRef({ onGeometry, onEditGeometry, onSelect, observation, drawing, editing, rasterLayer });
  latest.current = { onGeometry, onEditGeometry, onSelect, observation, drawing, editing, rasterLayer };

  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [useFallback, setUseFallback] = useState(true);
  const [coords, setCoords] = useState("54.8750, 69.1500");
  const [pixel, setPixel] = useState<any>(null);
  const [style, setStyle] = useState<"streets" | "satellite">("streets");
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: BASE_STYLE,
        center: [69.18, 54.88],
        zoom: 7.5,
        minZoom: 3,
        maxZoom: 18,
        attributionControl: false,
        transformRequest: (url) => ({ url, credentials: "include" })
      });
    } catch {
      setMapFailed(true);
      return;
    }

    let loaded = false;
    const contextLost = () => setMapFailed(true);
    map.getCanvas().addEventListener("webglcontextlost", contextLost);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      loaded = true;
      setMapFailed(false);
      map.addSource("pastures", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "pasture-fill",
        type: "fill",
        source: "pastures",
        paint: {
          "fill-color": ["case", ["boolean", ["get", "selected"], false], "#10b981", "#334155"],
          "fill-opacity": ["case", ["boolean", ["get", "selected"], false], 0.16, 0.06]
        }
      });
      map.addLayer({
        id: "pasture-line",
        type: "line",
        source: "pastures",
        paint: {
          "line-color": ["case", ["boolean", ["get", "selected"], false], "#047857", "#475569"],
          "line-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.5]
        }
      });

      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 7 }),
        modes: [
          new TerraDrawPolygonMode(),
          new TerraDrawSelectMode({
            flags: {
              polygon: {
                feature: {
                  draggable: true,
                  rotateable: false,
                  scaleable: false,
                  coordinates: { midpoints: true, draggable: true, deletable: true }
                }
              }
            }
          })
        ],
        undoRedo: {
          modeLevel: new TerraDrawModeUndoRedo(),
          sessionLevel: new TerraDrawSessionUndoRedo(),
          keyboardShortcuts: new TerraDrawUndoRedoKeyboardShortcuts()
        }
      });
      draw.start();
      draw.setMode("select");
      drawRef.current = draw;

      draw.on("finish", (id, context) => {
        if (context.mode !== "polygon" || !latest.current.drawing || latest.current.editing) return;
        const item = draw.getSnapshotFeature(id);
        if (item?.geometry.type !== "Polygon") return;
        draftFeatureIdRef.current = id;
        latest.current.onGeometry?.(item.geometry as PastureGeometry);
        draw.setMode("select");
        requestAnimationFrame(() => {
          try { draw.selectFeature(id); } catch { /* feature remains visible */ }
        });
      });

      draw.on("change", (ids, type) => {
        setHistoryVersion((value) => value + 1);
        if (ignoreChangeRef.current) return;
        const draftId = draftFeatureIdRef.current;
        const editId = editFeatureIdRef.current;
        if (draftId != null && ids.includes(draftId)) {
          const item = draw.getSnapshotFeature(draftId);
          if (type === "delete" || !item) latest.current.onGeometry?.(null);
          else if (item.geometry.type === "Polygon") latest.current.onGeometry?.(item.geometry as PastureGeometry);
        }
        if (type === "update" && editId != null && ids.includes(editId)) {
          const item = draw.getSnapshotFeature(editId);
          if (item?.geometry.type === "Polygon") latest.current.onEditGeometry?.(item.geometry as PastureGeometry);
        }
      });

      map.on("mousemove", (event) => setCoords(`${event.lngLat.lat.toFixed(5)}, ${event.lngLat.lng.toFixed(5)}`));
      map.on("click", "pasture-fill", (event) => {
        if (latest.current.drawing || latest.current.editing) return;
        const id = event.features?.[0]?.properties?.id;
        if (id) latest.current.onSelect?.(id);
      });
      map.on("click", async (event) => {
        if (latest.current.drawing || latest.current.editing) return;
        const currentObservation = latest.current.observation;
        if (!currentObservation) return;
        try {
          const index = latest.current.rasterLayer === "ndmi" ? "ndmi" : "ndvi";
          setPixel(await api(`/ndvi/${currentObservation.id}/pixel?lng=${event.lngLat.lng}&lat=${event.lngLat.lat}&index=${index}`));
        } catch {
          setPixel(null);
        }
      });
      setMapReady(true);
    });

    mapRef.current = map;
    const readinessTimer = window.setTimeout(() => { if (!loaded) setMapFailed(true); }, 3000);
    return () => {
      window.clearTimeout(readinessTimer);
      map.getCanvas().removeEventListener("webglcontextlost", contextLost);
      drawRef.current?.stop();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const visiblePastures = editing ? pastures.filter((pasture) => pasture.id !== selected?.id) : pastures;
    const data = {
      type: "FeatureCollection" as const,
      features: visiblePastures.map((pasture) => ({
        type: "Feature" as const,
        geometry: pasture.geometry,
        properties: { id: pasture.id, selected: pasture.id === selected?.id, name: pasture.name }
      }))
    };
    (map.getSource("pastures") as GeoJSONSource | undefined)?.setData(data as any);
  }, [mapReady, pastures, selected, editing]);

  useEffect(() => {
    if (!mapReady || !selected || !mapRef.current) return;
    const coordinates = selected.geometry.type === "Polygon"
      ? selected.geometry.coordinates.flat(1)
      : selected.geometry.coordinates.flat(2);
    const first = coordinates[0] as [number, number];
    const bounds = coordinates.reduce<maplibregl.LngLatBounds>(
      (box, position) => box.extend(position as [number, number]),
      new maplibregl.LngLatBounds(first, first)
    );
    mapRef.current.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 700 });
  }, [mapReady, selected?.id]);

  useEffect(() => {
    if (drawing || editing) setUseFallback(false);
  }, [drawing, editing]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!mapReady || !draw) return;
    ignoreChangeRef.current = true;
    try { draw.clear(); } catch { /* nothing to clear */ }
    try { draw.clearUndoRedoHistory(); } catch { /* undo is optional */ }
    draftFeatureIdRef.current = null;
    editFeatureIdRef.current = null;

    if (editing && selected) {
      const editGeometry = selected.geometry.type === "MultiPolygon"
        ? { type: "Polygon" as const, coordinates: selected.geometry.coordinates[0]! }
        : selected.geometry;
      const id = crypto.randomUUID();
      const result = draw.addFeatures([{ id, type: "Feature", geometry: editGeometry, properties: { mode: "polygon" } }]);
      if (result[0]?.valid) {
        editFeatureIdRef.current = id;
        try { draw.setMode("select"); } catch { /* keep rendered geometry */ }
        requestAnimationFrame(() => {
          try { draw.selectFeature(id); } catch { /* keep rendered geometry */ }
        });
      }
    } else if (drawing) {
      try { draw.setMode("polygon"); } catch { /* map remains usable */ }
    } else {
      try { draw.setMode("select"); } catch { /* map remains usable */ }
    }
    ignoreChangeRef.current = false;
    setHistoryVersion((value) => value + 1);
  }, [mapReady, drawing, editing, selected?.id, draftResetKey, editResetKey]);

  useEffect(() => {
    if (!onCancelGeometry || (!drawing && !editing)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelGeometry();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawing, editing, onCancelGeometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (map.getLayer("ndvi-layer")) map.removeLayer("ndvi-layer");
    if (map.getSource("ndvi-image")) map.removeSource("ndvi-image");
    if (!observation?.bbox || observation.status !== "READY") return;
    const [minX, minY, maxX, maxY] = observation.bbox;
    map.addSource("ndvi-image", {
      type: "image",
      url: assetUrl(rasterAssetPath(observation.id, rasterLayer)),
      coordinates: [[minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY]]
    });
    map.addLayer({
      id: "ndvi-layer",
      type: "raster",
      source: "ndvi-image",
      paint: { "raster-opacity": opacity, "raster-fade-duration": 0 }
    }, "pasture-line");
  }, [mapReady, observation?.id, rasterLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("ndvi-layer")) map.setPaintProperty("ndvi-layer", "raster-opacity", opacity);
  }, [opacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (map.getLayer("ml-layer")) map.removeLayer("ml-layer");
    if (map.getSource("ml-image")) map.removeSource("ml-image");
    if (!segmentationId || !observation?.bbox) return;
    const [minX, minY, maxX, maxY] = observation.bbox;
    map.addSource("ml-image", {
      type: "image",
      url: assetUrl(`/ml/predictions/${segmentationId}/visualization`),
      coordinates: [[minX, maxY], [maxX, maxY], [maxX, minY], [minX, minY]]
    });
    map.addLayer({
      id: "ml-layer",
      type: "raster",
      source: "ml-image",
      paint: { "raster-opacity": opacity, "raster-fade-duration": 0 }
    }, "pasture-line");
  }, [mapReady, segmentationId, observation?.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    map.setLayoutProperty("base-streets", "visibility", style === "streets" ? "visible" : "none");
    map.setLayoutProperty("base-satellite", "visibility", style === "satellite" ? "visible" : "none");
  }, [mapReady, style]);

  const fallbackActive = useFallback || mapFailed;
  const geometryMode = drawing || editing;
  const canUndo = Boolean(drawRef.current?.canUndo());
  const canRedo = Boolean(drawRef.current?.canRedo());
  const runHistory = (direction: "undo" | "redo") => {
    const draw = drawRef.current;
    if (!draw) return;
    if (direction === "undo") draw.undo();
    else draw.redo();
    setHistoryVersion((value) => value + 1);
  };

  return <div className={`relative overflow-hidden bg-slate-200 ${className ?? ""}`}>
    {fallbackActive && <FallbackMap pastures={pastures} selected={selected} observation={observation} opacity={opacity} rasterLayer={rasterLayer} failed={mapFailed} onSelect={onSelect}/>} 
    <div ref={container} className={`absolute inset-0 transition-opacity ${fallbackActive ? "pointer-events-none opacity-0" : "opacity-100"}`}/>

    <div className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] gap-1 overflow-x-auto rounded-lg border border-white/70 bg-white/95 p-1 shadow-lg backdrop-blur sm:left-3 sm:top-3">
      <button
        onClick={() => setUseFallback(true)}
        disabled={geometryMode}
        title={geometryMode ? t("Завершите или отмените работу с полигоном") : t("Открыть 2D-карту")}
        className={`min-h-9 shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-[11px] ${useFallback ? "bg-slate-800 text-white" : "text-slate-600"}`}
      >{t("2D карта")}</button>
      <button
        onClick={() => { setStyle("streets"); setUseFallback(false); }}
        disabled={mapFailed}
        className={`min-h-9 shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-[11px] ${!useFallback && style === "streets" ? "bg-slate-800 text-white" : "text-slate-600"}`}
      >{t("Интерактивная")}</button>
      <button
        onClick={() => { setStyle("satellite"); setUseFallback(false); }}
        disabled={mapFailed}
        title={t("Спутниковая подложка")}
        className={`min-h-9 shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:text-[11px] ${!useFallback && style === "satellite" ? "bg-slate-800 text-white" : "text-slate-600"}`}
      >{t("Спутник")}</button>
    </div>

    {geometryMode && <div className="absolute left-2 right-2 top-14 flex flex-wrap items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1.5 shadow-xl backdrop-blur sm:left-1/2 sm:right-auto sm:top-3 sm:-translate-x-1/2 sm:flex-nowrap">
      <span className="max-w-60 px-2 text-center text-[10px] font-semibold text-slate-600 sm:text-left">
        {editing ? t("Тяните вершины; клик по середине ребра добавит точку") : geometryReady ? t("Полигон готов — вершины можно перемещать") : t("Ставьте точки; двойной клик завершит полигон")}
      </span>
      <button onClick={() => runHistory("undo")} disabled={!canUndo} title={t("Отменить действие (Ctrl+Z)")} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30"><Undo2 size={15}/></button>
      <button onClick={() => runHistory("redo")} disabled={!canRedo} title={t("Вернуть действие (Ctrl+Shift+Z)")} className="rounded-md p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-30"><Redo2 size={15}/></button>
      {onResetGeometry && <button onClick={onResetGeometry} title={t("Сбросить изменения")} className="flex min-h-9 items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-50"><RotateCcw size={14}/>{t("Сбросить")}</button>}
      {onCancelGeometry && <button onClick={onCancelGeometry} title={`${t("Отмена")} (Esc)`} className="flex min-h-9 items-center gap-1 rounded-md px-2 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100"><X size={14}/>{t("Отмена")}</button>}
    </div>}

    {observation && <div className="absolute left-3 top-14 rounded-lg border border-white/70 bg-white/95 px-3 py-2 shadow-lg">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-emerald-500"/>
        <span className="text-[11px] font-bold text-slate-700">{rasterLayer.toUpperCase()} · {formatDate(observation.acquisitionDate)}</span>
        {observation.isSynthetic && <Badge tone="amber">SYNTHETIC</Badge>}
      </div>
    </div>}
    <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-slate-900/80 px-2.5 py-1.5 text-[10px] text-white shadow"><Crosshair size={12}/>{coords}</div>
    {pixel && <div className="absolute left-3 right-3 top-24 rounded-xl border border-slate-200 bg-white p-3 shadow-xl sm:left-auto sm:w-52">
      <div className="flex items-center gap-2 text-xs font-bold"><ScanLine size={14} className="text-emerald-600"/>{t("Пиксель")} {String(pixel.index ?? "ndvi").toUpperCase()}</div>
      <div className="mt-3 grid grid-cols-2 gap-y-2 text-[11px]">
        <span className="text-slate-500">{t("Значение")}</span><b className="text-right">{formatNumber(pixel.value ?? pixel.ndvi ?? pixel.ndmi, 3)}</b>
        {pixel.vegetationClass && <><span className="text-slate-500">{t("Состояние")}</span><b className="text-right">{translateRuntime(pixel.vegetationClass)}</b></>}
        <span className="text-slate-500">{t("Дата")}</span><b className="text-right">{formatDate(pixel.acquisitionDate)}</b>
      </div>
      <button className="mt-2 min-h-9 text-[10px] font-semibold text-slate-400" onClick={() => setPixel(null)}>{t("Закрыть")}</button>
    </div>}
  </div>;
}
