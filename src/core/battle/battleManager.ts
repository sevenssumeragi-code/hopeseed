// 戦闘マネージャ（GDD第16巻20-4-2 FSM + 第6巻技効果 + 第8巻敵/ボス仕様 + 第14巻確率）。
// - 敵Lvスケーリング（第8巻10-0-1）: 敵Lv=パーティ平均+エリア補正。HP×(1+0.10(Lv-1))/他×(1+0.08(Lv-1))
// - 一撃必殺（クリティカル）＝即死。ボスは無効（第8巻11章共通）
// - ボス: 状態異常付与率半減・逃走不可・予告行動
// - 誘拐: 島側海賊の戦闘コマンド・戦闘不能者対象・10%・1戦闘2回まで・庇う無効
// - 取り憑き: 基礎25%(首魁35%)・3(2)ターンCD・ネオ+15%・保持者成功で即GO

import { DB, getEnemyDef } from "../../dataLoader.js";
import { RNG } from "../rng.js";
import { BattleLog } from "./battleLog.js";
import {
  calcDamage, calcHit, protectRate, applyBuffStage,
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
}

export type CommandKind = "attack" | "skill" | "guard" | "protect" | "item" | "flee";

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
  paralyzedThisTurn: boolean;
  sleepSkip: boolean;
}

export interface BattleResult {
  outcome: BattleOutcome;
  goReason: GOReason | null;
  expGained: number;
  drops: string[];
  silver: number;
  deaths: string[];
  kidnapped: string[];
  possessed: string[];
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
  private trustAvgOf: (id: string) => number;
  private braveSongTurn: Record<string, number> = {};
  private kidnapTries = 0;
  private possessedIds: string[] = [];
  private hopeDevoured = false;

  constructor(
    enemyIds: string[],
    members: CharacterState[],
    holderId: string,
    ctx: BattleContext,
    rng: RNG,
    trustAvgOf: (id: string) => number,
  ) {
    if (members.length > DB.config.BATTLE_MEMBERS_MAX) {
      throw new Error(`battle members exceed ${DB.config.BATTLE_MEMBERS_MAX}`);
    }
    this.ctx = ctx;
    this.rng = rng;
    this.holderId = holderId;
    this.trustAvgOf = trustAvgOf;
    const avgLv = members.reduce((s, m) => s + m.level, 0) / Math.max(1, members.length);
    this.allies = members.map((m) => {
      // 海賊風煮込み: 次戦闘まで攻撃+1段
      if (m.atkBuffNextBattle > 0) {
        m.buffs["atk"] = Math.min(DB.config.damage.buff_stage_cap,
          (m.buffs["atk"] ?? 0) + m.atkBuffNextBattle);
        m.buffTurns["atk"] = 999;
        m.atkBuffNextBattle = 0;
      }
      return { state: m, guarding: false, protecting: null, protectedBy: null, paralyzedThisTurn: false, sleepSkip: false };
    });
    this.enemies = enemyIds.map((id, i) => {
      const e = scaleEnemy(id, avgLv, ctx.areaLvMod ?? 0);
      e.id = `${id}_${i}`;
      return e;
    });
  }

  get enemyFamilies(): string[] {
    return [...new Set(this.enemies.filter((e) => e.alive).map((e) => e.def.family))];
  }

  availableCommands(actorId: string): CommandKind[] {
    const isHolder = actorId === this.holderId;
    const aliveAllies = this.allies.filter((a) => !a.state.downed);
    if (isHolder) {
      if (aliveAllies.length === 1) return ["guard", "flee"];
      return ["guard", "protect", "item", "flee"];
    }
    return ["attack", "skill", "guard", "protect", "item", "flee"];
  }

  learnedSkills(actorId: string): [string, Skill][] {
    const level = this.allies.find((a) => a.state.id === actorId)?.state.level ?? 1;
    return skillsForCharacter(actorId)
      .filter(([, s]) => s.learn_lv <= level)
      .map(([id, s]) => [id, enhancedSkill(s, level)]);
  }

