// Контракт input-слоя. Игра, рендер и аудио читают только EyeState (CLAUDE.md, правило 1).

export type Zone = 'L' | 'C' | 'R'; // MVP; позже 3×2

export type EyeEvent =
  | 'blinkStart'
  | 'blinkEnd'
  | 'closeStart'
  | 'closeEnd'
  | 'zoneChange'
  | 'signalLost'
  | 'signalBack';

export interface EyeState {
  t: number; // ms, монотонное: performance.now() или время реплея от 0
  confidence: number; // 0..1
  lost: boolean; // сигнал потерян (после дебаунса); пока true, остальные поля заморожены
  gaze: { x: number; y: number }; // -1..1 после калибровки; x>0 — правая часть экрана, y>0 — верх
  zone: Zone;
  blink: boolean; // веки сомкнуты, но не дольше closedMs
  closed: boolean; // сомкнуты дольше closedMs; никогда не true вместе с blink
  wink: 'L' | 'R' | null; // анатомический глаз игрока
  wide: number; // 0..1
  squint: number; // 0..1, прищур при открытых глазах
  events: EyeEvent[]; // накопленные с прошлого poll()
}

export type SourceKind = 'tracker' | 'fallback' | 'replay';

export interface EyeSource {
  readonly kind: SourceKind;
  start(): Promise<void>;
  stop(): void;
  /** Последнее состояние + все события с прошлого poll. */
  poll(now: number): EyeState;
}

/**
 * Числовой выход трекера за кадр. Формат фикстур.
 * Суффиксы L/R — как в именах MediaPipe (eyeBlinkLeft → blinkL); анатомичность проверяется в оверлее.
 */
export interface RawFrame {
  t: number;
  face: number; // 1 — лицо найдено, 0 — нет (число, чтобы кадр был чисто числовым)
  luma: number; // 0..1, средняя яркость bbox лица
  blinkL: number;
  blinkR: number;
  squintL: number;
  squintR: number;
  wideL: number;
  wideR: number;
  lookInL: number;
  lookOutL: number;
  lookUpL: number;
  lookDownL: number;
  lookInR: number;
  lookOutR: number;
  lookUpR: number;
  lookDownR: number;
  headYaw: number; // прокси из landmarks, доли ширины лица; знак и масштаб снимает калибровка
  headPitch: number;
  irisX: number; // зрачок в прорези глаза, ~−0.5..0.5, среднее по глазам
  irisY: number;
}

export const RAW_KEYS = [
  't', 'face', 'luma',
  'blinkL', 'blinkR', 'squintL', 'squintR', 'wideL', 'wideR',
  'lookInL', 'lookOutL', 'lookUpL', 'lookDownL',
  'lookInR', 'lookOutR', 'lookUpR', 'lookDownR',
  'headYaw', 'headPitch', 'irisX', 'irisY',
] as const satisfies readonly (keyof RawFrame)[];

/** Landmarks для визуализации (лидар-окно, оверлей). Не пишется в фикстуры: биометрия. */
export interface FaceFrame {
  t: number;
  points: Float32Array; // 478 × (x, y, z), нормированные координаты кадра камеры (не зеркальные)
}

export interface CalibrationProfile {
  version: 1;
  calibrated: boolean;
  open: { L: number; R: number }; // blink-score при открытых глазах
  shut: { L: number; R: number }; // blink-score при закрытых
  h: { left: number; center: number; right: number }; // сырой gaze по X в точках калибровки
  v: { down: number; center: number; up: number };
  closedMs: number;
  /** v2: регрессия взгляда по gazeFeatures(). Нет — работает mapAxis по h/v (профиль v1). */
  map?: { x: number[]; y: number[] };
  /** v2: персональные пороги век (нормированный score) из шума открытых глаз. */
  lid?: { on: number; off: number; confirm?: number };
  /** v2: средняя ошибка на валидации, в единицах gaze (экран = 2). */
  accuracy?: number;
}

export type ProtocolId = 'calm' | 'blinks' | 'zones' | 'closed' | 'lost';

export interface Cue {
  t: number; // ms от начала записи
  kind: 'blink' | 'look' | 'close' | 'cover';
  zone?: Zone;
  durMs?: number;
}

export interface FixtureMeta {
  name: string;
  protocol: ProtocolId;
  recordedAt: string;
  durationMs: number;
  conditions: { glasses: boolean; light: 'normal' | 'low' };
  profile: CalibrationProfile;
  cues: Cue[];
  synthetic?: boolean;
  note?: string;
}

export interface Fixture {
  version: 1;
  meta: FixtureMeta;
  frames: RawFrame[];
}
