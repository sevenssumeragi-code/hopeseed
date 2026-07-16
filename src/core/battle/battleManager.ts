// 戦闘マネージャ（GDD第4巻・正本 完全準拠）。
// 5-1 フロー / 5-2 参加(保持者任意・HP0仕様#14) / 5-3 ターン制(同速ランダム) /
// 5-4 コマンド(防御SP+5・庇う完全無効・逃走全体・手なずける) / 5-5 ダメージ /
// 5-6 命中(技量-回避)×0.2・一撃必殺(ボス/保持者無効・水の女神救済) /
// 5-7 状態異常戦闘中効果 / 5-8 誘拐 / 5-9 取り憑き(裏切りユニット・説得・浄化) /
// 5-10 敵AI(ヘイト方式+8種AI型) / 5-11 SP・EXP / 5-12 ログ / 5-13 終了処理。

import { DB, getEnemyDef } from "../../dataLoader.js";
import { RNG } from "../rng.js";
import { BattleLog } from "./battleLog.js";
import {
  calcDamage, calcHit, protectRate, fleeRate, tameRate, persuadeRate,
  applyBuffStage,
  type Combatant, type DamageContext,
} from "./damageCalc.js";
import { effectiveStat, expToNext, maxHp, maxSp, enhancedSkill, skillsForCharacter } from "../stats.js";
import type {
  CharacterState, EnemyState, EnemySkill, Skill, SkillEffect, GOReason, TimeSlot, Tide,
} from "../../types.js";

export interface BattleContext {
  location: string;
  slot: TimeSlot;
  tide: Tide;
  isBoss: boolean;
  bossId?: string;
  weatherHitPenalty?: number;
  areaLvMod?: number;
  waterGraceActive?: boolean;   // 水の供物期限内（引き込み救済1戦1回・第4巻5-6-2）
}

export type CommandKind =
  | "attack" | "skill" | "guard" | "protect" | "item" | "flee"
  | "tame" | "persuade";

export interface Command {
  kind: CommandKind;
  actorId: string;
  skillId?: string;
  targetEnemyIndex?: number;
  targetAllyId?: string;
  itemId?: string;
}

export type BattleOutcome = "ongoing" | "victory" | "fled" | "defeat" | "gameover" | "drowned";

interface AllyRuntime {
  state: CharacterState;
  guarding: boolean;
  protecting: string | null;
  protectedBy: string | null;
  betrayed: boolean;            // 裏切り状態（第4巻5-9: 敵AIの駒）
  cmdFailed: boolean;
}

export interface BattleResult {
  outcome: BattleOutcome;
  goReason: GOReason | null;
  expGained: number;
  drops: string[];
  silver: number;
  deaths: string[];
  kidnapped: string[];
  possessed: string[];          // 戦闘終了時も裏切りのままのキャラ
  persuaded: string[];          // 戦闘中に説得/浄化で復帰したキャラ
  protectSuccessPairs: [string, string][];  // 庇う成功 from→to（信頼+3用）
  sharkKills: number;
}

export function scaleEnemy(defId: string, partyAvgLv: number, areaMod: number): EnemyState {
  const def = getEnemyDef(defId);
  const sc = DB.config.enemy_scaling;
  let lv: number;
  let hp: number;
  let refBase: { atk: number; def: number; spd: number; skl: number; eva: number };

  if (def.boss) {
    lv = Math.max(def.min_lv ?? 1, Math.round(partyAvgLv) + 3);
    hp = def.hp_fixed!;
    const ref = getEnemyDef(def.stat_ref!).base!;
    const m = def.stat_mult ?? {};
    const s = 1 + sc.stat_per_lv * (lv - 1);
    refBase = {
      atk: Math.round(ref.atk * s * (m["atk"] ?? 1)),
      def: Math.round(ref.def * s * (m["def"] ?? 1)),
      spd: Math.round(ref.spd * s * (m["spd"] ?? 1)),
      skl: Math.round(ref.skl * s * (m["skl"] ?? 1)),
      eva: Math.round(ref.eva * s * (m["eva"] ?? 1)),
    };
  } else {
    lv = Math.max(1, Math.round(partyAvgLv) + areaMod);
    hp = Math.round(def.base!.hp * (1 + sc.hp_per_lv * (lv - 1)));
    const s = 1 + sc.stat_per_lv * (lv - 1);
    refBase = {
      atk: Math.round(def.base!.atk * s),
      def: Math.round(def.base!.def * s),
      spd: Math.round(def.base!.spd * s),
      skl: Math.round(def.base!.skl * s),
      eva: Math.round(def.base!.eva * s),
    };
  }

  return {
    id: defId, defId, def, level: lv, hp, maxHp: hp,
    atk: refBase.atk, defStat: refBase.def, spd: refBase.spd,
    skl: refBase.skl, eva: refBase.eva,
    buffs: {}, status: {}, alive: true,
    cooldowns: {}, usedOnce: new Set(), telegraphed: null,
  };
}

export class BattleManager {
  readonly log = new BattleLog();
  readonly ctx: BattleContext;
  readonly rng: RNG;
  allies: AllyRuntime[] = [];
  enemies: EnemyState[] = [];
  turn = 0;
  outcome: BattleOutcome = "ongoing";
  private holderId: string;
  private pairTrust: (a: string, b: string) => number;
  private trustTotalOf: (id: string) => number;
  private braveSongTurn: Record<string, number> = {};
  private kidnapTries = 0;
  private hopeDevoured = false;
  private holderLost: GOReason | null = null;
  private waterGraceUsed = false;
  private lastAttacker: Record<string, string> = {};  // enemyId → 直前に攻撃してきた味方id
  private swarmTargets: Record<string, string> = {};  // defId → 集中攻撃対象(群れ型)
  private fleeFailedThisTurn = false;
  private lionProcThisTurn = new Set<string>();
  private persuadedIds: string[] = [];
  private protectSuccessPairs: [string, string][] = [];

  constructor(
    enemyIds: string[],
    members: CharacterState[],
    holderId: string,
    ctx: BattleContext,
    rng: RNG,
    pairTrust: (a: string, b: string) => number,
    trustTotalOf?: (id: string) => number,
  ) {
    if (members.length > DB.config.BATTLE_MEMBERS_MAX) {
      throw new Error(`battle members exceed ${DB.config.BATTLE_MEMBERS_MAX}`);
    }
    this.ctx = ctx;
    this.rng = rng;
    this.holderId = holderId;
    this.pairTrust = pairTrust;
    this.trustTotalOf = trustTotalOf ?? (() => 0);
    const avgLv = members.reduce((s, m) => s + m.level, 0) / Math.max(1, members.length);
    this.allies = members.map((m) => {
      if (m.atkBuffNextBattle > 0) {
        m.buffs["atk"] = Math.min(DB.config.damage.buff_stage_cap,
          (m.buffs["atk"] ?? 0) + m.atkBuffNextBattle);
        m.buffTurns["atk"] = 999;
        m.atkBuffNextBattle = 0;
      }
      return {
        state: m, guarding: false, protecting: null, protectedBy: null,
        betrayed: false, cmdFailed: false,
      };
    });
    this.enemies = enemyIds.map((id, i) => {
      const e = scaleEnemy(id, avgLv, ctx.areaLvMod ?? 0);
      e.id = `${id}_${i}`;
      return e;
    });
    this.log.push("encounter", { s: [...new Set(this.enemies.map((e) => e.def.name))].join("と") });
  }

  get enemyFamilies(): string[] {
    return [...new Set(this.enemies.filter((e) => e.alive && !e.tamedTurns).map((e) => e.def.family))];
  }

  private holderInBattle(): AllyRuntime | undefined {
    return this.allies.find((a) => a.state.id === this.holderId);
  }

