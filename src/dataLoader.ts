// data/ のマスターデータを読み込み・スキーマ検証する（GDD第16巻20-2/20-3、data_loader.gd相当）。
// 数値のハードコード禁止・全マネージャはこのデータ駆動（20-5原則）。

import config from "../data/config.json";
import characters from "../data/characters.json";
import skills from "../data/skills.json";
import enemies from "../data/enemies.json";
import bosses from "../data/bosses.json";
import items from "../data/items.json";
import recipes from "../data/recipes.json";
import maps from "../data/maps.json";
import weather from "../data/weather.json";
import trust from "../data/trust.json";
import endings from "../data/endings.json";
import achievements from "../data/achievements.json";

import routeRenny from "../data/scenarios/routes/route_renny.json";
import routeHyu from "../data/scenarios/routes/route_hyu.json";
import routeJinpachi from "../data/scenarios/routes/route_jinpachi.json";
import routeMuni from "../data/scenarios/routes/route_muni.json";
import routeGeru from "../data/scenarios/routes/route_geru.json";
import routeNeo from "../data/scenarios/routes/route_neo.json";
import talks from "../data/scenarios/talks.json";
import personal from "../data/scenarios/personal.json";
import hidden from "../data/scenarios/hidden.json";
import npcLines from "../data/scenarios/npc_lines.json";

import type {
  CharacterDef, Skill, EnemyDef, ItemDef, MapDef, ScenarioEvent,
} from "./types.js";

// 型を緩く受けてから狭める（JSONの _source フィールド等を許容）
const stripMeta = <T>(obj: Record<string, unknown>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    out[k] = v as T;
  }
  return out;
};

export const DB = {
  config: config as Record<string, any>,
  characters: stripMeta<CharacterDef>(characters as any),
  skills: stripMeta<Skill>(skills as any),
  enemies: stripMeta<EnemyDef>(enemies as any),
  bosses: stripMeta<EnemyDef>(bosses as any),
  items: stripMeta<ItemDef>(items as any),
  recipes: recipes as unknown as Record<string, any[]>,
  maps: stripMeta<MapDef>(maps as any),
  weather: weather as any,
  trust: trust as any,
  endings: endings as any,
  achievements: (achievements as any).list as any[],
  scenarios: collectScenarios(),
  talks: talks as any,                       // 第11巻14-1/14-2/14-3（掛け合い・庇う特別）
  personal: personal as any,                 // 第11巻14-5（個人・第2巻待ちプレースホルダ）
  hidden: (hidden as any).events as any[],   // 第11巻14-4（隠し12本・TalkManagerが評価）
  npcLines: npcLines as any,
};

function collectScenarios(): ScenarioEvent[] {
  const out: ScenarioEvent[] = [];
  const routeFiles = [routeRenny, routeHyu, routeJinpachi, routeMuni, routeGeru, routeNeo];
  for (const rf of routeFiles) out.push(...((rf as any).events as ScenarioEvent[]));
  return out;
}

// enemy/boss を統合参照
export function getEnemyDef(id: string): EnemyDef {
  return DB.enemies[id] ?? DB.bosses[id];
}

export interface ValidationResult { ok: boolean; errors: string[]; }

// M1受け入れ基準: JSONの参照整合・数値健全性を検証する
export function validateData(): ValidationResult {
  const errors: string[] = [];
  const charIds = Object.keys(DB.characters);

  for (const [cid, c] of Object.entries(DB.characters)) {
    if (c.base.hp <= 0) errors.push(`character '${cid}' has non-positive base hp`);
    // 全キャラに技が存在するか（技はowner参照で紐付け）
    const skills = Object.values(DB.skills).filter((s) => s.owner === cid);
    if (skills.length === 0) errors.push(`character '${cid}' has no skills`);
  }
  for (const [sid, s] of Object.entries(DB.skills)) {
    if (!charIds.includes(s.owner)) errors.push(`skill '${sid}' owner '${s.owner}' not a character`);
    if (s.learn_lv < 1 || s.learn_lv > DB.config.MAX_LEVEL) {
      errors.push(`skill '${sid}' learn_lv out of range`);
    }
  }
  // 敵のドロップ品・stat_ref参照
  for (const [eid, e] of Object.entries({ ...DB.enemies, ...DB.bosses })) {
    const def = e as EnemyDef;
    for (const d of def.drops ?? []) {
      if (d.item !== "herb_random" && !DB.items[d.item]) {
        errors.push(`enemy '${eid}' drops missing item '${d.item}'`);
      }
    }
    if (def.boss) {
      if (!def.hp_fixed) errors.push(`boss '${eid}' missing hp_fixed`);
      if (def.stat_ref && !DB.enemies[def.stat_ref]) {
        errors.push(`boss '${eid}' stat_ref '${def.stat_ref}' missing`);
      }
    } else if (!def.base) {
      errors.push(`enemy '${eid}' missing base stats`);
    }
  }
  for (const [mid, m] of Object.entries(DB.maps)) {
    for (const conn of m.connections) {
      if (!DB.maps[conn]) errors.push(`map '${mid}' connects to missing map '${conn}'`);
    }
    for (const eid of [...m.enemies, ...(m.night_enemies ?? [])]) {
      if (!DB.enemies[eid]) errors.push(`map '${mid}' spawns missing enemy '${eid}'`);
    }
    if (m.boss && !DB.bosses[m.boss]) errors.push(`map '${mid}' boss '${m.boss}' missing`);
    for (const g of m.gather) {
      if (!DB.items[g.item]) errors.push(`map '${mid}' gathers missing item '${g.item}'`);
    }
  }
  for (const [type, list] of Object.entries(DB.recipes)) {
    if (type.startsWith("_")) continue;
    for (const r of list) {
      if (!DB.items[r.result]) errors.push(`recipe '${r.id}' result '${r.result}' missing`);
      for (const inp of r.inputs) {
        if (!DB.items[inp.item]) errors.push(`recipe '${r.id}' input '${inp.item}' missing`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
