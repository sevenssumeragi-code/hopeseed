// 受け入れテスト（GDD第16巻20-8）。tsx tests/run.ts で実行。

import { DB, validateData } from "../src/dataLoader.js";
import { GameManager } from "../src/core/gameManager.js";
import { protectRate } from "../src/core/battle/damageCalc.js";
import { statAtLevel, enhanceStage } from "../src/core/stats.js";
import { checksum } from "../src/core/saveManager.js";
import { pairKey } from "../src/core/trustManager.js";

let passed = 0, failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg} (expected=${expected}, actual=${actual})`);
}

console.log("[M1] データ基盤");

test("JSONスキーマ検証が通る", () => {
  const r = validateData();
  assert(r.ok, r.errors.join("; "));
});

test("レニィ正本数値の一致（第16巻20-3-1）", () => {
  const r = DB.characters["renny"];
  assertEq(r.base.hp, 42, "base.hp");
  assertEq(r.base.sp, 12, "base.sp");
  assertEq(r.growth.hp, 5.0, "growth.hp");
  assertEq(r.craft.cook, 55, "craft.cook");
  assertEq((r.ability_battle as any).proc, 0.5, "awakened_lion proc");
  assertEq((r.ability_holder as any).tribute_interval_water, 28, "water_grace 28日");
});

test("激流斬・英雄の号令の正本数値（第16巻20-3-2）", () => {
  const s = DB.skills["renny_08"];
  assertEq(s.name, "激流斬", "name");
  assertEq(s.accuracy, 90, "accuracy");
  assertEq(s.power, 2.5, "power");
  assertEq(s.sp_cost, 13, "sp_cost");
  assertEq(s.effects[0].type, "bleed", "effect");
  assertEq(s.effects[0].chance, 0.20, "chance");
  const g = DB.skills["geru_15"];
  assertEq(g.learn_lv, 60, "learn_lv");
  assertEq(g.sp_cost, 18, "sp_cost");
});

test("サメ正本数値の一致（第16巻20-3-3）", () => {
  const e = DB.enemies["shark"];
  assertEq(e.base.hp, 85, "hp");
  assertEq(e.exp_base, 22, "exp");
  assertEq(e.skills[1].condition, "high_tide", "引き込みは満潮限定");
  assertEq(e.skills[1].effects[0].type, "instant_death", "即死");
});

test("Lv算出 base+growth*(Lv-1)", () => {
  const r = DB.characters["renny"];
  assertEq(statAtLevel(r, "hp", 1), 42, "Lv1 hp");
  assertEq(statAtLevel(r, "hp", 99), 42 + 5 * 98, "Lv99 hp=532");
});

test("enhance_stage = floor(max(0,Lv-60)/5)", () => {
  assertEq(enhanceStage(60), 0, "Lv60");
  assertEq(enhanceStage(64), 0, "Lv64");
  assertEq(enhanceStage(65), 1, "Lv65");
  assertEq(enhanceStage(99), 7, "Lv99");
});

console.log("[M2] コアループ");

test("[供物] 14日超過でGO4（炎・自動スキップ）", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  for (let i = 0; i < 20 && gm.phase !== "gameover"; i++) {
    gm.gs.hunger = 100; // 飢餓死を除外して供物のみ検証
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.phase, "gameover", "GO発生");
  assert(gm.gs.gameOver === "tribute_fire_expired" || gm.gs.gameOver === "tribute_water_expired",
    `供物GO: ${gm.gs.gameOver}`);
  // 14日期限: Day1供物→Day16朝(経過15日目)にremaining<0
  assert(gm.gs.day <= 16, `期限内に発火 day=${gm.gs.day}`);
});

test("[供物] 加護キャラ保持時は28日（ジンパチ=炎）", () => {
  const gm = new GameManager();
  gm.newGame("jinpachi", 42);
  assertEq(gm.tribute.intervalDays("fire"), 28, "炎28日");
  assertEq(gm.tribute.intervalDays("water"), 14, "水は14日のまま");
});

test("[供物] レニィ保持者は水28日", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  assertEq(gm.tribute.intervalDays("water"), 28, "水28日");
  assertEq(gm.tribute.intervalDays("fire"), 14, "炎は14日のまま");
});

test("[供物] 正しい品目で期限リセット", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  gm.gs.day = 10;
  const r1 = gm.tribute.offer("fire", "raw_meat");
  assert(r1.ok, "肉→炎OK");
  assertEq(gm.gs.tribute.fireLastDay, 10, "期限リセット");
  const r2 = gm.tribute.offer("fire", "fish");
  assert(!r2.ok, "魚→炎NG");
  const r3 = gm.tribute.offer("water", "fish");
  assert(r3.ok, "魚→水OK");
});

test("[空腹] 絶食でゲージ減衰→7日でGO", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  for (let i = 0; i < 15 && gm.phase !== "gameover"; i++) {
    // 供物は継続、食事はしない
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.endDay();
  }
  assertEq(gm.phase, "gameover", "飢餓GO");
});

test("[セーブ] チェックサム付きセーブ→ロード一致・破損検出", () => {
  const gm = new GameManager();
  gm.newGame("muni", 42);
  gm.gs.day = 33;
  gm.save.saveManual(1, gm.gs);
  const loaded = gm.save.loadSlot("manual_1");
  assert(loaded !== null, "ロード成功");
  assertEq(loaded!.day, 33, "day一致");
  assertEq(loaded!.holder, "muni", "holder一致");
  assert(checksum("abc") !== checksum("abd"), "チェックサム感度");
});

console.log("[M3] 戦闘");

test("[戦闘] 保持者のコマンドに攻撃/技/魔術が出ない", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["wild_boar"], ["renny", "geru"]);
  const cmds = b.availableCommands("renny");
  assert(!cmds.includes("attack"), "攻撃なし");
  assert(!cmds.includes("skill"), "技なし");
  assert(cmds.includes("guard") && cmds.includes("protect")
    && cmds.includes("item") && cmds.includes("flee"), "防御/庇う/アイテム/逃げるは可");
  const geruCmds = b.availableCommands("geru");
  assert(geruCmds.includes("attack") && geruCmds.includes("skill"), "非保持者は攻撃/技可");
});

test("[戦闘] 保持者単独時は防御/逃げるのみ", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["wild_boar"], ["renny"]);
  const cmds = b.availableCommands("renny");
  assertEq(cmds.length, 2, "2コマンドのみ");
  assert(cmds.includes("guard") && cmds.includes("flee"), "防御/逃げる");
});

test("[戦闘] 保持者の攻撃コマンドは拒否される", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["wild_boar"], ["renny", "geru"]);
  let threw = false;
  try {
    b.executeTurn([{ kind: "attack", actorId: "renny", targetEnemyIndex: 0 }]);
  } catch { threw = true; }
  assert(threw, "掟違反は例外");
});

test("[戦闘] HP0→戦闘不能→終了時死亡確定、保持者は即GO", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["wild_boar"], ["renny", "geru"]);
  // 保持者を強制戦闘不能に
  b.allies[0].state.hp = 0;
  b.allies[0].state.downed = true;
  b.allies[1].state.hp = 0;
  b.allies[1].state.downed = true;
  b.finish();
  const result = gm.settleBattle();
  assertEq(result.outcome, "gameover", "GO");
  assertEq(gm.gs.gameOver, "holder_death", "保持者死亡GO");
});

test("[戦闘] 庇う成功率 = 50+技量0.3+信頼0.3+補正、上限95", () => {
  assertEq(protectRate(50, 50), 50 + 15 + 15, "基本式");
  assertEq(protectRate(999, 999), 95, "上限95");
  assertEq(protectRate(0, 0, 10), 60, "補正加算");
});

test("[戦闘] 誘拐は戦闘不能者のみ対象・海賊戦・保持者誘拐で即GO", () => {
  // 誘拐率100%にして確定発生させる
  const orig = DB.config.kidnap.rate;
  (DB.config.kidnap as any).rate = 1.0;
  try {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.gs.location = "beach";
    const b = gm.startBattle(["pirate_thug"], ["renny", "geru"]);
    b.allies[0].state.hp = 0;
    b.allies[0].state.downed = true; // 保持者戦闘不能
    b.allies[1].state.hp = 0;
    b.allies[1].state.downed = true;
    b.finish();
    const result = gm.settleBattle();
    assert(result.kidnapped.includes("renny"), "戦闘不能者が誘拐対象");
    assertEq(gm.gs.gameOver, "holder_kidnap", "保持者誘拐GO");
  } finally {
    (DB.config.kidnap as any).rate = orig;
  }
});

test("[戦闘] 満潮浅瀬は8ターンで強制終了→溺水（レニィ保持者は救済）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "shallows";
  gm.gs.tide = "high";
  // 高HPのボス級を通常戦扱いで倒しきれない状況を作る
  const b = gm.startBattle(["shark"], ["renny", "jinpachi"]);
  b.enemies[0].hp = 999999;
  b.enemies[0].maxHp = 999999;
  let outcome = "ongoing";
  for (let i = 0; i < 12 && outcome === "ongoing"; i++) {
    outcome = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "guard", actorId: "jinpachi" },
    ]);
    // 引き込み即死や通常攻撃で全滅しないようHPを補充（潮汐ルールの検証に限定）
    for (const a of b.allies) { a.state.hp = a.state.maxHp; a.state.downed = false; }
  }
  assertEq(outcome, "drowned", "8ターンで溺水");
  assert(b.turn <= 8, `8ターン以内 turn=${b.turn}`);
  const result = gm.settleBattle();
  assertEq(result.outcome, "drowned", "結果=溺水");
  assertEq(result.deaths.length, 0, "レニィ保持者→全員溺死しない");
  assertEq(gm.gs.gameOver, null, "GOしない");
});

test("[戦闘] ヌシ戦は満潮強制終了を免除", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "shallows";
  gm.gs.tide = "high";
  const b = gm.startBattle(["deep_sea_nushi"], ["renny", "jinpachi"], true, "deep_sea_nushi");
  let outcome = "ongoing";
  for (let i = 0; i < 10 && outcome === "ongoing"; i++) {
    outcome = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "guard", actorId: "jinpachi" },
    ]);
    for (const a of b.allies) { a.state.hp = a.state.maxHp; a.state.downed = false; }
  }
  assert(outcome !== "drowned", "ヌシ戦は溺水強制終了なし");
});

test("[戦闘] 勝利で経験値・SP回復・信頼度上昇", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const before = gm.trust.pair("renny", "geru");
  const b = gm.startBattle(["swarm_mosquito"], ["renny", "geru"]);
  let outcome = "ongoing";
  for (let i = 0; i < 30 && outcome === "ongoing"; i++) {
    outcome = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "attack", actorId: "geru", targetEnemyIndex: 0 },
    ]);
  }
  assertEq(outcome, "victory", "勝利");
  const result = gm.settleBattle();
  assert(result.expGained > 0, "経験値獲得");
  assert(gm.trust.pair("renny", "geru") > before, "共闘で信頼度上昇");
  assertEq(gm.gs.stats.battlesWon, 1, "勝利カウント");
});

console.log("[M3] 状態異常");

test("[状態] 毒7日タイマー死亡", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("geru", "poison", "test");
  assertEq(gm.gs.party["geru"].status.poison, 7, "毒7日");
  for (let i = 0; i < 7; i++) {
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.gs.hunger = 100;
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.gs.party["geru"].exclusion, "dead", "7日後に死亡");
  assertEq(gm.phase !== "gameover", true, "非保持者はGOしない");
});

test("[状態] 大出血3日タイマー死亡・保持者なら即GO", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("renny", "bleed", "test");
  assertEq(gm.gs.party["renny"].status.bleed, 3, "出血3日");
  for (let i = 0; i < 4 && gm.phase !== "gameover"; i++) {
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.gs.hunger = 100;
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.gs.gameOver, "holder_death", "保持者死亡GO");
});

test("[状態] 昏睡3~5日で自然回復（薬なし・矛盾#7）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("muni", "coma", "nightmare");
  assertEq(gm.gs.party["muni"].exclusion, "coma", "昏睡除外");
  const days = gm.gs.party["muni"].comaDaysLeft;
  assert(days >= 3 && days <= 5, `3~5日 (${days})`);
  for (let i = 0; i < days; i++) {
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.gs.hunger = 100;
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.gs.party["muni"].exclusion, "none", "自然回復");
});

test("[状態] 裏切り3日で離脱・保持者取り憑きは即GO", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.possess("geru");
  assertEq(gm.gs.party["geru"].exclusion, "betrayal", "裏切り状態");
  for (let i = 0; i < 3; i++) {
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.gs.hunger = 100;
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.gs.party["geru"].exclusion, "dead", "3日後離脱(除外)");

  const gm2 = new GameManager();
  gm2.newGame("renny", 42);
  gm2.possess("renny");
  assertEq(gm2.gs.gameOver, "holder_possess", "保持者取り憑きGO");
});

console.log("[M2] 蘇生");

test("[蘇生] 7日に1人、Lv・技・持ち物・信頼度が引き継がれる", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 10;
  gm.gs.party["geru"].level = 15;
  gm.gs.party["geru"].exclusion = "dead";
  gm.gs.party["muni"].exclusion = "dead";
  const trustBefore = gm.trust.pair("geru", "renny");

  assert(gm.party.revive("geru"), "1人目蘇生OK");
  assertEq(gm.gs.party["geru"].exclusion, "none", "復帰");
  assertEq(gm.gs.party["geru"].level, 15, "Lv引き継ぎ");
  assertEq(gm.trust.pair("geru", "renny"), trustBefore, "信頼度引き継ぎ");

  assert(!gm.party.revive("muni"), "同週2人目は不可");
  gm.gs.day = 17;
  assert(gm.party.revive("muni"), "7日後は可");
});

console.log("[M6] 信頼度");

test("[信頼] ムニ保持者は全上昇×1.5切り上げ", () => {
  const gm = new GameManager();
  gm.newGame("muni", 42);
  const key = pairKey("renny", "geru");
  const before = gm.gs.trust[key];
  gm.trust.add("renny", "geru", 3, "test");
  assertEq(gm.gs.trust[key], before + Math.ceil(3 * 1.5), "3→5 (×1.5切り上げ)");
});

test("[信頼] 非ムニ保持者は等倍", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  const key = pairKey("muni", "geru");
  const before = gm.gs.trust[key];
  gm.trust.add("muni", "geru", 3, "test");
  assertEq(gm.gs.trust[key], before + 3, "等倍");
});

test("[信頼] 庇うカウンタ→特別シナリオ判定（3回で発火）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  assertEq(gm.trust.onProtectSuccess("geru", "renny"), null, "1回目");
  assertEq(gm.trust.onProtectSuccess("geru", "renny"), null, "2回目");
  const special = gm.trust.onProtectSuccess("geru", "renny");
  assert(special !== null && special.includes("protect_special"), "3回目で特別シナリオ");
});

console.log("[M7] エンディング");

test("[ED] 除外0＋avg80＋核心7/7＋隠し旗 → 真ED", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 365;
  // 条件を満たす
  for (const key of Object.keys(gm.gs.trust)) gm.gs.trust[key] = 90;
  for (let i = 1; i <= 7; i++) gm.gs.flags[`core_ev${i}`] = true;
  gm.joinGoddess();
  const ed = gm.endingJudge.judge();
  assertEq(ed.id, "TRUE", "真ED");
});

test("[ED] 条件不足→下位ED", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 365;
  gm.gs.party["geru"].exclusion = "dead";
  gm.gs.party["muni"].exclusion = "dead"; // 除外2
  for (const key of Object.keys(gm.gs.trust)) gm.gs.trust[key] = 30;
  const ed = gm.endingJudge.judge();
  assertEq(ed.id, "NORMAL", "ノーマルED");
});

test("[GO] 保持者の死亡/誘拐/取り憑きで各GO理由", () => {
  const reasons = ["holder_death", "holder_kidnap", "holder_possess"] as const;
  for (const r of reasons) {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.triggerGameOver(r);
    assertEq(gm.phase, "gameover", `${r} phase`);
    assertEq(gm.gs.gameOver, r, `${r} reason`);
  }
});

console.log("[M5] クラフト");

test("[クラフト] 調理・工作・薬草開発", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.inventory["raw_meat"] = 2;
  const r = gm.craft.craft("cook", "grilled_meat", "renny");
  assert(r.ok, "調理成功");
  assertEq(gm.gs.inventory["grilled_meat"], 1, "焼き肉+1");
  assertEq(gm.gs.inventory["raw_meat"], 1, "生肉-1");
  assertEq(gm.gs.stats.cooked, 1, "調理カウント");

  gm.gs.inventory["herb_leaf"] = 5;
  const r2 = gm.craft.craft("pharmacy", "antidote", "neo");
  assert(r2.ok, "薬草開発成功(ネオpharmacy60)");
});

test("[クラフト] 技能不足で失敗", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.inventory["herb_leaf"] = 10;
  gm.gs.inventory["toxic_pollen"] = 5;
  // cure_all は skill_req 60。renny の pharmacy は 40 → 失敗
  const r = gm.craft.craft("pharmacy", "cure_all", "renny");
  assert(!r.ok, "レニィには不可");
  // neo の pharmacy は 60 → 成功
  const r2 = gm.craft.craft("pharmacy", "cure_all", "neo");
  assert(r2.ok, "ネオなら可");
});

console.log("[M2] 365日通し（自動スキップ）");

test("供物・食事を続ければ365日到達→EndingJudge", () => {
  const gm = new GameManager();
  gm.newGame("geru", 7);
  let guard = 0;
  while (gm.phase !== "ending" && gm.phase !== "gameover" && guard++ < 400) {
    // 毎日供物・満腹を維持（コアループのみ検証）
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.gs.hunger = 100;
    gm.gs.starvingDays = 0;
    gm.endDay();
  }
  assertEq(gm.phase, "ending", `365日到達 (day=${gm.gs.day}, phase=${gm.phase})`);
  assertEq(gm.gs.day, 365, "day=365");
  assert(gm.lastEndingId !== null, "ED判定済み");
  assert(gm.gs.achievements.includes("survivor_365"), "1年生存実績");
});

console.log("");
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("失敗:", failures.join("\n"));
  process.exit(1);
}
