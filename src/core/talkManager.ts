// TalkManager（第9巻12-4「イベント条件の一元管理」＋第11巻14章の脚本再生）。
// シナリオ本文より先の「トリガー評価と脚本再生の仕組み」本体（工程6）。
//
// 扱うイベント種:
//  - ペア掛け合い（15ペア×5話・信頼度20/40/60/80/100・両者在籍・拠点で夕or夜）
//  - 3人掛け合い（レニィ×ジンパチ×ヒュウ・3ペア合計120/180/240）
//  - 庇う特別（ペア合算3/7/15回・3段階）
//  - 個人信頼度イベント（対保持者20/40/60/80/100・拠点で朝）
//  - 全員参加イベント（100/200/349日目）
//  - 隠しイベント（12本・固有条件）
// 優先度（12-4【AI提案】）: メイン（ルート）＞個人＞掛け合い＞庇う特別。未発生分は繰り越し。

import { DB } from "../dataLoader.js";
import type { TrustManager } from "./trustManager.js";
import type { GameState } from "../types.js";

export type TalkKind = "party" | "hidden" | "personal" | "pair" | "group" | "protect_special";

export interface AvailableTalk {
  id: string;
  kind: TalkKind;
  title: string;
  pair?: string;          // pair/protect_special
  char?: string;          // personal
  n?: number;
}

export interface PlayedTalk {
  id: string;
  kind: TalkKind;
  title: string;
  text: string;
  rewardLines: string[];
}

const KIND_PRIORITY: TalkKind[] = ["party", "hidden", "personal", "pair", "group", "protect_special"];

export class TalkManager {
  constructor(private gs: GameState, private trust: TrustManager) {}

  private played(id: string): boolean {
    return !!this.gs.flags[`${id}_done`];
  }

  private bothActive(pair: string): boolean {
    return pair.split(":").every((id) => {
      const c = this.gs.party[id];
      return c && c.exclusion === "none" && c.comaDaysLeft === 0;
    });
  }

  private atBaseEveningOrNight(): boolean {
    return this.gs.location === "base" && (this.gs.slot === "evening" || this.gs.slot === "night");
  }

