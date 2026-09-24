// Кладёт wasm и модель MediaPipe в public/mediapipe/ (не в git). Идемпотентно.
// Модель качается один раз и проверяется по sha256.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'mediapipe');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(outDir, 'wasm');
const modelPath = join(outDir, 'face_landmarker.task');

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(outDir, { recursive: true });
// vision_wasm_module_internal.* нужен только при forVisionTasks(path, useModule=true) — не используем, −12 МБ деплоя.
cpSync(wasmSrc, wasmDst, { recursive: true, filter: (src) => !src.includes('module_internal') });
for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) rmSync(join(wasmDst, f), { force: true });

if (existsSync(modelPath) && sha256(readFileSync(modelPath)) === MODEL_SHA256) {
  process.exit(0);
}

console.log(`[setup] downloading ${MODEL_URL}`);
try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  if (hash !== MODEL_SHA256) throw new Error(`sha256 mismatch: ${hash}`);
  writeFileSync(modelPath, buf);
  console.log(`[setup] model ok (${buf.length} bytes)`);
} catch (err) {
  console.error(`[setup] model download failed: ${err.message}`);
  console.error(`[setup] скачай вручную ${MODEL_URL} в ${modelPath}`);
  console.error('[setup] fallback-режим работает и без модели.');
}