  // ============ コマンド可否（第4巻5-2-2/5-4/5-7）============
  availableCommands(actorId: string): CommandKind[] {
    const a = this.allies.find((x) => x.state.id === actorId);
    if (!a || a.betrayed) return [];
    const isHolder = actorId === this.holderId;
    const actionable = this.allies.filter((x) => !x.state.downed && !x.betrayed);
    const cmds: CommandKind[] = [];

    if (isHolder) {
      if (actionable.length === 1) return ["guard", "flee"]; // 保持者単独: 防御/逃げるのみ(アイテム不可)
      cmds.push("guard", "protect", "item", "flee");
    } else {
      // 大出血: 攻撃コマンド使用不可（第4巻5-7）
      if (a.state.status.bleed === undefined) cmds.push("attack");
      cmds.push("skill", "guard", "protect", "item", "flee");
      // 手なずける: ジンパチ・非保持者・敵に獣族（第4巻5-4-7）
      if (actorId === "jinpachi" && this.holderId !== "jinpachi"
        && this.enemies.some((e) => e.alive && !e.tamedTurns && e.def.family === "beast" && !e.def.boss)) {
        cmds.push("tame");
      }
    }
    // 説得: 裏切り状態の味方がいる（第4巻5-9）
    if (this.allies.some((x) => x.betrayed)) cmds.push("persuade");
    return cmds;
  }

  // かばう成功率プレビュー（第13巻16-4: 対象選択時にリアルタイム表示）
  protectRatePreview(fromId: string, toId: string): number {
    const a = this.allies.find((x) => x.state.id === fromId);
    if (!a) return 0;
    let bonus = a.state.protectRateBuff;
    const w = a.state.equippedWeapon ? DB.items[a.state.equippedWeapon] : null;
    if (w?.protect_bonus) bonus += w.protect_bonus;
    if (this.holderId === "muni") bonus += DB.config.protect.muni_holder_bonus;
    return Math.round(protectRate(
      this.allyEffSkl(a.state), this.pairTrust(fromId, toId), bonus));
  }

  learnedSkills(actorId: string): [string, Skill][] {
    const level = this.allies.find((a) => a.state.id === actorId)?.state.level ?? 1;
    return skillsForCharacter(actorId)
      .filter(([, s]) => s.learn_lv <= level)
      .map(([id, s]) => [id, enhancedSkill(s, level)]);
  }

  // ============ 実効ステータス（パッシブ・状態異常込み／第4巻5-5-3・5-7）============
  private allyEffSkl(s: CharacterState): number {
    let v = effectiveStat(s, "skl");
    if (s.status.burn !== undefined) v *= DB.config.battle_status.burn_stat_mult; // 大火傷: 技量×0.7
    return v;
  }

  private allyEffAtk(s: CharacterState): number {
    let v = effectiveStat(s, "atk");
    if (s.status.burn !== undefined) v *= DB.config.battle_status.burn_stat_mult; // 大火傷: 攻撃×0.7
    return v;
  }

  private allyEffEva(s: CharacterState): number {
    let v = effectiveStat(s, "eva");
    const p = DB.config.passives;
    // ムニ「ミニマムボディ」: 非保持者・常時 回避×1.4
    if (s.id === "muni" && this.holderId !== "muni") v *= p.muni_minimum_body.eva_mult;
    // ヒュウ「闇の加護」: 夜間または森・非保持者 回避×1.3
    if (s.id === "hyu" && this.holderId !== "hyu" && this.darkGraceActive()) {
      v *= p.hyu_dark_grace.eva_def_mult;
    }
    return v;
  }

  private allyEffDef(s: CharacterState): number {
    let v = effectiveStat(s, "def");
    if (s.id === "hyu" && this.holderId !== "hyu" && this.darkGraceActive()) {
      v *= DB.config.passives.hyu_dark_grace.eva_def_mult;
    }
    return v;
  }

  private darkGraceActive(): boolean {
    return this.ctx.slot === "night" || this.ctx.location === "forest_lake";
  }

  private allyCombatant(a: AllyRuntime): Combatant {
    const s = a.state;
    const def = DB.characters[s.id];
    const st = s.status;
    return {
      id: s.id, isEnemy: false, level: s.level,
      hp: s.hp, maxHp: s.maxHp,
      atk: this.allyEffAtk(s), def: this.allyEffDef(s),
      mag: def.base.mag === null ? null : effectiveStat(s, "mag"),
      buffs: s.buffs, weaknessFamily: def.weakness.battle_family,
      isGuarding: a.guarding,
      hasPoison: st.poison !== undefined,
      hasAnyStatus: st.poison !== undefined || st.burn !== undefined || st.bleed !== undefined
        || (st.paralysis ?? 0) > 0 || st.plagueDay !== undefined || st.infectDay !== undefined
        || st.obesity === true,
      isHolder: s.id === this.holderId,
    };
  }

  private enemyCombatant(e: EnemyState): Combatant {
    let atk = e.atk;
    if ((e.status as any).burn) atk *= DB.config.battle_status.burn_stat_mult;
    return {
      id: e.id, isEnemy: true, family: e.def.family, isBoss: !!e.def.boss,
      level: e.level, hp: e.hp, maxHp: e.maxHp,
      atk, def: e.defStat, mag: e.atk,
      buffs: e.buffs, isGuarding: false,
      hasPoison: (e.status as any).poison !== undefined,
    };
  }

  private dmgCtx(extra?: Partial<DamageContext>): DamageContext {
    const geru = this.allies.find((a) => a.state.id === "geru");
    return {
      slot: this.ctx.slot,
      location: this.ctx.location,
      protectedTarget: false,
      // ゲル統率: 参加中・戦闘不能でない・非保持者（第4巻5-5-3）
      geruLeadership: !!geru && !geru.state.downed && !geru.betrayed && this.holderId !== "geru",
      goddessInParty: this.allies.some((a) => a.state.id === "goddess" && !a.state.downed),
      enemyFamilies: this.enemyFamilies,
      rng: this.rng,
      neoNonHolder: this.holderId !== "neo",
      ...extra,
    };
  }

  // 保持者喪失の即時GO（第4巻5-2-3: 戦闘終了を待たない）
  private markDowned(a: AllyRuntime): void {
    a.state.hp = 0;
    a.state.downed = true;
    this.log.push("down", { b: DB.characters[a.state.id].name });
    if (a.state.id === this.holderId) {
      this.holderLost = "holder_death";
      this.outcome = "gameover";
    }
  }

