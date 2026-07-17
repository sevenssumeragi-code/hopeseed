// AchievementManager（第15巻19章・正本）。achievements.json（全65種）駆動。
// 実績は周回をまたいで累積し、セーブとは別のシステムデータに保存（第13巻17-5）。
// 解除時はトーストキューに積み、UIが表示する（19章冒頭）。

import { DB } from "../dataLoader.js";
import { readGallery, readUnlockedAchievements, persistAchievement } from "./saveManager.js";
import type { TrustManager } from "./trustManager.js";
import type { GameState } from "../types.js";

export class AchievementManager {
  private toastQueue: string[] = [];

  constructor(private gs: GameState, private trust: TrustManager) {
    // 周回累積: システムデータの解除済みを現セッションへ反映（第15巻）
    for (const id of readUnlockedAchievements()) {
      if (!this.gs.achievements.includes(id)) this.gs.achievements.push(id);
    }
  }

  // 状態変化のたびに呼び、新規解除された実績IDの配列を返す
  check(endingGrade?: string): string[] {
    const unlocked: string[] = [];
    for (const a of DB.achievements) {
      if (a.cond.all_others) continue; // H15は最後に別判定
      if (this.gs.achievements.includes(a.id)) continue;
      if (this.matches(a.cond, endingGrade)) {
        this.unlock(a.id, unlocked);
      }
    }
    // H15「島に愛された者」: 自身を除く64種すべて解除（19-2）
    const h15 = DB.achievements.find((a) => a.cond.all_others);
    if (h15 && !this.gs.achievements.includes(h15.id)
      && DB.achievements.every((a) => a.id === h15.id || this.gs.achievements.includes(a.id))) {
      this.unlock(h15.id, unlocked);
    }
    return unlocked;
  }

  private unlock(id: string, out: string[]): void {
    this.gs.achievements.push(id);
    persistAchievement(id);   // 周回累積（システムデータ）
    this.toastQueue.push(id);
    out.push(id);
  }

  // UI用: 未表示のトーストを取り出す（第15巻: 画面右上にトースト表示）
  consumeToasts(): string[] {
    const t = [...this.toastQueue];
    this.toastQueue = [];
    return t;
  }

  private matches(cond: Record<string, any>, endingGrade?: string): boolean {
    const s = this.gs.stats as Record<string, number | undefined>;
    if (cond.battles_won !== undefined && this.gs.stats.battlesWon < cond.battles_won) return false;
    if (cond.survived_day !== undefined && this.gs.day < cond.survived_day) return false;
    if (cond.revived !== undefined && this.gs.stats.revived < cond.revived) return false;
    if (cond.protect_success !== undefined && this.gs.stats.protectSuccess < cond.protect_success) return false;
    if (cond.stat !== undefined && (s[cond.stat.key] ?? 0) < cond.stat.min) return false;
    if (cond.flag !== undefined && !this.gs.flags[cond.flag]) return false;
    if (cond.flags_any !== undefined && !cond.flags_any.some((f: string) => this.gs.flags[f])) return false;
    if (cond.flag_count !== undefined) {
      const n = Object.keys(this.gs.flags)
        .filter((f) => f.startsWith(cond.flag_count.prefix) && this.gs.flags[f]).length;
      if (n < cond.flag_count.count) return false;
    }
    if (cond.pair_max !== undefined
      && Math.max(0, ...Object.values(this.gs.trust)) < cond.pair_max) return false;
    if (cond.tribute_fire_min !== undefined && this.gs.tribute.fireCount < cond.tribute_fire_min) return false;
    if (cond.tribute_water_min !== undefined && this.gs.tribute.waterCount < cond.tribute_water_min) return false;
    if (cond.tribute_total_min !== undefined
      && this.gs.tribute.fireCount + this.gs.tribute.waterCount < cond.tribute_total_min) return false;
    if (cond.level_any_min !== undefined
      && !Object.values(this.gs.party).some((c) => c.level >= cond.level_any_min)) return false;
    if (cond.ending !== undefined && endingGrade !== cond.ending) return false;
    if (cond.ending_any && endingGrade === undefined) return false;
    if (cond.stats_zero !== undefined
      && cond.stats_zero.some((k: string) => ((s[k] as number) ?? (k === "comaTotal" ? this.gs.stats.comaTotal : 0)) > 0)) return false;
    if (cond.gallery_ending !== undefined && !readGallery().endings.includes(cond.gallery_ending)) return false;
    if (cond.gallery_go !== undefined && !readGallery().goSeen.includes(cond.gallery_go)) return false;
    if (cond.gallery_endings_min !== undefined
      && readGallery().endings.length < cond.gallery_endings_min) return false;
    if (cond.cleared_routes_min !== undefined
      && (readGallery().clearedRoutes ?? []).length < cond.cleared_routes_min) return false;
    if (cond.trust_avg_min !== undefined && this.trust.avgHolder() < cond.trust_avg_min) return false;
    return true;
  }

  // コンプリート率（19-3-1: 重み=通常1/隠し2/A49・A50・H14・H15=5）
  completionRate(): number {
    const total = DB.achievements.reduce((s2, a) => s2 + (a.weight ?? (a.hidden ? 2 : 1)), 0);
    const got = DB.achievements
      .filter((a) => this.gs.achievements.includes(a.id))
      .reduce((s2, a) => s2 + (a.weight ?? (a.hidden ? 2 : 1)), 0);
    return Math.round((got / total) * 100);
  }
}

// タイトル画面用: セッション外からのコンプリート率（システムデータのみで算出）
export function globalCompletionRate(): number {
  const unlocked = readUnlockedAchievements();
  const total = DB.achievements.reduce((s, a) => s + (a.weight ?? (a.hidden ? 2 : 1)), 0);
  const got = DB.achievements
    .filter((a) => unlocked.includes(a.id))
    .reduce((s, a) => s + (a.weight ?? (a.hidden ? 2 : 1)), 0);
  return Math.round((got / total) * 100);
}
