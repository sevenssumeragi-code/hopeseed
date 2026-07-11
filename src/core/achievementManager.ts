// AchievementManager（GDD第16巻20-2）。achievements.json駆動で解除判定。

import { DB } from "../dataLoader.js";
import type { TrustManager } from "./trustManager.js";
import type { GameState } from "../types.js";

export class AchievementManager {
  constructor(private gs: GameState, private trust: TrustManager) {}

  // 状態変化のたびに呼び、新規解除された実績IDの配列を返す
  check(endingId?: string): string[] {
    const unlocked: string[] = [];
    for (const a of DB.achievements) {
      if (this.gs.achievements.includes(a.id)) continue;
      if (this.matches(a.cond, endingId)) {
        this.gs.achievements.push(a.id);
        unlocked.push(a.id);
      }
    }
    return unlocked;
  }

  private matches(cond: Record<string, any>, endingId?: string): boolean {
    const s = this.gs.stats;
    if (cond.battles_won !== undefined && s.battlesWon < cond.battles_won) return false;
    if (cond.survived_day !== undefined && this.gs.day < cond.survived_day) return false;
    if (cond.cooked !== undefined && s.cooked < cond.cooked) return false;
    if (cond.built !== undefined && s.built < cond.built) return false;
    if (cond.brewed !== undefined && s.brewed < cond.brewed) return false;
    if (cond.revived !== undefined && s.revived < cond.revived) return false;
    if (cond.protect_success !== undefined && s.protectSuccess < cond.protect_success) return false;
    if (cond.trust_avg_min !== undefined && this.trust.avgHolder() < cond.trust_avg_min) return false;
    if (cond.ending !== undefined && endingId !== cond.ending) return false;
    if (cond.flag !== undefined && !this.gs.flags[cond.flag]) return false;
    return true;
  }

  completionRate(): number {
    return Math.round((this.gs.achievements.length / DB.achievements.length) * 100);
  }
}
