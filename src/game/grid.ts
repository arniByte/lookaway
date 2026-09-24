// Пространственная сетка для запросов «что рядом» (коллайдеры, образцы, фауна).

export class SpatialGrid<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();

  constructor(
    private cell: number,
    items: Iterable<T> = [],
  ) {
    for (const it of items) this.insert(it);
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  insert(it: T): void {
    const k = this.key(Math.floor(it.x / this.cell), Math.floor(it.z / this.cell));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(it);
  }

  /** Кандидаты в квадрате вокруг точки (фильтрацию по точной дистанции делает вызывающий). */
  near(x: number, z: number, r: number): T[] {
    const out: T[] = [];
    const x0 = Math.floor((x - r) / this.cell);
    const x1 = Math.floor((x + r) / this.cell);
    const z0 = Math.floor((z - r) / this.cell);
    const z1 = Math.floor((z + r) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(this.key(cx, cz));
        if (list) out.push(...list);
      }
    }
    return out;
  }
}