  private allyCombatant(a: AllyRuntime): Combatant {
    const s = a.state;
    const def = DB.characters[s.id];
    const st = s.status;
    return {
      id: s.id, isEnemy: false, level: s.level,
      hp: s.hp, maxHp: s.maxHp,
      atk: effectiveStat(s, "atk"), def: effectiveStat(s, "def"),
      mag: def.base.mag === null ? null : effectiveStat(s, "mag"),
      buffs: s.buffs, weaknessFamily: def.weakness.battle_family,
      isGuarding: a.guarding,
      hasPoison: (st.poison ?? 0) > 0,
      hasAnyStatus: Object.values(st).some((v) => v !== undefined && v !== 0 && v !== false),
      isHolder: s.id === this.holderId,
    };
  }

  private enemyCombatant(e: EnemyState): Combatant {
    return {
      id: e.id, isEnemy: true, family: e.def.family, isBoss: !!e.def.boss,
      level: e.level, hp: e.hp, maxHp: e.maxHp,
      atk: e.atk, def: e.defStat, mag: e.atk,
      buffs: e.buffs, isGuarding: false,
      hasPoison: (e.status.poison ?? 0) > 0,
    };
  }

  private dmgCtx(extra?: Partial<DamageContext>): DamageContext {
    return {
      slot: this.ctx.slot,
      protectedTarget: false,
      geruInBattleAlive: this.allies.some((a) => a.state.id === "geru" && !a.state.downed),
      goddessInParty: this.allies.some((a) => a.state.id === "goddess" && !a.state.downed),
      enemyFamilies: this.enemyFamilies,
      rng: this.rng,
      neoNonHolder: this.holderId !== "neo",
      ...extra,
    };
  }

