// TributeManager（GDD第16巻20-5）。供物期限14日、加護保持者は28日（第0巻0-3-4）。
// 期限超過→GO4(火山噴火)/GO5(島水没)。

import { DB } from "../dataLoader.js";
import type { GameState, Goddess, GOReason } from "../types.js";

export class TributeManager {
  constructor(private gs: GameState) {}

  intervalDays(goddess: Goddess): number {
    const t = DB.config.tribute;
    // ジンパチ保持者→炎28日／レニィ保持者→水28日
    if (goddess === "fire" && this.gs.holder === "jinpachi") return t.grace_interval_days;
    if (goddess === "water" && this.gs.holder === "renny") return t.grace_interval_days;
    return goddess === "fire" ? t.fire_interval_days : t.water_interval_days;
  }

  remainingDays(goddess: Goddess): number {
    const last = goddess === "fire" ? this.gs.tribute.fireLastDay : this.gs.tribute.waterLastDay;
    return this.intervalDays(goddess) - (this.gs.day - last);
  }

  // 供物を捧げる。品目familyの検査（肉=fire/魚=water）と在庫消費、台詞キーを返す
  offer(goddess: Goddess, itemId: string): { ok: boolean; line: string } {
    const item = DB.items[itemId];
    const requiredFamily = goddess === "fire"
      ? DB.config.tribute.fire_item_family
      : DB.config.tribute.water_item_family;
    const lines = goddess === "fire" ? DB.npcLines.fire_goddess : DB.npcLines.water_goddess;

    if (!item || item.family !== requiredFamily || (this.gs.inventory[itemId] ?? 0) < 1) {
      return { ok: false, line: lines.offer_none };
    }
    this.gs.inventory[itemId]--;
    if (goddess === "fire") { this.gs.tribute.fireLastDay = this.gs.day; this.gs.tribute.fireCount++; }
    else { this.gs.tribute.waterLastDay = this.gs.day; this.gs.tribute.waterCount++; }
    this.gs.journal?.tributes.push({ day: this.gs.day, goddess }); // 日誌（第13巻16-2）
    return { ok: true, line: lines.offer_ok };
  }

  // 日次判定（MorningTickから呼ぶ）。期限超過でGO理由を返す
  checkExpiry(): GOReason | null {
    if (this.remainingDays("fire") < 0) return "tribute_fire_expired";
    if (this.remainingDays("water") < 0) return "tribute_water_expired";
    return null;
  }
}
