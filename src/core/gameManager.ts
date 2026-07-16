// GameManager（GDD第16巻20-5: FSMの親）+ 第7・8・14巻の正データ対応。

import { DB, getEnemyDef } from "../dataLoader.js";
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
  CharacterState, FoodStockEntry, GameState, GOReason, TimeSlot, Tide,
} from "../types.js";

export type GamePhase =
  | "title" | "prologue" | "holder_select"
  | "base" | "map" | "battle"
  | "ending" | "gameover";

const HOLDER_CANDIDATES = ["renny", "hyu", "jinpachi", "muni", "geru", "neo"];

// エリア別敵Lv補正（第4巻5-10-3・正本: 森0/草原+1/砂浜+1/荒野+2/登山道+2/浅瀬+3/海賊船+3）
const AREA_LV_MOD: Record<string, number> = DB.config.area_lv_mod;

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
  pendingNightRaid = false;
  private nightEventsResolved = false;
  private nightEventBattle = false;

  newGame(holderId: string, seed?: number): void {
    if (!HOLDER_CANDIDATES.includes(holderId)) throw new Error(`invalid holder: ${holderId}`);
    const rngSeed = seed ?? DB.config.rng_seed_default;
    this.rng = new RNG(rngSeed);

    const party: Record<string, CharacterState> = {};
    for (const id of HOLDER_CANDIDATES) party[id] = createCharacterState(id);

    this.gs = {
      day: 1, slot: "morning", tide: "low", weather: "clear", prevWeather: "clear",
      holder: holderId, location: "base",
      party, flags: { [`route_${holderId}`]: true },
      inventory: { meat: 2, fish: 2, nuts: 3, herb_green: 2, herb_red: 1, wood: 2, grass_fiber: 2, hopeseed: 1 },
      foodStock: [],
      silver: 0,
      trust: TrustManager.initTrust(),
      // M2仕様: Day0=漂着時に女神へ挨拶済み扱い（供物ゼロならDay15朝にGO）
      tribute: { fireLastDay: 0, waterLastDay: 0, fireCount: 0, waterCount: 0 },
      exploredToday: false,
      reviveLastDay: 0,
      stats: {
        battlesWon: 0, cooked: 0, built: 0, brewed: 0,
        revived: 0, protectSuccess: 0, sharkKills: 0, comaTotal: 0,
      },
      achievements: [],
      protectCounts: {},
      gameOver: null,
      rngSeed,
      version: 2,
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
    this.craft = new CraftManager(this.gs, this.rng);
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

  advanceTime(slots: number): void {
    const order: TimeSlot[] = DB.config.time_slots;
    for (let i = 0; i < slots; i++) {
      const idx = order.indexOf(this.gs.slot);
      if (idx >= order.length - 1) { this.endDay(); return; }
      this.gs.slot = order[idx + 1];
      this.updateTide();
    }
  }

  // 潮汐: 夕・夜=満潮（第14巻TIDE_HIGH_SLOTS）
  private updateTide(): void {
    this.gs.tide = (DB.config.tide_high_slots as string[]).includes(this.gs.slot) ? "high" : "low";
  }

  endDay(): void {
    if (this.phase === "gameover" || this.phase === "ending") return;
    this.sleepTick();
    if ((this.phase as GamePhase) === "gameover") return;

    if (this.gs.day >= DB.config.DAY_MAX) {
      this.phase = "ending";
      const ed = this.endingJudge.judge();
      this.lastEndingId = ed.id;
      this.achievements.check(ed.id);
      return;
    }
    this.gs.day++;
    this.gs.slot = "morning";
    this.updateTide();
    this.morningTick();
  }

  morningTick(): void {
    // 天候（第14巻18-9: 季節・嵐翌日晴れ・供物期限前は嵐抑制）
    const tributeLeft = Math.min(this.tribute.remainingDays("fire"), this.tribute.remainingDays("water"));
    this.gs.prevWeather = this.gs.weather;
    this.gs.weather = this.weather.rollDaily(this.rng, this.gs.day, this.gs.prevWeather, tributeLeft);

    // 食料の期限切れ（保存3日・第7巻8-2）
    this.gs.foodStock = this.gs.foodStock.filter(
      (f) => this.gs.day - f.madeDay < DB.config.craft.food_expire_days);

    const tick = this.statusFx.dailyTick();
    for (const d of tick.deaths) {
      if (d.charId === this.gs.holder) { this.triggerGameOver("holder_death"); return; }
    }

    const expired = this.tribute.checkExpiry();
    if (expired) { this.triggerGameOver(expired); return; }
    this.achievements.check();
  }

  // 就寝前の夜イベント判定（M2のSleepTickフックをUI戦闘へ接続）。
  // UIはこれを呼び、raid/dreamerがあれば戦闘を挟んでから endDay() を呼ぶ。
  rollNightEvents(): { raid: boolean; dreamer: string | null } {
    this.nightEventsResolved = true;
    let raid = false;
    let raidRate = 0;
    for (const [fromDay, rate] of DB.config.night_raid.phases as [number, number][]) {
      if (this.gs.day >= fromDay) raidRate = rate;
    }
    if (raidRate > 0 && this.rng.chance(raidRate)) raid = true;

    let dreamer: string | null = null;
    if (this.gs.day >= DB.config.dream.active_from_day) {
      for (const c of this.party.getActiveMembers()) {
        let rate = c.id === "renny" ? DB.config.dream.rate_renny : DB.config.dream.rate_base;
        if (this.gs.flags["nightmare_king_defeated"]) rate *= DB.config.dream.king_defeat_mult;
        if (this.rng.chance(rate)) { dreamer = c.id; break; } // 一晩に1人
      }
    }
    this.pendingNightRaid = raid;
    return { raid, dreamer };
  }

  private sleepTick(): void {
    // UI経由で夜イベント解決済みならスキップ。ヘッドレス（テスト等）は自動解決:
    // 夢魔遭遇=自動昏睡（戦わず取り憑かれた扱い）・夜襲=フラグのみ。
    if (!this.nightEventsResolved) {
      const ev = this.rollNightEvents();
      if (ev.dreamer) this.statusFx.apply(ev.dreamer, "coma", "nightmare");
    }
    this.nightEventsResolved = false;

    // 雨天野宿の感染症（第14巻18-4: 20%）— 拠点泊は屋根ありとして半減【AI提案】
    const wx = this.weather.effects(this.gs.weather);
    if (wx.infection_camp && this.rng.chance((wx.infection_camp as number) * 0.5)) {
      const targets = this.party.getActiveMembers();
      if (targets.length > 0) {
        this.statusFx.apply(this.rng.pick(targets).id, "infection", "rain_camp");
      }
    }

    for (const c of this.party.getActiveMembers()) {
      if (DB.config.sp.sleep_restore_full) c.sp = c.maxSp;
      c.hp = Math.min(c.maxHp, c.hp + Math.round(c.maxHp * 0.5));
      c.buffs = {};
      c.buffTurns = {};
      c.hitDebuff = 0; c.hitDebuffTurns = 0;
      c.protectRateBuff = 0; c.protectRateTurns = 0;
    }
    this.save.autosave(this.gs);
  }

  // ============ 食事（品質別・第7巻8-2）============
  eatDish(stockIndex: number, eaterId?: string): { ok: boolean; message: string } {
    const entry = this.gs.foodStock[stockIndex];
    if (!entry) return { ok: false, message: "その料理はもうない。" };
    const item = DB.items[entry.dishId];
    this.gs.foodStock.splice(stockIndex, 1);

    const hpRatio = entry.quality === "great" ? DB.config.craft.food_hp_great
      : entry.quality === "normal" ? DB.config.craft.food_hp_normal
      : DB.config.craft.food_hp_poor;
    const spRatio = entry.quality === "great" ? DB.config.sp.meal_ratio_great
      : entry.quality === "normal" ? DB.config.sp.meal_ratio_normal
      : DB.config.sp.meal_ratio_poor;

    const special = item.special ?? {};
    const eaters = special["party_heal"] ? this.party.getActiveMembers()
      : [this.gs.party[eaterId ?? this.gs.holder]];

    let msg = entry.quality === "great" ? `「${item.great_name}」を味わった！` : `${item.name}を食べた。`;
    for (const c of eaters) {
      if (!c) continue;
      // 満腹+40%（品質問わず・キャラ個別）
      c.satiety = Math.min(DB.config.hunger.max_gauge, c.satiety + DB.config.hunger.meal_restore);
      c.hp = Math.min(c.maxHp, c.hp + Math.round(c.maxHp * hpRatio));
      if (special["sp_full"]) c.sp = c.maxSp;
      else c.sp = Math.min(c.maxSp, c.sp + Math.round(c.maxSp * spRatio));
      if (special["atk_buff_next_battle"]) c.atkBuffNextBattle = special["atk_buff_next_battle"] as number;
      // かろうじて食べれる物: 15%で肥満
      if (entry.quality === "poor" && this.rng.chance(DB.config.status_timers.obesity_chance_poor_food)) {
        this.statusFx.apply(c.id, "obesity", "poor_food");
        msg += `　${DB.characters[c.id].name}は肥満になってしまった…`;
      }
      // クラゲの酢の物(失敗品): 10%でしびれ
      if (entry.quality === "poor" && special["fail_paralysis"]
        && this.rng.chance(special["fail_paralysis"] as number)) {
        this.statusFx.apply(c.id, "paralysis", "jellyfish");
        msg += `　${DB.characters[c.id].name}の口がしびれた！`;
      }
      // 肥満中に great/normal を食べたら粗食リセット
      if (c.status.obesity && entry.quality !== "poor") c.status.obesityPlainDays = 0;
    }
    if (special["plague_resist"]) this.gs.flags["plague_resist_today"] = true;
    return { ok: true, message: msg };
  }

  // 生食（木の実HP10%回復・キノコ10%毒・第7巻8-1）
  eatRaw(itemId: string, eaterId: string): { ok: boolean; message: string } {
    const item = DB.items[itemId];
    if (!item || (this.gs.inventory[itemId] ?? 0) < 1) return { ok: false, message: "持っていない。" };
    const c = this.gs.party[eaterId];
    if (!c) return { ok: false, message: "誰が食べる？" };
    if (!item.raw_edible && !item.raw_risk) return { ok: false, message: "生では食べられない。調理が必要だ。" };
    this.gs.inventory[itemId]--;
    c.satiety = Math.min(DB.config.hunger.max_gauge, c.satiety + 10);
    let msg = `${item.name}をかじった。`;
    if (item.raw_edible) {
      c.hp = Math.min(c.maxHp, c.hp + Math.round(c.maxHp * item.raw_edible.hp_ratio));
    }
    if (item.raw_risk?.["poison"] && this.rng.chance(item.raw_risk["poison"])) {
      this.statusFx.apply(eaterId, "poison", "raw_mushroom");
      msg += `　${DB.characters[eaterId].name}は毒にあたった！`;
    }
    return { ok: true, message: msg };
  }

  // 薬の使用（フィールド/拠点）
  useMedicine(itemId: string, targetId: string): { ok: boolean; message: string } {
    const item = DB.items[itemId];
    if (!item?.cure || (this.gs.inventory[itemId] ?? 0) < 1) return { ok: false, message: "使えない。" };
    this.gs.inventory[itemId]--;
    for (const cure of item.cure) this.statusFx.cure(targetId, cure);
    return { ok: true, message: `${DB.characters[targetId].name}に${item.name}を使った。` };
  }

  // ============ 移動 ============
  moveTo(mapId: string): { ok: boolean; deaths: string[] } {
    const current = DB.maps[this.gs.location];
    if (!current.connections.includes(mapId)) return { ok: false, deaths: [] };
    // 海賊船は小舟の修理材が必要（第7巻8-7）
    const req = current.requires_for?.[mapId];
    if (req && (this.gs.inventory[req] ?? 0) < 1 && !this.gs.flags[`used_${req}`]) {
      return { ok: false, deaths: [] };
    }
    if (req && (this.gs.inventory[req] ?? 0) >= 1) {
      this.gs.inventory[req]--;
      this.gs.flags[`used_${req}`] = true;
    }
    this.gs.location = mapId;
    this.gs.exploredToday = true;
    this.phase = DB.maps[mapId].is_base ? "base" : "map";
    // 毒の移動ダメージ＋しびれ移動死判定（第14巻18-4）
    this.statusFx.poisonMoveTick();
    const deaths = this.statusFx.paralysisMoveCheck(mapId, this.gs.tide);
    for (const d of deaths) {
      if (d.charId === this.gs.holder) this.triggerGameOver("holder_death");
    }
    this.advanceTime(1);
    return { ok: true, deaths: deaths.map((d) => d.charId) };
  }

  // ============ 戦闘 ============
  startBattle(enemyIds: string[], memberIds: string[], isBoss = false, bossId?: string): BattleManager {
    // 保持者は選択しなくてもよい（第4巻5-2-1）
    const members = memberIds
      .map((id) => this.gs.party[id])
      .filter((c) => c && c.exclusion === "none" && c.comaDaysLeft === 0);
    if (members.length === 0) throw new Error("no battle members");
    const ctx: BattleContext = {
      location: this.gs.location,
      slot: this.gs.slot,
      tide: this.gs.tide as Tide,
      isBoss, bossId,
      weatherHitPenalty: (this.weather.effects(this.gs.weather).hit_penalty as number) ?? 0,
      areaLvMod: AREA_LV_MOD[this.gs.location] ?? 0,
      waterGraceActive: this.tribute.remainingDays("water") >= 0,
    };
    this.currentBattle = new BattleManager(
      enemyIds, members, this.gs.holder, ctx, this.rng,
      (a, b) => this.trust.pair(a, b),
      (id) => this.trust.totalOf(id),
    );
    this.phase = "battle";
    return this.currentBattle;
  }

  settleBattle(): BattleResult {
    if (!this.currentBattle) throw new Error("no battle in progress");
    const b = this.currentBattle;
    const result = b.settle();

    this.gs.stats.sharkKills += result.sharkKills;

    const tb = DB.config.trust_battle;
    const ids = b.allies.map((a) => a.state.id);
    const allPairs = (amount: number, reason: string) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          this.trust.add(ids[i], ids[j], amount, reason);
        }
      }
    };
    const demonBattle = b.enemies.some((e) => e.def.family === "demon");

    // 庇う成功: 当該ペア+3・方向付きカウンタ（第4巻5-4-4/5-13-2）
    for (const [from, to] of result.protectSuccessPairs) {
      this.trust.onProtectSuccess(from, to);
    }
    // 説得成功: 当該ペア+5（第4巻5-9）※説得者記録は簡略化し復帰者と保持者のペア
    for (const pid of result.persuaded) {
      this.trust.add(this.gs.holder, pid, tb.persuade_success, "persuade");
    }
    // 味方の死亡発生: 全ペア−2（第4巻5-13-2）
    if (result.deaths.length > 0) allPairs(tb.member_death_all_pairs, "member_death");

    if (result.outcome === "victory") {
      this.gs.stats.battlesWon++;
      this.gs.silver += result.silver;
      for (const item of result.drops) {
        this.gs.inventory[item] = Math.min(DB.config.gather.stack_max,
          (this.gs.inventory[item] ?? 0) + 1);
      }
      // 勝利: 参加者全ペア+1／悪魔戦は+2（第4巻5-13-2/5-9）
      allPairs(demonBattle ? tb.demon_win_all_pairs : tb.victory_all_pairs, "victory");
      // 控えの生存メンバーに30%（第4巻5-11-2）
      const reserveExp = Math.round(result.expGained * DB.config.exp.reserve_ratio);
      if (reserveExp > 0) {
        for (const c of Object.values(this.gs.party)) {
          if (ids.includes(c.id)) continue;
          if (c.exclusion !== "none" || c.comaDaysLeft > 0) continue;
          b.grantExp(c, reserveExp);
        }
      }
      // ボス撃破処理
      if (b.ctx.bossId) {
        const bossDef = getEnemyDef(b.ctx.bossId);
        this.gs.flags[`${b.ctx.bossId}_defeated`] = true;
        if (bossDef.on_defeat?.["stop_island_pirates"]) this.gs.flags["pirates_stopped"] = true;
        if (bossDef.on_defeat?.["dream_rate_mult"]) this.gs.flags["nightmare_king_defeated"] = true;
        if (bossDef.victory === "rescue_kidnapped_all") {
          for (const c of Object.values(this.gs.party)) {
            if (c.exclusion === "kidnapped") {
              c.exclusion = "none";
              c.downed = false;
              c.hp = Math.max(1, Math.round(c.maxHp * 0.5));
            }
          }
        }
      }
    }

    // 取り憑きを許して敗走: 全ペア−3（第4巻5-9）
    if (result.outcome !== "victory" && demonBattle && result.possessed.length > 0) {
      allPairs(tb.demon_lose_all_pairs, "demon_lose");
    }
    // 敗北: 控えに生存者がいれば全滅ではない→拠点へ強制送還（第4巻5-13-3）
    if (result.outcome === "defeat" && !result.goReason) {
      this.gs.location = "base";
    }

    // 溺水（第0巻矛盾#4）
    if (result.outcome === "drowned") {
      const rennyHolder = this.gs.holder === "renny";
      const waterOk = this.tribute.remainingDays("water") >= 0;
      for (const a of b.allies) {
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
      // 夜イベント戦闘（夢魔・夜襲）は就寝処理の一部なので時間を進めない
      if (!this.nightEventBattle) this.advanceTime(1);
      this.achievements.check();
    }
    this.nightEventBattle = false;
    this.currentBattle = null;
    return result;
  }

  // ============ ドグ商店（第7巻8-0）============
  dogAvailable(): boolean {
    return this.gs.day >= DB.config.kidnap.pirate_active_from_day
      && this.gs.location === "beach" && !this.gs.flags["dog_closed"];
  }

  buyPrice(itemId: string): number | null {
    const sell = DB.items[itemId]?.sell;
    return sell == null ? null : sell * DB.config.economy.buy_mult;
  }

  buyItem(itemId: string): boolean {
    const price = this.buyPrice(itemId);
    if (price === null || this.gs.silver < price) return false;
    this.gs.silver -= price;
    this.gs.inventory[itemId] = (this.gs.inventory[itemId] ?? 0) + 1;
    return true;
  }

  sellItem(itemId: string): boolean {
    const sell = DB.items[itemId]?.sell;
    if (sell == null || (this.gs.inventory[itemId] ?? 0) < 1) return false;
    this.gs.inventory[itemId]--;
    this.gs.silver += sell;
    return true;
  }

  // ============ 武器装備 ============
  equip(charId: string, itemId: string): boolean {
    const c = this.gs.party[charId];
    const item = DB.items[itemId];
    if (!c || !item || item.category !== "weapon") return false;
    if (item.weapon_type !== DB.characters[charId].weapon_type) return false;
    if ((this.gs.inventory[itemId] ?? 0) < 1) return false;
    if (c.equippedWeapon) {
      this.gs.inventory[c.equippedWeapon] = (this.gs.inventory[c.equippedWeapon] ?? 0) + 1;
    }
    this.gs.inventory[itemId]--;
    c.equippedWeapon = itemId;
    return true;
  }

  // ============ ボス出現条件（第8巻11章）============
  bossUnlocked(bossId: string): boolean {
    const def = getEnemyDef(bossId);
    const u = def.unlock ?? {};
    if (this.gs.flags[`${bossId}_defeated`] && bossId !== "pirate_captain") return false;
    if (u["day_min"] !== undefined && this.gs.day < (u["day_min"] as number)) return false;
    if (u["day_fixed"] !== undefined && this.gs.day < (u["day_fixed"] as number)) return false;
    if (u["tributes_fire_min"] !== undefined && this.gs.tribute.fireCount < (u["tributes_fire_min"] as number)) return false;
    if (u["shark_kills_min"] !== undefined && this.gs.stats.sharkKills < (u["shark_kills_min"] as number)) return false;
    if (u["coma_count_min"] !== undefined && this.gs.stats.comaTotal < (u["coma_count_min"] as number)) return false;
    if (u["tide"] !== undefined && this.gs.tide !== u["tide"]) return false;
    return true;
  }

  // 夢の中の戦闘（第8巻10-8: 眠った本人1人。敵Lv=本人のLv。勝利=安眠HP+10%/敗北=昏睡）
  startDreamBattle(dreamerId: string): BattleManager {
    const dreamer = this.gs.party[dreamerId];
    const ctx: BattleContext = {
      location: "dream", slot: "night", tide: "low",
      isBoss: false, weatherHitPenalty: 0, areaLvMod: 0,
    };
    this.nightEventBattle = true;
    this.currentBattle = new BattleManager(
      ["nightmare"], [dreamer],
      // 夢の主が保持者でない場合、保持者制限は夢の主に適用されない
      dreamerId === this.gs.holder ? this.gs.holder : "__none__",
      ctx, this.rng,
      (a, b) => this.trust.pair(a, b),
      (id) => this.trust.totalOf(id),
    );
    this.phase = "battle";
    return this.currentBattle;
  }

  // 夢戦闘の後処理: 勝利=安眠(HP+10%)・敗北/逃走=昏睡（敗北時のみ）
  settleDreamBattle(dreamerId: string): BattleResult {
    const result = this.settleBattle();
    const c = this.gs.party[dreamerId];
    if (result.outcome === "victory") {
      c.hp = Math.min(c.maxHp, c.hp + Math.round(c.maxHp * 0.10));
    } else if (result.outcome === "defeat") {
      c.downed = false;
      c.hp = Math.max(1, c.hp);
      this.statusFx.apply(dreamerId, "coma", "nightmare");
    }
    return result;
  }

  // 夜襲戦闘（第14巻18-6）: 拠点に悪魔1〜2体【AI提案: 対象選択式は第9巻12-5-2受領後に差替】
  startNightRaidBattle(memberIds: string[]): BattleManager {
    const count = this.rng.int(1, 2);
    const ctx: BattleContext = {
      location: "base", slot: "night", tide: "low",
      isBoss: false, weatherHitPenalty: 0, areaLvMod: 0,
    };
    this.nightEventBattle = true;
    const members = memberIds
      .map((id) => this.gs.party[id])
      .filter((c) => c && c.exclusion === "none" && c.comaDaysLeft === 0);
    if (members.length === 0) throw new Error("no battle members");
    this.currentBattle = new BattleManager(
      Array(count).fill("demon"), members, this.gs.holder, ctx, this.rng,
      (a, b) => this.trust.pair(a, b),
      (id) => this.trust.totalOf(id),
    );
    this.phase = "battle";
    return this.currentBattle;
  }

  triggerGameOver(reason: GOReason): void {
    this.gs.gameOver = reason;
    this.phase = "gameover";
  }

  possess(charId: string): void {
    if (charId === this.gs.holder) { this.triggerGameOver("holder_possess"); return; }
    this.statusFx.apply(charId, "betrayal", "demon");
  }

  joinGoddess(): void {
    if (this.gs.party["goddess"]) return;
    const lv = Math.max(DB.characters["goddess"].join_min_lv ?? 40,
      Math.round(this.party.avgLevel()));
    this.gs.party["goddess"] = createCharacterState("goddess", lv);
    this.gs.flags["goddess_joined"] = true;
  }

  foodStockList(): FoodStockEntry[] { return this.gs.foodStock; }
}
