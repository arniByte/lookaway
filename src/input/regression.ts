// Взвешенная ridge-регрессия для калибровки взгляда. Без зависимостей: матрицы маленькие (≤ 10×10).

/** Решить A·x = b методом Гаусса с выбором главного элемента. null — вырожденная система. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export interface RidgeFit {
  /** Веса в исходных единицах признаков; w[0] — свободный член (признак 0 должен быть константой 1). */
  w: number[];
}

/**
 * Ridge по стандартизованным признакам (свободный член не штрафуется), веса пересчитаны обратно.
 * X[i][0] = 1. weights — вес строки (например, 1/кадров в точке, чтобы все точки весили одинаково).
 */
export function ridge(X: number[][], y: number[], weights: number[], lambda: number): RidgeFit | null {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (n === 0 || d === 0) return null;
  const wsum = weights.reduce((a, b) => a + b, 0);
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  for (let j = 1; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += weights[i] * X[i][j];
    m /= wsum;
    let v = 0;
    for (let i = 0; i < n; i++) v += weights[i] * (X[i][j] - m) ** 2;
    mean[j] = m;
    sd[j] = Math.sqrt(v / wsum) || 1;
  }
  const Z = X.map((row) => row.map((v, j) => (j === 0 ? 1 : (v - mean[j]) / sd[j])));
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const wi = weights[i];
    for (let a = 0; a < d; a++) {
      b[a] += wi * Z[i][a] * y[i];
      for (let c = 0; c < d; c++) A[a][c] += wi * Z[i][a] * Z[i][c];
    }
  }
  for (let a = 1; a < d; a++) A[a][a] += lambda * wsum;
  const beta = solve(A, b);
  if (!beta) return null;
  const w = new Array(d).fill(0);
  w[0] = beta[0];
  for (let j = 1; j < d; j++) {
    w[j] = beta[j] / sd[j];
    w[0] -= (beta[j] * mean[j]) / sd[j];
  }
  return { w };
}

export const dot = (w: readonly number[], f: readonly number[]): number => {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * f[i];
  return s;
};
