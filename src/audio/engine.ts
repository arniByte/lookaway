// Общий звуковой движок: один AudioContext на всю игру. Браузер даёт звук только после жеста,
// поэтому контекст создаётся и будится в обработчике первого клика/клавиши (installAudioUnlock),
// а не после await (запуск камеры и модели длится секунды — жест к тому времени «протухает»).
//
// Шина: источники → bus → компрессор → master → выход; send → свёртка (процедурный лес) → компрессор.

export interface Engine {
  ctx: AudioContext;
  bus: GainNode; // сухой вход
  send: GainNode; // вход реверберации
  master: GainNode;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

let engine: Engine | null = null;

export const audio = (): Engine | null => engine;

/** true — звук реально играет (контекст не заблокирован браузером). */
export const audioRunning = (): boolean => engine?.ctx.state === 'running';

/** Создать и разбудить контекст. Вызывать из обработчика жеста. */
export function unlockAudio(): Engine {
  engine ??= create();
  if (engine.ctx.state !== 'running') void engine.ctx.resume();
  return engine;
}

/** Будить звук на каждом жесте: вкладка могла усыпить контекст. */
export function installAudioUnlock(): void {
  const wake = () => unlockAudio();
  addEventListener('pointerdown', wake, { capture: true });
  addEventListener('keydown', wake, { capture: true });
}

function create(): Engine {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.006;
  comp.release.value = 0.25;
  comp.connect(master).connect(ctx.destination);
  const bus = ctx.createGain();
  bus.connect(comp);
  const send = ctx.createGain();
  const verb = ctx.createConvolver();
  verb.buffer = forestImpulse(ctx);
  const ret = ctx.createGain();
  ret.gain.value = 0.55;
  send.connect(verb).connect(ret).connect(comp);
  return { ctx, bus, send, master, white: noise(ctx, 'white'), pink: noise(ctx, 'pink'), brown: noise(ctx, 'brown') };
}

function noise(ctx: AudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') {
        // Фильтр Пола Келлета: −3 дБ/окт.
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
  }
  return buf;
}

/** Импульсная характеристика ночного леса: без стен, рассеянный хвост ~2.5 с, верхи гаснут быстрее. */
function forestImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round(sr * 2.8);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.round(sr * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const k = 0.15 + 0.8 * Math.min(1, t / 1.5); // со временем фильтр темнее
      lp += (Math.random() * 2 - 1 - lp) * (1 - k);
      d[i] = lp * Math.exp(-t * 2.6) * 0.6;
    }
    // Ранние отражения — стволы вокруг.
    for (let r = 0; r < 14; r++) {
      const at = pre + Math.round(sr * (0.008 + Math.random() * 0.09));
      d[at] += (Math.random() * 2 - 1) * 0.5 * Math.exp(-r * 0.12);
    }
  }
  return buf;
}