  // ============ ターン実行（第4巻5-3）============
  executeTurn(commands: Command[]): BattleOutcome {
    if (this.outcome !== "ongoing") return this.outcome;
    this.turn++;
    this.fleeFailedThisTurn = false;
    this.lionProcThisTurn.clear();

    for (const a of this.allies) {
      a.guarding = false;
      a.protecting = null;
      a.protectedBy = null;
      a.cmdFailed = false;
      // コマンド失敗判定（第4巻5-7: しびれ25%/疫病30%）
      const bs = DB.config.battle_status;
      if ((a.state.status.paralysis ?? 0) > 0 && this.rng.chance(bs.paralysis_cmd_fail)) a.cmdFailed = true;
      if (a.state.status.plagueDay !== undefined && this.rng.chance(bs.plague_cmd_fail)) a.cmdFailed = true;
    }
    this.swarmTargets = {};

    const tideRule = this.ctx.location === "shallows" && this.ctx.tide === "high"
      && !(this.ctx.isBoss && this.ctx.bossId === "deep_sea_nushi");
    if (tideRule) {
      const left = DB.config.tide.shallows_high_tide_force_end_turns - this.turn;
      if (left >= 0) this.log.push("tide_warning", { v: left });
    }

    interface Act { spd: number; tie: number; kind: "ally" | "enemy" | "betrayed" | "tamed"; allyCmd?: Command; enemyIdx?: number; allyIdx?: number; }
    const acts: Act[] = [];

    for (const cmd of commands) {
      const a = this.allies.find((x) => x.state.id === cmd.actorId);
      if (!a || a.state.downed || a.betrayed) continue;
      const allowed = this.availableCommands(cmd.actorId);
      if (!allowed.includes(cmd.kind)) {
        throw new Error(`command rule violation: ${cmd.actorId} cannot use '${cmd.kind}'`);
      }
      acts.push({
        spd: applyBuffStage(effectiveStat(a.state, "spd"), a.state.buffs["spd"] ?? 0),
        tie: this.rng.next(), kind: "ally", allyCmd: cmd,
      });
    }
    this.enemies.forEach((e, i) => {
      if (!e.alive) return;
      acts.push({
        spd: applyBuffStage(e.spd, e.buffs["spd"] ?? 0), tie: this.rng.next(),
        kind: e.tamedTurns ? "tamed" : "enemy", enemyIdx: i,
      });
    });
    // 裏切り状態の味方: 敵AIの駒として行動（第4巻5-9）
    this.allies.forEach((a, i) => {
      if (a.betrayed && !a.state.downed) {
        acts.push({
          spd: applyBuffStage(effectiveStat(a.state, "spd"), a.state.buffs["spd"] ?? 0),
          tie: this.rng.next(), kind: "betrayed", allyIdx: i,
        });
      }
    });

    // 防御・庇う宣言（先行入力型・第4巻5-3）
    for (const act of acts) {
      const cmd = act.allyCmd;
      if (!cmd) continue;
      const a = this.allies.find((x) => x.state.id === cmd.actorId)!;
      if (a.cmdFailed) continue;
      if (cmd.kind === "guard") {
        a.guarding = true;
        this.log.push("guard", { a: DB.characters[a.state.id].name });
      } else if (cmd.kind === "protect" && cmd.targetAllyId) {
        a.protecting = cmd.targetAllyId;
      }
    }

    // 素早さ降順・同値はランダム（第4巻5-3）
    acts.sort((x, y) => y.spd - x.spd || y.tie - x.tie);
    for (const act of acts) {
      if (this.checkEnd() !== "ongoing") break;
      if (act.kind === "enemy") this.resolveEnemyAction(act.enemyIdx!);
      else if (act.kind === "tamed") this.resolveTamedAction(act.enemyIdx!);
      else if (act.kind === "betrayed") this.resolveBetrayedAction(act.allyIdx!);
      else this.resolveAllyAction(act.allyCmd!);
      if (this.outcome !== "ongoing") return this.finish();
    }

    this.turnEnd(tideRule);
    const end = this.checkEnd();
    if (end !== "ongoing") { this.outcome = end; return this.finish(); }
    return "ongoing";
  }

  // ============ 味方行動 ============
  private resolveAllyAction(cmd: Command): void {
    const a = this.allies.find((x) => x.state.id === cmd.actorId)!;
    if (a.state.downed || a.betrayed) return;
    if (this.fleeFailedThisTurn && cmd.kind !== "guard") return; // 逃走失敗: 全員行動済み扱い
    if (a.cmdFailed) {
      const key = (a.state.status.paralysis ?? 0) > 0 ? "cmd_fail_paralysis" : "cmd_fail_plague";
      this.log.push(key, { b: DB.characters[a.state.id].name });
      return;
    }
    const name = DB.characters[a.state.id].name;

    switch (cmd.kind) {
      case "guard": return; // 宣言済み（SP+5はturnEnd）
      case "protect": {
        const target = this.allies.find((x) => x.state.id === cmd.targetAllyId);
        if (!target || target.state.downed || target.betrayed) return;
        let bonus = a.state.protectRateBuff;
        const w = a.state.equippedWeapon ? DB.items[a.state.equippedWeapon] : null;
        if (w?.protect_bonus) bonus += w.protect_bonus;
        // ムニ保持者「庇護の妖精」: 全員+15%（第4巻5-4-4）
        if (this.holderId === "muni") bonus += DB.config.protect.muni_holder_bonus;
        const rate = protectRate(
          this.allyEffSkl(a.state),
          this.pairTrust(a.state.id, target.state.id),  // ペア信頼度（正本）
          bonus,
        );
        if (this.rng.chance(rate / 100)) {
          target.protectedBy = a.state.id;
          this.protectSuccessPairs.push([a.state.id, target.state.id]);
          this.log.push("protect", { a: name, b: DB.characters[target.state.id].name });
        } else {
          this.log.push("protect_fail", { a: name });
        }
        return;
      }
      case "flee": {
        if (this.ctx.isBoss) { this.log.push("flee_ng"); this.fleeFailedThisTurn = true; return; }
        const actives = this.allies.filter((x) => !x.state.downed && !x.betrayed);
        const allyAvg = actives.reduce((s, x) => s + x.state.level, 0) / Math.max(1, actives.length);
        const aliveEnemies = this.enemies.filter((e) => e.alive && !e.tamedTurns);
        const enemyAvg = aliveEnemies.reduce((s, e) => s + e.level, 0) / Math.max(1, aliveEnemies.length);
        if (this.rng.chance(fleeRate(allyAvg, enemyAvg) / 100)) {
          this.log.push("flee_ok", { a: DB.characters[this.holderId]?.name ?? name });
          this.outcome = "fled";
        } else {
          this.log.push("flee_ng");
          this.fleeFailedThisTurn = true; // 失敗: そのターン全員行動済み扱い（第4巻5-4-6）
        }
        return;
      }
      case "item": {
        if (!cmd.itemId) return;
        const item = DB.items[cmd.itemId];
        if (!item) return;
        this.log.push("item", { a: name, s: item.name });
        // 戦闘中の蘇生手段なし: 対象はHP1以上のみ（第4巻5-2-3）
        const target = this.allies.find((x) => x.state.id === (cmd.targetAllyId ?? cmd.actorId));
        if (!target || target.state.downed) return;
        if (item.cure) {
          for (const c of item.cure) this.cureStatus(target.state, c);
          this.log.push("cure", { b: DB.characters[target.state.id].name });
        }
        return;
      }
      case "tame": {
        // 手なずける（第4巻5-4-7）: 獣族1体を3ターン味方化
        const target = this.pickEnemy(cmd.targetEnemyIndex);
        if (!target || target.def.family !== "beast" || target.def.boss) return;
        if (this.rng.chance(tameRate(this.allyEffSkl(a.state)) / 100)) {
          target.tamedTurns = DB.config.tame.turns;
          this.log.push("tame_ok", { b: target.def.name });
        } else {
          this.log.push("tame_ng", { b: target.def.name });
        }
        return;
      }
      case "persuade": {
        // 説得（第4巻5-9）: 30% + ペア信頼度×0.5
        const target = this.allies.find((x) => x.state.id === cmd.targetAllyId && x.betrayed);
        if (!target) return;
        const rate = persuadeRate(this.pairTrust(a.state.id, target.state.id));
        if (this.rng.chance(rate / 100)) {
          target.betrayed = false;
          this.persuadedIds.push(target.state.id);
          this.log.push("persuade_ok", { a: name, b: DB.characters[target.state.id].name });
        } else {
          this.log.push("persuade_ng", { a: name });
        }
        return;
      }
      case "attack": {
        const target = this.pickEnemy(cmd.targetEnemyIndex);
        if (!target) return;
        this.log.push("attack", { a: name });
        this.allyStrike(a, target, this.basicAttackSkill(a.state.id));
        return;
      }
      case "skill": {
        if (!cmd.skillId) return;
        const raw = DB.skills[cmd.skillId];
        if (!raw || raw.owner !== a.state.id || raw.learn_lv > a.state.level) return;
        const skill = enhancedSkill(raw, a.state.level);
        if (a.state.sp < skill.sp_cost) { this.log.push("sp_short"); return; }
        a.state.sp -= skill.sp_cost;
        this.log.push(skill.kind === "magic" ? "magic" : "skill", { a: name, s: skill.name });

        // 光属性技を裏切り味方へ→浄化判定（第4巻5-9: 基礎60%・ダメージなし）
        const betrayedTarget = this.allies.find((x) => x.state.id === cmd.targetAllyId && x.betrayed);
        if (betrayedTarget && this.isLightSkill(skill)) {
          if (this.rng.chance(DB.config.purify_rate)) {
            betrayedTarget.betrayed = false;
            this.persuadedIds.push(betrayedTarget.state.id);
            this.log.push("purify", { b: DB.characters[betrayedTarget.state.id].name });
          } else {
            this.log.push("purify_ng");
          }
          return;
        }

        if (skill.kind === "support" || skill.kind === "heal") {
          this.resolveSupport(a, skill, cmd);
          return;
        }
        if (skill.effects.some((e) => e.type === "party_attack")) {
          const target = this.pickEnemy(cmd.targetEnemyIndex);
          if (!target) return;
          for (const m of this.allies) {
            if (m.state.downed || m.betrayed || m.state.id === this.holderId) continue;
            if (!target.alive) break;
            this.allyStrike(m, target, { ...skill, effects: [] });
          }
          return;
        }
        const targets = skill.target === "enemy_all"
          ? this.enemies.filter((e) => e.alive && !e.tamedTurns)
          : [this.pickEnemy(cmd.targetEnemyIndex)].filter(Boolean) as EnemyState[];
        for (const t of targets) this.allyStrike(a, t, skill);
        for (const eff of skill.effects) {
          if (eff.type === "ally_buff") {
            const ally = this.allies.find((x) => x.state.id === cmd.targetAllyId && !x.state.downed)
              ?? this.allies.find((x) => !x.state.downed && !x.betrayed && x.state.id !== a.state.id)
              ?? a;
            this.applyBuff(ally.state, eff);
            this.log.push("buff", { b: DB.characters[ally.state.id].name, s: (eff.stats ?? []).join("/") });
          } else if (eff.type === "self_buff") {
            this.applyBuff(a.state, eff);
            this.log.push("buff", { b: name, s: (eff.stats ?? []).join("/") });
          }
        }
        return;
      }
    }
  }

