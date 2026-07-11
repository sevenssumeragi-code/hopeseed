// 敵AI（GDD第16巻20-2 enemy_ai.gd相当）。第8巻のAI詳細未受領のため
// ai種別ごとの基本方針は【AI提案・要差替】。conditionタグ(high_tide等)は正本仕様。

import type { RNG } from "../rng.js";
import type { EnemySkill, EnemyState } from "../../types.js";

export interface AITargetInfo {
  index: number;
  hpRatio: number;
  isHolder: boolean;
  downed: boolean;
}

export interface AIDecision {
  skill: EnemySkill;
  targetIndex: number;
}

function usable(skill: EnemySkill, ctx: { tide: string }): boolean {
  if (skill.condition === "high_tide") return ctx.tide === "high";
  return true;
}

export function decideAction(
  enemy: EnemyState,
  targets: AITargetInfo[],
  ctx: { tide: string; slot: string },
  rng: RNG,
): AIDecision | null {
  const alive = targets.filter((t) => !t.downed);
  if (alive.length === 0) return null;

  const skills = enemy.def.skills.filter((s) => usable(s, ctx));
  if (skills.length === 0) return null;

  let skill: EnemySkill;
  let pool = alive;

  switch (enemy.def.ai) {
    case "predator":
      // 捕食者: HPが低い獲物を狙う。満潮時は引き込みを優先。
      skill = skills.find((s) => s.condition === "high_tide" && ctx.tide === "high")
        ?? rng.pick(skills);
      pool = [...alive].sort((a, b) => a.hpRatio - b.hpRatio).slice(0, 1);
      break;
    case "aggressive":
      skill = rng.pick(skills);
      break;
    case "defensive":
      skill = rng.pick(skills);
      break;
    case "caster":
      // 術師: 補助技を3割で混ぜる
      skill = rng.chance(0.3)
        ? (skills.find((s) => s.power === null) ?? rng.pick(skills))
        : (skills.find((s) => s.power !== null) ?? rng.pick(skills));
      break;
    default:
      // boss_* : 大技を4割、それ以外は通常
      if (enemy.def.ai.startsWith("boss_")) {
        skill = rng.chance(0.4)
          ? skills[skills.length - 1]
          : skills[0];
      } else {
        skill = rng.pick(skills);
      }
  }

  const target = rng.pick(pool);
  return { skill, targetIndex: target.index };
}
