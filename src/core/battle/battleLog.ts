// 戦闘ログ（GDD第16巻20-9: battle_log.jsonのテンプレート＋プレースホルダで管理）。

import templates from "../../../data/battle_log.json";

const T = templates as Record<string, string>;

export class BattleLog {
  lines: string[] = [];

  push(key: string, vars: Record<string, string | number> = {}): string {
    let line = T[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      line = line.replaceAll(`{${k}}`, String(v));
    }
    this.lines.push(line);
    return line;
  }

  clear(): void { this.lines = []; }
  tail(n: number): string[] { return this.lines.slice(-n); }
}
