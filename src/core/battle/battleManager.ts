// 戦闘マネージャ（GDD第16巻20-4-2 戦闘FSMと1対1）。
// Init → MemberSelect → TurnStart → CommandInput/AIDecide → Resolve(素早さ降順)
// → TurnEnd(スリップ/バフ減衰/水神の加護/満潮カウント) → 終了判定 → BattleEnd。
// 受け入れ基準(20-8):
//  - 保持者のコマンドに攻撃/技/魔術が出ない／保持者単独時は防御・逃げるのみ
//  - HP0→戦闘不能→終了時死亡確定、保持者は即GO
//  - 誘拐は戦闘不能者のみ・10%・庇うで無効
//  - 満潮浅瀬は8ターン強制終了→溺水判定（ヌシ戦免除）

import { DB, getEnemyDef } from "../../dataLoader.js";
import { RNG } from "../rng.js";
import { BattleLog } from "./battleLog.js";
import { decideAction } from "./enemyAI.js";
import {
  calcDamage, calcHit, protectRate, applyBuffStage, type Combatant,
} from "./damageCalc.js";
import { effectiveStat, expToNext, maxHp, maxSp } from "../stats.js";
import type {
  CharacterState, EnemyState, Skill, SkillEffect, GOReason, TimeSlot, Tide,
} from "../../types.js";

export interface BattleContext {
  location: string;
  slot: TimeSlot;
  tide: Tide;
  isBoss: boolean;
  bossId?: string;
  weatherHitPenalty?: number;
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
  protecting: string | null; // 庇う対象のchar_id
  protectedBy: string | null;
  paralyzedThisTurn: boolean;
}

export interface BattleResult {
  outcome: BattleOutcome;
  goReason: GOReason | null;
  expGained: number;
  drops: string[];
  deaths: string[];      // 戦闘終了時に死亡確定したchar_id
  kidnapped: string[];   // 誘拐されたchar_id
}

