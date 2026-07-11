// GameManager（GDD第16巻20-5: FSMの親。日付・フェーズの唯一の権威）。
// 20-4-1: Title→Prologue→HolderSelect→DayLoop(MorningTick→Base/Map/Battle⇄→SleepTick)
//         →Day365 EndingJudge→Ending。どこからでもGameOverへ遷移可（GO5条件）。

import { DB } from "../dataLoader.js";
import { RNG } from "./rng.js";
import { PartyManager, createCharacterState } from "./partyManager.js";
import { TrustManager } from "./trustManager.js";
import { TributeManager } from "./tributeManager.js";
import { StatusEffectManager } from "./statusEffectManager.js";
import { WeatherManager } from "./weatherManager.js";
import { EventManager } from "./eventManager.js";
import { CraftManager } from "./craftManager.js";
import { EndingJudge } from "./endingJudge.js";
import { AchievementManager } from "./achievementManager.js";
import { SaveManager } from "./saveManager.js";
import {
  BattleManager, type BattleContext, type BattleResult,
} from "./battle/battleManager.js";
import type {
  CharacterState, GameState, GOReason, TimeSlot, Tide,
} from "../types.js";

export type GamePhase =
  | "title" | "prologue" | "holder_select"
  | "base" | "map" | "battle"
  | "ending" | "gameover";

const HOLDER_CANDIDATES = ["renny", "hyu", "jinpachi", "muni", "geru", "neo"];

export class GameManager {
  gs!: GameState;
  phase: GamePhase = "title";
  rng!: RNG;

  party!: PartyManager;
  trust!: TrustManager;
  tribute!: TributeManager;
  statusFx!: StatusEffectManager;
  weather = new WeatherManager();
  events!: EventManager;
  craft!: CraftManager;
  endingJudge!: EndingJudge;
  achievements!: AchievementManager;
  save = new SaveManager();

  currentBattle: BattleManager | null = null;
  lastEndingId: string | null = null;

  // --- HolderSelect: 6人から1人・変更不可（掟）---
  newGame(holderId: string, seed?: number): void {
    if (!HOLDER_CANDIDATES.includes(holderId)) {
      throw new Error(`invalid holder: ${holderId}`);
    }
    const rngSeed = seed ?? DB.config.rng_seed_default;
    this.rng = new RNG(rngSeed);

    const party: Record<string, CharacterState> = {};
    for (const id of HOLDER_CANDIDATES) party[id] = createCharacterState(id);
    // 隠しキャラ（湖の女神）は goddess_joined フラグで後から加入

    this.gs = {
      day: 1, slot: "morning", tide: "low", weather: "clear",
      holder: holderId, location: "base",
      party, flags: { [`route_${holderId}`]: true },
      inventory: { raw_meat: 2, fish: 2, herb_leaf: 3, hopeseed: 1 },
      trust: TrustManager.initTrust(),
      tribute: { fireLastDay: 1, waterLastDay: 1 },
      hunger: DB.config.hunger.max_gauge,
      starvingDays: 0,
      reviveLastDay: 0,
      stats: { battlesWon: 0, cooked: 0, built: 0, brewed: 0, revived: 0, protectSuccess: 0 },
      achievements: [],
      gameOver: null,
      rngSeed,
      version: 1,
    };
    this.bindManagers();
    this.phase = "base";
    this.morningTick();
  }

  private bindManagers(): void {
    this.party = new PartyManager(this.gs);
    this.trust = new TrustManager(this.gs);
    this.tribute = new TributeManager(this.gs);
    this.statusFx = new StatusEffectManager(this.gs, this.rng);
    this.events = new EventManager(this.gs, this.trust);
    this.craft = new CraftManager(this.gs);
    this.endingJudge = new EndingJudge(this.gs, this.party, this.trust, this.events);
    this.achievements = new AchievementManager(this.gs, this.trust);
  }

  loadGame(slotId: string): boolean {
    const gs = this.save.loadSlot(slotId);
    if (!gs) return false;
    this.gs = gs;
    this.rng = new RNG(gs.rngSeed);
    this.bindManagers();
    this.phase = gs.gameOver ? "gameover" : "base";
    return true;
  }