  // ============ 一覧（優先度順・12-4） ============
  available(): AvailableTalk[] {
    const out: AvailableTalk[] = [
      ...this.availablePartyEvents(),
      ...this.availableHidden(),
      ...this.availablePersonal(),
      ...this.availablePairTalks(),
      ...this.availableGroupTalks(),
      ...this.availableProtectSpecials(),
    ];
    return out.sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind));
  }

  // ペア掛け合い: 各ペアの「次の話」のみ列挙（第1〜5話は順番に解放）
  availablePairTalks(): AvailableTalk[] {
    if (!this.atBaseEveningOrNight()) return [];
    const thresholds: number[] = DB.config.trust.pair_talk_thresholds;
    const out: AvailableTalk[] = [];
    for (const key of Object.keys(this.gs.trust)) {
      if (!this.bothActive(key)) continue;
      const talks = (DB.talks.pair_talks as any[])
        .filter((t) => t.pair === key)
        .sort((a, b) => a.n - b.n);
      const next = talks.find((t) => !this.played(t.id));
      if (!next) continue;
      if (this.trust.pair(...(key.split(":") as [string, string])) >= thresholds[next.n - 1]) {
        out.push({ id: next.id, kind: "pair", title: next.title, pair: key, n: next.n });
      }
    }
    return out;
  }

  // 3人掛け合い: 3ペア合計120/180/240（第9巻12-4）
  availableGroupTalks(): AvailableTalk[] {
    if (!this.atBaseEveningOrNight()) return [];
    const trio: string[] = DB.trust.group_trio;
    if (!trio.every((id) => {
      const c = this.gs.party[id];
      return c && c.exclusion === "none" && c.comaDaysLeft === 0;
    })) return [];
    let sum = 0;
    for (let i = 0; i < trio.length; i++) {
      for (let j = i + 1; j < trio.length; j++) sum += this.trust.pair(trio[i], trio[j]);
    }
    const out: AvailableTalk[] = [];
    const next = (DB.talks.group_talks as any[])
      .sort((a, b) => a.n - b.n)
      .find((t) => !this.played(t.id));
    if (next && sum >= next.sum_min) {
      out.push({ id: next.id, kind: "group", title: next.title, n: next.n });
    }
    return out;
  }

  // 庇う特別: ペア合算 protect_count 3/7/15（第11巻14-3）
  availableProtectSpecials(): AvailableTalk[] {
    if (this.gs.location !== "base") return [];
    const stages = DB.talks.protect_special_stages as any[];
    const out: AvailableTalk[] = [];
    for (const key of Object.keys(this.gs.trust)) {
      if (!this.bothActive(key)) continue;
      const [a, b] = key.split(":");
      const count = this.trust.pairProtectCount(a, b);
      const next = stages.find((s) => !this.played(`pspecial${s.n}_${key}`));
      if (next && count >= next.count) {
        const sub = next.n === 3 ? DB.talks.protect_special3_subtitles[key] : undefined;
        out.push({
          id: `pspecial${next.n}_${key}`,
          kind: "protect_special",
          title: sub ? `${next.title}「${sub}」` : next.title,
          pair: key, n: next.n,
        });
      }
    }
    return out;
  }

  // 個人信頼度イベント: 対保持者20/40/60/80/100・拠点で朝（第11巻14-5）
  availablePersonal(): AvailableTalk[] {
    if (this.gs.location !== "base" || this.gs.slot !== "morning") return [];
    const out: AvailableTalk[] = [];
    for (const char of Object.keys(this.gs.party)) {
      if (char === this.gs.holder || char === "goddess") continue;
      const c = this.gs.party[char];
      if (!c || c.exclusion !== "none" || c.comaDaysLeft > 0) continue;
      const events = (DB.personal.events as any[])
        .filter((e) => e.char === char)
        .sort((a, b) => a.n - b.n);
      const next = events.find((e) => !this.played(e.id));
      if (next && this.trust.pair(this.gs.holder, char) >= next.trust_req) {
        out.push({ id: next.id, kind: "personal", title: next.title, char, n: next.n });
      }
    }
    return out;
  }

  // 全員参加イベント: 100日目の宴／200日目の会議／決戦前夜（第11巻14-2【AI提案】）
  availablePartyEvents(): AvailableTalk[] {
    const out: AvailableTalk[] = [];
    for (const ev of DB.talks.party_events as any[]) {
      if (this.played(ev.id)) continue;
      if (this.gs.day !== ev.day) continue;
      if (ev.slot && this.gs.slot !== ev.slot && !(ev.slot === "night" && this.gs.slot === "evening")) continue;
      if (this.gs.location !== "base") continue;
      // 「100日目の宴」は全員在籍が条件
      if (ev.id === "party_day100" && Object.values(this.gs.party)
        .some((c) => c.id !== "goddess" && c.exclusion !== "none")) continue;
      out.push({ id: ev.id, kind: "party", title: ev.title });
    }
    return out;
  }

  // 隠しイベント12本の条件評価（第11巻14-4）
  availableHidden(): AvailableTalk[] {
    const out: AvailableTalk[] = [];
    for (const ev of DB.hidden as any[]) {
      if (this.played(ev.id) || this.gs.flags[`${ev.id}_played`]) continue;
      if (!this.hiddenCondOk(ev.trigger ?? {})) continue;
      if ((ev.requires_alive ?? []).some((id: string) => {
        const c = this.gs.party[id];
        return !c || c.exclusion !== "none";
      })) continue;
      out.push({ id: ev.id, kind: "hidden", title: ev.title ?? ev.id });
    }
    return out;
  }

  private hiddenCondOk(t: any): boolean {
    if (t.day_min !== undefined && this.gs.day < t.day_min) return false;
    if (t.day_max !== undefined && this.gs.day > t.day_max) return false;
    if (t.day_exact !== undefined && this.gs.day !== t.day_exact) return false;
    if (t.location !== undefined && this.gs.location !== t.location) return false;
    if (t.slot !== undefined && !t.slot.includes(this.gs.slot)) return false;
    if (t.weather !== undefined && this.gs.weather !== t.weather) return false;
    if (t.flags_all?.some((f: string) => !this.gs.flags[f])) return false;
    if (t.holder_not !== undefined && this.gs.holder === t.holder_not) return false;
    if (t.holder_trust_sum_min !== undefined
      && this.trust.holderTrustSum() < t.holder_trust_sum_min) return false;
    if (t.holder_avg_min !== undefined && this.trust.avgHolder() < t.holder_avg_min) return false;
    if (t.all_pairs_avg_min !== undefined) {
      const vals = Object.values(this.gs.trust);
      const avg = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      if (avg < t.all_pairs_avg_min) return false;
    }
    if (t.pair_trust !== undefined) {
      const [a, b] = (t.pair_trust.pair as string).split(":");
      if (this.trust.pair(a, b) < t.pair_trust.min) return false;
    }
    // 「遅延なく連続12回」= 期限切れ即GOのため達成回数で代替【AI提案】
    if (t.tribute_total_min !== undefined
      && this.gs.tribute.fireCount + this.gs.tribute.waterCount < t.tribute_total_min) return false;
    if (t.dog_spent_min !== undefined && (this.gs.stats.dogSpent ?? 0) < t.dog_spent_min) return false;
    if (t.no_continue && this.gs.continued) return false;
    return true;
  }

  // ============ 再生（報酬適用・第11巻共通報酬） ============
  play(id: string): PlayedTalk | null {
    const gain = DB.trust.gain;
    const rewardLines: string[] = [];

    // ペア掛け合い
    const pt = (DB.talks.pair_talks as any[]).find((t) => t.id === id);
    if (pt) {
      const [a, b] = pt.pair.split(":");
      this.trust.add(a, b, gain.talk_view, `talk:${id}`);
      if (pt.n === 5) {
        // 第5話: 庇う成功率+5%恒久（第11巻共通報酬）
        this.gs.flags[`talk5_${pt.pair}`] = true;
        this.gs.flags[`pair_story_completed_${pt.pair}`] = true; // ED出力（第9巻12-6）
        rewardLines.push(`【恒久】${DB.characters[a].name}と${DB.characters[b].name}の「庇う」成功率+${DB.config.trust.talk5_protect_bonus}%`);
      }
      this.finish(id, "pair");
      return { id, kind: "pair", title: pt.title, text: pt.text, rewardLines };
    }

    // 3人掛け合い
    const gt = (DB.talks.group_talks as any[]).find((t) => t.id === id);
    if (gt) {
      const trio: string[] = DB.trust.group_trio;
      for (let i = 0; i < trio.length; i++) {
        for (let j = i + 1; j < trio.length; j++) {
          this.trust.add(trio[i], trio[j], gain.talk_view, `talk:${id}`);
        }
      }
      if (gt.n === 3) this.gs.flags["ed_flag_group3"] = true; // ED分岐フラグ（第11巻14-2）
      this.finish(id, "group");
      return { id, kind: "group", title: gt.title, text: gt.text, rewardLines };
    }

    // 庇う特別（pspecial{n}_{pair}）
    const pm = id.match(/^pspecial(\d)_(.+)$/);
    if (pm) {
      const n = Number(pm[1]);
      const pair = pm[2];
      const [a, b] = pair.split(":");
      const stage = (DB.talks.protect_special_stages as any[]).find((s) => s.n === n);
      if (!stage) return null;
      const text = stage.text
        .replaceAll("{a}", DB.characters[a].name)
        .replaceAll("{b}", DB.characters[b].name);
      if (stage.trust) this.trust.add(a, b, stage.trust, `pspecial:${id}`);
      if (n === 2) {
        rewardLines.push(`【恒久】このペアの「庇う」成功率+${DB.config.trust.protect_special2_bonus}%`);
      }
      if (n === 3) {
        this.gs.flags[`protect_special_${pair}`] = true; // ED出力（第9巻12-6）
        rewardLines.push("【恒久】二人が同じ戦場に立つとき、受けるダメージ−10%");
      }
      this.finish(id, "protect_special");
      const sub = n === 3 ? DB.talks.protect_special3_subtitles[pair] : undefined;
      return { id, kind: "protect_special", title: sub ? `${stage.title}「${sub}」` : stage.title, text, rewardLines };
    }

    // 個人信頼度イベント（第2巻正本: 効果は各キャラ表の通り）
    const pe = (DB.personal.events as any[]).find((e) => e.id === id);
    if (pe) {
      const amount = pe.trust ?? DB.personal.reward_trust ?? gain.personal_event;
      this.trust.add(this.gs.holder, pe.char, amount, `personal:${id}`);
      if (pe.effect === "trust_all_3") this.trust.addAllPairs(3, `personal:${id}`);      // ムニ「かぞくのえ」
      if (pe.effect === "neo_name_call") this.trust.addCharAll("neo", 5, `personal:${id}`); // ネオ「貴様ではなく」
      if (pe.effect) {
        this.gs.flags[`eff_${pe.effect}`] = true;
        rewardLines.push(`【恒久】${pe.title}の効果を得た`);
      }
      if (pe.n === 5) this.gs.flags[`personal_event_max_${pe.char}`] = true; // ED出力（第9巻12-6）
      this.finish(id, "personal");
      return { id, kind: "personal", title: pe.title, text: pe.text, rewardLines };
    }

    // 全員参加イベント
    const pv = (DB.talks.party_events as any[]).find((e) => e.id === id);
    if (pv) {
      if (pv.trust_all_pairs) this.trust.addAllPairs(pv.trust_all_pairs, `party:${id}`);
      this.finish(id, "party");
      return { id, kind: "party", title: pv.title, text: pv.text, rewardLines };
    }

    // 隠しイベント
    const hd = (DB.hidden as any[]).find((e) => e.id === id);
    if (hd) {
      const variant = hd.variants?.[0];
      const r = hd.rewards ?? {};
      if (r.trust_all_pairs) this.trust.addAllPairs(r.trust_all_pairs, `hidden:${id}`);
      if (r.trust_char_all) this.trust.addCharAll(r.trust_char_all.char, r.trust_char_all.amount, `hidden:${id}`);
      for (const f of hd.sets_flags ?? []) this.gs.flags[f] = true;
      this.finish(id, "hidden");
      return { id, kind: "hidden", title: hd.title ?? id, text: variant?.text ?? "", rewardLines };
    }

    return null;
  }

  private finish(id: string, _kind: TalkKind): void {
    this.gs.flags[`${id}_done`] = true;
    this.gs.journal?.events.push({ day: this.gs.day, id }); // 日誌（第13巻16-2）
  }

  // ============ 信頼度帯のランダム会話（第9巻12-5-1）============
  // 台詞セットA(0-39)/B(40-79)/C(80-100)。汎用文はデータ未受領のため【AI提案】
  flavorLine(a: string, b: string): string {
    const v = this.trust.pair(a, b);
    const an = DB.characters[a].name;
    const bn = DB.characters[b].name;
    if (v >= 80) return `${an}と${bn}は、言葉少なに深い話をしている。昔のこと、これからのこと——二人だけの時間だ。`;
    if (v >= 40) return `${an}と${bn}が軽口を叩き合っている。ずいぶん気安い間柄になったものだ。`;
    return `${an}と${bn}が、ぎこちなく言葉を交わしている。まだ互いに距離がある。`;
  }

  // ED出力（第9巻12-6）
  edOutputs(): {
    trustAvgHolder: number; trustTotal: number;
    pairStoryCompleted: string[]; protectSpecial: string[]; personalEventMax: string[];
  } {
    const flags = this.gs.flags;
    const pick = (prefix: string) => Object.keys(flags)
      .filter((f) => f.startsWith(prefix) && flags[f])
      .map((f) => f.slice(prefix.length));
    return {
      trustAvgHolder: this.trust.avgHolder(),
      trustTotal: this.trust.totalAllPairs(),
      pairStoryCompleted: pick("pair_story_completed_"),
      protectSpecial: pick("protect_special_"),
      personalEventMax: pick("personal_event_max_"),
    };
  }
}
