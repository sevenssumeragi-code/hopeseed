// EventManager（GDD第16巻20-5 / 20-3-4イベント共通スキーマ）。
// evaluate_triggers: day/flags/location/slot/trust条件を評価し発火可能イベントを列挙。
// play: variant解決（trust_avg_holder>=N / default）→ 報酬・フラグ付与。

import { DB } from "../dataLoader.js";
import type { TrustManager } from "./trustManager.js";
import type { GameState, ScenarioEvent } from "../types.js";

export interface PlayedEvent {
  id: string;
  text: string;
  variantKey: string;
}

export class EventManager {
  constructor(private gs: GameState, private trust: TrustManager) {}

  evaluateTriggers(): ScenarioEvent[] {
    const out: ScenarioEvent[] = [];
    for (const ev of DB.scenarios) {
      if (this.gs.flags[`${ev.id}_played`]) continue;
      const t = ev.trigger;
      if (t.day_min !== undefined && this.gs.day < t.day_min) continue;
      if (t.day_max !== undefined && this.gs.day > t.day_max) continue;
      if (t.location !== undefined && this.gs.location !== t.location) continue;
      if (t.slot !== undefined && !t.slot.includes(this.gs.slot)) continue;
      if (t.flags_all?.some((f) => !this.gs.flags[f])) continue;
      if (t.flags_none?.some((f) => this.gs.flags[f])) continue;
      if (t.trust_min !== undefined && ev.pair) {
        const [a, b] = ev.pair.split(":");
        if (this.trust.pair(a, b) < t.trust_min) continue;
      }
      if (ev.requires_alive?.some((id) => {
        const c = this.gs.party[id];
        return !c || c.exclusion !== "none";
      })) continue;
      out.push(ev);
    }
    return out;
  }

  private resolveCond(cond: string): boolean {
    if (cond === "default") return true;
    const m = cond.match(/^trust_avg_holder>=(\d+)$/);
    if (m) return this.trust.avgHolder() >= Number(m[1]);
    return false;
  }

  play(eventId: string): PlayedEvent | null {
    const ev = DB.scenarios.find((e) => e.id === eventId);
    if (!ev) return null;
    const variant = ev.variants.find((v) => this.resolveCond(v.cond));
    if (!variant) return null;

    // 報酬（trust）
    for (const r of ev.rewards?.trust ?? []) {
      const [a, b] = r.pair.split(":");
      if (b === "*") {
        for (const other of Object.keys(this.gs.party)) {
          if (other !== a) this.trust.add(a, other, r.amount, `event:${ev.id}`);
        }
      } else {
        this.trust.add(a, b, r.amount, `event:${ev.id}`);
      }
    }
    for (const f of ev.sets_flags ?? []) this.gs.flags[f] = true;
    this.gs.flags[`${ev.id}_played`] = true;
    if (ev.core) {
      this.gs.flags[`core_${ev.id}`] = true;
    }
    return { id: ev.id, text: variant.text, variantKey: variant.key };
  }

  coreEventCount(): number {
    return Object.keys(this.gs.flags).filter((f) => f.startsWith("core_") && this.gs.flags[f]).length;
  }
}
