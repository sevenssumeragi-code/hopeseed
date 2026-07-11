// EndingJudge（GDD第16巻20-5）。Day365で判定。
// 真ED条件: 除外0＋avg80＋核心7/7＋隠し旗（20-8確定）。priority降順で最初に満たしたEDを返す。

import { DB } from "../dataLoader.js";
import type { PartyManager } from "./partyManager.js";
import type { TrustManager } from "./trustManager.js";
import type { EventManager } from "./eventManager.js";
import type { GameState } from "../types.js";

export interface EndingResult { id: string; name: string; desc: string; }

export class EndingJudge {
  constructor(
    private gs: GameState,
    private party: PartyManager,
    private trust: TrustManager,
    private events: EventManager,
  ) {}

  judge(): EndingResult {
    const endings = Object.entries(DB.endings.endings as Record<string, any>)
      .sort(([, a], [, b]) => b.priority - a.priority);

    for (const [id, ed] of endings) {
      if (this.matches(ed.cond)) {
        return { id, name: ed.name, desc: ed.desc };
      }
    }
    // NORMALは survived_day のみなので必ず到達するが、保険としてフォールバック
    const normal = DB.endings.endings["NORMAL"];
    return { id: "NORMAL", name: normal.name, desc: normal.desc };
  }

  private matches(cond: Record<string, any>): boolean {
    if (cond.survived_day !== undefined && this.gs.day < cond.survived_day) return false;
    if (cond.exclusions_max !== undefined && this.party.exclusionCount() > cond.exclusions_max) return false;
    if (cond.trust_avg_min !== undefined && this.trust.avgHolder() < cond.trust_avg_min) return false;
    if (cond.core_events_required !== undefined
      && this.events.coreEventCount() < cond.core_events_required) return false;
    if (cond.hidden_flag && !this.gs.flags["goddess_joined"]) return false;
    return true;
  }
}
