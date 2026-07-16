// マップ移動フェーズ（GDD第0巻0-3-2）。簡易3D風(2.5D見下ろし)マップを
// 保持者キャラで歩行移動。敵シンボル接触で戦闘、採取ポイント、出口で隣接マップへ。
// 3Dモデル素材なしでも成立するようcanvas 2.5D描画を採用【AI提案・Three.js移行可能な構造】。

import { DB } from "../dataLoader.js";
import type { RNG } from "../core/rng.js";
import type { MapDef, TimeSlot } from "../types.js";

export interface FieldSymbol {
  kind: "enemy" | "gather" | "exit" | "shrine" | "boss" | "hazard" | "drift" | "fishing";
  x: number; y: number;
  enemyId?: string;
  gatherItem?: string;
  exitTo?: string;
  shrine?: string;
  bossId?: string;
  dx: number; dy: number;
}

export interface FieldEncounter { enemyIds: string[]; isBoss: boolean; bossId?: string; }

const AREA_COLORS: Record<string, [string, string]> = {
  base: ["#3a5a3a", "#2c4a2c"],
  forest_lake: ["#2c5a3c", "#1e4a30"],
  grassland: ["#4a6a34", "#3a5a28"],
  wasteland: ["#5a4a3a", "#4a3a2c"],
  trail: ["#6a3a2c", "#552a20"],
  volcano_summit: ["#7a2c1c", "#601c10"],
  beach: ["#8a7a52", "#7a6a44"],
  shallows: ["#2c5a7a", "#1e4a6a"],
  shrine_islet: ["#3a6a7a", "#2c5a6a"],
  pirate_ship: ["#4a3a2c", "#3a2c20"],
  dream: ["#4a2c6a", "#3a2055"],
};

export class FieldState {
  map: MapDef;
  mapId: string;
  px: number; py: number; // プレイヤー位置（マス座標）
  symbols: FieldSymbol[] = [];
  private rng: RNG;
  private day: number;
  private densityMult: number;
  private piratesStopped: boolean;

  private weather: string;
  private hasFishingRod: boolean;
  private driftAvailable: boolean;

  constructor(mapId: string, rng: RNG, slot: TimeSlot, opts?: {
    bossDefeated?: boolean; day?: number; densityMult?: number; piratesStopped?: boolean;
    weather?: string; hasFishingRod?: boolean; driftAvailable?: boolean;
  }) {
    this.mapId = mapId;
    this.map = DB.maps[mapId];
    this.rng = rng;
    this.day = opts?.day ?? 1;
    this.densityMult = opts?.densityMult ?? 1.0;
    this.piratesStopped = opts?.piratesStopped ?? false;
    this.weather = opts?.weather ?? "clear";
    this.hasFishingRod = opts?.hasFishingRod ?? false;
    this.driftAvailable = opts?.driftAvailable ?? false;
    this.px = this.map.size[0] / 2;
    this.py = this.map.size[1] - 2;
    this.populate(slot, opts?.bossDefeated ?? false);
  }

