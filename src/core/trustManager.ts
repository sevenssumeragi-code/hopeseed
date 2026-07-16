// TrustManager（GDD第16巻20-5: 第9巻の唯一の窓口）。
// 第9巻12章正本: 値域0-100(12-1)・段階名(12-2)・増減テーブル(12-3)・
// ムニ保持者×1.5切り上げ(12-3-1)・就寝時の要約表示(12-7)。ペアキーは英語ID昇順 'a:b'。

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
    // ムニ保持者は全上昇×1.5切り上げ（下降は対象外・12-3-1）
    if (this.gs.holder === "muni" && amount > 0) {
      v = Math.ceil(amount * DB.config.trust.muni_holder_mult);
    }
    const { min, max } = DB.config.trust;
    this.gs.trust[key] = Math.max(min, Math.min(max, this.gs.trust[key] + v));
    // 就寝時の要約表示用に上昇を記録（12-7: 数値でなく雰囲気で伝える）
    if (v > 0) {
      this.gs.trustDelta ??= {};
      this.gs.trustDelta[key] = (this.gs.trustDelta[key] ?? 0) + v;
    }
  }

  // キャラAと他の全ペアに一括加算（誕生日・蘇生等の「〜絡み全ペア」用）
  addCharAll(a: string, amount: number, reason: string): void {
    for (const other of Object.keys(this.gs.party)) {
      if (other !== a) this.add(a, other, amount, reason);
    }
  }

  // 全15ペアに一括加算（宴・死亡ペナルティ等）
  addAllPairs(amount: number, reason: string): void {
    for (const key of Object.keys(this.gs.trust)) {
      const [a, b] = key.split(":");
      this.add(a, b, amount, reason);
    }
  }

  pair(a: string, b: string): number {
    return this.gs.trust[pairKey(a, b)] ?? 0;
  }

  // 段階名（12-2: 他人/知人/仲間/友達/親友/絆）
  stageName(v: number): string {
    const stages = DB.trust.stages as { min: number; name: string }[];
    let name = stages[0].name;
    for (const s of stages) if (v >= s.min) name = s.name;
    return name;
  }

  // 保持者と他メンバーの平均信頼度（12-6: trust_avg_holder）
  avgHolder(): number {
    const holder = this.gs.holder;
    const others = Object.keys(this.gs.party).filter((id) => id !== holder);
    const vals = others
      .map((id) => this.gs.trust[pairKey(holder, id)])
      .filter((v): v is number => v !== undefined);
    if (vals.length === 0) return 0;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  // 保持者⇔5人の合計（湖の女神加入条件・第9巻12-4）
  holderTrustSum(): number {
    const holder = this.gs.holder;
    return Object.keys(this.gs.party)
      .filter((id) => id !== holder)
      .reduce((s, id) => s + (this.gs.trust[pairKey(holder, id)] ?? 0), 0);
  }

  // 全15ペア合計（12-6: trust_total 0〜1500）
  totalAllPairs(): number {
    return Object.values(this.gs.trust).reduce((s, v) => s + v, 0);
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
  // 特別掛け合いの解放判定はペア合算（第11巻14-3）で TalkManager が行う
  onProtectSuccess(from: string, to: string): string | null {
    const key = `${from}>${to}`;
    this.gs.protectCounts[key] = (this.gs.protectCounts[key] ?? 0) + 1;
    this.add(from, to, DB.config.trust_battle.protect_success, "protect_success");
    this.gs.stats.protectSuccess++;
    const thresholds: number[] = DB.config.protect.special_thresholds;
    if (thresholds.includes(this.pairProtectCount(from, to))) {
      return `protect_special_${pairKey(from, to)}_${this.pairProtectCount(from, to)}`;
    }
    return null;
  }

  // ペアの庇う成功回数・合算（第11巻14-3【AI提案：合算方式】）
  pairProtectCount(a: string, b: string): number {
    return (this.gs.protectCounts[`${a}>${b}`] ?? 0) + (this.gs.protectCounts[`${b}>${a}`] ?? 0);
  }

  // 全ペア信頼度合計（取り憑き抵抗・第4巻5-9／裏切り回避式・第9巻12-5-2）
  totalOf(id: string): number {
    const others = Object.keys(this.gs.party).filter((x) => x !== id);
    return others.reduce((s, o) => s + (this.gs.trust[pairKey(id, o)] ?? 0), 0);
  }

  // 裏切り回避率（第9巻12-5-2）: 40 + 対象の全ペア信頼度合計×0.08(最大+40) + 選択肢補正、上限100
  betrayalAvoidRate(targetId: string, choice: "correct" | "neutral" | "wrong"): number {
    const c = DB.config.trust.betrayal_avoid;
    const trustBonus = Math.min(c.trust_bonus_cap, this.totalOf(targetId) * c.per_trust);
    const choiceBonus = choice === "correct" ? c.choice_correct
      : choice === "neutral" ? c.choice_neutral : c.choice_wrong;
    return Math.min(100, c.base + trustBonus + choiceBonus);
  }

  // 就寝時の絆要約（12-7:「AとBの絆が深まった気がする」）。取得後クリア
  consumeDailySummary(): string[] {
    const delta = this.gs.trustDelta ?? {};
    const lines = Object.keys(delta)
      .filter((k) => delta[k] > 0)
      .sort((a, b) => delta[b] - delta[a])
      .slice(0, 3)
      .map((k) => {
        const [a, b] = k.split(":");
        return `${DB.characters[a]?.name}と${DB.characters[b]?.name}の絆が深まった気がする。`;
      });
    this.gs.trustDelta = {};
    return lines;
  }

  // 放置ペナルティの日次処理（12-3-2【AI提案】: 除外7日ごと−1／飢餓3日以上−2全ペア）
  dailyNeglectTick(): void {
    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion === "dead" || c.exclusion === "kidnapped") {
        c.excludedDays = (c.excludedDays ?? 0) + 1;
        if (c.excludedDays % DB.trust.neglect_interval_days === 0) {
          this.addCharAll(c.id, DB.trust.loss.neglect_excluded, "neglect_excluded");
        }
      } else {
        c.excludedDays = 0;
      }
      if (c.exclusion === "none" && c.starveDays >= DB.trust.starve_neglect_from_days) {
        this.addAllPairs(DB.trust.loss.starve_neglect, "starve_neglect");
      }
    }
  }
}