  // --- 時間帯を進める（移動/作業のコスト消費）---
  advanceTime(slots: number): void {
    const order: TimeSlot[] = DB.config.time_slots;
    for (let i = 0; i < slots; i++) {
      const idx = order.indexOf(this.gs.slot);
      if (idx >= order.length - 1) {
        this.endDay();
        return;
      }
      this.gs.slot = order[idx + 1];
    }
  }

  // --- SleepTick→翌日（20-4-1）---
  endDay(): void {
    if (this.phase === "gameover" || this.phase === "ending") return;

    // SleepTick: 夢魔判定→回復→オートセーブ
    this.sleepTick();
    if (this.phase !== "base" && (this.phase as GamePhase) === "gameover") return;

    if (this.gs.day >= DB.config.DAY_MAX) {
      this.phase = "ending";
      const ed = this.endingJudge.judge();
      this.lastEndingId = ed.id;
      this.achievements.check(ed.id);
      return;
    }

    this.gs.day++;
    this.gs.slot = "morning";
    this.morningTick();
  }

  // --- MorningTick: 天候決定/タイマー進行/イベント判定（20-4-1）---
  morningTick(): void {
    this.gs.weather = this.weather.rollDaily(this.rng);
    // 潮汐: 1日周期で干潮⇔満潮（第0巻0-3-3）
    this.gs.tide = this.gs.day % 2 === 1 ? "low" : "high";

    // 状態異常・空腹の日次タイマー
    const tick = this.statusFx.dailyTick();
    for (const d of tick.deaths) {
      if (d.charId === this.gs.holder) {
        this.triggerGameOver("holder_death");
        return;
      }
    }
    if (tick.starvation) {
      // 絶食7日→死亡。全体空腹管理のため保持者死亡としてGO（第0巻0-5【AI提案・解釈】）
      this.triggerGameOver("holder_death");
      return;
    }

    // 供物期限判定（GO4/GO5）
    const expired = this.tribute.checkExpiry();
    if (expired) {
      this.triggerGameOver(expired);
      return;
    }
    this.achievements.check();
  }

  private sleepTick(): void {
    // 夢魔遭遇判定（就寝時・第0巻0-3-3。キャラ別遭遇率はweaknessから）
    for (const c of this.party.getActiveMembers()) {
      const def = DB.characters[c.id];
      if (def.weakness.type === "dream_coma") {
        const m = def.weakness.detail.match(/([\d.]+)/);
        const rate = m ? Number(m[1]) : 0;
        if (this.rng.chance(rate)) {
          // 夢魔敗北→昏睡（簡易判定: 実戦闘は夢の中マップで行う設計。ここでは遭遇=昏睡リスク）
          this.statusFx.apply(c.id, "coma", "nightmare");
        }
      }
    }
    // 就寝回復: SP全回復・HP半回復（矛盾#10採用）
    for (const c of this.party.getActiveMembers()) {
      if (DB.config.sp.sleep_restore_full) c.sp = c.maxSp;
      c.hp = Math.min(c.maxHp, c.hp + Math.round(c.maxHp * 0.5));
      c.buffs = {};
    }
    this.save.autosave(this.gs);
  }

  // --- 食事（拠点）: 空腹回復＋SP一部回復 ---
  eat(itemId: string): boolean {
    const item = DB.items[itemId];
    if (!item || item.category !== "food" || (this.gs.inventory[itemId] ?? 0) < 1) return false;
    this.gs.inventory[itemId]--;
    this.gs.hunger = Math.min(DB.config.hunger.max_gauge,
      this.gs.hunger + (item.hunger_restore ?? DB.config.hunger.meal_restore));
    for (const c of this.party.getActiveMembers()) {
      if (item.hp_restore) c.hp = Math.min(c.maxHp, c.hp + item.hp_restore);
      if (item.sp_restore) c.sp = Math.min(c.maxSp, c.sp + item.sp_restore);
    }
    return true;
  }

