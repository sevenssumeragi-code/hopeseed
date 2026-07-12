// ダメージ計算（GDD第16巻20-6正本 + 第6巻7-0-1効果対応 + 第8巻弱点系統）。
// バフ段階: +1段=×1.25／−1段=×0.8（第6巻7-0-1）・±2段まで。

import { DB } from "../../dataLoader.js";
import { enhanceStage } from "../stats.js";
import type { RNG } from "../rng.js";
import type { Skill, SkillEffect } from "../../types.js";

export interface Combatant {
  id: string;
  isEnemy: boolean;
  family?: string;              // 敵のみ
  isBoss?: boolean;
  level: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  mag: number | null;
  buffs: Record<string, number>;
  weaknessFamily?: string | null; // 味方のみ（第8巻: この系統との戦闘で全能力0.7倍）
  isGuarding: boolean;
  hasPoison?: boolean;
  hasAnyStatus?: boolean;
  isHolder?: boolean;
}

export interface DamageContext {
  slot: string;
  protectedTarget: boolean;
  geruInBattleAlive: boolean;
  goddessInParty: boolean;      // 弱点無効（第0巻矛盾#1）
  enemyFamilies: string[];      // 戦闘中の敵系統（弱点判定用）
  rng: RNG;
  awakenedLionProc?: boolean;
  neoNonHolder?: boolean;       // 魔法剣: 非保持者ネオの魔術×1.4
  lightMult?: number;           // 首魁: 光属性被ダメ×2.0
  fixedVariance?: number;       // テスト用
}

// 段階制バフ: +1段×1.25 / −1段×0.8（乗算累積・±2段）
export function applyBuffStage(stat: number, stage: number): number {
  const cap = DB.config.damage.buff_stage_cap;
  const s = Math.max(-cap, Math.min(cap, stage));
  if (s > 0) return stat * Math.pow(DB.config.damage.buff_up_mult, s);
  if (s < 0) return stat * Math.pow(DB.config.damage.buff_down_mult, -s);
  return stat;
}

function nightBonus(skill: Skill, ctx: DamageContext): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "night_bonus");
  if (e && ctx.slot === "night") return e.mult ?? 1.25;
  return 1.0;
}

function antiDemon(skill: Skill, target: Combatant): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "anti_demon");
  if (e && target.family === "demon") return e.mult ?? 1.5;
  return 1.0;
}

// 弱点系統補正（第8巻）: 使用者の弱点系統の敵がいる戦闘では全能力0.7倍。女神在籍で無効。
export function weaknessStatMult(
  weaknessFamily: string | null | undefined,
  ctx: Pick<DamageContext, "enemyFamilies" | "goddessInParty">,
): number {
  if (!weaknessFamily) return 1.0;
  if (ctx.goddessInParty) return 1.0;
  return ctx.enemyFamilies.includes(weaknessFamily)
    ? DB.config.damage.weakness_stat_mult : 1.0;
}

function hpScaling(user: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "hp_scaling");
  if (!e) return 1.0;
  const ratio = user.hp / user.maxHp;
  if (e.mode === "below_half") return ratio <= 0.5 ? (e.mult ?? 1.3) : 1.0; // 希望の一閃
  if (e.mode === "missing") return 1 + (1 - ratio) * (e.mult ?? 1.0);        // 魂の拳
  return 1.0;
}

function selfStatusBonus(user: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "self_status_bonus");
  if (e && user.hasAnyStatus) return e.mult ?? 2.0; // シシの牙
  return 1.0;
}

function poisonTargetBonus(target: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "poison_target_bonus");
  if (e && target.hasPoison) return e.mult ?? 1.5; // 終焉の影
  return 1.0;
}

export function calcDamage(
  user: Combatant, target: Combatant, skill: Skill, ctx: DamageContext,
): number {
  const c = DB.config.damage;

  let stat = skill.kind === "magic" ? (user.mag ?? 0) : user.atk;
  const statKey = skill.kind === "magic" ? "mag" : "atk";
  stat = applyBuffStage(stat, user.buffs[statKey] ?? user.buffs["atk"] ?? 0);
  if (ctx.geruInBattleAlive && !user.isEnemy) stat *= c.geru_leadership_mult;
  // 弱点系統: 使用者の出力低下
  stat *= weaknessStatMult(user.weaknessFamily, ctx);
  // 魔法剣（第6巻7-7: 非保持者ネオの魔術威力×1.4）
  if (ctx.neoNonHolder && user.id === "neo" && skill.kind === "magic") {
    stat *= c.neo_magic_blade_mult;
  }

  const power = (skill.power ?? 0) *
    (user.isEnemy ? 1 : Math.pow(DB.config.enhance.power_mult_per_step, enhanceStage(user.level)));

  let defEff = applyBuffStage(target.def, target.buffs["def"] ?? 0);
  defEff *= weaknessStatMult(target.weaknessFamily, ctx); // 被弾側も全能力0.7倍
  const base = stat * power - defEff * c.def_factor;

  const variance = ctx.fixedVariance ?? ctx.rng.range(c.variance_min, c.variance_max);
  let dmg = base * variance;

  const mults = [
    target.isGuarding ? c.guard_mult : 1.0,
    ctx.protectedTarget ? c.protected_mult : 1.0,
    nightBonus(skill, ctx),
    antiDemon(skill, target),
    ctx.awakenedLionProc ? ((DB.characters["renny"].ability_battle as any).dmg_mult as number) : 1.0,
    hpScaling(user, skill),
    selfStatusBonus(user, skill),
    poisonTargetBonus(target, skill),
    ctx.lightMult ?? 1.0,
  ];
  for (const m of mults) dmg *= m;

  return Math.max(c.min_damage, Math.round(dmg));
}

// 命中判定: 命中率 − 対象回避(バフ込) − 使用者の命中低下 − 天候補正
export function calcHit(
  targetEva: number, targetEvaStage: number, skill: { accuracy: number },
  userHitDebuff: number, rng: RNG, hitPenalty = 0,
): boolean {
  const h = DB.config.hit;
  const evaEff = applyBuffStage(targetEva, targetEvaStage);
  let rate = skill.accuracy - evaEff * h.eva_factor - userHitDebuff - hitPenalty;
  rate = Math.max(h.min_hit, Math.min(h.max_hit, rate));
  return rng.chance(rate / 100);
}

// 庇う成功率 = 50 + 技量×0.3 + 信頼×0.3 + 補正、上限95（第16巻20-8/第4巻）
export function protectRate(skl: number, trust: number, bonus = 0): number {
  const p = DB.config.protect;
  return Math.min(p.cap, p.base_rate + skl * p.skill_factor + trust * p.trust_factor + bonus);
}
