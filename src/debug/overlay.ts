// Debug-оверлей (TECH → Debug-оверлей). Переключение — Backquote (на русской раскладке «ё»).
import { config } from '../config';
import { EYE_OUTLINE } from '../input/tracker';
import { PROTOCOLS } from '../input/protocols';
import type { CalibrationProfile, EyeState, FaceFrame, ProtocolId, RawFrame, SourceKind } from '../input/types';
import { button, el } from './ui';

export interface OverlayHooks {
  selectSource(kind: 'fallback' | 'tracker'): void;
  loadReplay(file: File): void;
  calibrate(): void;
  recenter(): void;
  record(protocol: ProtocolId, conditions: { glasses: boolean; light: 'normal' | 'low' }): void;
}

export interface OverlayInput {
  state: EyeState;
  kind: SourceKind;
  raw: RawFrame | null;
  score: number | null;
  face: FaceFrame | null;
  video: HTMLVideoElement | null;
  stats: { inferMs: number; hz: number; delegate: string; targetHz: number } | null;
  profile: CalibrationProfile | null;
  renderFps: number;
}

interface Sample {
  t: number;
  bL: number;
  bR: number;
  score: number;
  x: number;
  conf: number;
  squint: number;
  shut: boolean;
  lost: boolean;
}

const W = 400;

export class Overlay {
  readonly root: HTMLDivElement;
  private statusEl: HTMLPreElement;
  private infoEl: HTMLPreElement;
  private reportEl: HTMLPreElement;
  private graph: HTMLCanvasElement;
  private cam: HTMLCanvasElement;
  private srcButtons = new Map<string, HTMLButtonElement>();
  private samples: Sample[] = [];
  private lastT = -1;

