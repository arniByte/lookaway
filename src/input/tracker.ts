// Единственное место с MediaPipe (CLAUDE.md, правило 1). Кадр камеры → RawFrame + FaceFrame.
// Пиксели не покидают память: яркость считается из уменьшенного кадра и сразу забывается.
import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { config as defaultConfig, type Config } from '../config';
import type { FaceFrame, RawFrame } from './types';

const BLENDSHAPES = {
  blinkL: 'eyeBlinkLeft',
  blinkR: 'eyeBlinkRight',
  squintL: 'eyeSquintLeft',
  squintR: 'eyeSquintRight',
  wideL: 'eyeWideLeft',
  wideR: 'eyeWideRight',
  lookInL: 'eyeLookInLeft',
  lookOutL: 'eyeLookOutLeft',
  lookUpL: 'eyeLookUpLeft',
  lookDownL: 'eyeLookDownLeft',
  lookInR: 'eyeLookInRight',
  lookOutR: 'eyeLookOutRight',
  lookUpR: 'eyeLookUpRight',
  lookDownR: 'eyeLookDownRight',
} as const satisfies Partial<Record<keyof RawFrame, string>>;

// Индексы face mesh (478 точек с радужкой).
const LM = {
  noseTip: 1,
  faceEdgeA: 234,
  faceEdgeB: 454,
  forehead: 10,
  chin: 152,
  eyes: [
    { corners: [33, 133], top: 159, bottom: 145 },
    { corners: [362, 263], top: 386, bottom: 374 },
  ],
  irisCenters: [468, 473],
} as const;

export const EYE_OUTLINE: readonly (readonly number[])[] = [
  [33, 160, 158, 133, 153, 144],
  [362, 385, 387, 263, 373, 380],
];

const emptyRaw = (t: number, luma: number): RawFrame => ({
  t, face: 0, luma,
  blinkL: 0, blinkR: 0, squintL: 0, squintR: 0, wideL: 0, wideR: 0,
  lookInL: 0, lookOutL: 0, lookUpL: 0, lookDownL: 0,
  lookInR: 0, lookOutR: 0, lookUpR: 0, lookDownR: 0,
  headYaw: 0, headPitch: 0, irisX: 0, irisY: 0,
});

export interface TrackerOutput {
  raw: RawFrame;
  face: FaceFrame | null;
}

export class FaceTracker {
  private lumaCtx: CanvasRenderingContext2D;
  private luma = 0;
  private frame = 0;

  private constructor(
    private lm: FaceLandmarker,
    readonly delegate: 'GPU' | 'CPU',
    private cfg: Config,
  ) {
    const c = document.createElement('canvas');
    c.width = cfg.tracker.lumaSize.w;
    c.height = cfg.tracker.lumaSize.h;
    this.lumaCtx = c.getContext('2d', { willReadFrequently: true })!;
  }

  static async create(cfg: Config = defaultConfig): Promise<FaceTracker> {
    const base = import.meta.env.BASE_URL;
    const fileset = await FilesetResolver.forVisionTasks(base + cfg.tracker.wasmPath);
    const make = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + cfg.tracker.modelPath, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false, // поворот головы — из landmarks (TECH → Сигналы)
      });
    try {
      return new FaceTracker(await make(cfg.tracker.delegate), cfg.tracker.delegate, cfg);
    } catch (err) {
      if (cfg.tracker.delegate === 'CPU') throw err;
      console.warn('[tracker] GPU delegate не поднялся, пробую CPU', err);
      return new FaceTracker(await make('CPU'), 'CPU', cfg);
    }
  }

  /** t — монотонное время в мс (MediaPipe требует возрастающие timestamps). */
  detect(video: HTMLVideoElement, t: number): TrackerOutput {
    const res = this.lm.detectForVideo(video, t);
    const pts = res.faceLandmarks[0];
    const shapes = res.faceBlendshapes[0]?.categories;

    if (this.frame++ % this.cfg.tracker.lumaEveryNFrames === 0) this.luma = this.sampleLuma(video, pts);
    if (!pts || !shapes) return { raw: emptyRaw(t, this.luma), face: null };

    const raw = emptyRaw(t, this.luma);
    raw.face = 1;
    const byName = new Map(shapes.map((c) => [c.categoryName, c.score]));
    for (const [key, name] of Object.entries(BLENDSHAPES) as [keyof typeof BLENDSHAPES, string][]) {
      raw[key] = byName.get(name) ?? 0;
    }

    const nose = pts[LM.noseTip];
    const a = pts[LM.faceEdgeA];
    const b = pts[LM.faceEdgeB];
    const top = pts[LM.forehead];
    const chin = pts[LM.chin];
    raw.headYaw = (nose.x - a.x) / (b.x - a.x || 1e-6) - 0.5;
    raw.headPitch = (nose.y - top.y) / (chin.y - top.y || 1e-6) - 0.5;

    const iris = irisOffset(pts);
    raw.irisX = iris.x;
    raw.irisY = iris.y;

    const points = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => points.set([p.x, p.y, p.z], i * 3));
    return { raw, face: { t, points } };
  }

  close(): void {
    this.lm.close();
  }

  private sampleLuma(video: HTMLVideoElement, pts: NormalizedLandmark[] | undefined): number {
    const { w, h } = this.cfg.tracker.lumaSize;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return 0;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    if (pts) {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      sx = Math.max(0, x0 * vw);
      sy = Math.max(0, y0 * vh);
      sw = Math.max(1, Math.min(vw - sx, (x1 - x0) * vw));
      sh = Math.max(1, Math.min(vh - sy, (y1 - y0) * vh));
    }
    this.lumaCtx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    const d = this.lumaCtx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (w * h * 255);
  }
}

/** Смещение зрачка в прорези глаза, −0.5..0.5, среднее по глазам. Радужка приписывается ближайшему глазу. */
function irisOffset(pts: NormalizedLandmark[]): { x: number; y: number } {
  if (pts.length < 478) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const ci of LM.irisCenters) {
    const c = pts[ci];
    const eye = [...LM.eyes].sort((e1, e2) => distToEye(c, pts, e1) - distToEye(c, pts, e2))[0];
    const p = pts[eye.corners[0]];
    const q = pts[eye.corners[1]];
    const x0 = Math.min(p.x, q.x);
    const x1 = Math.max(p.x, q.x);
    const top = pts[eye.top];
    const bottom = pts[eye.bottom];
    sx += (c.x - x0) / (x1 - x0 || 1e-6) - 0.5;
    sy += (c.y - top.y) / (bottom.y - top.y || 1e-6) - 0.5;
  }
  return { x: sx / 2, y: sy / 2 };
}

function distToEye(c: NormalizedLandmark, pts: NormalizedLandmark[], eye: (typeof LM.eyes)[number]): number {
  const p = pts[eye.corners[0]];
  const q = pts[eye.corners[1]];
  return Math.hypot(c.x - (p.x + q.x) / 2, c.y - (p.y + q.y) / 2);
}
