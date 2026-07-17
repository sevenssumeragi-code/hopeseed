// StatusEffectManager（第14巻18-4 戦闘外タイマー・最終値）。
// 毒7日/大火傷7日/大出血3日/疫病(3日目から重症化20%+10%/日→重症3日で死亡)/
// 感染症(6日目から5%+5%/日→重症3日・毎日10%伝染)/しびれ移動死30%/肥満/絶食7日。

import { DB } from "../dataLoader.js";
import type { RNG } from "./rng.js";
import type { GameState } from "../types.js";

export interface DeathEvent { charId: string; cause: string; }
export interface DailyTickResult {
  deaths: DeathEvent[];
  recovered: { charId: string; from: string }[];
  left: string[];
  starvation: boolean;
  infected: string[];   // 伝染発生
}

export class StatusEffectManager {
  constructor(private gs: GameState, private rng: RNG) {}

  apply(charId: string, effect: string, _source: string): void {
    const c = this.gs.party[charId];
    if (!c) return;
    const t = DB.config.status_timers;
    switch (effect) {
      case "poison": c.status.poison = t.poison_death_days; break;
      case "burn": c.status.burn = t.burn_death_days; break;
      case "bleed": c.status.bleed = t.bleed_death_days; break;
      case "paralysis": c.status.paralysis = 1; break;
      case "plague": c.status.plagueDay = 0; break;
      case "infection": c.status.infectDay = 0; break;
      case "obesity": c.status.obesity = true; c.status.obesityPlainDays = 0; break;
      case "coma":
        c.comaDaysLeft = this.rng.int(t.coma_recover_min_days, t.coma_recover_max_days);
        c.exclusion = "coma";
        this.gs.stats.comaTotal++;
        this.gs.lastComaDay = this.gs.day; // 夢魔遭遇+2%の週判定（第14巻18-7）
        break;
      case "betrayal":
        c.exclusion = "betrayal";
        c.betrayalDaysLeft = DB.config.possess.betrayal_leave_days;
        break;
      default: break;
    }
  }

  cure(charId: string, effect: string): void {
    const c = this.gs.party[charId];
    if (!c) return;
    const st = c.status;
    // 実際に治療が成立した回数を数える（A26「名医の島」・第15巻）
    const had = (effect === "poison" && st.poison !== undefined)
      || (effect === "burn" && st.burn !== undefined)
      || (effect === "bleed" && st.bleed !== undefined)
      || (effect === "paralysis" && st.paralysis !== undefined)
      || (effect === "plague" && st.plagueDay !== undefined)
      || (effect === "infection" && st.infectDay !== undefined)
      || (effect === "obesity" && st.obesity === true);
    if (had) this.gs.stats.cured = (this.gs.stats.cured ?? 0) + 1;
    if (effect === "poison") delete st.poison;
    else if (effect === "burn") delete st.burn;
    else if (effect === "bleed") delete st.bleed;
    else if (effect === "paralysis") delete st.paralysis;
    else if (effect === "plague") { delete st.plagueDay; delete st.plagueSevereDays; }
    else if (effect === "infection") { delete st.infectDay; delete st.infectSevereDays; }
    else if (effect === "obesity") { delete st.obesity; delete st.obesityPlainDays; }
  }

  // 作業コマンド不可判定（大火傷・大出血 = 第7巻9-0）
  canWork(charId: string): boolean {
    const c = this.gs.party[charId];
    if (!c) return false;
    return !(c.status.burn !== undefined || c.status.bleed !== undefined);
  }

  dailyTick(): DailyTickResult {
    const res: DailyTickResult = { deaths: [], recovered: [], left: [], starvation: false, infected: [] };
    const t = DB.config.status_timers;

    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion === "dead" || c.exclusion === "kidnapped") continue;
      const st = c.status;

      // 毒・大火傷・大出血: タイマー死亡
      for (const k of ["poison", "burn", "bleed"] as const) {
        if (st[k] !== undefined) {
          st[k]!--;
          if (st[k]! <= 0) {
            c.exclusion = "dead";
            res.deaths.push({ charId: c.id, cause: k });
          }
        }
      }
      if (c.exclusion === "dead") continue;

      // 疫病: 3日目から重症化判定20%+10%/日→重症のまま3日で死亡
      if (st.plagueDay !== undefined) {
        st.plagueDay++;
        if (st.plagueSevereDays !== undefined) {
          st.plagueSevereDays++;
          if (st.plagueSevereDays >= t.plague_severe_death_days) {
            c.exclusion = "dead";
            res.deaths.push({ charId: c.id, cause: "plague" });
            continue;
          }
        } else if (st.plagueDay >= t.plague_severe_from_day) {
          const chance = t.plague_severe_base
            + t.plague_severe_step * (st.plagueDay - t.plague_severe_from_day);
          if (this.rng.chance(chance)) st.plagueSevereDays = 0;
        }
      }