  private populate(slot: TimeSlot, bossDefeated: boolean): void {
    const [w, h] = this.map.size;
    // 出口
    this.map.connections.forEach((to, i) => {
      const positions: [number, number][] = [
        [w / 2, 0.8], [1, h / 2], [w - 1, h / 2], [w / 2, h - 0.8],
      ];
      const [x, y] = positions[i % positions.length];
      this.symbols.push({ kind: "exit", x, y, exitTo: to, dx: 0, dy: 0 });
    });
    // 敵シンボル: 密度は第14巻18-2（昼/夜）。夜は悪魔等が追加、海賊は昼のみ・40日目以降。
    const isNight = slot === "night";
    let pool = this.map.enemies.filter((id) => {
      const def = DB.enemies[id];
      const sp = def.spawn ?? { areas: [] };
      if (sp.from_day && this.day < sp.from_day) return false;
      if (def.family === "pirate" && (this.piratesStopped || (isNight && this.map.night_no_pirates))) return false;
      if (sp.time === "night" && !isNight) return false;
      if (sp.time === "day" && isNight && def.family !== "pirate") return false;
      return true;
    });
    if (isNight && this.map.night_enemies) {
      pool = pool.concat(this.map.night_enemies.filter((id) => {
        const sp = DB.enemies[id].spawn;
        return !(sp?.from_day && this.day < sp.from_day);
      }));
    }
    if (pool.length > 0) {
      let count = isNight ? this.map.density_night : this.map.density_day;
      // 火山灰: 火山系エリアの敵密度+20%（第3巻4-2）
      if (this.weather === "ash" && this.map.ash_density_bonus) {
        count *= 1 + this.map.ash_density_bonus;
      }
      // 夜間は火の玉の出現密度+30%（第3巻4-2）
      if (isNight && this.map.night_fireball_bonus) {
        count *= 1 + this.map.night_fireball_bonus;
      }
      count = Math.max(1, Math.round(count * this.densityMult));
      for (let i = 0; i < count; i++) {
        const enemyId = this.rng.pick(pool);
        const stationary = DB.enemies[enemyId].spawn?.stationary ?? false;
        this.symbols.push({
          kind: "enemy",
          x: this.rng.range(2, w - 2), y: this.rng.range(2, h * 0.75),
          enemyId,
          dx: stationary ? 0 : this.rng.range(-0.03, 0.03),
          dy: stationary ? 0 : this.rng.range(-0.03, 0.03),
        });
      }
    }
    // 採取ポイント
    for (const g of this.map.gather) {
      const n = Math.round(g.rate * 4);
      for (let i = 0; i < n; i++) {
        this.symbols.push({
          kind: "gather",
          x: this.rng.range(2, w - 2), y: this.rng.range(2, h - 2),
          gatherItem: g.item, dx: 0, dy: 0,
        });
      }
    }
    // 溶岩流（第3巻4-1: 触れるとダメージ+大火傷判定）
    if (this.map.lava_hazard) {
      for (let i = 0; i < 4; i++) {
        this.symbols.push({
          kind: "hazard",
          x: this.rng.range(3, w - 3), y: this.rng.range(4, h - 4),
          dx: 0, dy: 0,
        });
      }
    }
    // 漂着物ポイント（第3巻4-8: 毎日1回）
    if (this.map.drift_point && this.driftAvailable) {
      this.symbols.push({ kind: "drift", x: this.rng.range(3, w - 3), y: h - 3, dx: 0, dy: 0 });
    }
    // 釣りポイント（第3巻4-4/4-9: 釣り竿所持で解放・魚の安定供給）
    if (this.map.fishing && this.hasFishingRod) {
      this.symbols.push({ kind: "fishing", x: this.rng.range(3, w - 3), y: this.rng.range(3, h / 2), dx: 0, dy: 0 });
    }
    // 祠
    if (this.map.has_shrine) {
      this.symbols.push({ kind: "shrine", x: w / 2, y: 2, shrine: this.map.has_shrine, dx: 0, dy: 0 });
    }
    // ボス（海賊船最深部など・撃破済みなら出現しない）
    if (this.map.boss && !bossDefeated) {
      this.symbols.push({ kind: "boss", x: w / 2, y: 1.5, bossId: this.map.boss, dx: 0, dy: 0 });
    }
  }

  // 炎の女神の加護（第3巻4-2: 供物継続時、まれに敵を焼き払う）
  applyFireGrace(bonusChance = 0): string | null {
    if (!this.map.fire_grace) return null;
    const enemies = this.symbols.filter((s) => s.kind === "enemy");
    if (enemies.length === 0) return null;
    // 隠し「炎と水の姉妹」: 加護発動率+10%（第11巻14-4 #3）
    if (!this.rng.chance(DB.config.field.fire_grace_chance + bonusChance)) return null;
    const target = this.rng.pick(enemies);
    this.removeSymbol(target);
    return DB.enemies[target.enemyId!]?.name ?? null;
  }

  // 移動。接触イベントを返す
  move(dx: number, dy: number): FieldSymbol | null {
    const [w, h] = this.map.size;
    this.px = Math.max(0.5, Math.min(w - 0.5, this.px + dx));
    this.py = Math.max(0.5, Math.min(h - 0.5, this.py + dy));

    // 敵シンボルの徘徊
    for (const s of this.symbols) {
      if (s.kind !== "enemy") continue;
      s.x += s.dx; s.y += s.dy;
      if (s.x < 1 || s.x > w - 1) s.dx *= -1;
      if (s.y < 1 || s.y > h - 1) s.dy *= -1;
      // プレイヤーを緩く追尾
      s.x += Math.sign(this.px - s.x) * 0.01;
      s.y += Math.sign(this.py - s.y) * 0.01;
    }

    // 接触判定
    for (const s of this.symbols) {
      const d = Math.hypot(s.x - this.px, s.y - this.py);
      const r = s.kind === "exit" ? 1.0 : 0.8;
      if (d < r) return s;
    }
    return null;
  }

  removeSymbol(s: FieldSymbol): void {
    this.symbols = this.symbols.filter((x) => x !== s);
  }

  // エンカウント編成: シンボルの敵1~3体【AI提案】。満潮浅瀬は出現2倍（正本tide_multiplier）
  buildEncounter(s: FieldSymbol, tide: string): FieldEncounter {
    if (s.kind === "boss") return { enemyIds: [s.bossId!], isBoss: true, bossId: s.bossId };
    const id = s.enemyId!;
    const def = DB.enemies[id];
    let max = 2;
    if (def.spawn?.tide_multiplier && tide === "high") max = 3;
    const n = this.rng.int(1, max);
    return { enemyIds: Array(n).fill(id), isBoss: false };
  }

