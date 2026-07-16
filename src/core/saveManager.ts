// SaveManager（GDD第16巻20-5 / 20-1: JSON＋チェックサム 第13巻17-5）。
// ブラウザではlocalStorage、Node(テスト)ではメモリMapに保存。
// オートセーブ=スロットローテーション、手動3スロット。

import type { GameState } from "../types.js";

const memStore = new Map<string, string>();

function storeSet(key: string, value: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  else memStore.set(key, value);
}
function storeGet(key: string): string | null {
  if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  return memStore.get(key) ?? null;
}

// FNV-1a 32bit チェックサム
export function checksum(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface SaveMeta {
  day: number; holder: string; slot: string; savedAt: string;
  aliveCount: number; trustAvg: number;
}
interface SaveEnvelope { checksum: string; payload: string; savedAt: string; meta?: SaveMeta; }
const MANUAL_SLOTS = 10;

export class SaveManager {
  private autoIndex = 0;
  private static AUTO_SLOTS = 3;

  autosave(gs: GameState, slotRotation = true): string {
    const slot = `auto_${this.autoIndex}`;
    if (slotRotation) this.autoIndex = (this.autoIndex + 1) % SaveManager.AUTO_SLOTS;
    this.write(slot, gs);
    return slot;
  }

  saveManual(slot: number, gs: GameState): void {
    this.write(`manual_${slot}`, gs);
  }

  loadSlot(slotId: string): GameState | null {
    const raw = storeGet(`hopeseed_${slotId}`);
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as SaveEnvelope;
      if (checksum(env.payload) !== env.checksum) return null; // 破損検出
      return JSON.parse(env.payload) as GameState;
    } catch {
      return null;
    }
  }

  private write(slotId: string, gs: GameState): void {
    const payload = JSON.stringify(gs);
    const alive = Object.values(gs.party).filter((c) => c.exclusion === "none").length;
    const holderTrust = Object.keys(gs.party)
      .filter((id) => id !== gs.holder)
      .map((id) => gs.trust[[gs.holder, id].sort().join(":")])
      .filter((v): v is number => v !== undefined);
    const env: SaveEnvelope = {
      checksum: checksum(payload),
      payload,
      savedAt: new Date().toISOString(),
      meta: {
        day: gs.day, holder: gs.holder, slot: gs.slot,
        savedAt: new Date().toISOString(),
        aliveCount: alive,
        trustAvg: holderTrust.length > 0
          ? holderTrust.reduce((s2, v) => s2 + v, 0) / holderTrust.length : 0,
      },
    };
    storeSet(`hopeseed_${slotId}`, JSON.stringify(env));
  }

  readMeta(slotId: string): SaveMeta | null {
    const raw = storeGet(`hopeseed_${slotId}`);
    if (!raw) return null;
    try {
      const env = JSON.parse(raw) as SaveEnvelope;
      return env.meta ?? null;
    } catch { return null; }
  }

  // オート3世代＋手動10（第13巻17-3: 計13スロット一覧）
  listSlots(): string[] {
    const slots: string[] = [];
    for (let i = 0; i < SaveManager.AUTO_SLOTS; i++) {
      if (storeGet(`hopeseed_auto_${i}`)) slots.push(`auto_${i}`);
    }
    for (let i = 1; i <= MANUAL_SLOTS; i++) {
      if (storeGet(`hopeseed_manual_${i}`)) slots.push(`manual_${i}`);
    }
    return slots;
  }

  allSlotIds(): string[] {
    const ids: string[] = [];
    for (let i = 0; i < SaveManager.AUTO_SLOTS; i++) ids.push(`auto_${i}`);
    for (let i = 1; i <= MANUAL_SLOTS; i++) ids.push(`manual_${i}`);
    return ids;
  }
}
