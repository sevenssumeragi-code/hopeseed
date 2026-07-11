// PartyManager（GDD第16巻20-5）。除外・昏睡の管理と蘇生（湖の祠・7日CD）。

import { DB } from "../dataLoader.js";
import { maxHp, maxSp } from "./stats.js";
import type { CharacterState, ExclusionKind, GameState } from "../types.js";

export function createCharacterState(id: string, level = 1): CharacterState {
  const def = DB.characters[id];
  return {
    id, level, exp: 0,
    hp: maxHp(def, level), sp: maxSp(def, level),
    maxHp: maxHp(def, level), maxSp: maxSp(def, level),
    exclusion: "none", comaDaysLeft: 0, betrayalDaysLeft: 0,
    status: {}, buffs: {}, equippedWeapon: null, downed: false,
  };
}

export class PartyManager {
  constructor(private gs: GameState) {}

  // 除外(死亡/誘拐/裏切り離脱)・昏睡を除く行動可能メンバー
  getActiveMembers(): CharacterState[] {
    return Object.values(this.gs.party).filter(
      (c) => c.exclusion === "none" && c.comaDaysLeft === 0,
    );
  }

  getHolder(): CharacterState { return this.gs.party[this.gs.holder]; }

  applyExclusion(charId: string, kind: ExclusionKind): void {
    const c = this.gs.party[charId];
    if (!c) return;
    c.exclusion = kind;
  }

  // 蘇生: 湖の祠。7日に1人（Lv・技・持ち物・信頼度は引き継がれる=CharacterStateを保持したまま復帰）
  revive(charId: string): boolean {
    const c = this.gs.party[charId];
    if (!c || c.exclusion !== "dead") return false;
    const cd = DB.config.revive.cooldown_days;
    if (this.gs.reviveLastDay > 0 && this.gs.day - this.gs.reviveLastDay < cd) return false;
    c.exclusion = "none";
    c.downed = false;
    c.hp = c.maxHp;
    c.sp = c.maxSp;
    c.status = {};
    this.gs.reviveLastDay = this.gs.day;
    this.gs.stats.revived++;
    return true;
  }

  exclusionCount(): number {
    return Object.values(this.gs.party).filter((c) => c.exclusion !== "none").length;
  }
}