  executeTurn(commands: Command[]): BattleOutcome {
    if (this.outcome !== "ongoing") return this.outcome;
    this.turn++;

    for (const a of this.allies) {
      a.guarding = false;
      a.protecting = null;
      a.protectedBy = null;
      a.paralyzedThisTurn = (a.state.status.paralysis ?? 0) > 0 && this.rng.chance(0.5);
    }

    const tideRule = this.ctx.location === "shallows" && this.ctx.tide === "high"
      && !(this.ctx.isBoss && this.ctx.bossId === "deep_sea_nushi");
    if (tideRule) {
      const left = DB.config.tide.shallows_high_tide_force_end_turns - this.turn;
      if (left >= 0) this.log.push("tide_warning", { v: left });
    }

    interface Act { spd: number; isEnemy: boolean; allyCmd?: Command; enemyIdx?: number; }
    const acts: Act[] = [];
    for (const cmd of commands) {
      const a = this.allies.find((x) => x.state.id === cmd.actorId);
      if (!a || a.state.downed || a.sleepSkip) { if (a) a.sleepSkip = false; continue; }
      const allowed = this.availableCommands(cmd.actorId);
      if (!allowed.includes(cmd.kind)) {
        throw new Error(`holder rule violation: ${cmd.actorId} cannot use '${cmd.kind}'`);
      }
      acts.push({
        spd: applyBuffStage(effectiveStat(a.state, "spd"), a.state.buffs["spd"] ?? 0),
        isEnemy: false, allyCmd: cmd,
      });
    }
    this.enemies.forEach((e, i) => {
      if (e.alive) acts.push({
        spd: applyBuffStage(e.spd, e.buffs["spd"] ?? 0), isEnemy: true, enemyIdx: i,
      });
    });

    // 防御・庇う宣言を先行処理
    for (const act of acts) {
      const cmd = act.allyCmd;
      if (!cmd) continue;
      const a = this.allies.find((x) => x.state.id === cmd.actorId)!;
      if (cmd.kind === "guard") {
        a.guarding = true;
        this.log.push("guard", { a: DB.characters[a.state.id].name });
      } else if (cmd.kind === "protect" && cmd.targetAllyId) {
        a.protecting = cmd.targetAllyId;
      }
    }

    acts.sort((x, y) => y.spd - x.spd);
    for (const act of acts) {
      if (this.checkEnd() !== "ongoing") break;
      if (act.isEnemy) this.resolveEnemyAction(act.enemyIdx!);
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
    if (a.state.downed) return;
    if (a.paralyzedThisTurn) {
      this.log.push("paralysis_act", { b: DB.characters[a.state.id].name });
      return;
    }
    const name = DB.characters[a.state.id].name;

    switch (cmd.kind) {
      case "guard": return;
      case "protect": {
        const target = this.allies.find((x) => x.state.id === cmd.targetAllyId);
        if (!target || target.state.downed) return;
        let bonus = a.state.protectRateBuff;
        const w = a.state.equippedWeapon ? DB.items[a.state.equippedWeapon] : null;
        if (w?.protect_bonus) bonus += w.protect_bonus; // 妖精のスリング+5%
        const rate = protectRate(effectiveStat(a.state, "skl"), this.trustAvgOf(a.state.id), bonus);
        if (this.rng.chance(rate / 100)) {
          target.protectedBy = a.state.id;
          this.log.push("protect", { a: name, b: DB.characters[target.state.id].name });
        } else {
          this.log.push("protect_fail", { a: name, b: DB.characters[target.state.id].name });
        }
        return;
      }
      case "flee": {
        if (this.ctx.isBoss) { this.log.push("flee_ng"); return; }
        // 逃走率 = 50 + Lv差×3（第14巻FLEE_BASE）
        const avgLv = this.allies.reduce((s, x) => s + x.state.level, 0) / this.allies.length;
        const enemyLv = this.enemies.filter((e) => e.alive)
          .reduce((s, e) => s + e.level, 0) / Math.max(1, this.enemies.filter((e) => e.alive).length);
        const rate = DB.config.battle.flee_base_rate
          + (avgLv - enemyLv) * DB.config.battle.flee_lv_diff_coef;
        if (this.rng.chance(Math.max(5, Math.min(95, rate)) / 100)) {
          this.log.push("flee_ok");
          this.outcome = "fled";
        } else this.log.push("flee_ng");
        return;
      }
      case "item": {
        if (!cmd.itemId) return;
        const item = DB.items[cmd.itemId];
        if (!item) return;
        this.log.push("item", { a: name, s: item.name });
        const target = this.allies.find((x) => x.state.id === (cmd.targetAllyId ?? cmd.actorId));
        if (!target) return;
        if (item.cure) {
          for (const c of item.cure) this.cureStatus(target.state, c);
          this.log.push("cure", { b: DB.characters[target.state.id].name });
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
        this.log.push("skill", { a: name, s: skill.name });

        if (skill.kind === "support" || skill.kind === "heal") {
          this.resolveSupport(a, skill, cmd);
          return;
        }
        // 全軍突撃（第6巻7-4）: 参加中の味方全員(保持者除く)が倍率1.3で一斉攻撃
        if (skill.effects.some((e) => e.type === "party_attack")) {
          const target = this.pickEnemy(cmd.targetEnemyIndex);
          if (!target) return;
          for (const m of this.allies) {
            if (m.state.downed || m.state.id === this.holderId) continue;
            if (!target.alive) break;
            this.allyStrike(m, target, { ...skill, effects: [] });
          }
          return;
        }
        const targets = skill.target === "enemy_all"
          ? this.enemies.filter((e) => e.alive)
          : [this.pickEnemy(cmd.targetEnemyIndex)].filter(Boolean) as EnemyState[];
        for (const t of targets) this.allyStrike(a, t, skill);
        // 攻撃技に付随する味方向け効果（援護撃・ころころ）
        for (const eff of skill.effects) {
          if (eff.type === "ally_buff") {
            const ally = this.allies.find((x) => x.state.id === cmd.targetAllyId && !x.state.downed)
              ?? this.allies.find((x) => !x.state.downed && x.state.id !== a.state.id)
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
    const user = this.allyCombatant(a);
    // 命中判定は1回（第6巻7-0-1: n回攻撃）
    const hit = calcHit(target.eva, target.buffs["eva"] ?? 0, skill,
      a.state.hitDebuff, this.rng, this.ctx.weatherHitPenalty ?? 0);
    if (!hit) { this.log.push("miss", { b: target.def.name }); return; }

    // 一撃必殺判定（クリティカル=即死。ボス無効・第8巻11章）
    if (!target.def.boss) {
      const critBonus = skill.effects.find((e) => e.type === "crit_bonus")?.amount ?? 0;
      const critRate = effectiveStat(a.state, "crit") + critBonus;
      if (this.rng.chance(critRate / 100)) {
        target.hp = 0; target.alive = false;
        this.log.push("critical", { b: target.def.name });
        this.log.push("enemy_down", { b: target.def.name });
        return;
      }
    }

    let lionProc = false;
    if (a.state.id === "renny") {
      lionProc = this.rng.chance((DB.characters["renny"].ability_battle as any).proc);
      if (lionProc) this.log.push("awakened_lion");
    }

    const hits = skill.hits ?? 1;
    let total = 0;
    for (let i = 0; i < hits && target.alive; i++) {
      // 各ヒットごとにダメージ乱数を個別適用（第6巻7-0-1）
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
    // 吸命斬（与ダメの20%回復）
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
    // 勇気の歌シナジー（第6巻7-0-4）: 同一ターンに両者使用で+2段
    let synergyStage = 0;
    if (skill.song_id === "brave_song") {
      this.braveSongTurn[a.state.id] = this.turn;
      if (this.braveSongTurn["geru"] === this.turn && this.braveSongTurn["muni"] === this.turn) {
        synergyStage = 1;
        this.log.push("brave_song_synergy");
      }
    }
    const targets = skill.target === "ally_all"
      ? this.allies.filter((x) => !x.state.downed)
      : skill.target === "self"
        ? [a]
        : skill.target === "enemy_single"
          ? []
          : [this.allies.find((x) => x.state.id === cmd.targetAllyId && !x.state.downed) ?? a];

    for (const t of targets) {
      const tName = DB.characters[t.state.id].name;
      for (const eff of skill.effects) {
        switch (eff.type) {
          case "heal": {
            // 回復量 = 使用者の技量 × 係数（第6巻7-0-2）
            const heal = Math.round(effectiveStat(a.state, "skl") * (eff.coef ?? 2.0)
              * (synergyStage > 0 ? 1.5 : 1.0));
            t.state.hp = Math.min(t.state.maxHp, t.state.hp + heal);
            this.log.push("heal", { b: tName, v: heal });
            break;
          }
          case "buff": {
            // 指揮官の覚悟: HP25%以下の味方のみ
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
    // 敵対象の補助（咆哮・おねがい・幻惑等）
    if (skill.target === "enemy_single") {
      const target = this.pickEnemy(cmd.targetEnemyIndex);
      if (!target) return;
      const hit = calcHit(target.eva, target.buffs["eva"] ?? 0, skill,
        a.state.hitDebuff, this.rng, 0);
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
    // ボスは状態異常付与率半減（第8巻11章共通）
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

  // ============ 敵行動 ============
  private resolveEnemyAction(idx: number): void {
    const e = this.enemies[idx];
    if (!e?.alive) return;
    if ((e.status.paralysis ?? 0) > 0 && this.rng.chance(0.5)) {
      this.log.push("paralysis_act", { b: e.def.name });
      return;
    }
    const skill = this.chooseEnemySkill(e);
    if (!skill) return;

    // 予告行動: 予告ターンはログのみ
    if (skill.telegraph && e.telegraphed !== skill.name) {
      e.telegraphed = skill.name;
      const holderName = DB.characters[this.holderId].name;
      this.log.push("raw", { text: skill.telegraph.replace("{holder}", holderName) });
      return;
    }
    if (e.telegraphed === skill.name) e.telegraphed = null;

    this.execEnemySkill(e, skill);
  }

  private chooseEnemySkill(e: EnemyState): EnemySkill | null {
    const usable = e.def.skills.filter((s) => {
      if (s.condition === "high_tide" && this.ctx.tide !== "high") return false;
      if (s.condition === "ally_downed" && !this.allies.some((a) => a.state.downed)) return false;
      if (s.once && e.usedOnce.has(s.name)) return false;
      if ((e.cooldowns[s.name] ?? 0) > 0) return false;
      if (s.effects.some((x) => x.type === "kidnap") && this.kidnapTries >= DB.config.kidnap.max_tries_per_battle) return false;
      return true;
    });
    if (usable.length === 0) return null;

    // 予告中はその技を続行
    if (e.telegraphed) {
      const t = usable.find((s) => s.name === e.telegraphed);
      if (t) return t;
      e.telegraphed = null;
    }

    const plan = e.def.ai_plan;
    if (plan) return this.bossPlanSkill(e, usable, plan);

    // 通常敵: 誘拐/引き込み/取り憑きの条件技を優先、他はランダム
    const special = usable.find((s) =>
      s.condition === "high_tide" || s.condition === "ally_downed"
      || s.effects.some((x) => x.type === "possess"));
    if (special && this.rng.chance(0.4)) return special;
    const normal = usable.filter((s) => s !== special);
    return normal.length > 0 ? this.rng.pick(normal) : special!;
  }

  private bossPlanSkill(e: EnemyState, usable: EnemySkill[], plan: any): EnemySkill {
    const hpRatio = e.hp / e.maxHp;
    const by = (name: string) => usable.find((s) => s.name === name);
    switch (plan.type) {
      case "volcano_lord": {
        if (hpRatio <= plan.rage_below_hp && !e.usedOnce.has("_rage")) {
          e.usedOnce.add("_rage");
          e.buffs["atk"] = (e.buffs["atk"] ?? 0) + plan.rage_atk_stage;
          this.log.push("raw", { text: "火山の主が怒りに燃え上がった！" });
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
        }
        if (e.usedOnce.has("_stance")) return by("宝剣一閃") ?? this.rng.pick(usable);
        if (this.turn % plan.smash_cycle === 0) return by("舵輪殴打") ?? this.rng.pick(usable);
        return by("カットラス") ?? this.rng.pick(usable);
      }
      case "nushi": {
        const phase = this.turn % 3;
        if (phase === 1) return by("高波") ?? this.rng.pick(usable);
        if (phase === 2) return by("丸呑み") ?? this.rng.pick(usable); // telegraph→翌ターン発動
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

  private execEnemySkill(e: EnemyState, skill: EnemySkill): void {
    if (skill.once) e.usedOnce.add(skill.name);
    if (skill.cooldown) e.cooldowns[skill.name] = skill.cooldown;
    this.log.push("skill", { a: e.def.name, s: skill.name });

    // 召喚（手下を呼ぶ）
    const summon = skill.effects.find((x) => x.type === "summon");
    if (summon) {
      const avgLv = this.allies.reduce((s, x) => s + x.state.level, 0) / this.allies.length;
      for (let i = 0; i < (summon.count ?? 1); i++) {
        const add = scaleEnemy(summon.enemy!, avgLv, this.ctx.areaLvMod ?? 0);
        add.id = `${summon.enemy}_s${this.enemies.length}`;
        this.enemies.push(add);
      }
      this.log.push("raw", { text: "海賊の手下が現れた！" });
      return;
    }

    // 対象選択
    const aliveAllies = this.allies.filter((a) => !a.state.downed);
    if (aliveAllies.length === 0) return;

    // 誘拐（島側海賊・戦闘不能者対象・10%・庇う無効・1戦闘2回まで）
    const kidnap = skill.effects.find((x) => x.type === "kidnap");
    if (kidnap) {
      const downed = this.allies.filter((a) => a.state.downed && a.state.exclusion === "none");
      if (downed.length === 0) return;
      this.kidnapTries++;
      const victim = this.rng.pick(downed);
      if (victim.protectedBy) {
        this.log.push("kidnap_blocked", { b: DB.characters[victim.state.id].name });
        return;
      }
      if (this.rng.chance(kidnap.chance ?? DB.config.kidnap.rate)) {
        victim.state.exclusion = "kidnapped";
        this.log.push("kidnap", { b: DB.characters[victim.state.id].name });
      } else {
        this.log.push("kidnap_fail", { b: DB.characters[victim.state.id].name });
      }
      return;
    }

    // 取り憑き（基礎25%/首魁35%・ネオ+15%・保持者成功で即GO）
    const possess = skill.effects.find((x) => x.type === "possess");
    if (possess) {
      const weights = aliveAllies.map((a) => a.state.id === "neo" ? 1.5 : a.state.id === this.holderId ? 1.3 : 1.0);
      const total = weights.reduce((s, w) => s + w, 0);
      let roll = this.rng.next() * total;
      let victim = aliveAllies[0];
      for (let i = 0; i < aliveAllies.length; i++) {
        roll -= weights[i];
        if (roll <= 0) { victim = aliveAllies[i]; break; }
      }
      let chance = possess.chance ?? DB.config.possess.rate_base;
      if (victim.state.id === "neo") chance += DB.config.possess.neo_bonus;
      if (victim.protectedBy) {
        this.log.push("possess_blocked", { b: DB.characters[victim.state.id].name });
        return;
      }
      if (this.rng.chance(chance)) {
        this.possessedIds.push(victim.state.id);
        this.log.push("possess_hit", { b: DB.characters[victim.state.id].name });
        if (victim.state.id === this.holderId) { this.outcome = "gameover"; }
        else {
          victim.state.exclusion = "betrayal";
          victim.state.betrayalDaysLeft = DB.config.possess.betrayal_leave_days;
          victim.state.downed = true; // 戦闘から離脱
        }
      } else {
        this.log.push("possess_fail", { b: DB.characters[victim.state.id].name });
      }
      return;
    }

    // 希望喰らい（保持者限定・庇う成功でのみ無効・成功で即GO）
    const devour = skill.effects.find((x) => x.type === "hope_devour");
    if (devour) {
      const holder = this.allies.find((a) => a.state.id === this.holderId);
      if (!holder || holder.state.downed) return;
      if (holder.protectedBy) {
        this.log.push("hope_devour_blocked", { a: DB.characters[holder.protectedBy].name });
        return;
      }
      this.hopeDevoured = true;
      this.log.push("hope_devour", { b: DB.characters[this.holderId].name });
      this.outcome = "gameover";
      return;
    }

    // 通常対象選択（捕食型はHP低い相手／夢魔の王は保持者ヘイト×2）
    let pool = aliveAllies;
    if (e.def.ai === "predator") {
      pool = [...aliveAllies].sort((a, b) => a.state.hp / a.state.maxHp - b.state.hp / b.state.maxHp).slice(0, 1);
    }
    const targets = skill.target === "all" ? aliveAllies
      : skill.target === "holder" ? aliveAllies.filter((a) => a.state.id === this.holderId)
      : [this.rng.pick(pool)];

    for (let target of targets) {
      const isProtected = !!target.protectedBy;
      if (isProtected && skill.target !== "all") {
        const protector = this.allies.find((x) => x.state.id === target.protectedBy);
        if (protector && !protector.state.downed) target = protector;
      }
      const tName = DB.characters[target.state.id].name;

      const hit = calcHit(effectiveStat(target.state, "eva"), target.state.buffs["eva"] ?? 0,
        skill, (e as any).hitDebuff ?? 0, this.rng, 0);
      if (!hit) { this.log.push("miss", { b: tName }); continue; }

      // 即死技（引き込み系・丸呑み）
      const instant = skill.effects.find((x) => x.type === "instant_death");
      if (instant) {
        const rennyImmune = target.state.id === "renny";
        const guarded = instant.guard_negates && target.guarding;
        if (rennyImmune || isProtected || guarded) {
          this.log.push("instant_death_resist", { b: tName });
        } else {
          target.state.hp = 0; target.state.downed = true;
          this.log.push("instant_death", { b: tName });
          this.log.push("down", { b: tName });
        }
        continue;
      }

      // 誘眠・悪夢の鎖（次ターン行動不可）
      const sleep = skill.effects.find((x) => x.type === "sleep_skip");
      if (sleep && skill.power === null) {
        if (this.rng.chance(sleep.chance ?? 0.3)) {
          target.sleepSkip = true;
          this.log.push("sleep_skip", { b: tName });
        }
        continue;
      }

      // 庇う成功率デバフ（絶望の囁き）
      const pr = skill.effects.find((x) => x.type === "protect_rate");
      if (pr && skill.power === null) {
        target.state.protectRateBuff += pr.amount ?? -20;
        target.state.protectRateTurns = pr.turns ?? 3;
        this.log.push("raw", { text: `${tName}の庇う力が弱まった…` });
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
          if (target.state.hp <= 0) {
            target.state.hp = 0; target.state.downed = true;
            this.log.push("down", { b: tName });
          }
        }
        // 敵の吸血（lifesteal）
        const steal = skill.effects.find((x) => x.type === "lifesteal");
        if (steal && total > 0) {
          e.hp = Math.min(e.maxHp, e.hp + Math.round(total * (steal.ratio ?? 0.2)));
        }
        // 一撃必殺率+（喉狙い）: 対象死亡ではなく戦闘不能化
        const crit = skill.effects.find((x) => x.type === "crit_bonus");
        if (crit && !target.state.downed && this.rng.chance((crit.amount ?? 5) / 100)) {
          target.state.hp = 0; target.state.downed = true;
          this.log.push("critical", { b: tName });
          this.log.push("down", { b: tName });
        }
        // 状態異常付与
        for (const eff of skill.effects) {
          if (target.state.downed) break;
          this.applyStatusToAlly(target.state, eff, tName);
        }
      }
    }
  }

  private applyStatusToAlly(state: CharacterState, eff: SkillEffect, name: string): void {
    const t = DB.config.status_timers;
    const kinds = ["poison", "burn", "bleed", "paralysis", "plague"];
    if (!kinds.includes(eff.type)) return;
    if (!this.rng.chance(eff.chance ?? 0)) return;
    // 防御中は付与率半減（第6巻7-0-1）→ 判定済のためガード時50%で無効化
    const a = this.allies.find((x) => x.state.id === state.id);
    if (a?.guarding && this.rng.chance(0.5)) return;
    // ジンパチ大火傷無効（第8巻10-1）
    if (eff.type === "burn" && state.id === "jinpachi"
      && (DB.characters["jinpachi"].ability_battle as any).burn_immunity) return;

    switch (eff.type) {
      case "poison": state.status.poison = t.poison_death_days; break;
      case "burn": state.status.burn = t.burn_death_days; break;
      case "bleed": state.status.bleed = t.bleed_death_days; break;
      case "paralysis": state.status.paralysis = 2; break;
      case "plague": state.status.plagueDay = 0; break;
    }
    this.log.push(eff.type, { b: name });
  }

  // ============ TurnEnd ============
  private turnEnd(tideRule: boolean): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      for (const k of ["bleed", "poison", "burn"] as const) {
        if ((e.status as any)[k]) {
          const v = Math.max(1, Math.round(e.maxHp * 0.05));
          e.hp -= v;
          this.log.push("slip", { b: e.def.name, s: k === "bleed" ? "出血" : k === "poison" ? "毒" : "火傷", v });
          if (e.hp <= 0) { e.hp = 0; e.alive = false; this.log.push("enemy_down", { b: e.def.name }); }
        }
      }
      if (e.status.paralysis) e.status.paralysis--;
      for (const k of Object.keys(e.cooldowns)) {
        if (e.cooldowns[k] > 0) e.cooldowns[k]--;
      }
    }
    // 味方バフ減衰
    for (const a of this.allies) {
      const s = a.state;
      if (s.status.paralysis) s.status.paralysis--;
      for (const k of Object.keys(s.buffTurns)) {
        s.buffTurns[k]--;
        if (s.buffTurns[k] <= 0) { delete s.buffTurns[k]; delete s.buffs[k]; }
      }
      if (s.hitDebuffTurns > 0) { s.hitDebuffTurns--; if (s.hitDebuffTurns === 0) s.hitDebuff = 0; }
      if (s.protectRateTurns > 0) { s.protectRateTurns--; if (s.protectRateTurns === 0) s.protectRateBuff = 0; }
    }
    // 水神の加護（女神在籍時20%で全員HP5%回復・第0巻矛盾#1）
    const goddess = this.allies.find((a) => a.state.id === "goddess" && !a.state.downed);
    if (goddess) {
      const ab = DB.characters["goddess"].ability_battle as any;
      if (this.rng.chance(ab.proc)) {
        for (const a of this.allies) {
          if (a.state.downed) continue;
          a.state.hp = Math.min(a.state.maxHp,
            a.state.hp + Math.max(1, Math.round(a.state.maxHp * ab.heal_ratio)));
        }
        this.log.push("goddess_heal", { v: "5%" });
      }
    }
    if (tideRule && this.turn >= DB.config.tide.shallows_high_tide_force_end_turns) {
      this.log.push("tide_drown");
      this.outcome = "drowned";
    }
  }

  private pickEnemy(idx?: number): EnemyState | null {
    if (idx !== undefined && this.enemies[idx]?.alive) return this.enemies[idx];
    return this.enemies.find((e) => e.alive) ?? null;
  }

  private checkEnd(): BattleOutcome {
    if (this.outcome !== "ongoing") return this.outcome;
    if (this.enemies.every((e) => !e.alive)) return "victory";
    if (this.allies.every((a) => a.state.downed)) return "defeat";
    return "ongoing";
  }

  finish(): BattleOutcome {
    if (this.outcome === "ongoing") this.outcome = this.checkEnd();
    return this.outcome;
  }

  // BattleEnd（20-4-3 + 第8巻）
  settle(): BattleResult {
    const result: BattleResult = {
      outcome: this.outcome, goReason: null,
      expGained: 0, drops: [], silver: 0, deaths: [], kidnapped: [], possessed: [...this.possessedIds],
      sharkKills: 0,
    };

    if (this.hopeDevoured || this.possessedIds.includes(this.holderId)) {
      result.goReason = "holder_possess";
    }

    if (this.outcome === "victory") {
      this.log.push("victory");
      // EXP = Σ 基礎EXP × 敵Lv × 0.5（第8巻10-0-1）
      const exp = Math.round(this.enemies.reduce(
        (s, e) => s + e.def.exp_base * e.level * DB.config.exp.enemy_coef, 0));
      result.expGained = exp;
      this.log.push("exp", { v: exp });
      const survivors = this.allies.filter((a) => !a.state.downed);
      for (const a of survivors) {
        a.state.exp += exp;
        while (a.state.level < DB.config.MAX_LEVEL && a.state.exp >= expToNext(a.state.level)) {
          a.state.exp -= expToNext(a.state.level);
          a.state.level++;
          const def = DB.characters[a.state.id];
          const hpGain = maxHp(def, a.state.level) - a.state.maxHp;
          a.state.maxHp = maxHp(def, a.state.level);
          a.state.maxSp = maxSp(def, a.state.level);
          a.state.hp = Math.min(a.state.maxHp, a.state.hp + Math.max(0, hpGain));
          this.log.push("levelup", { a: def.name, v: a.state.level });
          const c = DB.config.enhance;
          if (a.state.level > c.start_level && (a.state.level - c.start_level) % c.step_levels === 0) {
            this.log.push("enhance", { a: def.name });
          }
        }
        a.state.sp = Math.min(a.state.maxSp, a.state.sp + DB.config.sp.battle_win_restore);
      }
      // ドロップ＋銀貨
      for (const e of this.enemies) {
        if (e.defId === "shark") result.sharkKills++;
        for (const d of e.def.drops) {
          if (this.rng.chance(d.rate)) {
            const item = d.item === "herb_random"
              ? this.rng.pick(["herb_red", "herb_blue", "herb_green", "herb_yellow"])
              : d.item;
            result.drops.push(item);
            this.log.push("drop", { s: DB.items[item]?.name ?? item });
          }
        }
        if (e.def.silver) {
          result.silver += this.rng.int(e.def.silver[0], e.def.silver[1]);
        } else if (!e.def.boss) {
          result.silver += this.rng.int(DB.config.economy.silver_min, DB.config.economy.silver_max);
        }
        if (e.def.silver_reward) result.silver += e.def.silver_reward;
      }
      if (result.silver > 0) this.log.push("silver", { v: result.silver });
    }
    if (this.outcome === "defeat") this.log.push("defeat");

    // 戦闘不能者の死亡確定（20-4-3。誘拐は戦闘中に処理済み）
    for (const a of this.allies) {
      if (a.state.exclusion === "kidnapped") {
        result.kidnapped.push(a.state.id);
        if (a.state.id === this.holderId) result.goReason = "holder_kidnap";
        continue;
      }
      if (a.state.exclusion === "betrayal") continue;
      if (!a.state.downed) continue;
      // 夢魔戦: 敗北しても死亡せず昏睡（第8巻10-8）
      if (this.enemies.some((e) => e.def.family === "nightmare")) {
        a.state.downed = false;
        a.state.hp = 1;
        continue;
      }
      a.state.exclusion = "dead";
      result.deaths.push(a.state.id);
      if (a.state.id === this.holderId) result.goReason = "holder_death";
    }

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
}
