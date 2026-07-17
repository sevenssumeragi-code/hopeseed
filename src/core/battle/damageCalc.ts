// ダメージ・命中・庇う計算（GDD第4巻5-5/5-6/5-4-4 正本 + 第6巻7-0-1）。
// バフ段階: +1段×1.25/+2段×1.5625(上限)、−1段×0.8/−2段×0.64（第4巻5-5-4）。

import { DB } from "../../dataLoader.js";
import { enhanceStage } from "../stats.js";
import type { RNG } from "../rng.js";
import type { Skill, SkillEffect } from "../../types.js";

export interface Combatant {
  id: string;
  isEnemy: boolean;
  family?: string;
  isBoss?: boolean;
  level: number;
  hp: number;
  maxHp: number;
  atk: number;                 // パッシブ・大火傷補正適用済みの実効値
  def: number;                 // 同上（闇の加護等適用済み）
  mag: number | null;
  buffs: Record<string, number>;
  weaknessFamily?: string | null;
  weaknessMult?: number;   // 個人イベントによる弱点緩和 0.7→0.8（第2巻）
  isGuarding: boolean;
  hasPoison?: boolean;
  hasAnyStatus?: boolean;
  isHolder?: boolean;
}

export interface DamageContext {
  slot: string;
  location: string;
  protectedTarget: boolean;
  geruLeadership: boolean;      // ゲル参加中・戦闘不能でない・非保持者（第4巻5-5-3）
  goddessInParty: boolean;
  enemyFamilies: string[];
  rng: RNG;
  awakenedLionProc?: boolean;
  neoNonHolder?: boolean;
  lightMult?: number;
  fixedVariance?: number;
}

// 段階制バフ（第4巻5-5-4: +1=×1.25/+2=×1.5625相当。−1=×0.8/−2=×0.64）
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

// 弱点系統補正（第4巻5-5-3: 全能力×0.7。女神「弱点浄化」で無効）
export function weaknessStatMult(
  weaknessFamily: string | null | undefined,
  ctx: Pick<DamageContext, "enemyFamilies" | "goddessInParty">,
  weaknessMult?: number,
): number {
  if (!weaknessFamily) return 1.0;
  if (ctx.goddessInParty) return 1.0;
  return ctx.enemyFamilies.includes(weaknessFamily)
    ? (weaknessMult ?? DB.config.damage.weakness_stat_mult) : 1.0;
}

function hpScaling(user: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "hp_scaling");
  if (!e) return 1.0;
  const ratio = user.hp / user.maxHp;
  if (e.mode === "below_half") return ratio <= 0.5 ? (e.mult ?? 1.3) : 1.0;
  if (e.mode === "missing") return 1 + (1 - ratio) * (e.mult ?? 1.0);
  return 1.0;
}

function selfStatusBonus(user: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "self_status_bonus");
  if (e && user.hasAnyStatus) return e.mult ?? 2.0;
  return 1.0;
}

function poisonTargetBonus(target: Combatant, skill: Skill): number {
  const e = skill.effects.find((x: SkillEffect) => x.type === "poison_target_bonus");
  if (e && target.hasPoison) return e.mult ?? 1.5;
  return 1.0;
}

// ダメージ計算（第4巻5-5）
export function calcDamage(
  user: Combatant, target: Combatant, skill: Skill, ctx: DamageContext,
): number {
  const c = DB.config.damage;

  let stat = skill.kind === "magic" ? (user.mag ?? 0) : user.atk;
  const statKey = skill.kind === "magic" ? "mag" : "atk";
  stat = applyBuffStage(stat, user.buffs[statKey] ?? user.buffs["atk"] ?? 0);
  if (ctx.geruLeadership && !user.isEnemy) stat *= c.geru_leadership_mult;
  stat *= weaknessStatMult(user.weaknessFamily, ctx, user.weaknessMult);
  if (ctx.neoNonHolder && user.id === "neo" && skill.kind === "magic") {
    stat *= c.neo_magic_blade_mult;
  }

  const power = (skill.power ?? 0) *
    (user.isEnemy ? 1 : Math.pow(DB.config.enhance.power_mult_per_step, enhanceStage(user.level)));

  let defEff = applyBuffStage(target.def, target.buffs["def"] ?? 0);
  defEff *= weaknessStatMult(target.weaknessFamily, ctx, target.weaknessMult);
  const base = stat * power - defEff * c.def_factor;

  const variance = ctx.fixedVariance ?? ctx.rng.range(c.variance_min, c.variance_max);
  let dmg = base * variance;

  const mults = [
    target.isGuarding ? DB.config.guard.damage_mult : 1.0,
    ctx.protectedTarget ? c.protected_mult : 1.0,      // 庇う軽減×0.5（第4巻5-4-4）
    nightBonus(skill, ctx),
    antiDemon(skill, target),
    ctx.awakenedLionProc ? (DB.config.passives.renny_awakened_lion.dmg_mult as number) : 1.0,
    hpScaling(user, skill),
    selfStatusBonus(user, skill),
    poisonTargetBonus(target, skill),
    ctx.lightMult ?? 1.0,
  ];
  for (const m of mults) dmg *= m;

  return Math.max(c.min_damage, Math.round(dmg));
}

// 命中判定（第4巻5-6-1・正本）:
// 最終命中率 = 技の基礎命中率 + (攻撃側の技量 − 対象の回避力)×0.2 + 命中系デバフ
// 上限100/下限10。回避は命中判定に内包（失敗=回避）。
export function calcHit(
  userSkl: number, targetEva: number, targetEvaStage: number,
  accuracy: number, userHitDebuff: number, rng: RNG, hitPenalty = 0,
): boolean {
  const h = DB.config.hit;
  const evaEff = applyBuffStage(targetEva, targetEvaStage);
  let rate = accuracy + (userSkl - evaEff) * h.skl_eva_factor - userHitDebuff - hitPenalty;
  rate = Math.max(h.min_hit, Math.min(h.max_hit, rate));
  return rng.chance(rate / 100);
}

// 庇う成功率（第4巻5-4-4・正本）:
// 50 + 庇う側の技量×0.3 + ペア信頼度×0.3 + 補正。上限95/下限20。
export function protectRate(skl: number, pairTrust: number, bonus = 0): number {
  const p = DB.config.protect;
  const rate = p.base_rate + skl * p.skill_factor + pairTrust * p.trust_factor + bonus;
  return Math.max(p.floor, Math.min(p.cap, rate));
}

// 逃走成功率（第4巻5-4-6）: 50+(味方Lv平均−敵Lv平均)×3。上限95/下限10。
export function fleeRate(allyAvgLv: number, enemyAvgLv: number): number {
  const b = DB.config.battle;
  const rate = b.flee_base_rate + (allyAvgLv - enemyAvgLv) * b.flee_lv_diff_coef;
  return Math.max(b.flee_floor, Math.min(b.flee_cap, rate));
}

// 手なずけ成功率（第4巻5-4-7）: 40+技量×0.3。上限90。
export function tameRate(skl: number): number {
  const t = DB.config.tame;
  return Math.min(t.cap, t.base + skl * t.skill_factor);
}

// 説得成功率（第4巻5-9）: 30+ペア信頼度×0.5（+選択肢15）
export function persuadeRate(pairTrust: number, dialogBonus = false): number {
  const p = DB.config.persuade;
  return p.base + pairTrust * p.trust_factor + (dialogBonus ? p.dialog_bonus : 0);
}
