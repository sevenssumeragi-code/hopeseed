// StatusEffectManager（GDD第16巻20-5）。
// daily_tick: 毒7日/大出血3日/疫病重症化20%+10%/日 のタイマー死亡（20-8確定）、
// 昏睡3~5日回復、裏切り3日離脱、空腹減衰・絶食7日死亡。

import { DB } from "../dataLoader.js";
import type { RNG } from "./rng.js";
import type { GameState } from "../types.js";

export interface DeathEvent { charId: string; cause: string; }
export interface DailyTickResult {
  deaths: DeathEvent[];
  recovered: { charId: string; from: string }[];
  left: string[];       // 裏切り離脱
  starvation: boolean;  // 全体飢餓死フラグ
}

export class StatusEffectManager {
  constructor(private gs: GameState, private rng: RNG) {}

  apply(charId: string, effect: string, _source: string): void {
    const c = this.gs.party[charId];
    if (!c) return;
    const t = DB.config.status_timers;
    switch (effect) {
      case "poison": c.status.poison = t.poison_death_days; break;
      case "bleed": c.status.bleed = t.bleed_death_days; break;
      case "plague":
        c.status.plague = 0;
        c.status.plague_chance = t.plague_worsen_base;
        break;
      case "coma":
        c.comaDaysLeft = this.rng.int(t.coma_recover_min_days, t.coma_recover_max_days);
        c.exclusion = "coma";
        break;
      case "betrayal":
        c.exclusion = "betrayal";
        c.betrayalDaysLeft = t.betrayal_leave_days;
        break;
      default: break;
    }
  }

  cure(charId: string, effect: string): void {
    const c = this.gs.party[charId];
    if (!c) return;
    delete (c.status as Record<string, unknown>)[effect];
    if (effect === "plague") delete c.status.plague_chance;
  }

  dailyTick(): DailyTickResult {
    const res: DailyTickResult = { deaths: [], recovered: [], left: [], starvation: false };
    const t = DB.config.status_timers;

    for (const c of Object.values(this.gs.party)) {
      if (c.exclusion === "dead" || c.exclusion === "kidnapped") continue;

      // 毒・大出血: 残日数を減らし0で死亡
      for (const k of ["poison", "bleed"] as const) {
        if (c.status[k] !== undefined) {
          c.status[k]!--;
          if (c.status[k]! <= 0) {
            c.exclusion = "dead";
            res.deaths.push({ charId: c.id, cause: k });
          }
        }
      }
      if (c.exclusion === "dead") continue;

      // 疫病: 重症化判定 20% + 10%/日。重症化=死亡（第14巻詳細未受領のため重症化→死亡と解釈【AI提案】）
      if (c.status.plague !== undefined) {
        const chance = c.status.plague_chance ?? t.plague_worsen_base;
        if (this.rng.chance(chance)) {
          c.exclusion = "dead";
          res.deaths.push({ charId: c.id, cause: "plague" });
          continue;
        }
        c.status.plague_chance = chance + t.plague_worsen_per_day;
        c.status.plague!++;
      }

      // 昏睡: 3~5日で自然回復（薬なし・矛盾#7）
      if (c.comaDaysLeft > 0) {
        c.comaDaysLeft--;
        if (c.comaDaysLeft === 0) {
          c.exclusion = "none";
          res.recovered.push({ charId: c.id, from: "coma" });
        }
      }

      // 裏切り: 3日で離脱（矛盾#9）
      if (c.exclusion === "betrayal") {
        c.betrayalDaysLeft--;
        if (c.betrayalDaysLeft <= 0) {
          c.exclusion = "dead"; // 離脱(除外扱い)
          res.left.push(c.id);
        }
      }
    }

    // 空腹: 1日で減衰、0が7日続くと死亡（絶食7日・第0巻0-5）
    this.gs.hunger = Math.max(0, this.gs.hunger - DB.config.hunger.decay_per_day);
    if (this.gs.hunger <= 0) {
      this.gs.starvingDays++;
      if (this.gs.starvingDays >= DB.config.hunger.starve_death_days) res.starvation = true;
    } else {
      this.gs.starvingDays = 0;
    }

    return res;
  }
}
