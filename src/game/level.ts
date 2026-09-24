// Геометрия грейбокс-комнаты. Общая для симуляции, рендера и лидара.
import { config as defaultConfig, type Config } from '../config';
import type { Zone } from '../input/types';

export const LANES: readonly Zone[] = ['L', 'C', 'R'];

/** Центр дорожки в координатах gaze.x (центры зон, куда смотрит калибровка). */
export const laneX = (lane: Zone, cfg: Config = defaultConfig): number =>
  lane === 'L' ? -cfg.gaze.calibTarget : lane === 'R' ? cfg.gaze.calibTarget : 0;

/** Угол дорожки от оси взгляда: точка gaze.x = ±2/3 на экране соответствует этому углу при hfov. */
export const gazeToYaw = (x: number, cfg: Config = defaultConfig): number =>
  Math.atan(x * Math.tan(((cfg.render.hfovDeg / 2) * Math.PI) / 180));

export const laneYaw = (lane: Zone, cfg: Config = defaultConfig): number => gazeToYaw(laneX(lane, cfg), cfg);

/** Мировая позиция на дорожке (камера в начале координат, смотрит в −Z). */
export function lanePos(lane: Zone, dist: number, cfg: Config = defaultConfig): { x: number; z: number } {
  const a = laneYaw(lane, cfg);
  return { x: Math.sin(a) * dist, z: -Math.cos(a) * dist };
}

export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/** Комната: ширина, глубина, высота + колонны и хлам. Всё — боксы, чтобы лидар сэмплировал их же. */
export const ROOM = { halfW: 8, depth: 15, height: 3 };

export function roomProps(cfg: Config = defaultConfig): Box[] {
  const boxes: Box[] = [];
  // Колонны между дорожками — ориентиры в темноте, дорожки не перекрывают.
  const mid = laneYaw('R', cfg) / 2;
  for (const d of [5, 10]) {
    for (const s of [-1, 1]) {
      boxes.push({ x: s * Math.sin(mid) * d, y: ROOM.height / 2, z: -Math.cos(mid) * d, w: 0.45, h: ROOM.height, d: 0.45 });
    }
  }
  // Хлам у стен.
  boxes.push({ x: -7.2, y: 0.4, z: -4, w: 1, h: 0.8, d: 1.2 });
  boxes.push({ x: 6.9, y: 0.6, z: -9, w: 1.4, h: 1.2, d: 0.8 });
  boxes.push({ x: -6.5, y: 0.35, z: -12.5, w: 1.8, h: 0.7, d: 0.9 });
  return boxes;
}