  constructor(hooks: OverlayHooks) {
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) hooks.loadReplay(f);
      fileInput.value = '';
    });

    const srcRow = el('div', 'display:flex;gap:6px;flex-wrap:wrap');
    const addSrc = (label: string, kind: string, fn: () => void) => {
      const b = button(label, fn);
      this.srcButtons.set(kind, b);
      srcRow.append(b);
    };
    addSrc('Fallback', 'fallback', () => hooks.selectSource('fallback'));
    addSrc('Tracker', 'tracker', () => hooks.selectSource('tracker'));
    addSrc('Replay…', 'replay', () => fileInput.click());

    const protoSel = el('select');
    for (const p of Object.values(PROTOCOLS)) {
      const o = el('option', '', p.title);
      o.value = p.id;
      protoSel.append(o);
    }
    const glasses = el('input');
    glasses.type = 'checkbox';
    const lowLight = el('input');
    lowLight.type = 'checkbox';
    const recRow = el(
      'div',
      'display:flex;gap:6px;flex-wrap:wrap;align-items:center',
      protoSel,
      el('label', '', glasses, ' очки'),
      el('label', '', lowLight, ' слабый свет'),
      button('● Record', () =>
        hooks.record(protoSel.value as ProtocolId, {
          glasses: glasses.checked,
          light: lowLight.checked ? 'low' : 'normal',
        }),
      ),
    );

    this.statusEl = el('pre', 'color:#fc6;min-height:1.4em');
    this.infoEl = el('pre');
    this.reportEl = el('pre', 'color:#9c9');
    this.graph = el('canvas', `width:${W}px;height:220px;background:#080808`);
    this.graph.width = W * devicePixelRatio;
    this.graph.height = 220 * devicePixelRatio;
    this.cam = el('canvas', `width:${W}px;height:300px;background:#080808;display:none`);
    this.cam.width = W * devicePixelRatio;
    this.cam.height = 300 * devicePixelRatio;

    this.root = el(
      'div',
      `position:fixed;top:0;right:0;bottom:0;width:${W + 24}px;overflow-y:auto;background:rgba(0,0,0,.88);border-left:1px solid #333;padding:10px 12px;box-sizing:border-box;z-index:10;display:flex;flex-direction:column;gap:8px`,
      el('div', 'color:#fff', 'LOOK AWAY · M0 debug   (` / ё — скрыть)'),
      el('div', 'color:#777', 'Видео обрабатывается только на этом устройстве и никуда не отправляется.'),
      srcRow,
      el('div', 'display:flex;gap:6px', button('Калибровка', () => hooks.calibrate()), button('Перецентровка', () => hooks.recenter())),
      recRow,
      this.statusEl,
      this.infoEl,
      this.graph,
      this.cam,
      this.reportEl,
      fileInput,
    );
    document.body.append(this.root);

    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') this.toggle();
    });
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  toggle(): void {
    this.root.style.display = this.visible ? 'none' : 'flex';
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setReport(text: string): void {
    this.reportEl.textContent = text;
  }

  update(i: OverlayInput): void {
    const s = i.state;
    if (s.t !== this.lastT) {
      this.lastT = s.t;
      this.samples.push({
        t: s.t,
        bL: i.raw?.blinkL ?? NaN,
        bR: i.raw?.blinkR ?? NaN,
        score: i.score ?? (s.blink || s.closed ? 1 : 0),
        x: s.gaze.x,
        conf: s.confidence,
        squint: s.squint,
        shut: s.blink || s.closed,
        lost: s.lost,
      });
      const cutoff = s.t - config.debug.graphSeconds * 1000;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    }
    if (!this.visible) return;

    for (const [kind, b] of this.srcButtons) b.classList.toggle('on', kind === i.kind);

    const f = (v: number) => v.toFixed(2).padStart(5);
    const lines = [
      `source ${i.kind}   render ${i.renderFps.toFixed(0)} fps`,
      i.stats ? `tracker ${i.stats.hz}/${i.stats.targetHz} Hz   infer ${i.stats.inferMs.toFixed(1)} ms   ${i.stats.delegate}` : '',
      `conf ${f(s.confidence)}   ${s.lost ? 'LOST' : 'ok'}`,
      `zone ${s.zone}   gaze x ${f(s.gaze.x)} y ${f(s.gaze.y)}`,
      `lid ${s.closed ? 'CLOSED' : s.blink ? 'BLINK' : 'open'}   wink ${s.wink ?? '-'}   wide ${f(s.wide)}   squint ${f(s.squint)}`,
      i.raw
        ? `raw blinkL ${f(i.raw.blinkL)} blinkR ${f(i.raw.blinkR)}  squintL ${f(i.raw.squintL)} R ${f(i.raw.squintR)}\n    yaw ${f(i.raw.headYaw)} pitch ${f(i.raw.headPitch)}  iris ${f(i.raw.irisX)} ${f(i.raw.irisY)}  luma ${f(i.raw.luma)}`
        : '',
      i.profile
        ? `профиль: ${
            i.profile.calibrated
              ? `${i.profile.map ? 'v2' : 'v1'}, closedMs ${i.profile.closedMs}` +
                (i.profile.lid ? `, веки on ${i.profile.lid.on.toFixed(2)} off ${i.profile.lid.off.toFixed(2)}` : '') +
                (i.profile.accuracy !== undefined ? `, точность ±${(i.profile.accuracy * 50).toFixed(0)}% экрана` : '')
              : 'НЕ откалиброван — нажми «Калибровка»'
          }`
        : '',
    ];
    this.infoEl.textContent = lines.filter(Boolean).join('\n');

    this.drawGraph(s.t);
    this.drawCam(i);
  }

  private drawGraph(now: number): void {
    const c = this.graph.getContext('2d')!;
    const px = devicePixelRatio;
    const w = this.graph.width;
    const span = config.debug.graphSeconds * 1000;
    const X = (t: number) => w - ((now - t) / span) * w;
    c.clearRect(0, 0, w, this.graph.height);
    c.lineWidth = px;

    const lane = (top: number, h: number, lo: number, hi: number) => (v: number) => (top + h - ((v - lo) / (hi - lo)) * h) * px;
    const blinkY = lane(4, 90, 0, 1);
    const xY = lane(104, 70, -1, 1);
    const confY = lane(182, 34, 0, 1);

    // Фон: сомкнуты / потерян
    for (let k = 1; k < this.samples.length; k++) {
      const a = this.samples[k - 1];
      const b = this.samples[k];
      if (a.lost || a.shut) {
        c.fillStyle = a.lost ? 'rgba(255,60,60,.15)' : 'rgba(80,160,255,.12)';
        c.fillRect(X(a.t), 0, X(b.t) - X(a.t) + 1, this.graph.height);
      }
    }

    const hline = (y: number, color: string) => {
      c.strokeStyle = color;
      c.setLineDash([4 * px, 4 * px]);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
      c.setLineDash([]);
    };
    hline(blinkY(config.lid.onThreshold), '#733');
    hline(blinkY(config.lid.offThreshold), '#373');
    hline(xY(config.zones.boundary), '#444');
    hline(xY(-config.zones.boundary), '#444');
    hline(xY(0), '#222');

    const plot = (get: (s: Sample) => number, y: (v: number) => number, color: string) => {
      c.strokeStyle = color;
      c.beginPath();
      let pen = false;
      for (const s of this.samples) {
        const v = get(s);
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        if (pen) c.lineTo(X(s.t), y(v));
        else c.moveTo(X(s.t), y(v));
        pen = true;
      }
      c.stroke();
    };
    plot((s) => s.bL, blinkY, '#f93');
    plot((s) => s.bR, blinkY, '#3cf');
    plot((s) => s.score, blinkY, '#fff');
    plot((s) => s.x, xY, '#fc6');
    plot((s) => s.conf, confY, '#6c6');
    plot((s) => s.squint, confY, '#c6c');

    c.font = `${10 * px}px monospace`;
    c.fillStyle = '#888';
    c.fillText('blinkL(оранж) blinkR(голуб) score(бел), пороги on/off', 4 * px, 12 * px);
    c.fillText('gaze.x, границы зон', 4 * px, 114 * px);
    c.fillText('confidence(зел) squint(фиол)', 4 * px, 192 * px);
  }

  private drawCam(i: OverlayInput): void {
    const show = i.kind === 'tracker' && !!i.video && i.video.readyState >= 2;
    this.cam.style.display = show ? 'block' : 'none';
    if (!show || !i.video) return;
    const c = this.cam.getContext('2d')!;
    const w = this.cam.width;
    const h = this.cam.height;
    const px = devicePixelRatio;
    // Зеркально, как селфи. Пиксели только рисуются, никуда не уходят.
    c.save();
    c.translate(w, 0);
    c.scale(-1, 1);
    c.drawImage(i.video, 0, 0, w, h);
    c.restore();

    if (i.face) {
      const p = i.face.points;
      c.strokeStyle = '#6cf';
      c.lineWidth = px;
      for (const loop of EYE_OUTLINE) {
        c.beginPath();
        loop.forEach((idx, k) => {
          const x = (1 - p[idx * 3]) * w;
          const y = p[idx * 3 + 1] * h;
          if (k) c.lineTo(x, y);
          else c.moveTo(x, y);
        });
        c.closePath();
        c.stroke();
      }
    }

    if (i.raw) {
      const bar = (label: string, v: number, y: number, color: string) => {
        c.fillStyle = 'rgba(0,0,0,.6)';
        c.fillRect(0, y - 12 * px, w, 16 * px);
        c.fillStyle = color;
        c.fillRect(150 * px, y - 9 * px, v * (w - 160 * px), 10 * px);
        c.font = `${11 * px}px monospace`;
        c.fillText(`${label} ${v.toFixed(2)}`, 6 * px, y);
      };
      bar('eyeBlinkLeft ', i.raw.blinkL, 16 * px, '#f93');
      bar('eyeBlinkRight', i.raw.blinkR, 34 * px, '#3cf');
      c.fillStyle = 'rgba(0,0,0,.6)';
      c.fillRect(0, h - 34 * px, w, 34 * px);
      c.fillStyle = '#ccc';
      c.font = `${10 * px}px monospace`;
      c.fillText('Закрой СВОЙ левый глаз: растёт eyeBlinkLeft → lid.swapLR=false,', 6 * px, h - 20 * px);
      c.fillText('растёт eyeBlinkRight → swapLR=true. Видео зеркальное (селфи).', 6 * px, h - 7 * px);
    }
  }
}
