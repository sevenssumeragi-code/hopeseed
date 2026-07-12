// ステータス算出（GDD第5巻正本）。
// 能力値(Lv) = round(base + growth×(Lv−1))。丸めは第5巻の表と一致する偶数丸め(round half to even)。
// 女神は第5巻6-7の導出規則（他キャラ同Lv値×係数）。
// EXP: 次Lvまで = round(15 × Lv^1.7)（第5巻6-8/第14巻LEVEL_EXP）。

import { DB } from "../dataLoader.js";
import type { CharacterDef, CharacterState, StatBlock, Skill } from "../types.js";

export type StatName = keyof StatBlock;

// 偶数丸め（第5巻の成長表生成と同一の丸め規則）
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  const eps = 1e-9;
  if (diff > 0.5 + eps) return floor + 1;
  if (diff < 0.5 - eps) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function linearStat(def: CharacterDef, stat: StatName, level: number): number {
  const b = def.base[stat];
  const g = def.growth[stat];
  if (b === null || g === null) return 0;
  const raw = b + g * (level - 1);
  if (stat === "crit") return Math.round(raw * 10) / 10; // 小数第1位
  return roundHalfEven(raw);
}

export function statAtLevel(defOrId: CharacterDef | string, stat: StatName, level: number): number {
  const id = typeof defOrId === "string" ? defOrId : idOf(defOrId);
  const def = typeof defOrId === "string" ? DB.characters[defOrId] : defOrId;

  // 湖の女神: 他キャラ同Lv値からの導出（第5巻6-7）
  if (id === "goddess" && def.derived) {
    if (stat === "crit") {
      const f = def.crit_formula!;
      return Math.round((f.base + f.per_lv * (level - 1)) * 10) / 10;
    }
    if (stat === "mag") return 0;
    const rule = def.derived[stat];
    if (rule) {
      const [refSpec, mult] = rule;
      const [refId, refStatRaw] = refSpec.includes(":") ? refSpec.split(":") : [refSpec, stat];
      const refStat = (refStatRaw || stat) as StatName;
      const refVal = linearStat(DB.characters[refId], refStat, level);
      return roundHalfEven(refVal * mult);
    }
  }
  return linearStat(def, stat, level);
}

function idOf(def: CharacterDef): string {
  for (const [id, d] of Object.entries(DB.characters)) if (d === def) return id;
  return "";
}

export function maxHp(def: CharacterDef, level: number): number {
  return statAtLevel(def, "hp", level);
}
export function maxSp(def: CharacterDef, level: number): number {
  return statAtLevel(def, "sp", level);
}

// 装備込み実効ステータス（肥満は素早さ半減・第14巻18-4）
export function effectiveStat(state: CharacterState, stat: StatName): number {
  let v = statAtLevel(state.id, stat, state.level);
  const w = state.equippedWeapon ? DB.items[state.equippedWeapon] : null;
  if (w) {
    if (stat === "atk" && w.atk_bonus) v += w.atk_bonus;
    if (stat === "mag" && w.mag_bonus) v += w.mag_bonus;
  }
  if (stat === "spd" && state.status.obesity) v = Math.floor(v / 2);
  return v;
}

// キャラの技一覧（owner一致・learn_lv順）。ネオは剣技+魔術の両方。
export function skillsForCharacter(charId: string): [string, Skill][] {
  return Object.entries(DB.skills)
    .filter(([, s]) => s.owner === charId)
    .sort((a, b) => a[1].learn_lv - b[1].learn_lv);
}

// Lv61+強化（第6巻7-9）: Lv65から5Lvごと+Lv99で計8段階
export function enhanceStage(level: number): number {
  if (level >= 99) return DB.config.enhance.max_stage;
  return Math.floor(Math.max(0, level - DB.config.enhance.start_level) / DB.config.enhance.step_levels);
}

// 強化適用後の技パラメータ（倍率×1.03^n / 命中+1×n / SP−1×n・下限max(3, ceil(基礎×0.6))）
export function enhancedSkill(skill: Skill, level: number): Skill {
  const stage = enhanceStage(level);
  if (stage === 0) return skill;
  const c = DB.config.enhance;
  const spFloor = Math.max(c.sp_floor_min, Math.ceil(skill.sp_cost * c.sp_floor_ratio));
  return {
    ...skill,
    power: skill.power === null ? null : skill.power * Math.pow(c.power_mult_per_step, stage),
    accuracy: Math.min(100, skill.accuracy + c.acc_per_step * stage),
    sp_cost: Math.max(spFloor, skill.sp_cost - c.sp_reduce_per_step * stage),
    effects: skill.effects.map((e) =>
      e.type === "heal" && e.coef !== undefined
        ? { ...e, coef: e.coef * Math.pow(c.power_mult_per_step, stage) }
        : e,
    ),
  };
}

// 次Lvまでの必要EXP = round(15 × Lv^1.7)（第5巻6-8）
export function expToNext(level: number): number {
  return Math.round(DB.config.exp.level_coef * Math.pow(level, DB.config.exp.level_pow));
}
