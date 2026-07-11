// ダメージ計算（GDD第16巻20-6 擬似コードの正本を忠実に移植）。
// 数値は config.json 参照（ハードコード禁止・20-5原則)。

import { DB } from "../../dataLoader.js";
import { enhanceStage } from "../stats.js";
import type { RNG } from "../rng.js";
import type { Skill, SkillEffect } from "../../types.js";

export interface Combatant {
  id: string;
  isEnemy: boolean;
  level: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  mag: number | null;
  buffs: Record<string, number>; // 段階制 -2..+2
  family?: string;               // 敵のみ
  weaknessType?: string;         // 味方のみ
  isGuarding: boolean;
}

export interface DamageContext {
  slot: string;                 // 時間帯
  protectedTarget: boolean;     // 庇われている
  geruInBattleAlive: boolean;   // ゲル統率(×1.4)
  goddessInParty: boolean;      // 弱点無効(矛盾#1採用)
  rng: RNG;
  awakenedLionProc?: boolean;   // レニィ覚醒(事前判定を注入)
}

// 段階制バフ: stage×0.25 を乗算（±2段まで）
export function applyBuffStage(stat: number, stage: number): number {
  const cap = DB.config.damage.buff_stage_cap;
  const per = DB.config.damage.buff_stage_mult;
  const s = Math.max(-cap, Math.min(cap, stage));
  return stat * (1 + per * s);
}

function nightBonus(skill: Skill, ctx: DamageContext): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "night_bonus");
  if (e && ctx.slot === "night") return e.mult ?? 1.3;
  return 1.0;
}

function antiDemon(skill: Skill, target: Combatant): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "anti_demon");
  if (e && target.family === "demon") return e.mult ?? 1.5;
  return 1.0;
}

// 弱点補正: 攻撃側の属性が対象の弱点なら0.7/0.8（受け側被弾増として表現）。
// 女神がパーティにいる間は味方の弱点無効=1.0（第0巻矛盾#1）。
function weaknessMod(skill: Skill, target: Combatant, ctx: DamageContext): number {
  if (!target.weaknessType || target.weaknessType === "none") return 1.0;
  if (!target.isEnemy && ctx.goddessInParty) return 1.0; // 女神浄化で1.0
  // 敵スキル側に属性タグが無い場合は補正なし。属性一致時のみ弱点倍率。
  const skillElement = (skill as unknown as { element?: string }).element;
  if (skillElement && skillElement === target.weaknessType) {
    return 1 / DB.config.damage.weakness_mult; // 被ダメ増(≈1.43倍)
  }
  return 1.0;
}

function hpScaling(user: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "hp_scaling");
  if (!e) return 1.0;
  // HPが減るほど威力上昇: 1.0 + (1 - hp/maxHp) * mult
  return 1.0 + (1 - user.hp / user.maxHp) * (e.mult ?? 1.0);
}

export function calcDamage(
  user: Combatant, target: Combatant, skill: Skill, ctx: DamageContext,
): number {
  const c = DB.config.damage;

  // stat = user.mag if magic else user.atk
  let stat = skill.kind === "magic" ? (user.mag ?? 0) : user.atk;
  // 段階制バフ ±2段
  const statKey = skill.kind === "magic" ? "mag" : "atk";
  stat = applyBuffStage(stat, user.buffs[statKey] ?? 0);
  // ゲル統率
  if (ctx.geruInBattleAlive && !user.isEnemy) stat *= c.geru_leadership_mult;

  // power = skill.power * 1.03^enhance_stage
  const power = (skill.power ?? 0) *
    Math.pow(DB.config.enhance.power_mult_per_step, user.isEnemy ? 0 : enhanceStage(user.level));

  // base = stat*power - target.def_effective*0.5
  const defEff = applyBuffStage(target.def, target.buffs["def"] ?? 0);
  const base = stat * power - defEff * c.def_factor;

  // 乱数幅 0.90..1.10
  let dmg = base * ctx.rng.range(c.variance_min, c.variance_max);

  // 補正の積
  const mults = [
    target.isGuarding ? c.guard_mult : 1.0,
    ctx.protectedTarget ? c.protected_mult : 1.0,
    nightBonus(skill, ctx),
    antiDemon(skill, target),
    weaknessMod(skill, target, ctx),
    ctx.awakenedLionProc ? (DB.characters["renny"].ability_battle as any).dmg_mult : 1.0,
    hpScaling(user, skill),
  ];
  for (const m of mults) dmg *= m;

  return Math.max(c.min_damage, Math.round(dmg));
}

// 命中判定（第4巻5-6-1詳細は未受領。第16巻APIに従い accuracy - eva で判定【AI提案・要差替】）
// userSkl は第4巻受領後に式へ組み込む予定で引数として保持。
export function calcHit(
  _userSkl: number, targetEva: number, skill: Skill, rng: RNG, hitPenalty = 0,
): boolean {
  const h = DB.config.hit;
  let rate = skill.accuracy - targetEva * h.eva_factor - hitPenalty;
  rate = Math.max(h.min_hit, Math.min(h.max_hit, rate));
  return rng.chance(rate / 100);
}

// 庇う成功率 = 50 + 技量*0.3 + 信頼*0.3 + 補正、上限95（第16巻20-8で確定）
export function protectRate(skl: number, trust: number, bonus = 0): number {
  const p = DB.config.protect;
  return Math.min(p.cap, p.base_rate + skl * p.skill_factor + trust * p.trust_factor + bonus);
}