      // 感染症: 6日目から5%+5%/日→重症3日で死亡・毎日10%で伝染
      if (st.infectDay !== undefined) {
        st.infectDay++;
        if (st.infectSevereDays !== undefined) {
          st.infectSevereDays++;
          if (st.infectSevereDays >= t.infect_severe_death_days) {
            c.exclusion = "dead";
            res.deaths.push({ charId: c.id, cause: "infection" });
            continue;
          }
        } else if (st.nursedToday) {
          // 看病: 重症化判定をその日1回スキップ（第7巻9-4）
        } else if (st.infectDay >= t.infect_severe_from_day) {
          const chance = t.infect_severe_base
            + t.infect_severe_step * (st.infectDay - t.infect_severe_from_day);
          if (this.rng.chance(chance)) st.infectSevereDays = 0;
        }
        delete st.nursedToday;
      }

      // 肥満: 粗食7日で解消
      if (st.obesity) {
        st.obesityPlainDays = (st.obesityPlainDays ?? 0) + 1;
        if (st.obesityPlainDays >= t.obesity_plain_days) {
          delete st.obesity; delete st.obesityPlainDays;
          res.recovered.push({ charId: c.id, from: "obesity" });
        }
      }

      // 昏睡: 3~5日で自然回復（矛盾#7）
      if (c.comaDaysLeft > 0) {
        c.comaDaysLeft--;
        if (c.comaDaysLeft === 0) {
          c.exclusion = "none";
          res.recovered.push({ charId: c.id, from: "coma" });
        }
      }

      // 裏切り: 3日で離脱
      if (c.exclusion === "betrayal") {
        c.betrayalDaysLeft--;
        if (c.betrayalDaysLeft <= 0) {
          c.exclusion = "dead";
          res.left.push(c.id);
        }
      }
    }

    // 感染症の伝染（M2仕様: 感染者が1人でもいる限り、1日1回10%で未感染の味方1人へ）
    const infectedExists = Object.values(this.gs.party).some(
      (c) => c.exclusion !== "dead" && c.exclusion !== "kidnapped" && c.status.infectDay !== undefined);
    if (infectedExists && this.rng.chance(t.infect_spread_rate)) {
      const targets = Object.values(this.gs.party).filter(
        (o) => o.exclusion === "none" && o.status.infectDay === undefined);
      if (targets.length > 0) {
        const victim = this.rng.pick(targets);
        victim.status.infectDay = 0;
        res.infected.push(victim.id);
      }
    }

    // 空腹（第14巻18-4・M2仕様: キャラ個別。−15%/日(探索−20%)・0%で毎日HP10%減・絶食7日で死亡）
    const decay = this.gs.exploredToday
      ? DB.config.hunger.decay_per_day_explore : DB.config.hunger.decay_per_day;
    this.gs.exploredToday = false;
    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion === "dead" || c.exclusion === "kidnapped") continue;
      c.satiety = Math.max(0, c.satiety - decay);
      if (c.satiety <= 0) {
        c.starveDays++;
        c.hp = Math.max(1, c.hp - Math.round(c.maxHp * DB.config.hunger.zero_daily_hp_loss));
        if (c.starveDays >= DB.config.hunger.starve_death_days) {
          c.exclusion = "dead";
          res.deaths.push({ charId: c.id, cause: "starvation" });
          if (c.id === this.gs.holder) res.starvation = true;
        }
      } else {
        c.starveDays = 0;
      }
    }

    return res;
  }

  // 移動時判定: しびれ状態で火山/満潮浅瀬に入ると30%で死亡（第14巻18-4）
  paralysisMoveCheck(mapId: string, tide: string): DeathEvent[] {
    const t = DB.config.status_timers;
    const map = DB.maps[mapId];
    const dangerous = map?.paralysis_death_zone
      || (map?.paralysis_death_zone_high_tide && tide === "high");
    if (!dangerous) return [];
    const deaths: DeathEvent[] = [];
    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion !== "none") continue;
      if ((c.status.paralysis ?? 0) > 0 && this.rng.chance(t.paralysis_move_death)) {
        c.exclusion = "dead";
        deaths.push({ charId: c.id, cause: "paralysis_move" });
      }
    }
    return deaths;
  }

  // 毒: 移動1エリアごとにHP3%減（第14巻18-4）
  poisonMoveTick(): void {
    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion !== "none") continue;
      if (c.status.poison !== undefined) {
        c.hp = Math.max(1, c.hp - Math.max(1, Math.round(c.maxHp * DB.config.status_timers.poison_move_hp_loss)));
      }
    }
  }
}
