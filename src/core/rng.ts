// シード管理された乱数生成器（GDD第16巻20-5: テスト再現性を確保）。
// mulberry32 — 決定論的で高速。

export class RNG {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number { return min + this.next() * (max - min); }
  int(minInclusive: number, maxInclusive: number): number {
    return Math.floor(this.range(minInclusive, maxInclusive + 1));
  }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  getState(): number { return this.state; }
  setState(s: number): void { this.state = s >>> 0; }
}