  private basicAttackSkill(ownerId: string): Skill {
    return {
      name: "攻撃", owner: ownerId, learn_lv: 1, kind: "physical",
      target: "enemy_single", accuracy: 95, power: 1.0, hits: 1, sp_cost: 0,
      effects: [], desc: "通常攻撃",
    };
  }

  private allyStrike(a: AllyRuntime, target: EnemyState, skill: Skill): void {
    this.lastAttacker[target.id] = a.state.id;
    const user = this.allyCombatant(a);
    const hit = calcHit(this.allyEffSkl(a.state), target.eva, target.buffs["eva"] ?? 0,
      skill.accuracy, a.state.hitDebuff, this.rng, this.ctx.weatherHitPenalty ?? 0);
    if (!hit) { this.log.push("miss", { b: target.def.name }); return; }

    // 一撃必殺（第4巻5-6-2: 命中成立後判定・ボス無効）
    if (!target.def.boss) {
      const critBonus = skill.effects.find((e) => e.type === "crit_bonus")?.amount ?? 0;
      const critRate = effectiveStat(a.state, "crit") + critBonus;
      if (this.rng.chance(critRate / 100)) {
        target.hp = 0; target.alive = false;
        this.log.push("critical", { b: target.def.name });
        return;
      }
    }

    // 目覚めるシシ（第4巻5-5-3: レニィが状態異常中・1ターン1度・50%）
    let lionProc = false;
    if (a.state.id === "renny" && !this.lionProcThisTurn.has("renny")) {
      const p = DB.config.passives.renny_awakened_lion;
      const hasStatus = this.allyCombatant(a).hasAnyStatus;
      if (hasStatus && this.rng.chance(p.proc)) {
        lionProc = true;
        this.lionProcThisTurn.add("renny");
        this.log.push("awakened_lion");
      }
    }

    const hits = skill.hits ?? 1;
    let total = 0;
    for (let i = 0; i < hits && target.alive; i++) {
      const dmg = calcDamage(user, this.enemyCombatant(target), skill,
        this.dmgCtx({
          awakenedLionProc: lionProc,
          lightMult: (target.def.light_damage_mult && this.isLightSkill(skill))
            ? target.def.light_damage_mult : 1.0,
        }));
      target.hp -= dmg;
      total += dmg;
      this.log.push("damage", { b: target.def.name, v: dmg });
      if (target.hp <= 0) { target.hp = 0; target.alive = false; }
    }
    const steal = skill.effects.find((e) => e.type === "lifesteal");
    if (steal && total > 0) {
      const heal = Math.round(total * (steal.ratio ?? 0.2));
      a.state.hp = Math.min(a.state.maxHp, a.state.hp + heal);
      this.log.push("heal", { b: DB.characters[a.state.id].name, v: heal });
    }
    if (target.alive) this.applyEffectsToEnemy(skill.effects, target);
    else this.log.push("enemy_down", { b: target.def.name });
  }

  private isLightSkill(skill: Skill): boolean {
    return skill.effects.some((e) => e.type === "anti_demon");
  }

  private applyBuff(state: CharacterState, eff: SkillEffect, synergyStage = 0): void {
    const cap = DB.config.damage.buff_stage_cap;
    for (const st of eff.stats ?? []) {
      const stage = (eff.stage ?? 1) + synergyStage;
      state.buffs[st] = Math.max(-cap, Math.min(cap, (state.buffs[st] ?? 0) + stage));
      state.buffTurns[st] = eff.turns ?? DB.config.damage.buff_turns;
    }
  }

  private cureStatus(state: CharacterState, status: string): void {
    const st = state.status;
    if (status === "poison") delete st.poison;
    else if (status === "burn") delete st.burn;
    else if (status === "paralysis") delete st.paralysis;
    else if (status === "plague") { delete st.plagueDay; delete st.plagueSevereDays; }
    else if (status === "infection") { delete st.infectDay; delete st.infectSevereDays; }
    else if (status === "obesity") { delete st.obesity; delete st.obesityPlainDays; }
    else if (status === "bleed") delete st.bleed;
  }

  private resolveSupport(a: AllyRuntime, skill: Skill, cmd: Command): void {
    let synergyStage = 0;
    if (skill.song_id === "brave_song") {
      this.braveSongTurn[a.state.id] = this.turn;
      if (this.braveSongTurn["geru"] === this.turn && this.braveSongTurn["muni"] === this.turn) {
        synergyStage = 1;
        this.log.push("brave_song_synergy");
      }
    }
    const targets = skill.target === "ally_all"
      ? this.allies.filter((x) => !x.state.downed && !x.betrayed)
      : skill.target === "self"
        ? [a]
        : skill.target === "enemy_single"
          ? []
          : [this.allies.find((x) => x.state.id === cmd.targetAllyId && !x.state.downed && !x.betrayed) ?? a];

    for (const t of targets) {
      const tName = DB.characters[t.state.id].name;
      for (const eff of skill.effects) {
        switch (eff.type) {
          case "heal": {
            const heal = Math.round(this.allyEffSkl(a.state) * (eff.coef ?? 2.0)
              * (synergyStage > 0 ? 1.5 : 1.0));
            t.state.hp = Math.min(t.state.maxHp, t.state.hp + heal);
            this.log.push("heal", { b: tName, v: heal });
            break;
          }
          case "buff": {
            if (eff.condition === "hp_below_25" && t.state.hp / t.state.maxHp > 0.25) break;
            this.applyBuff(t.state, eff, synergyStage);
            this.log.push("buff", { b: tName, s: (eff.stats ?? []).join("/") });
            break;
          }
          case "cure": {
            for (const st of eff.statuses ?? []) this.cureStatus(t.state, st);
            this.log.push("cure", { b: tName });
            break;
          }
          case "protect_rate": {
            t.state.protectRateBuff += eff.amount ?? 20;
            t.state.protectRateTurns = eff.turns ?? 3;
            this.log.push("protect_rate_up", { b: tName });
            break;
          }
          default: break;
        }
      }
    }
    if (skill.target === "enemy_single") {
      const target = this.pickEnemy(cmd.targetEnemyIndex);
      if (!target) return;
      const hit = calcHit(this.allyEffSkl(a.state), target.eva, target.buffs["eva"] ?? 0,
        skill.accuracy, a.state.hitDebuff, this.rng, 0);
      if (!hit) { this.log.push("miss", { b: target.def.name }); return; }
      for (const eff of skill.effects) {
        if (eff.type === "debuff") {
          const cap = DB.config.damage.buff_stage_cap;
          for (const st of eff.stats ?? []) {
            target.buffs[st] = Math.max(-cap, (target.buffs[st] ?? 0) - (eff.stage ?? 1));
          }
          this.log.push("debuff", { b: target.def.name, s: (eff.stats ?? []).join("/") });
        } else if (eff.type === "hit_debuff") {
          (target as any).hitDebuff = ((target as any).hitDebuff ?? 0) + (eff.amount ?? 15);
          this.log.push("debuff", { b: target.def.name, s: "命中" });
        }
      }
    }
  }

