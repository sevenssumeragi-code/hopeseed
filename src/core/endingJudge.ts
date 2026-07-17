// EndingJudge（第12巻15章・正本）。365日目に判定。
// STEP1: ルート=保持者 → STEP2: グレード（真/グッド/ノーマル/ビター・15-2）
// → STEP3: エピローグ合成（ルート別＋ペア後日談＋庇う特別＋特殊分岐15-4）。
// ※「生存」=死亡・誘拐除外でないこと。昏睡・状態異常・裏切り中は生存扱い（15-1）。
// ※湖の女神の加入有無はグレード判定に影響しない（演出のみ）。

import { DB } from "../dataLoader.js";
import type { PartyManager } from "./partyManager.js";
import type { TrustManager } from "./trustManager.js";
import type { EventManager } from "./eventManager.js";
import type { GameState } from "../types.js";

export type EndingGrade = "true" | "good" | "normal" | "bitter";

export interface EndingResult {
  id: string;            // ED01〜ED22（15-5）
  grade: EndingGrade;
  name: string;          // ED名（コンプリート管理用）
  gradeName: string;     // グレードED名
  route: string;
  texts: string[];       // 合成エピローグ（本編→ルート→特殊→後日談）
  needsNeoChoice: boolean; // ネオルート帰還/残留の選択待ち（15-4-1）
  // 互換用（旧UI）
  desc: string;
}

const MEMBERS = ["renny", "jinpachi", "hyu", "muni", "geru", "neo"];

export class EndingJudge {
  constructor(
    private gs: GameState,
    _party: PartyManager,
    private trust: TrustManager,
    private events: EventManager,
  ) {}

  // 除外者 = 保持者以外で死亡・誘拐のメンバー（15-1）
  private excludedMembers(): string[] {
    return MEMBERS.filter((id) => id !== this.gs.holder).filter((id) => {
      const c = this.gs.party[id];
      return !c || c.exclusion === "dead" || c.exclusion === "kidnapped";
    });
  }

  gradeOf(): EndingGrade {
    const excluded = this.excludedMembers();
    const others = MEMBERS.length - 1;
    const avg = this.trust.avgHolder();
    const core7 = this.events.coreEventCount() >= 7;
    const hiddenFlag = !!this.gs.flags["ed_flag_starry_night"] || !!this.gs.flags["ed_flag_holder_night"];
    if (excluded.length === 0 && avg >= 80 && core7 && hiddenFlag) return "true";
    if (excluded.length === 0 && avg >= 50) return "good";
    if (excluded.length < others) return "normal";
    return "bitter";
  }

  // neoChoice: ネオルート真/グッドでN5消化済みの場合の帰還/残留（15-4-1）
  judge(neoChoice?: "return" | "stay"): EndingResult {
    const route = this.gs.holder;
    const grade = this.gradeOf();
    const ed = DB.endings;
    const texts: string[] = [];
    let id: string = grade === "bitter" ? ed.ed_ids.bitter : ed.ed_ids[grade][route];
    let needsNeoChoice = false;

    // 本編（グレード共通文）
    texts.push(ed.grades[grade].common);

    if (grade !== "bitter") {
      // ネオルートの帰還/残留選択（真・グッドのみ・N5消化済み）
      const neoBranch = route === "neo" && (grade === "true" || grade === "good")
        && !!this.gs.flags["route_neo_N5_done"];
      if (neoBranch && !neoChoice) {
        needsNeoChoice = true;
      } else if (neoBranch && neoChoice) {
        const sp = neoChoice === "return" ? ed.specials.neo_return : ed.specials.neo_stay;
        id = sp.ed_id;
        texts.push(sp.text);
        // trust_avg 90以上の帰還には隠し後日談「裂け目の向こうから手紙が届く」
        if (neoChoice === "return" && this.trust.avgHolder() >= 90) {
          texts.push(ed.specials.neo_letter);
        }
      } else {
        // ムニルート「再会」分岐（真EDの上位版・15-4-2）
        const muniReunion = route === "muni" && grade === "true"
          && !!this.gs.flags["route_muni_M5_done"]
          && !!this.gs.flags["hidden_dream_reunion_done"];
        if (muniReunion) {
          id = ed.specials.muni_reunion.ed_id;
          texts.push(ed.specials.muni_reunion.text);
        } else {
          texts.push(ed.route_epilogues[route]?.[grade === "true" ? "true" : grade === "good" ? "good" : "normal"] ?? "");
          if (route === "muni" && grade === "true") texts.push(ed.specials.muni_hope);
        }
      }

      // ノーマルEDの誘拐差分（15-2）
      if (grade === "normal" && this.excludedMembers().some((m) => this.gs.party[m]?.exclusion === "kidnapped")) {
        texts.push(ed.specials.normal_kidnap_note);
      }

      // 3人組エピローグ「卒業」（15-4-3: グループ第3話済＋3人生存・真/グッド）
      if ((grade === "true" || grade === "good")
        && this.gs.flags["talk_group3_3_done"]
        && ["renny", "jinpachi", "hyu"].every((c) => this.gs.party[c]?.exclusion === "none"
          || this.gs.party[c]?.exclusion === "coma")) {
        texts.push(ed.specials.group3);
      }

      // 湖の女神の見送り差分（15-4-4）
      if (this.gs.flags["goddess_joined"]) texts.push(ed.specials.goddess_sendoff);
    }

    // ペア後日談・庇う特別エピローグ（15-4-5）
    const pairDone = Object.keys(this.gs.flags)
      .filter((f) => f.startsWith("pair_story_completed_") && this.gs.flags[f]);
    if (pairDone.length > 0 && grade !== "bitter") {
      texts.push(`——エンドロールに、${pairDone.length}組の後日談が流れた。`);
    }
    const pspecial = Object.keys(this.gs.flags)
      .filter((f) => f.startsWith("protect_special_") && this.gs.flags[f])
      .map((f) => f.slice("protect_special_".length));
    for (const pair of pspecial) {
      const sub = DB.talks.protect_special3_subtitles[pair];
      if (sub && grade !== "bitter") {
        texts.push(`——「背中を預けた二人」${sub ? `〈${sub}〉` : ""}の特別後日談が追加された。`);
      }
    }

    const name = ed.ed_names[id] ?? ed.grades[grade].name;
    return {
      id, grade, name,
      gradeName: ed.grades[grade].name,
      route, texts, needsNeoChoice,
      desc: texts[0] ?? "",
    };
  }
}
