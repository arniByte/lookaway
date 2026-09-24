// Навигация для компаса HUD. Чистые функции: 0 — север (−z), по часовой стрелке, радианы.

/** В диапазон (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t <= 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/** Курс камеры с поворотом yaw (three.js, YXZ): вперёд — (−sin yaw, 0, −cos yaw). */
export const headingOf = (yaw: number) => wrapAngle(-yaw);

/** Азимут на точку со смещением (dx, dz) от игрока. */
export const bearingTo = (dx: number, dz: number) => Math.atan2(dx, -dz);
