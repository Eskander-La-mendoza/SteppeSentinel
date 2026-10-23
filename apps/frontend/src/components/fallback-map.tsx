"use client";

import type { NdviObservation, Pasture, PastureGeometry } from "@pasturevision/shared";
import { assetUrl } from "@/lib/api";
import type { RasterLayer } from "@/components/gis-map";
import { useI18n } from "@/lib/i18n";

const TILE_SIZE = 256;
const GRID_SIZE = 5;

type Position = [number, number];

function project([longitude, latitude]: Position, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin(Math.max(-85.0511, Math.min(85.0511, latitude)) * Math.PI / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

function positions(geometry: PastureGeometry): Position[] {
  return geometry.type === "Polygon"
    ? geometry.coordinates.flat(1) as Position[]
    : geometry.coordinates.flat(2) as Position[];
}

function geometryBounds(pasture: Pasture | null): [number, number, number, number] {
  if (!pasture) return [69.05, 54.72, 69.18, 54.8];
  const points = positions(pasture.geometry);
  return points.reduce<[number, number, number, number]>(
    (box, [longitude, latitude]) => [
      Math.min(box[0], longitude), Math.min(box[1], latitude),
      Math.max(box[2], longitude), Math.max(box[3], latitude)
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
}

function geometryPath(geometry: PastureGeometry, originX: number, originY: number, zoom: number) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((polygon) => polygon.map((ring) => ring.map((position, index) => {
    const point = project(position as Position, zoom);
    return `${index === 0 ? "M" : "L"}${point.x - originX},${point.y - originY}`;
  }).join(" ") + " Z")).join(" ");
}

function fitZoom(bbox: [number, number, number, number]) {
  const available = GRID_SIZE * TILE_SIZE * 0.65;
  for (let zoom = 18; zoom >= 3; zoom -= 1) {
    const northWest = project([bbox[0], bbox[3]], zoom);
    const southEast = project([bbox[2], bbox[1]], zoom);
    if (southEast.x - northWest.x <= available && southEast.y - northWest.y <= available) return zoom;
  }
  return 3;
}

interface Props {
  pastures?: Pasture[];
  selected: Pasture | null;
  observation: NdviObservation | null;
  opacity: number;
  rasterLayer?: RasterLayer;
  failed?: boolean;
  onSelect?: (id: string) => void;
}

function rasterAssetPath(observationId: string, layer: RasterLayer) {
  if (layer === "ndmi") return `/ndvi/${observationId}/ndmi/visualization`;
  if (layer === "rgb") return `/ndvi/${observationId}/rgb`;
  return `/ndvi/${observationId}/visualization`;
}

export function FallbackMap({ pastures = [], selected, observation, opacity, rasterLayer = "ndvi", failed = false, onSelect }: Props) {
  const { t } = useI18n();
  const bbox = observation?.bbox ?? geometryBounds(selected);
  const zoom = fitZoom(bbox);
  const center = project([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], zoom);
  const firstTileX = Math.floor(center.x / TILE_SIZE) - Math.floor(GRID_SIZE / 2);
  const firstTileY = Math.floor(center.y / TILE_SIZE) - Math.floor(GRID_SIZE / 2);
  const originX = firstTileX * TILE_SIZE;
  const originY = firstTileY * TILE_SIZE;
  const centerOffsetX = center.x - originX;
  const centerOffsetY = center.y - originY;
  const overlayNorthWest = observation?.bbox ? project([observation.bbox[0], observation.bbox[3]], zoom) : null;
  const overlaySouthEast = observation?.bbox ? project([observation.bbox[2], observation.bbox[1]], zoom) : null;
  const tiles = Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => ({
    column: index % GRID_SIZE,
    row: Math.floor(index / GRID_SIZE)
  }));

  return <div className="absolute inset-0 overflow-hidden bg-slate-200">
    <div className="absolute" style={{
      width: GRID_SIZE * TILE_SIZE,
      height: GRID_SIZE * TILE_SIZE,
      left: "50%",
      top: "50%",
      transform: `translate(${-centerOffsetX}px, ${-centerOffsetY}px)`
    }}>
      {tiles.map(({ column, row }) => <img
        key={`${column}-${row}`}
        alt=""
        draggable={false}
        src={assetUrl(`/map/tiles/streets/${zoom}/${firstTileX + column}/${firstTileY + row}?v=5`)}
        className="absolute size-64 select-none"
        style={{ left: column * TILE_SIZE, top: row * TILE_SIZE }}
      />)}
      {observation?.status === "READY" && overlayNorthWest && overlaySouthEast && <img
        alt={rasterLayer.toUpperCase()}
        draggable={false}
        src={assetUrl(rasterAssetPath(observation.id, rasterLayer))}
        className="absolute"
        style={{
          left: overlayNorthWest.x - originX,
          top: overlayNorthWest.y - originY,
          width: overlaySouthEast.x - overlayNorthWest.x,
          height: overlaySouthEast.y - overlayNorthWest.y,
          opacity
        }}
      />}
      <svg className="absolute inset-0" width={GRID_SIZE * TILE_SIZE} height={GRID_SIZE * TILE_SIZE}>
        {pastures.map((pasture) => <path key={pasture.id} d={geometryPath(pasture.geometry, originX, originY, zoom)} fill={pasture.id === selected?.id ? "rgba(16,185,129,.14)" : "rgba(51,65,85,.06)"} fillRule="evenodd" stroke={pasture.id === selected?.id ? "#047857" : "#475569"} strokeWidth={pasture.id === selected?.id ? 3 : 1.5} className="cursor-pointer" onClick={() => onSelect?.(pasture.id)}/>)}
      </svg>
    </div>
    <div className={`absolute bottom-3 right-3 rounded-md border px-3 py-2 text-[10px] font-semibold shadow ${failed ? "border-amber-200 bg-amber-50/95 text-amber-800" : "border-slate-200 bg-white/95 text-slate-700"}`}>
      {failed ? t("2D карта · WebGL недоступен") : t("2D карта")}
    </div>
  </div>;
}