  private applyEffectsToEnemy(effects: SkillEffect[], target: EnemyState): void {
    const bossHalf = target.def.boss ? 0.5 : 1.0;
    for (const eff of effects) {
      if (!target.alive) return;
      if (!["poison", "burn", "bleed", "paralysis"].includes(eff.type)) continue;
      if (this.rng.chance((eff.chance ?? 0) * bossHalf)) {
        if (eff.type === "paralysis") target.status.paralysis = 2;
        else (target.status as any)[eff.type] = 99;
        this.log.push(eff.type, { b: target.def.name });
      }
    }
  }

  // ============ 手なずけた獣の行動（第4巻5-4-7）============
  private resolveTamedAction(idx: number): void {
    const tamed = this.enemies[idx];
    if (!tamed?.alive || !tamed.tamedTurns) return;
    const targets = this.enemies.filter((e) => e.alive && !e.tamedTurns);
    if (targets.length === 0) return;
    const target = this.rng.pick(targets);
    this.log.push("attack", { a: tamed.def.name });
    const skill = tamed.def.skills.find((s) => s.power !== null);
    if (!skill) return;
    const hit = calcHit(tamed.skl, target.eva, target.buffs["eva"] ?? 0,
      skill.accuracy, 0, this.rng, 0);
    if (!hit) { this.log.push("miss", { b: target.def.name }); return; }
    const dmg = calcDamage(this.enemyCombatant(tamed), this.enemyCombatant(target),
      skill as unknown as Skill, this.dmgCtx());
    target.hp -= dmg;
    this.log.push("damage", { b: target.def.name, v: dmg });
    if (target.hp <= 0) {
      target.hp = 0; target.alive = false;
      this.log.push("enemy_down", { b: target.def.name });
    }
  }

  // ============ 裏切り味方の行動（第4巻5-9: 味方を通常攻撃）============
  private resolveBetrayedAction(idx: number): void {
    const b = this.allies[idx];
    if (!b.betrayed || b.state.downed) return;
    const targets = this.allies.filter((x) => !x.state.downed && !x.betrayed);
    if (targets.length === 0) return;
    this.log.push("betray_attack", { a: DB.characters[b.state.id].name });
    let target = this.rng.pick(targets);
    const isProtected = !!target.protectedBy;
    if (isProtected) {
      const protector = this.allies.find((x) => x.state.id === target.protectedBy);
      if (protector && !protector.state.downed) target = protector;
    }
    const tName = DB.characters[target.state.id].name;
    const hit = calcHit(this.allyEffSkl(b.state), this.allyEffEva(target.state),
      target.state.buffs["eva"] ?? 0, 95, 0, this.rng, 0);
    if (!hit) { this.log.push("miss", { b: tName }); return; }
    const dmg = calcDamage(this.allyCombatant(b), this.allyCombatant(target),
      this.basicAttackSkill(b.state.id), this.dmgCtx({ protectedTarget: isProtected }));
    target.state.hp -= dmg;
    this.log.push("damage", { b: tName, v: dmg });
    if (target.state.hp <= 0) this.markDowned(target);
  }

