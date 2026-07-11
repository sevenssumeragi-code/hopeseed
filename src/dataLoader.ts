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
import talkRennyGeru from "../data/scenarios/talks/pair_renny_geru.json";
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
  npcLines: npcLines as any,
};

function collectScenarios(): ScenarioEvent[] {
  const out: ScenarioEvent[] = [];
  const routeFiles = [routeRenny, routeHyu, routeJinpachi, routeMuni, routeGeru, routeNeo];
  for (const rf of routeFiles) out.push(...((rf as any).events as ScenarioEvent[]));
  out.push(talkRennyGeru as unknown as ScenarioEvent);
  out.push(...((hidden as any).events as ScenarioEvent[]));
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

  // キャラの技IDが skills に存在するか
  for (const [cid, c] of Object.entries(DB.characters)) {
    for (const sid of c.skills) {
      if (!DB.skills[sid]) errors.push(`character '${cid}' references missing skill '${sid}'`);
    }
    if (c.base.hp <= 0) errors.push(`character '${cid}' has non-positive base hp`);
  }
  // 技の owner が存在するか
  for (const [sid, s] of Object.entries(DB.skills)) {
    if (!charIds.includes(s.owner)) errors.push(`skill '${sid}' owner '${s.owner}' not a character`);
    if (s.learn_lv < 1 || s.learn_lv > DB.config.MAX_LEVEL) {
      errors.push(`skill '${sid}' learn_lv out of range`);
    }
  }
  // 敵のドロップ品が items に存在するか
  for (const [eid, e] of Object.entries({ ...DB.enemies, ...DB.bosses })) {
    for (const d of (e as EnemyDef).drops ?? []) {
      if (!DB.items[d.item]) errors.push(`enemy '${eid}' drops missing item '${d.item}'`);
    }
  }
  // マップの接続先が存在するか
  for (const [mid, m] of Object.entries(DB.maps)) {
    for (const conn of m.connections) {
      if (!DB.maps[conn]) errors.push(`map '${mid}' connects to missing map '${conn}'`);
    }
    for (const eid of [...m.enemies, ...(m.night_enemies ?? [])]) {
      if (!DB.enemies[eid]) errors.push(`map '${mid}' spawns missing enemy '${eid}'`);
    }
    if (m.boss && !DB.bosses[m.boss]) errors.push(`map '${mid}' boss '${m.boss}' missing`);
  }
  // レシピ結果が items に存在するか
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