  // 2.5D描画
  render(canvas: HTMLCanvasElement, slot: TimeSlot): void {
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width, H = canvas.height;
    const [mw, mh] = this.map.size;
    ctx.clearRect(0, 0, W, H);

    // 疑似遠近: yが小さい(奥)ほど横幅を圧縮
    const proj = (x: number, y: number): [number, number, number] => {
      const t = y / mh;                       // 0=奥 1=手前
      const scale = 0.45 + 0.55 * t;
      const sx = W / 2 + (x - mw / 2) * (W / mw) * scale;
      const sy = H * 0.12 + t * H * 0.8;
      return [sx, sy, scale];
    };

    // 地面
    const [c1, c2] = AREA_COLORS[this.mapId] ?? ["#3a4a3a", "#2c3a2c"];
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, c2);
    grad.addColorStop(1, c1);
    ctx.fillStyle = grad;
    const [tl] = [proj(0, 0)];
    const [tr] = [proj(mw, 0)];
    ctx.beginPath();
    ctx.moveTo(tl[0], tl[1]);
    ctx.lineTo(tr[0], tr[1]);
    ctx.lineTo(...(proj(mw, mh).slice(0, 2) as [number, number]));
    ctx.lineTo(...(proj(0, mh).slice(0, 2) as [number, number]));
    ctx.closePath();
    ctx.fill();

    // グリッド線（3D感）
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= mw; gx += 2) {
      ctx.beginPath();
      const a = proj(gx, 0), b = proj(gx, mh);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    for (let gy = 0; gy <= mh; gy += 2) {
      ctx.beginPath();
      const a = proj(0, gy), b = proj(mw, gy);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }

    // 夜の暗さ
    if (slot === "night") {
      ctx.fillStyle = "rgba(10,10,40,0.45)";
      ctx.fillRect(0, 0, W, H);
    } else if (slot === "evening") {
      ctx.fillStyle = "rgba(120,60,20,0.18)";
      ctx.fillRect(0, 0, W, H);
    }

    // シンボル（奥から描画）
    const drawList = [...this.symbols].sort((a, b) => a.y - b.y);
    const emoji: Record<string, string> = {
      enemy: "👹", gather: "🌿", exit: "🚩", shrine: "⛩️", boss: "💀",
      hazard: "🌋", drift: "📦", fishing: "🎣",
    };
    for (const s of drawList) {
      const [sx, sy, sc] = proj(s.x, s.y);
      ctx.font = `${Math.round(26 * sc)}px serif`;
      ctx.textAlign = "center";
      // 敵は種類で見た目変更
      let icon = emoji[s.kind];
      if (s.kind === "enemy" && s.enemyId) {
        const fam = DB.enemies[s.enemyId]?.family;
        icon = fam === "demon" ? "😈" : fam === "pirate" ? "🏴‍☠️"
          : fam === "giant_fish" ? "🦈" : fam === "insect" ? "🦟"
          : fam === "man_eating_plant" ? "🌺" : fam === "fire_monster" ? "🔥"
          : fam === "nightmare" ? "👻" : "🐗";
      }
      if (s.kind === "gather" && s.gatherItem) {
        const gi = s.gatherItem;
        icon = gi === "fish" ? "🐟" : gi === "volcanic_stone" || gi === "iron_ore" || gi === "iron_sand" ? "🪨"
          : gi === "wood" || gi === "driftwood" ? "🪵" : gi === "caviar" || gi === "pearl" ? "🫧"
          : gi === "shellfish" || gi === "crab" ? "🦀" : gi === "honey" ? "🍯"
          : gi === "holy_water" ? "💧" : gi.startsWith("herb") ? "🌿"
          : gi === "nuts" || gi === "mushroom" ? "🍄" : "🌿";
      }
      ctx.fillText(icon, sx, sy);
      if (s.kind === "exit") {
        ctx.font = `${Math.round(11 * sc)}px sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.fillText(DB.maps[s.exitTo!]?.name ?? "", sx, sy + 14 * sc);
      }
    }

    // プレイヤー（保持者）
    const [px, py, psc] = proj(this.px, this.py);
    ctx.font = `${Math.round(30 * psc)}px serif`;
    ctx.textAlign = "center";
    ctx.fillText("🧍", px, py);
    ctx.font = `${Math.round(12 * psc)}px sans-serif`;
    ctx.fillStyle = "#e8b84a";
    ctx.fillText("🌱", px + 14 * psc, py - 20 * psc);
  }
}