  // ============ 敵AI（第4巻5-10）============
  // ヘイト方式ターゲット選択（5-10-1）
  private pickTargetByHate(e: EnemyState): AllyRuntime | null {
    const pool = this.allies.filter((a) => !a.state.downed && !a.betrayed);
    if (pool.length === 0) return null;
    const h = DB.config.hate;
    const lowestHp = [...pool].sort(
      (a, b) => a.state.hp / a.state.maxHp - b.state.hp / b.state.maxHp)[0];
    const weights = pool.map((a) => {
      let w = 100;
      if (a.state.id === "muni") w *= h.muni;
      if (e.def.family === "demon" && a.state.id === this.holderId) w *= h.demon_vs_holder;
      if (e.def.ai === "predator" && a === lowestHp) w *= h.predator_lowest_hp;
      if (this.lastAttacker[e.id] === a.state.id) w *= h.last_attacker;
      // 夢魔の王: 保持者ヘイト×2.0（第8巻）
      if (e.defId === "nightmare_king" && a.state.id === this.holderId) w *= 2.0;
      return w;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = this.rng.next() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  private isStatusSkill(s: EnemySkill): boolean {
    return s.effects.some((x) =>
      ["poison", "burn", "bleed", "paralysis", "plague"].includes(x.type))
      || s.effects.some((x) => x.type === "debuff" || x.type === "hit_debuff");
  }

  private chooseEnemySkill(e: EnemyState): EnemySkill | null {
    const usable = e.def.skills.filter((s) => {
      if (s.condition === "high_tide" && this.ctx.tide !== "high") return false;
      if (s.condition === "ally_downed" && !this.allies.some((a) => a.state.downed && a.state.exclusion === "none")) return false;
      if (s.once && e.usedOnce.has(s.name)) return false;
      if ((e.cooldowns[s.name] ?? 0) > 0) return false;
      if (s.effects.some((x) => x.type === "kidnap") && this.kidnapTries >= DB.config.kidnap.max_tries_per_battle) return false;
      return true;
    });
    if (usable.length === 0) return null;

    if (e.telegraphed) {
      const t = usable.find((s) => s.name === e.telegraphed);
      if (t) return t;
      e.telegraphed = null;
    }

    const plan = e.def.ai_plan;
    if (plan) return this.bossPlanSkill(e, usable, plan);

    const attacks = usable.filter((s) => s.power !== null && !this.isStatusSkill(s));
    const statusSkills = usable.filter((s) => this.isStatusSkill(s));
    const kidnap = usable.find((s) => s.effects.some((x) => x.type === "kidnap"));
    const possess = usable.find((s) => s.effects.some((x) => x.type === "possess"));
    const instant = usable.find((s) => s.effects.some((x) => x.type === "instant_death"));

    switch (e.def.ai) {
      case "aggressive": {
        // 猪突型: 常に攻撃。HP30%以下で威嚇（攻撃バフ・1回）
        if (e.hp / e.maxHp <= 0.3 && !e.usedOnce.has("_roar")) {
          e.usedOnce.add("_roar");
          e.buffs["atk"] = Math.min(DB.config.damage.buff_stage_cap, (e.buffs["atk"] ?? 0) + 1);
          this.log.push("raw", { text: `${e.def.name}は威嚇している！` });
          return null;
        }
        return attacks.length > 0 ? this.rng.pick(attacks) : this.rng.pick(usable);
      }
      case "tactical":
        // 戦術型: 2ターンに1度デバフ/状態異常技
        if (this.turn % 2 === 0 && statusSkills.length > 0) return this.rng.pick(statusSkills);
        return attacks.length > 0 ? this.rng.pick(attacks) : this.rng.pick(usable);
      case "swarm":
        return this.rng.pick(usable);
      case "predator":
        // 捕食型: 満潮時は引き込みを3ターンに1度（cooldownで制御）
        if (instant) return instant;
        return attacks.length > 0 ? this.rng.pick(attacks) : this.rng.pick(usable);
      case "ambush":
        // 妨害型: 状態異常技を最優先
        if (statusSkills.length > 0) return this.rng.pick(statusSkills);
        return this.rng.pick(usable);
      case "kidnapper":
        // 誘拐型: 戦闘不能者がいれば50%で誘拐
        if (kidnap && this.rng.chance(0.5)) return kidnap;
        return attacks.length > 0 ? this.rng.pick(attacks) : this.rng.pick(usable);
      case "possessor":
        // 憑依型: 取り憑き3ターンCD（cooldownで制御・可能なら使う）
        if (possess) return possess;
        return attacks.length > 0 ? this.rng.pick(attacks) : this.rng.pick(usable);
      case "duelist":
        return this.rng.pick(usable);
      default:
        return this.rng.pick(usable);
    }
  }

  private bossPlanSkill(e: EnemyState, usable: EnemySkill[], plan: any): EnemySkill | null {
    const hpRatio = e.hp / e.maxHp;
    const by = (name: string) => usable.find((s) => s.name === name);
    switch (plan.type) {
      case "volcano_lord": {
        if (hpRatio <= plan.rage_below_hp && !e.usedOnce.has("_rage")) {
          e.usedOnce.add("_rage");
          e.buffs["atk"] = (e.buffs["atk"] ?? 0) + plan.rage_atk_stage;
          this.log.push("raw", { text: "火山の主が怒りに燃え上がった！" });
          return null;
        }
        if (hpRatio <= plan.breath_below_hp && this.turn % plan.breath_cycle === 0) {
          const b = by("マグマブレス"); if (b) return b;
        }
        return this.turn % 2 === 0 ? (by("地殻割り") ?? this.rng.pick(usable)) : (by("大噴石") ?? this.rng.pick(usable));
      }
      case "pirate_captain": {
        const summon = by("手下を呼ぶ");
        if (summon && this.turn <= plan.summon_by_turn) return summon;
        if (hpRatio <= plan.stance_below_hp && !e.usedOnce.has("_stance")) {
          e.usedOnce.add("_stance");
          e.buffs["atk"] = (e.buffs["atk"] ?? 0) + 1;
          e.buffs["def"] = (e.buffs["def"] ?? 0) + 1;
          this.log.push("raw", { text: "船長が宝剣を構えた！" });
          return null;
        }
        if (e.usedOnce.has("_stance")) return by("宝剣一閃") ?? this.rng.pick(usable);
        if (this.turn % plan.smash_cycle === 0) return by("舵輪殴打") ?? this.rng.pick(usable);
        return by("カットラス") ?? this.rng.pick(usable);
      }
      case "nushi": {
        const phase = this.turn % 3;
        if (phase === 1) return by("高波") ?? this.rng.pick(usable);
        if (phase === 2) return by("丸呑み") ?? this.rng.pick(usable);
        if (hpRatio <= plan.whirl_below_hp) return by("大渦") ?? this.rng.pick(usable);
        return this.rng.pick(usable);
      }
      case "nightmare_king": {
        if (this.turn === 1 && plan.open_whisper) return by("絶望の囁き") ?? this.rng.pick(usable);
        if (hpRatio <= plan.chain_below_hp && this.rng.chance(0.5)) return by("悪夢の鎖") ?? this.rng.pick(usable);
        return by("夢喰い") ?? this.rng.pick(usable);
      }
      case "demon_lord": {
        if (hpRatio <= plan.form2_below_hp && !e.usedOnce.has("_form2")) {
          e.usedOnce.add("_form2");
          e.buffs["atk"] = (e.buffs["atk"] ?? 0) + plan.form2_atk_stage;
          this.log.push("raw", { text: "首魁が絶望を具現させた——第2形態！" });
          return null;
        }
        if (e.usedOnce.has("_form2") && this.turn % plan.devour_cycle === 0) {
          const d = by("希望喰らい"); if (d) return d;
        }
        const possess = by("強憑依");
        if (possess && this.rng.chance(0.4)) return possess;
        return by("闇の暴風") ?? this.rng.pick(usable);
      }
      default:
        return this.rng.pick(usable);
    }
  }

  private resolveEnemyAction(idx: number): void {
    const e = this.enemies[idx];
    if (!e?.alive || e.tamedTurns) return;
    const bs = DB.config.battle_status;
    if ((e.status.paralysis ?? 0) > 0 && this.rng.chance(bs.paralysis_cmd_fail)) {
      this.log.push("cmd_fail_paralysis", { b: e.def.name });
      return;
    }
    const skill = this.chooseEnemySkill(e);
    if (!skill) return;

    if (skill.telegraph && e.telegraphed !== skill.name) {
      e.telegraphed = skill.name;
      const holderName = DB.characters[this.holderId]?.name ?? "";
      this.log.push("raw", { text: skill.telegraph.replace("{holder}", holderName) });
      return;
    }
    if (e.telegraphed === skill.name) e.telegraphed = null;

    this.execEnemySkill(e, skill);
  }

  private execEnemySkill(e: EnemyState, skill: EnemySkill): void {
    if (skill.once) e.usedOnce.add(skill.name);
    if (skill.cooldown) e.cooldowns[skill.name] = skill.cooldown;
    this.log.push("skill", { a: e.def.name, s: skill.name });

    const summon = skill.effects.find((x) => x.type === "summon");
    if (summon) {
      const actives = this.allies.filter((a) => !a.state.downed);
      const avgLv = actives.reduce((s, x) => s + x.state.level, 0) / Math.max(1, actives.length);
      for (let i = 0; i < (summon.count ?? 1); i++) {
        const add = scaleEnemy(summon.enemy!, avgLv, this.ctx.areaLvMod ?? 0);
        add.id = `${summon.enemy}_s${this.enemies.length}`;
        this.enemies.push(add);
      }
      this.log.push("raw", { text: "海賊の手下が現れた！" });
      return;
    }

    // 誘拐（第4巻5-8）
    const kidnap = skill.effects.find((x) => x.type === "kidnap");
    if (kidnap) {
      const downed = this.allies.filter((a) => a.state.downed && a.state.exclusion === "none");
      if (downed.length === 0) return;
      this.kidnapTries++;
      const victim = this.rng.pick(downed);
      const vName = DB.characters[victim.state.id].name;
      if (victim.protectedBy) {
        this.log.push("kidnap_blocked", { b: vName });
        return;
      }
      if (this.rng.chance(kidnap.chance ?? DB.config.kidnap.rate)) {
        victim.state.exclusion = "kidnapped";
        this.log.push("kidnap", { b: vName });
        if (victim.state.id === this.holderId) {
          this.holderLost = "holder_kidnap";
          this.outcome = "gameover";
        }
      } else {
        this.log.push("kidnap_fail", { b: vName });
      }
      return;
    }

    // 取り憑き（第4巻5-9: 信頼度抵抗・ネオ+15%・庇う無効）
    const possess = skill.effects.find((x) => x.type === "possess");
    if (possess) {
      const victim = this.pickTargetByHate(e);
      if (!victim) return;
      const vName = DB.characters[victim.state.id].name;
      if (victim.protectedBy) {
        this.log.push("possess_blocked", { b: vName });
        return;
      }
      let chance = possess.chance ?? DB.config.possess.rate_base;
      if (victim.state.id === "neo") chance += DB.config.possess.neo_bonus;
      chance -= this.trustTotalOf(victim.state.id) * DB.config.possess.resist_per_trust_total;
      if (this.rng.chance(Math.max(0.01, chance))) {
        this.log.push("possess_hit", { b: vName });
        if (victim.state.id === this.holderId) {
          this.holderLost = "holder_possess";
          this.outcome = "gameover";
        } else {
          victim.betrayed = true;  // 戦闘中は裏切りユニットとして残る（第4巻5-9）
        }
      } else {
        this.log.push("possess_fail", { b: vName });
      }
      return;
    }

    // 希望喰らい（第8巻: 保持者限定・庇う成功でのみ無効）
    const devour = skill.effects.find((x) => x.type === "hope_devour");
    if (devour) {
      const holder = this.holderInBattle();
      if (!holder || holder.state.downed) return;
      if (holder.protectedBy) {
        this.log.push("hope_devour_blocked", { a: DB.characters[holder.protectedBy].name });
        return;
      }
      this.hopeDevoured = true;
      this.log.push("hope_devour");
      this.outcome = "gameover";
      return;
    }

    const aliveAllies = this.allies.filter((a) => !a.state.downed && !a.betrayed);
    if (aliveAllies.length === 0) return;

    // 群れ型: 同種2体以上で同一対象に集中攻撃（第4巻5-10-2）
    let primary: AllyRuntime | null = null;
    if (e.def.ai === "swarm"
      && this.enemies.filter((x) => x.alive && x.defId === e.defId && !x.tamedTurns).length >= 2) {
      const sharedId = this.swarmTargets[e.defId];
      primary = this.allies.find((a) => a.state.id === sharedId && !a.state.downed && !a.betrayed)
        ?? this.pickTargetByHate(e);
      if (primary) this.swarmTargets[e.defId] = primary.state.id;
    } else {
      primary = this.pickTargetByHate(e);
    }
    if (!primary) return;

    const targets = skill.target === "all" ? aliveAllies
      : skill.target === "holder" ? aliveAllies.filter((a) => a.state.id === this.holderId)
      : [primary];

    for (let target of targets) {
      const isProtected = !!target.protectedBy;
      if (isProtected && skill.target !== "all") {
        const protector = this.allies.find((x) => x.state.id === target.protectedBy);
        if (protector && !protector.state.downed) target = protector;
      }
      const tName = DB.characters[target.state.id].name;

      const hit = calcHit(e.skl, this.allyEffEva(target.state), target.state.buffs["eva"] ?? 0,
        skill.accuracy, (e as any).hitDebuff ?? 0, this.rng, 0);
      if (!hit) { this.log.push("miss", { b: tName }); continue; }

      // 即死技（引き込み系・丸呑み）: レニィ無効・庇う無効・防御無効化(丸呑み)・水の女神救済1戦1回
      const instant = skill.effects.find((x) => x.type === "instant_death");
      if (instant) {
        const rennyImmune = target.state.id === "renny";
        const guarded = instant.guard_negates && target.guarding;
        if (rennyImmune || isProtected || guarded) {
          this.log.push("instant_death_resist", { b: tName });
        } else if (this.ctx.waterGraceActive && !this.waterGraceUsed) {
          this.waterGraceUsed = true;
          this.log.push("water_grace_save", { b: tName });
        } else {
          target.state.hp = 0;
          target.state.downed = true;
          target.state.exclusion = "dead"; // 即死亡（除外・第4巻5-6-2）
          this.log.push("instant_death", { b: tName });
          if (target.state.id === this.holderId) {
            this.holderLost = "holder_death";
            this.outcome = "gameover";
          }
        }
        continue;
      }

      const sleep = skill.effects.find((x) => x.type === "sleep_skip");
      if (sleep && skill.power === null) {
        if (this.rng.chance(sleep.chance ?? 0.3)) {
          const ally = this.allies.find((x) => x.state.id === target.state.id);
          if (ally) ally.cmdFailed = true;
          this.log.push("sleep_skip", { b: tName });
        }
        continue;
      }

      const pr = skill.effects.find((x) => x.type === "protect_rate");
      if (pr && skill.power === null) {
        target.state.protectRateBuff += pr.amount ?? -20;
        target.state.protectRateTurns = pr.turns ?? 3;
        this.log.push("raw", { text: `${tName}の庇う力が弱まった……` });
        continue;
      }

      if (skill.power !== null) {
        const hits = skill.hits ?? 1;
        let total = 0;
        for (let i = 0; i < hits && !target.state.downed; i++) {
          const dmg = calcDamage(this.enemyCombatant(e), this.allyCombatant(target),
            skill as unknown as Skill, this.dmgCtx({ protectedTarget: isProtected }));
          target.state.hp -= dmg;
          total += dmg;
          this.log.push("damage", { b: tName, v: dmg });
          if (target.state.hp <= 0) this.markDowned(target);
        }
        if (this.outcome !== "ongoing") return;
        const steal = skill.effects.find((x) => x.type === "lifesteal");
        if (steal && total > 0) {
          e.hp = Math.min(e.maxHp, e.hp + Math.round(total * (steal.ratio ?? 0.2)));
        }
        // 一撃必殺（喉狙い等）: 保持者へは無効（第4巻5-6-2）
        const crit = skill.effects.find((x) => x.type === "crit_bonus");
        if (crit && !target.state.downed && target.state.id !== this.holderId
          && this.rng.chance((crit.amount ?? 5) / 100)) {
          this.log.push("critical", { b: tName });
          this.markDowned(target);
          if (this.outcome !== "ongoing") return;
        }
        // 状態異常付与（庇い成立時は完全無効・第4巻5-4-4）
        if (!isProtected) {
          for (const eff of skill.effects) {
            if (target.state.downed) break;
            this.applyStatusToAlly(target, eff);
          }
        }
      }
    }
  }

  private applyStatusToAlly(a: AllyRuntime, eff: SkillEffect): void {
    const t = DB.config.status_timers;
    const kinds = ["poison", "burn", "bleed", "paralysis", "plague"];
    if (!kinds.includes(eff.type)) return;
    let chance = eff.chance ?? 0;
    if (a.guarding) chance *= DB.config.guard.status_mult; // 防御中は付与率半減（第4巻5-4-3）
    if (!this.rng.chance(chance)) return;
    if (eff.type === "burn" && a.state.id === "jinpachi"
      && (DB.characters["jinpachi"].ability_battle as any).burn_immunity) return;

    const st = a.state.status;
    switch (eff.type) {
      case "poison": st.poison = t.poison_death_days; break;
      case "burn": st.burn = t.burn_death_days; break;
      case "bleed": st.bleed = t.bleed_death_days; break;
      case "paralysis": st.paralysis = 2; break;
      case "plague": st.plagueDay = 0; break;
    }
    this.log.push(eff.type, { b: DB.characters[a.state.id].name });
  }

  // ============ TurnEnd（第4巻5-7スリップ・5-4-3防御SP・水神の加護）============
  private turnEnd(tideRule: boolean): void {
    const bs = DB.config.battle_status;
    // 敵スリップ（毒5%/出血8%）
    for (const e of this.enemies) {
      if (!e.alive) continue;
      for (const [k, rate, label] of [["poison", bs.poison_slip, "毒"], ["bleed", bs.bleed_slip, "大出血"]] as const) {
        if ((e.status as any)[k]) {
          const v = Math.max(1, Math.round(e.maxHp * rate));
          e.hp -= v;
          this.log.push("slip", { b: e.def.name, s: label, v });
          if (e.hp <= 0) { e.hp = 0; e.alive = false; this.log.push("enemy_down", { b: e.def.name }); }
        }
      }
      if (e.status.paralysis) e.status.paralysis--;
      for (const k of Object.keys(e.cooldowns)) {
        if (e.cooldowns[k] > 0) e.cooldowns[k]--;
      }
      // 手なずけ経過（第4巻5-4-7: 3ターンで野生に帰る）
      if (e.tamedTurns) {
        e.tamedTurns--;
        if (e.tamedTurns <= 0) {
          e.tamedTurns = undefined;
          this.log.push("tame_end", { b: e.def.name });
        }
      }
    }
    // 味方スリップ（毒5%/出血8%・第4巻5-7）と防御SP+5・バフ減衰
    for (const a of this.allies) {
      const s = a.state;
      if (!s.downed) {
        for (const [k, rate, label] of [["poison", bs.poison_slip, "毒"], ["bleed", bs.bleed_slip, "大出血"]] as const) {
          if ((s.status as any)[k] !== undefined) {
            const v = Math.max(1, Math.round(s.maxHp * rate));
            s.hp -= v;
            this.log.push("slip", { b: DB.characters[s.id].name, s: label, v });
            if (s.hp <= 0) { this.markDowned(a); break; }
          }
        }
        if (a.guarding && !s.downed) {
          s.sp = Math.min(s.maxSp, s.sp + DB.config.guard.sp_recover); // 防御SP+5（第4巻5-4-3）
        }
      }
      for (const k of Object.keys(s.buffTurns)) {
        s.buffTurns[k]--;
        if (s.buffTurns[k] <= 0) { delete s.buffTurns[k]; delete s.buffs[k]; }
      }
      if (s.hitDebuffTurns > 0) { s.hitDebuffTurns--; if (s.hitDebuffTurns === 0) s.hitDebuff = 0; }
      if (s.protectRateTurns > 0) { s.protectRateTurns--; if (s.protectRateTurns === 0) s.protectRateBuff = 0; }
    }
    if (this.outcome !== "ongoing") return;

    // 水神の加護（第0巻矛盾#1）
    const goddess = this.allies.find((a) => a.state.id === "goddess" && !a.state.downed);
    if (goddess) {
      const ab = DB.characters["goddess"].ability_battle as any;
      if (this.rng.chance(ab.proc)) {
        for (const a of this.allies) {
          if (a.state.downed) continue;
          a.state.hp = Math.min(a.state.maxHp,
            a.state.hp + Math.max(1, Math.round(a.state.maxHp * ab.heal_ratio)));
        }
        this.log.push("goddess_heal");
      }
    }
    if (tideRule && this.turn >= DB.config.tide.shallows_high_tide_force_end_turns) {
      this.log.push("tide_drown");
      this.outcome = "drowned";
    }
  }

  private pickEnemy(idx?: number): EnemyState | null {
    if (idx !== undefined && this.enemies[idx]?.alive && !this.enemies[idx].tamedTurns) return this.enemies[idx];
    return this.enemies.find((e) => e.alive && !e.tamedTurns) ?? null;
  }

  private checkEnd(): BattleOutcome {
    if (this.outcome !== "ongoing") return this.outcome;
    if (this.enemies.every((e) => !e.alive || e.tamedTurns)) return "victory";
    // 参加者全員が戦闘不能または裏切りで敗北（第4巻5-13-1）
    if (this.allies.every((a) => a.state.downed || a.betrayed)) return "defeat";
    return "ongoing";
  }

  finish(): BattleOutcome {
    if (this.outcome === "ongoing") this.outcome = this.checkEnd();
    return this.outcome;
  }

  // ============ 戦闘終了処理（第4巻5-13）============
  settle(): BattleResult {
    const result: BattleResult = {
      outcome: this.outcome, goReason: this.holderLost,
      expGained: 0, drops: [], silver: 0, deaths: [], kidnapped: [],
      possessed: [], persuaded: [...this.persuadedIds],
      protectSuccessPairs: [...this.protectSuccessPairs],
      sharkKills: 0,
    };
    if (this.hopeDevoured) result.goReason = "holder_possess";

    const nightmareBattle = this.enemies.some((e) => e.def.family === "nightmare");

    // 1. 戦闘不能者の死亡確定（勝敗問わず・夢魔戦は昏睡特例）
    for (const a of this.allies) {
      if (a.state.exclusion === "kidnapped") {
        result.kidnapped.push(a.state.id);
        continue;
      }
      if (a.betrayed) {
        // 裏切りのまま持ち帰り→3日以内に解除できなければ離脱（第4巻5-9）
        a.state.exclusion = "betrayal";
        a.state.betrayalDaysLeft = DB.config.possess.betrayal_leave_days;
        result.possessed.push(a.state.id);
        continue;
      }
      if (!a.state.downed) continue;
      if (a.state.exclusion === "dead") { result.deaths.push(a.state.id); continue; } // 引き込み即死済み
      if (nightmareBattle) {
        a.state.downed = false;
        a.state.hp = 1;
        continue;
      }
      a.state.exclusion = "dead";
      result.deaths.push(a.state.id);
      this.log.push("death_confirm", { b: DB.characters[a.state.id].name });
      if (a.state.id === this.holderId) result.goReason = "holder_death";
    }

    if (this.outcome === "victory") {
      this.log.push("victory", { a: DB.characters[this.holderId]?.name ?? "みんな" });
      // 3. EXP付与（第4巻5-11-2: 参加者100%〈死亡確定者を除く〉）
      const exp = Math.round(this.enemies
        .filter((e) => !e.alive)
        .reduce((s, e) => s + e.def.exp_base * e.level * DB.config.exp.enemy_coef, 0));
      result.expGained = exp;
      this.log.push("exp", { v: exp });
      for (const a of this.allies) {
        if (a.state.exclusion !== "none") continue;
        this.grantExp(a.state, exp);
      }
      // 4. ドロップ判定
      for (const e of this.enemies) {
        if (e.alive) continue;
        if (e.defId === "shark") result.sharkKills++;
        for (const d of e.def.drops) {
          if (this.rng.chance(d.rate)) {
            const item = d.item === "herb_random"
              ? this.rng.pick(["herb_red", "herb_blue", "herb_green", "herb_yellow"])
              : d.item;
            result.drops.push(item);
            this.log.push("drop", { a: e.def.name, s: DB.items[item]?.name ?? item });
          }
        }
        if (e.def.silver) result.silver += this.rng.int(e.def.silver[0], e.def.silver[1]);
        else if (!e.def.boss) result.silver += this.rng.int(DB.config.economy.silver_min, DB.config.economy.silver_max);
        if (e.def.silver_reward) result.silver += e.def.silver_reward;
      }
      if (result.silver > 0) this.log.push("silver", { v: result.silver });
      // 5. SP回復（最大の10%・第4巻5-11-1）
      for (const a of this.allies) {
        if (a.state.exclusion !== "none" || a.state.downed) continue;
        a.state.sp = Math.min(a.state.maxSp,
          a.state.sp + Math.round(a.state.maxSp * DB.config.sp.battle_win_ratio));
      }
    }
    if (this.outcome === "defeat") this.log.push("defeat");

    if (this.outcome === "drowned") {
      for (const a of this.allies) {
        if (a.state.id === "renny") { a.state.downed = false; continue; }
        a.state.downed = true;
      }
    }

    if (result.goReason) this.outcome = "gameover";
    result.outcome = this.outcome;
    return result;
  }

  // EXP付与＋レベルアップ（第4巻5-11-3: 最大HP/SPの25%即時回復・技習得ログ）
  grantExp(state: CharacterState, exp: number): void {
    state.exp += exp;
    while (state.level < DB.config.MAX_LEVEL && state.exp >= expToNext(state.level)) {
      state.exp -= expToNext(state.level);
      const before = state.level;
      state.level++;
      const def = DB.characters[state.id];
      state.maxHp = maxHp(def, state.level);
      state.maxSp = maxSp(def, state.level);
      state.hp = Math.min(state.maxHp, state.hp + Math.round(state.maxHp * DB.config.levelup_recover_ratio));
      state.sp = Math.min(state.maxSp, state.sp + Math.round(state.maxSp * DB.config.levelup_recover_ratio));
      this.log.push("levelup", { a: def.name });
      // 技習得（第4巻5-11-3）
      for (const [, sk] of skillsForCharacter(state.id)) {
        if (sk.learn_lv > before && sk.learn_lv <= state.level) {
          this.log.push("skill_learned", { a: def.name, s: sk.name });
        }
      }
      const c = DB.config.enhance;
      if (state.level > c.start_level && (state.level - c.start_level) % c.step_levels === 0) {
        this.log.push("enhance", { a: def.name });
      }
    }
  }
}