export class BattleManager {
  readonly log = new BattleLog();
  readonly ctx: BattleContext;
  readonly rng: RNG;
  allies: AllyRuntime[] = [];
  enemies: EnemyState[] = [];
  turn = 0;
  outcome: BattleOutcome = "ongoing";
  goReason: GOReason | null = null;
  private holderId: string;
  private trustAvgOf: (id: string) => number;
  private braveSongUsedBy = new Set<string>();

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
    this.allies = members.map((m) => ({
      state: m, guarding: false, protecting: null, protectedBy: null, paralyzedThisTurn: false,
    }));
    this.enemies = enemyIds.map((id, i) => {
      const def = getEnemyDef(id);
      return {
        id: `${id}_${i}`, def, hp: def.base.hp, maxHp: def.base.hp,
        buffs: {}, status: {}, alive: true,
      };
    });
  }

  // 保持者コマンド制限（掟）: 攻撃/技/魔術は使用不可
  availableCommands(actorId: string): CommandKind[] {
    const isHolder = actorId === this.holderId;
    const aliveAllies = this.allies.filter((a) => !a.state.downed);
    if (isHolder) {
      if (aliveAllies.length === 1) return ["guard", "flee"]; // 保持者単独時
      return ["guard", "protect", "item", "flee"];
    }
    return ["attack", "skill", "guard", "protect", "item", "flee"];
  }

  private allyCombatant(a: AllyRuntime): Combatant {
    const s = a.state;
    const def = DB.characters[s.id];
    return {
      id: s.id, isEnemy: false, level: s.level,
      hp: s.hp, maxHp: s.maxHp,
      atk: effectiveStat(s, "atk"), def: effectiveStat(s, "def"),
      mag: def.base.mag === null ? null : effectiveStat(s, "mag"),
      buffs: s.buffs, weaknessType: def.weakness.type,
      isGuarding: a.guarding,
    };
  }

  private enemyCombatant(e: EnemyState): Combatant {
    return {
      id: e.id, isEnemy: true, level: 1,
      hp: e.hp, maxHp: e.maxHp,
      atk: e.def.base.atk, def: e.def.base.def, mag: e.def.base.atk,
      buffs: e.buffs, family: e.def.family, isGuarding: false,
    };
  }

  private geruAliveInBattle(): boolean {
    return this.allies.some((a) => a.state.id === "geru" && !a.state.downed);
  }
  private goddessInParty(): boolean {
    return this.allies.some((a) => a.state.id === "goddess" && !a.state.downed);
  }

  // 1ターンを実行。commandsは味方の入力(保持者制限は availableCommands で検証済み前提だが再検証する)。
  executeTurn(commands: Command[]): BattleOutcome {
    if (this.outcome !== "ongoing") return this.outcome;
    this.turn++;

    // --- TurnStart: 状態異常・パッシブ ---
    for (const a of this.allies) {
      a.guarding = false;
      a.protecting = null;
      a.protectedBy = null;
      a.paralyzedThisTurn =
        (a.state.status.paralysis ?? 0) > 0 && this.rng.chance(0.5);
    }

    // --- 満潮カウント警告（20-8: 8ターンで強制終了・ヌシ戦免除）---
    const tideRule = this.ctx.location === "shallows" && this.ctx.tide === "high"
      && !(this.ctx.isBoss && this.ctx.bossId === "deep_sea_nushi");
    if (tideRule) {
      const left = DB.config.tide.shallows_high_tide_force_end_turns - this.turn;
      if (left >= 0) this.log.push("tide_warning", { v: left });
    }

    // --- コマンド検証・行動列生成 ---
    interface Act { spd: number; isEnemy: boolean; allyCmd?: Command; enemyIdx?: number; }
    const acts: Act[] = [];

    for (const cmd of commands) {
      const a = this.allies.find((x) => x.state.id === cmd.actorId);
      if (!a || a.state.downed) continue;
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
      if (e.alive) acts.push({ spd: e.def.base.spd, isEnemy: true, enemyIdx: i });
    });

    // 庇う・防御は宣言として先行処理
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

    // --- Resolve: 素早さ降順 ---
    acts.sort((x, y) => y.spd - x.spd);
    for (const act of acts) {
      if (this.checkEnd() !== "ongoing") break;
      if (act.isEnemy) this.resolveEnemyAction(act.enemyIdx!);
      else this.resolveAllyAction(act.allyCmd!);
      if (this.outcome !== "ongoing") return this.finish();
    }

    // --- TurnEnd ---
    this.turnEnd(tideRule);
    const end = this.checkEnd();
    if (end !== "ongoing") { this.outcome = end; return this.finish(); }
    return "ongoing";
  }

  private resolveAllyAction(cmd: Command): void {
    const a = this.allies.find((x) => x.state.id === cmd.actorId)!;
    if (a.state.downed) return;
    if (a.paralyzedThisTurn) {
      this.log.push("paralysis", { b: DB.characters[a.state.id].name });
      return;
    }
    const name = DB.characters[a.state.id].name;

    switch (cmd.kind) {
      case "guard": return; // 宣言済み
      case "protect": {
        const target = this.allies.find((x) => x.state.id === cmd.targetAllyId);
        if (!target || target.state.downed) return;
        const rate = protectRate(
          effectiveStat(a.state, "skl"),
          this.trustAvgOf(a.state.id),
        );
        if (this.rng.chance(rate / 100)) {
          target.protectedBy = a.state.id;
          this.log.push("protect", { a: name, b: DB.characters[target.state.id].name });
        } else {
          this.log.push("protect_fail", { a: name, b: DB.characters[target.state.id].name });
        }
        return;
      }
      case "flee": {
        const rate = DB.config.battle.flee_base_rate;
        if (this.ctx.isBoss) { this.log.push("flee_ng"); return; }
        if (this.rng.chance(rate / 100)) {
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
        if (target && item.hp_restore) {
          const heal = Math.min(item.hp_restore, target.state.maxHp - target.state.hp);
          target.state.hp += heal;
          this.log.push("heal", { b: DB.characters[target.state.id].name, v: heal });
        }
        if (target && item.cure) {
          for (const c of item.cure) delete (target.state.status as any)[c];
        }
        if (target && item.revive && target.state.downed) {
          target.state.downed = false;
          target.state.hp = Math.max(1, Math.round(target.state.maxHp * 0.3));
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
        const skill = DB.skills[cmd.skillId];
        if (!skill || skill.learn_lv > a.state.level) return;
        if (a.state.sp < skill.sp_cost) { this.log.push("sp_short"); return; }
        a.state.sp -= skill.sp_cost;
        this.log.push("skill", { a: name, s: skill.name });

        if (skill.kind === "support") { this.resolveSupport(a, skill, cmd); return; }
        const targets = skill.target === "enemy_all"
          ? this.enemies.filter((e) => e.alive)
          : [this.pickEnemy(cmd.targetEnemyIndex)].filter(Boolean) as EnemyState[];
        for (const t of targets) this.allyStrike(a, t, skill);
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
    const hits = skill.hits ?? 1;
    for (let i = 0; i < hits && target.alive; i++) {
      const hit = calcHit(
        effectiveStat(a.state, "skl"), target.def.base.eva, skill, this.rng,
        this.ctx.weatherHitPenalty ?? 0,
      );
      if (!hit) { this.log.push("miss", { b: target.def.name }); continue; }

      // レニィ覚醒(50%で2倍)
      let lionProc = false;
      if (a.state.id === "renny") {
        const ab = DB.characters["renny"].ability_battle as any;
        lionProc = this.rng.chance(ab.proc);
        if (lionProc) this.log.push("awakened_lion");
      }
      const dmg = calcDamage(user, this.enemyCombatant(target), skill, {
        slot: this.ctx.slot, protectedTarget: false,
        geruInBattleAlive: this.geruAliveInBattle(),
        goddessInParty: this.goddessInParty(),
        rng: this.rng, awakenedLionProc: lionProc,
      });
      target.hp -= dmg;
      this.log.push("damage", { b: target.def.name, v: dmg });
      this.applyEffectsToEnemy(skill.effects, target);
      if (target.hp <= 0) {
        target.hp = 0; target.alive = false;
        this.log.push("enemy_down", { b: target.def.name });
      }
    }
  }

  private resolveSupport(a: AllyRuntime, skill: Skill, cmd: Command): void {
    // 勇気の歌シナジー（第0巻矛盾#5: ゲル+ムニ同時使用で効果1.5倍）
    let synergy = 1.0;
    if (skill.song_id === "brave_song") {
      this.braveSongUsedBy.add(a.state.id);
      if (this.braveSongUsedBy.has("geru") && this.braveSongUsedBy.has("muni")) {
        synergy = 1.5;
        this.log.push("brave_song_synergy");
      }
    }
    const targets = skill.target === "ally_all"
      ? this.allies.filter((x) => !x.state.downed)
      : skill.target === "self"
        ? [a]
        : [this.allies.find((x) => x.state.id === cmd.targetAllyId) ?? a];

    for (const t of targets) {
      for (const eff of skill.effects) {
        if (eff.type === "heal") {
          const heal = Math.round(t.state.maxHp * (eff.ratio ?? 0.3) * synergy);
          t.state.hp = Math.min(t.state.maxHp, t.state.hp + heal);
          this.log.push("heal", { b: DB.characters[t.state.id].name, v: heal });
        } else if (eff.type === "buff") {
          const cap = DB.config.damage.buff_stage_cap;
          for (const st of eff.stats ?? []) {
            const stage = Math.round((eff.stage ?? 1) * synergy);
            t.state.buffs[st] = Math.min(cap, (t.state.buffs[st] ?? 0) + stage);
            this.log.push("buff", { b: DB.characters[t.state.id].name, s: st });
          }
        } else if (eff.type === "cure") {
          t.state.status = {};
        }
      }
    }
    // debuff系は敵対象
    for (const eff of skill.effects) {
      if (eff.type === "debuff" || eff.type === "paralysis") {
        const target = this.pickEnemy(cmd.targetEnemyIndex);
        if (!target) continue;
        if (eff.type === "paralysis" && this.rng.chance(eff.chance ?? 0.3)) {
          target.status.paralysis = 2;
          this.log.push("paralysis", { b: target.def.name });
        } else if (eff.type === "debuff") {
          for (const st of eff.stats ?? []) {
            target.buffs[st] = Math.max(-DB.config.damage.buff_stage_cap,
              (target.buffs[st] ?? 0) - (eff.stage ?? 1));
            this.log.push("debuff", { b: target.def.name, s: st });
          }
        }
      }
    }
  }

  private applyEffectsToEnemy(effects: SkillEffect[], target: EnemyState): void {
    for (const eff of effects) {
      if (!target.alive) return;
      switch (eff.type) {
        case "bleed":
          if (this.rng.chance(eff.chance ?? 0)) {
            target.status.bleed = 99;
            this.log.push("bleed", { b: target.def.name });
          }
          break;
        case "poison":
          if (this.rng.chance(eff.chance ?? 0)) {
            target.status.poison = 99;
            this.log.push("poison", { b: target.def.name });
          }
          break;
        case "burn":
          if (this.rng.chance(eff.chance ?? 0)) {
            (target.status as any).burn = 99;
            this.log.push("burn", { b: target.def.name });
          }
          break;
        case "paralysis":
          if (this.rng.chance(eff.chance ?? 0)) {
            target.status.paralysis = 2;
            this.log.push("paralysis", { b: target.def.name });
          }
          break;
        default: break;
      }
    }
  }

  private resolveEnemyAction(idx: number): void {
    const e = this.enemies[idx];
    if (!e?.alive) return;
    if ((e.status.paralysis ?? 0) > 0 && this.rng.chance(0.5)) {
      this.log.push("paralysis", { b: e.def.name });
      return;
    }
    const targets = this.allies.map((a, i) => ({
      index: i, hpRatio: a.state.hp / a.state.maxHp,
      isHolder: a.state.id === this.holderId, downed: a.state.downed,
    }));
    const decision = decideAction(e, targets, { tide: this.ctx.tide, slot: this.ctx.slot }, this.rng);
    if (!decision) return;

    let target = this.allies[decision.targetIndex];
    this.log.push("skill", { a: e.def.name, s: decision.skill.name });

    // 庇う: 対象が庇われていればダメージ0.5倍かつ受け手が交代
    let isProtected = false;
    if (target.protectedBy) {
      const protector = this.allies.find((x) => x.state.id === target.protectedBy);
      if (protector && !protector.state.downed) { target = protector; isProtected = true; }
    }

    const skill = decision.skill;
    const targetName = DB.characters[target.state.id].name;

    const hit = calcHit(e.def.base.skl, effectiveStat(target.state, "eva"),
      skill as unknown as Skill, this.rng, 0);
    if (!hit) { this.log.push("miss", { b: targetName }); return; }

    // 即死技（サメ「深海へ引き込む」等）。レニィは覚醒でdrag_underwater無効。
    const instant = skill.effects.find((x) => x.type === "instant_death");
    if (instant) {
      const immune = target.state.id === "renny"
        && ((DB.characters["renny"].ability_battle as any).immune ?? []).includes("drag_underwater");
      if (immune || isProtected) {
        this.log.push("instant_death_resist", { b: targetName });
      } else {
        target.state.hp = 0; target.state.downed = true;
        this.log.push("instant_death", { b: targetName });
        this.log.push("down", { b: targetName });
      }
      return;
    }

    if (skill.power !== null) {
      const dmg = calcDamage(this.enemyCombatant(e), this.allyCombatant(target),
        skill as unknown as Skill, {
          slot: this.ctx.slot, protectedTarget: isProtected,
          geruInBattleAlive: false, goddessInParty: this.goddessInParty(),
          rng: this.rng,
        });
      target.state.hp -= dmg;
      this.log.push("damage", { b: targetName, v: dmg });
      // 状態異常付与
      for (const eff of skill.effects) {
        if ((eff.type === "poison" || eff.type === "bleed" || eff.type === "plague"
          || eff.type === "paralysis" || eff.type === "burn") && this.rng.chance(eff.chance ?? 0)) {
          if (eff.type === "paralysis") target.state.status.paralysis = 2;
          else if (eff.type === "poison") target.state.status.poison = DB.config.status_timers.poison_death_days;
          else if (eff.type === "bleed") target.state.status.bleed = DB.config.status_timers.bleed_death_days;
          else if (eff.type === "plague") target.state.status.plague = 0;
          this.log.push(eff.type, { b: targetName });
        }
      }
      if (target.state.hp <= 0) {
        target.state.hp = 0; target.state.downed = true;
        this.log.push("down", { b: targetName });
      }
    } else {
      // 補助技（バフ等）
      for (const eff of skill.effects) {
        if (eff.type === "buff") {
          for (const st of eff.stats ?? []) {
            e.buffs[st] = Math.min(DB.config.damage.buff_stage_cap, (e.buffs[st] ?? 0) + (eff.stage ?? 1));
          }
          this.log.push("buff", { b: e.def.name, s: (eff.stats ?? []).join("/") });
        }
      }
    }
  }

  private turnEnd(tideRule: boolean): void {
    // 敵スリップ（出血・毒・火傷: 最大HPの5%【AI提案】）
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const slip = ["bleed", "poison", "burn"].filter((k) => (e.status as any)[k]);
      for (const k of slip) {
        const v = Math.max(1, Math.round(e.maxHp * 0.05));
        e.hp -= v;
        this.log.push("slip", { b: e.def.name, s: k === "bleed" ? "出血" : k === "poison" ? "毒" : "火傷", v });
        if (e.hp <= 0) { e.hp = 0; e.alive = false; this.log.push("enemy_down", { b: e.def.name }); }
      }
      if (e.status.paralysis) e.status.paralysis--;
    }
    // 味方麻痺減衰
    for (const a of this.allies) {
      if (a.state.status.paralysis) a.state.status.paralysis--;
    }
    // 水神の加護: 女神が戦闘中、毎ターン20%で味方全員HP5%回復（第0巻矛盾#1）
    if (this.goddessInParty()) {
      const ab = DB.characters["goddess"].ability_battle as any;
      if (this.rng.chance(ab.proc)) {
        for (const a of this.allies) {
          if (a.state.downed) continue;
          const heal = Math.max(1, Math.round(a.state.maxHp * ab.heal_ratio));
          a.state.hp = Math.min(a.state.maxHp, a.state.hp + heal);
        }
        this.log.push("goddess_heal", { v: "5%" });
      }
    }
    // 満潮強制終了（8ターン→溺水判定）
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

  // BattleEnd: 経験値・ドロップ・死亡確定・誘拐判定・保持者GO（20-4-3）
  finish(): BattleOutcome {
    if (this.outcome === "ongoing") this.outcome = this.checkEnd();
    return this.outcome;
  }

  settle(): BattleResult {
    const result: BattleResult = {
      outcome: this.outcome, goReason: null,
      expGained: 0, drops: [], deaths: [], kidnapped: [],
    };

    if (this.outcome === "victory") {
      this.log.push("victory");
      // 経験値
      const exp = this.enemies.reduce((s, e) => s + e.def.exp_base, 0);
      result.expGained = exp;
      this.log.push("exp", { v: exp });
      const survivors = this.allies.filter((a) => !a.state.downed);
      for (const a of survivors) {
        a.state.exp += exp;
        while (a.state.level < DB.config.MAX_LEVEL && a.state.exp >= expToNext(a.state.level)) {
          a.state.exp -= expToNext(a.state.level);
          a.state.level++;
          const def = DB.characters[a.state.id];
          a.state.maxHp = maxHp(def, a.state.level);
          a.state.maxSp = maxSp(def, a.state.level);
          this.log.push("levelup", { a: def.name, v: a.state.level });
        }
        // 戦闘勝利SP回復（矛盾#10採用）
        a.state.sp = Math.min(a.state.maxSp, a.state.sp + DB.config.sp.battle_win_restore);
      }
      // ドロップ
      for (const e of this.enemies) {
        for (const d of e.def.drops) {
          if (this.rng.chance(d.rate)) {
            result.drops.push(d.item);
            this.log.push("drop", { s: DB.items[d.item]?.name ?? d.item });
          }
        }
      }
    }
    if (this.outcome === "defeat") this.log.push("defeat");

    // 戦闘不能者の処理（20-4-3）: 誘拐判定(海賊戦・10%・庇う無効は庇われ成立時点で対象外) → 死亡確定
    const pirateBattle = this.enemies.some((e) => e.def.family === "pirate");
    for (const a of this.allies) {
      if (!a.state.downed) continue;
      const id = a.state.id;
      if (pirateBattle && this.outcome !== "victory"
        && !a.protectedBy && this.rng.chance(DB.config.kidnap.rate)) {
        a.state.exclusion = "kidnapped";
        result.kidnapped.push(id);
        this.log.push("kidnap", { b: DB.characters[id].name });
        if (id === this.holderId) { result.goReason = "holder_kidnap"; }
      } else {
        a.state.exclusion = "dead";
        result.deaths.push(id);
        if (id === this.holderId) { result.goReason = "holder_death"; }
      }
    }
    // 溺水: レニィ以外は溺死判定（水の加護はGameManager側で救済判定）
    if (this.outcome === "drowned") {
      for (const a of this.allies) {
        if (a.state.id === "renny") continue;
        a.state.downed = true;
      }
    }
    if (result.goReason) this.outcome = "gameover";
    result.outcome = this.outcome;
    return result;
  }
}