  // --- 移動（マップ移動フェーズ）---
  moveTo(mapId: string): boolean {
    const current = DB.maps[this.gs.location];
    if (!current.connections.includes(mapId)) return false;
    this.gs.location = mapId;
    this.phase = DB.maps[mapId].is_base ? "base" : "map";
    this.advanceTime(1);
    return true;
  }

  // --- 戦闘開始（参加メンバー選択・最大4人）---
  startBattle(enemyIds: string[], memberIds: string[], isBoss = false, bossId?: string): BattleManager {
    const members = memberIds
      .map((id) => this.gs.party[id])
      .filter((c) => c && c.exclusion === "none" && c.comaDaysLeft === 0);
    // 保持者はマップ移動の操作キャラ＝戦闘に必ず帯同（掟）
    if (!members.some((m) => m.id === this.gs.holder)) {
      throw new Error("holder must join the battle party");
    }
    const ctx: BattleContext = {
      location: this.gs.location,
      slot: this.gs.slot,
      tide: this.gs.tide as Tide,
      isBoss,
      bossId,
      weatherHitPenalty: (this.weather.effects(this.gs.weather).hit_penalty as number) ?? 0,
    };
    this.currentBattle = new BattleManager(
      enemyIds, members, this.gs.holder, ctx, this.rng,
      (id) => this.trust.avgOf(id),
    );
    this.phase = "battle";
    return this.currentBattle;
  }

  // --- 戦闘後処理 ---
  settleBattle(): BattleResult {
    if (!this.currentBattle) throw new Error("no battle in progress");
    const result = this.currentBattle.settle();

    if (result.outcome === "victory") {
      this.gs.stats.battlesWon++;
      for (const item of result.drops) {
        this.gs.inventory[item] = (this.gs.inventory[item] ?? 0) + 1;
      }
      // 共闘の信頼度（battle_together）
      const ids = this.currentBattle.allies.map((a) => a.state.id);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          this.trust.add(ids[i], ids[j], DB.trust.gain.battle_together, "battle_together");
        }
      }
      // 海賊船長撃破→誘拐された仲間全員救出（矛盾#8）
      if (this.currentBattle.ctx.bossId === "pirate_captain") {
        for (const c of Object.values(this.gs.party)) {
          if (c.exclusion === "kidnapped") {
            c.exclusion = "none";
            c.downed = false;
            c.hp = Math.max(1, Math.round(c.maxHp * 0.5));
          }
        }
        this.gs.flags["pirate_captain_defeated"] = true;
      }
    }

    // 溺水判定: レニィ保持者なら溺死自体が発生しない。供物継続なら水の女神が救済（矛盾#4）
    if (result.outcome === "drowned") {
      const rennyHolder = this.gs.holder === "renny";
      const waterOk = this.tribute.remainingDays("water") >= 0;
      for (const a of this.currentBattle.allies) {
        if (a.state.id === "renny") { a.state.downed = false; continue; }
        if (rennyHolder || waterOk) {
          a.state.downed = false;
          a.state.hp = Math.max(1, a.state.hp);
        } else {
          a.state.exclusion = "dead";
          result.deaths.push(a.state.id);
          if (a.state.id === this.gs.holder) result.goReason = "holder_death";
        }
      }
    }

    if (result.goReason) {
      this.triggerGameOver(result.goReason);
    } else {
      this.phase = DB.maps[this.gs.location].is_base ? "base" : "map";
      this.advanceTime(1);
      this.achievements.check();
    }
    this.currentBattle = null;
    return result;
  }

  triggerGameOver(reason: GOReason): void {
    this.gs.gameOver = reason;
    this.phase = "gameover";
  }

  // 悪魔取り憑き（戦闘/イベント由来）。保持者なら即GO（掟）
  possess(charId: string): void {
    if (charId === this.gs.holder) {
      this.triggerGameOver("holder_possess");
      return;
    }
    this.statusFx.apply(charId, "betrayal", "demon");
  }

  // 隠しキャラ加入（hidden_goddessイベント後に呼ぶ）
  joinGoddess(): void {
    if (this.gs.party["goddess"]) return;
    this.gs.party["goddess"] = createCharacterState("goddess",
      Math.max(1, this.party.getHolder().level));
    this.gs.flags["goddess_joined"] = true;
  }
}
