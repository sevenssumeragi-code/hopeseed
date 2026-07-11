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

interface SaveEnvelope { checksum: string; payload: string; savedAt: string; }

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
    const env: SaveEnvelope = {
      checksum: checksum(payload),
      payload,
      savedAt: new Date().toISOString(),
    };
    storeSet(`hopeseed_${slotId}`, JSON.stringify(env));
  }

  listSlots(): string[] {
    const slots: string[] = [];
    for (let i = 0; i < SaveManager.AUTO_SLOTS; i++) {
      if (storeGet(`hopeseed_auto_${i}`)) slots.push(`auto_${i}`);
    }
    for (let i = 1; i <= 3; i++) {
      if (storeGet(`hopeseed_manual_${i}`)) slots.push(`manual_${i}`);
    }
    return slots;
  }
}
