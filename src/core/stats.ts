// Lv別実数値の実行時算出（GDD第16巻20-3-1: base + growth*(Lv-1)。第5巻の表は検証用）。

import { DB } from "../dataLoader.js";
import type { CharacterDef, CharacterState, StatBlock } from "../types.js";

export type StatName = keyof StatBlock;

export function statAtLevel(def: CharacterDef, stat: StatName, level: number): number {
  const b = def.base[stat];
  const g = def.growth[stat];
  if (b === null || g === null) return 0;
  const raw = b + g * (level - 1);
  // hp/sp は整数、他は小数1桁で保持（戦闘計算は四捨五入）
  if (stat === "crit") return Math.round(raw * 100) / 100;
  return Math.round(raw);
}

export function maxHp(def: CharacterDef, level: number): number { return statAtLevel(def, "hp", level); }
export function maxSp(def: CharacterDef, level: number): number { return statAtLevel(def, "sp", level); }

// 装備込みの実効ステータス（戦闘バフ段階は damageCalc 側で乗算）
export function effectiveStat(state: CharacterState, stat: StatName): number {
  const def = DB.characters[state.id];
  let v = statAtLevel(def, stat, state.level);
  if (stat === "atk" && state.equippedWeapon) {
    const w = DB.items[state.equippedWeapon];
    if (w?.atk_bonus) v += w.atk_bonus;
  }
  return v;
}

// enhance_stage = floor(max(0, Lv-60)/5)（第16巻20-3-2 / config.enhance）
export function enhanceStage(level: number): number {
  const c = DB.config.enhance;
  return Math.floor(Math.max(0, level - c.start_level) / c.step_levels);
}

// Lv1..99 の必要経験値（単純曲線・第18巻未受領のため【AI提案】）
export function expToNext(level: number): number {
  return Math.round(12 * Math.pow(level, 1.8));
}
