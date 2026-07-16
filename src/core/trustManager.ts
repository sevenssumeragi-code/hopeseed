// TrustManager（GDD第16巻20-5: 第9巻の唯一の窓口）。
// ムニ保持者×1.5切り上げを内包（20-8確定）。ペアキーは英語ID昇順 'a:b'。

import { DB } from "../dataLoader.js";
import type { GameState } from "../types.js";

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export class TrustManager {
  constructor(private gs: GameState) {}

  static initTrust(): Record<string, number> {
    const t: Record<string, number> = {};
    for (const p of DB.trust.pairs as string[]) {
      // データ表記ゆれに備え pairKey で正規化（英語ID昇順・20-9）
      const key = pairKey(...(p.split(":") as [string, string]));
      t[key] = DB.trust.initial_pairs[key] ?? DB.trust.initial_pairs[p] ?? DB.trust.initial_default;
    }
    return t;
  }

  add(a: string, b: string, amount: number, _reason: string): void {
    const key = pairKey(a, b);
    if (!(key in this.gs.trust)) return;
    let v = amount;
    // ムニ保持者は全上昇×1.5切り上げ（下降は対象外）
    if (this.gs.holder === "muni" && amount > 0) {
      v = Math.ceil(amount * DB.config.trust.muni_holder_mult);
    }
    const { min, max } = DB.config.trust;
    this.gs.trust[key] = Math.max(min, Math.min(max, this.gs.trust[key] + v));
  }

  pair(a: string, b: string): number {
    return this.gs.trust[pairKey(a, b)] ?? 0;
  }

  // 保持者と他メンバーの平均信頼度
  avgHolder(): number {
    const holder = this.gs.holder;
    const others = Object.keys(this.gs.party).filter((id) => id !== holder);
    const vals = others
      .map((id) => this.gs.trust[pairKey(holder, id)])
      .filter((v): v is number => v !== undefined);
    if (vals.length === 0) return 0;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  // 特定キャラの、パーティ全員との平均信頼度（庇う成功率などに使用）
  avgOf(id: string): number {
    const others = Object.keys(this.gs.party).filter((x) => x !== id);
    const vals = others
      .map((o) => this.gs.trust[pairKey(id, o)])
      .filter((v): v is number => v !== undefined);
    if (vals.length === 0) return 0;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  // 庇う成功（第4巻5-4-4）: 方向付きカウンタ protect_count[from][to] ＋当該ペア+3
  // 累計3/7/15回で庇う特別掛け合いシナリオ解放（第11巻）
  onProtectSuccess(from: string, to: string): string | null {
    const key = `${from}>${to}`;
    this.gs.protectCounts[key] = (this.gs.protectCounts[key] ?? 0) + 1;
    this.add(from, to, DB.config.trust_battle.protect_success, "protect_success");
    this.gs.stats.protectSuccess++;
    const thresholds: number[] = DB.config.protect.special_thresholds;
    if (thresholds.includes(this.gs.protectCounts[key])) {
      return `protect_special_${key}_${this.gs.protectCounts[key]}`;
    }
    return null;
  }

  // 全ペア信頼度合計（取り憑き抵抗・第4巻5-9）
  totalOf(id: string): number {
    const others = Object.keys(this.gs.party).filter((x) => x !== id);
    return others.reduce((s, o) => s + (this.gs.trust[pairKey(id, o)] ?? 0), 0);
  }
}
