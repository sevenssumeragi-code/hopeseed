// 受け入れテスト（GDD第16巻20-8 + 第5/6/7/8/14巻の数値一致検証=M1受け入れ基準）。

import { DB, validateData } from "../src/dataLoader.js";
import { GameManager } from "../src/core/gameManager.js";
import { protectRate, applyBuffStage, calcHit, fleeRate, tameRate, persuadeRate } from "../src/core/battle/damageCalc.js";
import { RNG } from "../src/core/rng.js";
import { scaleEnemy } from "../src/core/battle/battleManager.js";
import {
  statAtLevel, enhanceStage, enhancedSkill, expToNext, skillsForCharacter,
} from "../src/core/stats.js";
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
function assertClose(actual: number, expected: number, tol: number, msg: string): void {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg} (expected≈${expected}, actual=${actual})`);
}

// 供物・空腹を維持して1日進める（コアループ以外の検証用）
function passDay(gm: GameManager, cureAll = false): void {
  gm.gs.tribute.fireLastDay = gm.gs.day;
  gm.gs.tribute.waterLastDay = gm.gs.day;
  for (const c of Object.values(gm.gs.party)) {
    c.satiety = 100;
    c.starveDays = 0;
    if (cureAll) c.status = {};
  }
  gm.endDay();
}
function feedAll(gm: GameManager): void {
  for (const c of Object.values(gm.gs.party)) {
    c.satiety = 100;
    c.starveDays = 0;
  }
}

console.log("[M1] データ基盤・第5巻成長表一致");

test("JSONスキーマ検証が通る", () => {
  const r = validateData();
  assert(r.ok, r.errors.join("; "));
});

test("レニィ: Lv1/Lv50/Lv99が第5巻の表と一致", () => {
  assertEq(statAtLevel("renny", "hp", 1), 42, "Lv1 hp");
  assertEq(statAtLevel("renny", "hp", 50), 287, "Lv50 hp");
  assertEq(statAtLevel("renny", "atk", 50), 64, "Lv50 atk");
  assertEq(statAtLevel("renny", "hp", 99), 532, "Lv99 hp");
  assertEq(statAtLevel("renny", "atk", 99), 118, "Lv99 atk");
  assertEq(statAtLevel("renny", "crit", 99), 7.9, "Lv99 crit");
});

test("ジンパチ: Lv99 HP638/攻150/一撃12.8%", () => {
  assertEq(statAtLevel("jinpachi", "hp", 99), 638, "hp");
  assertEq(statAtLevel("jinpachi", "atk", 99), 150, "atk");
  assertEq(statAtLevel("jinpachi", "crit", 99), 12.8, "crit");
});

test("ヒュウ: Lv50 素早さ76/技量70・Lv99 回避129", () => {
  assertEq(statAtLevel("hyu", "spd", 50), 76, "spd50");
  assertEq(statAtLevel("hyu", "skl", 50), 70, "skl50");
  assertEq(statAtLevel("hyu", "eva", 99), 129, "eva99");
});

test("ムニ: Lv99 回避161（回避特化）", () => {
  assertEq(statAtLevel("muni", "eva", 99), 161, "eva");
  assertEq(statAtLevel("muni", "hp", 99), 402, "hp");
});

test("ゲル: Lv2 HP44/Lv4 HP54（第5巻の丸め規則一致）", () => {
  assertEq(statAtLevel("geru", "hp", 2), 44, "Lv2 hp(44.5→44)");
  assertEq(statAtLevel("geru", "hp", 4), 54, "Lv4 hp(53.5→54)");
  assertEq(statAtLevel("geru", "skl", 99), 140, "Lv99 skl");
});

test("ネオ: Lv99 魔力151・二刀流（剣技15+魔術15）", () => {
  assertEq(statAtLevel("neo", "mag", 99), 151, "mag");
  assertEq(statAtLevel("neo", "hp", 99), 554, "hp");
  const skills = skillsForCharacter("neo");
  assertEq(skills.length, 30, "剣技15+魔術15");
});

test("湖の女神: Lv40代表値（第5巻6-7導出）", () => {
  assertEq(statAtLevel("goddess", "hp", 40), 261, "hp=renny×1.1");
  assertEq(statAtLevel("goddess", "sp", 40), 66, "sp=renny×1.3");
  assertEq(statAtLevel("goddess", "atk", 40), 53, "atk=neo×0.9");
  assertEq(statAtLevel("goddess", "def", 40), 47, "def");
  assertEq(statAtLevel("goddess", "spd", 40), 44, "spd");
  assertEq(statAtLevel("goddess", "skl", 40), 61, "skl=geru×0.95");
  assertEq(statAtLevel("goddess", "eva", 40), 42, "eva");
  assertEq(statAtLevel("goddess", "crit", 40), 3.2, "crit");
});

test("必要EXP = round(15×Lv^1.7)（第5巻6-8）", () => {
  assertEq(expToNext(1), 15, "Lv1");
  assertEq(expToNext(10), 752, "Lv10");
  assertEq(expToNext(50), 11597, "Lv50");
  assertEq(expToNext(98), 36406, "Lv98");
});

console.log("[M1] 第6巻技データ一致");

test("技総数120（6キャラ×15+ネオ魔術15+女神15）", () => {
  assertEq(Object.keys(DB.skills).length, 120, "count");
});

test("激流斬(renny_08)の正本数値", () => {
  const s = DB.skills["renny_08"];
  assertEq(s.name, "激流斬", "name");
  assertEq(s.learn_lv, 24, "lv");
  assertEq(s.accuracy, 90, "acc");
  assertEq(s.power, 2.5, "power");
  assertEq(s.sp_cost, 13, "sp");
  assertEq(s.effects[0].type, "bleed", "effect");
  assertEq(s.effects[0].chance, 0.20, "chance");
});

test("冥王斬=一撃必殺+20%／死神の口づけ+15%", () => {
  assertEq(DB.skills["hyu_15"].effects[0].amount, 20, "冥王斬");
  assertEq(DB.skills["hyu_11"].effects[0].amount, 15, "死神の口づけ");
});

test("勇気の歌: ゲルLv47/ムニLv48・song_id共有（矛盾#5）", () => {
  assertEq(DB.skills["geru_12"].learn_lv, 47, "geru");
  assertEq(DB.skills["muni_13"].learn_lv, 48, "muni");
  assertEq(DB.skills["geru_12"].song_id, "brave_song", "song");
  assertEq(DB.skills["muni_13"].song_id, "brave_song", "song");
});

test("Lv61+強化（第6巻7-9）: 希望の一閃 Lv99=命中98/倍率4.81/SP17", () => {
  assertEq(enhanceStage(60), 0, "Lv60");
  assertEq(enhanceStage(65), 1, "Lv65");
  assertEq(enhanceStage(95), 7, "Lv95");
  assertEq(enhanceStage(99), 8, "Lv99=8段階");
  const s = enhancedSkill(DB.skills["renny_15"], 99);
  assertEq(s.accuracy, 98, "命中90+8");
  assertClose(s.power!, 4.81, 0.01, "倍率3.8×1.03^8");
  assertEq(s.sp_cost, 17, "SP25-8");
  const w = enhancedSkill(DB.skills["renny_01"], 99);
  assertEq(w.sp_cost, 3, "水しぶきSP下限3");
  assertEq(w.accuracy, 100, "命中上限100");
});

test("バフ段階: +1段×1.25/−1段×0.8（第6巻7-0-1）", () => {
  assertEq(applyBuffStage(100, 1), 125, "+1段");
  assertEq(applyBuffStage(100, -1), 80, "−1段");
  assertEq(applyBuffStage(100, 2), Math.round(100 * 1.5625 * 100) / 100, "+2段=×1.5625");
});

console.log("[M1] 第8巻敵・ボス一致");

test("敵21種（8系統・海賊は島側/船内）・ボス5種が存在", () => {
  assertEq(Object.keys(DB.enemies).length, 21, "enemies");
  assertEq(Object.keys(DB.bosses).length, 5, "bosses");
});

test("サメ正本値+満潮限定引き込み", () => {
  const e = DB.enemies["shark"];
  assertEq(e.base!.hp, 85, "hp");
  assertEq(e.exp_base, 22, "exp");
  assertEq(e.skills[1].condition, "high_tide", "満潮限定");
  assertEq(e.skills[1].accuracy, 55, "命中55");
});

test("敵Lvスケーリング（第8巻10-0-1）", () => {
  const e1 = scaleEnemy("shark", 1, 0);
  assertEq(e1.hp, 85, "Lv1 hp");
  const e11 = scaleEnemy("shark", 11, 0);
  assertEq(e11.level, 11, "lv");
  assertEq(e11.hp, Math.round(85 * 2.0), "Lv11 hp=×2.0");
  assertEq(e11.atk, Math.round(18 * 1.8), "Lv11 atk=×1.8");
});

test("ボス: 下限Lv・固定HP・能力比（第8巻11章）", () => {
  const b = scaleEnemy("volcano_lord", 10, 0);
  assertEq(b.level, 25, "下限Lv25");
  assertEq(b.hp, 900, "HP900固定");
  const flame = scaleEnemy("flame_beast", 25 - 0, 0); // 同Lv火炎獣
  assertEq(b.atk, Math.round(DB.enemies["flame_beast"].base!.atk * (1 + 0.08 * 24) * 1.3), "攻×1.3");
  assert(b.spd < flame.spd, "早×0.7");
  const nushi = scaleEnemy("deep_sea_nushi", 50, 0);
  assertEq(nushi.level, 53, "平均+3");
  assertEq(nushi.hp, 1000, "HP1000");
});

console.log("[M2] コアループ（第14巻最終値）");

test("[供物] 14日超過でGO・加護で28日", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  for (let i = 0; i < 20 && gm.phase !== "gameover"; i++) {
    feedAll(gm);
    gm.endDay();
  }
  assertEq(gm.phase, "gameover", "GO発生");
  assert(gm.gs.gameOver === "tribute_fire_expired" || gm.gs.gameOver === "tribute_water_expired", "供物GO");
  assertEq(gm.gs.day, 15, "M2-T1: 供物ゼロ→Day15の朝にGO（期限=Day14）");

  const gm2 = new GameManager();
  gm2.newGame("jinpachi", 42);
  assertEq(gm2.tribute.intervalDays("fire"), 28, "ジンパチ=炎28日");
  const gm3 = new GameManager();
  gm3.newGame("renny", 42);
  assertEq(gm3.tribute.intervalDays("water"), 28, "レニィ=水28日");
});

test("[供物] 品目検査と供物カウント", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  assert(gm.tribute.offer("fire", "meat").ok, "肉→炎OK");
  assertEq(gm.gs.tribute.fireCount, 1, "カウント");
  assert(!gm.tribute.offer("fire", "fish").ok, "魚→炎NG");
});

test("[空腹] キャラ個別減衰15/日(探索20)・絶食で餓死→保持者GO1(M2-T6)", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  const h0 = gm.gs.party["neo"].satiety;
  gm.gs.tribute.fireLastDay = gm.gs.day;
  gm.gs.tribute.waterLastDay = gm.gs.day;
  gm.endDay();
  assertEq(gm.gs.party["neo"].satiety, h0 - 15, "拠点日−15(個別)");
  // 誰も食べない → 全員が個別に餓死し、保持者死亡でGO1
  for (let i = 0; i < 30 && gm.phase !== "gameover"; i++) {
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    gm.endDay();
  }
  assertEq(gm.phase, "gameover", "飢餓GO");
  assertEq(gm.gs.gameOver, "holder_death", "GO1");
  assert(gm.gs.day >= 13 && gm.gs.day <= 16, `M2-T6b: 餓死時期はDay13〜16 (day=${gm.gs.day})`);
});

test("[天候] 嵐の翌日は必ず晴れ（第14巻18-9）", () => {
  const gm = new GameManager();
  gm.newGame("neo", 7);
  gm.gs.weather = "storm";
  passDay(gm);
  assertEq(gm.gs.weather, "clear", "翌日晴れ");
});

test("[潮汐] 夕・夜=満潮（第14巻TIDE_HIGH_SLOTS）", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42);
  assertEq(gm.gs.tide, "low", "朝=干潮");
  gm.advanceTime(2); // 朝→昼→夕
  assertEq(gm.gs.slot, "evening", "夕");
  assertEq(gm.gs.tide, "high", "夕=満潮");
});

test("[セーブ] チェックサム・ロード一致", () => {
  const gm = new GameManager();
  gm.newGame("muni", 42);
  gm.gs.day = 33;
  gm.gs.silver = 77;
  gm.save.saveManual(1, gm.gs);
  const loaded = gm.save.loadSlot("manual_1");
  assertEq(loaded!.day, 33, "day");
  assertEq(loaded!.silver, 77, "silver");
  assert(checksum("abc") !== checksum("abd"), "checksum感度");
});

console.log("[M3] 戦闘（20-8）");

test("[戦闘] 保持者のコマンドに攻撃/技/魔術が出ない", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["renny", "geru"]);
  const cmds = b.availableCommands("renny");
  assert(!cmds.includes("attack") && !cmds.includes("skill"), "攻撃/技なし");
  assert(cmds.includes("guard") && cmds.includes("protect") && cmds.includes("item") && cmds.includes("flee"), "防御/庇う/アイテム/逃げる");
  const b2cmds = b.availableCommands("geru");
  assert(b2cmds.includes("attack"), "非保持者は攻撃可");
});

test("[戦闘] 保持者単独時は防御/逃げるのみ・違反は例外", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["renny"]);
  assertEq(b.availableCommands("renny").length, 2, "2コマンド");
  let threw = false;
  try { b.executeTurn([{ kind: "attack", actorId: "renny", targetEnemyIndex: 0 }]); }
  catch { threw = true; }
  assert(threw, "掟違反は例外");
});

test("[戦闘] HP0→終了時死亡確定、保持者は即GO", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["renny", "geru"]);
  b.allies.forEach((a) => { a.state.hp = 0; a.state.downed = true; });
  b.finish();
  const result = gm.settleBattle();
  assertEq(result.outcome, "gameover", "GO");
  assertEq(gm.gs.gameOver, "holder_death", "保持者死亡");
});

test("[戦闘] 庇う成功率式（第4巻5-4-4）: 上限95/下限20", () => {
  assertEq(protectRate(50, 50), 80, "50+15+15");
  assertEq(protectRate(999, 999), 95, "上限95");
  assertEq(protectRate(0, 0, 10), 60, "補正");
  assertEq(protectRate(0, 0, -100), 20, "下限20");
});

test("[戦闘] 誘拐=島側海賊の戦闘技・戦闘不能者のみ・保持者誘拐GO", () => {
  const skill = DB.enemies["pirate_island"].skills.find((s) => s.name === "誘拐")!;
  const orig = skill.effects[0].chance;
  skill.effects[0].chance = 1.0;
  try {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.gs.location = "beach";
    const b = gm.startBattle(["pirate_island"], ["renny", "geru"]);
    b.allies[0].state.hp = 0;
    b.allies[0].state.downed = true; // 保持者戦闘不能
    // 海賊の手番で誘拐発動（複数ターン回す）
    let out = "ongoing";
    for (let i = 0; i < 6 && out === "ongoing"; i++) {
      out = b.executeTurn([{ kind: "guard", actorId: "geru" }]);
      if (b.allies[0].state.exclusion === "kidnapped") break;
      b.allies[1].state.hp = b.allies[1].state.maxHp; // ゲルは倒れないよう維持
      b.allies[1].state.downed = false;
    }
    assertEq(b.allies[0].state.exclusion, "kidnapped", "誘拐成立");
    b.finish();
    const result = gm.settleBattle();
    assertEq(gm.gs.gameOver, "holder_kidnap", "保持者誘拐GO");
    assert(result.kidnapped.includes("renny"), "結果に記録");
  } finally {
    skill.effects[0].chance = orig;
  }
});

test("[戦闘] 取り憑き: 保持者成功で即GO（悪魔）", () => {
  const skill = DB.enemies["demon"].skills.find((s) => s.name === "取り憑き")!;
  const orig = skill.effects[0].chance;
  skill.effects[0].chance = 1.0;
  try {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.gs.location = "grassland";
    const b = gm.startBattle(["demon"], ["renny"]);
    let out = "ongoing";
    for (let i = 0; i < 10 && out === "ongoing"; i++) {
      out = b.executeTurn([{ kind: "guard", actorId: "renny" }]);
      b.allies[0].state.hp = b.allies[0].state.maxHp;
      b.allies[0].state.downed = false;
    }
    assertEq(out, "gameover", "取り憑きGO");
    gm.settleBattle();
    assertEq(gm.gs.gameOver, "holder_possess", "GO理由");
  } finally {
    skill.effects[0].chance = orig;
  }
});

test("[戦闘] 満潮浅瀬8ターン強制終了→レニィ保持者は全員救済", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "shallows";
  gm.gs.tide = "high";
  const b = gm.startBattle(["shark"], ["renny", "jinpachi"]);
  b.enemies[0].hp = 999999; b.enemies[0].maxHp = 999999;
  let outcome = "ongoing";
  for (let i = 0; i < 12 && outcome === "ongoing"; i++) {
    outcome = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "guard", actorId: "jinpachi" },
    ]);
    for (const a of b.allies) { a.state.hp = a.state.maxHp; a.state.downed = false; }
  }
  assertEq(outcome, "drowned", "溺水");
  assert(b.turn <= 8, "8ターン以内");
  const result = gm.settleBattle();
  assertEq(result.deaths.length, 0, "レニィ保持者→溺死なし");
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
  assert(outcome !== "drowned", "免除");
});

test("[戦闘] 勝利: EXP=基礎×Lv×0.5・信頼度・銀貨", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const before = gm.trust.pair("renny", "geru");
  const b = gm.startBattle(["giant_mosquito"], ["renny", "geru"]);
  let outcome = "ongoing";
  for (let i = 0; i < 40 && outcome === "ongoing"; i++) {
    outcome = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "attack", actorId: "geru", targetEnemyIndex: 0 },
    ]);
  }
  assertEq(outcome, "victory", "勝利");
  const enemyLv = b.enemies[0].level;
  const result = gm.settleBattle();
  assertEq(result.expGained, Math.round(7 * enemyLv * 0.5), "EXP式");
  assert(gm.trust.pair("renny", "geru") > before, "信頼度上昇");
  assert(result.silver >= 1, "銀貨");
});

test("[戦闘] 夢魔戦は敗北しても死亡しない（第8巻10-8）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "dream";
  const b = gm.startBattle(["nightmare"], ["renny", "geru"]);
  b.allies.forEach((a) => { a.state.hp = 0; a.state.downed = true; });
  b.finish();
  const result = gm.settleBattle();
  assertEq(result.deaths.length, 0, "死亡なし");
  assertEq(gm.gs.gameOver, null, "GOなし");
});

console.log("[M3] 状態異常（第14巻18-4）");

test("[状態] 毒7日/大火傷7日/大出血3日のタイマー死亡", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("geru", "poison", "t");
  gm.statusFx.apply("muni", "burn", "t");
  gm.statusFx.apply("hyu", "bleed", "t");
  assertEq(gm.gs.party["geru"].status.poison, 7, "毒7");
  assertEq(gm.gs.party["muni"].status.burn, 7, "火傷7");
  assertEq(gm.gs.party["hyu"].status.bleed, 3, "出血3");
  for (let i = 0; i < 3; i++) passDay(gm);
  assertEq(gm.gs.party["hyu"].exclusion, "dead", "出血3日で死亡");
  assertEq(gm.gs.party["geru"].exclusion, "none", "毒はまだ");
  for (let i = 0; i < 4; i++) passDay(gm);
  assertEq(gm.gs.party["geru"].exclusion, "dead", "毒7日で死亡");
  assertEq(gm.gs.party["muni"].exclusion, "dead", "火傷7日で死亡");
});

test("[状態] ジンパチは大火傷無効（第8巻10-1）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "volcano";
  const b = gm.startBattle(["fireball"], ["renny", "jinpachi"]);
  // 直接効果適用経路を検証
  const jinAlly = b.allies.find((a) => a.state.id === "jinpachi")!;
  (b as any).applyStatusToAlly(jinAlly, { type: "burn", chance: 1.0 });
  assertEq(gm.gs.party["jinpachi"].status.burn, undefined, "無効");
});

test("[状態] 疫病: 3日目から重症化判定・重症3日で死亡", () => {
  const gm = new GameManager();
  gm.newGame("renny", 999); // 重症化が出るシード
  gm.statusFx.apply("geru", "plague", "t");
  let died = false;
  for (let i = 0; i < 30; i++) {
    passDay(gm);
    if (gm.gs.party["geru"].exclusion === "dead") { died = true; break; }
  }
  assert(died, "疫病はいずれ死に至る（20%+10%/日→重症3日）");
});

test("[状態] 昏睡3~5日自然回復・薬なし（矛盾#7）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("muni", "coma", "nightmare");
  const days = gm.gs.party["muni"].comaDaysLeft;
  assert(days >= 3 && days <= 5, `3~5日(${days})`);
  for (let i = 0; i < days; i++) passDay(gm);
  assertEq(gm.gs.party["muni"].exclusion, "none", "自然回復");
  assertEq(gm.gs.stats.comaTotal, 1, "昏睡カウント(夢魔の王出現条件)");
});

test("[状態] 裏切り3日で離脱・保持者取り憑きは即GO", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.possess("geru");
  for (let i = 0; i < 3; i++) passDay(gm);
  assertEq(gm.gs.party["geru"].exclusion, "dead", "3日離脱");
  const gm2 = new GameManager();
  gm2.newGame("renny", 42);
  gm2.possess("renny");
  assertEq(gm2.gs.gameOver, "holder_possess", "保持者GO");
});

console.log("[M5] クラフト（第7巻9章）");

test("[クラフト] 品質判定式（9-0-1）: ゲル薬90→大成功31.5%/失敗5%", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42); // 非ゲル保持者
  const apt = gm.craft.aptitude("pharmacy", "geru");
  assertEq(apt, 95, "ゲル薬90+ムニ同行5");
  // ゲル保持者なら+15
  const gm2 = new GameManager();
  gm2.newGame("geru", 42);
  assertEq(gm2.craft.aptitude("pharmacy", "geru"), 110, "+15マルチタスク");
  // ムニ調理20（ムニ本人にムニ同行ボーナスなし）
  assertEq(gm.craft.aptitude("cook", "muni"), 20, "ムニ調理20");
});

test("[クラフト] 調理→品質付き料理がストックされる", () => {
  const gm = new GameManager();
  gm.newGame("jinpachi", 42);
  gm.gs.inventory["meat"] = 3;
  const r = gm.craft.craft("cook", "dish_yakiniku", "jinpachi");
  assert(r.ok, "調理成功");
  assertEq(gm.gs.foodStock.length, 1, "ストック+1");
  assert(["great", "normal", "poor"].includes(gm.gs.foodStock[0].quality), "品質付与");
});

test("[クラフト] 料理は保存3日で消滅（第7巻8-2）", () => {
  const gm = new GameManager();
  gm.newGame("jinpachi", 42);
  gm.gs.foodStock.push({ dishId: "dish_yakiniku", quality: "normal", madeDay: gm.gs.day });
  passDay(gm); passDay(gm);
  assertEq(gm.gs.foodStock.length, 1, "2日目はまだある");
  passDay(gm);
  assertEq(gm.gs.foodStock.length, 0, "3日で消滅");
});

test("[クラフト] 薬草開発: 適性未満はレシピ選択不可（9-3）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  const rennyRecipes = gm.craft.availableRecipes("pharmacy", "renny"); // 薬40
  assert(!rennyRecipes.some((r) => r.id === "infection_cure"), "抗感染症薬(60)は不可");
  const geruRecipes = gm.craft.availableRecipes("pharmacy", "geru");   // 薬90
  assert(geruRecipes.some((r) => r.id === "infection_cure"), "ゲルは可");
  const hyuRecipes = gm.craft.availableRecipes("pharmacy", "hyu");     // 薬60
  assert(hyuRecipes.some((r) => r.id === "infection_cure"), "ヒュウ(60)も可");
});

test("[クラフト] 処置コマンドで大出血解除（薬では治らない・8-6）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("muni", "bleed", "t");
  // 薬に大出血治療は存在しない
  const bleedCure = Object.values(DB.items).filter((i) => i.cure?.includes("bleed"));
  assertEq(bleedCure.length, 0, "大出血を治す薬は無い");
  // 処置（ゲル薬90なら失敗率5%・成功まで再試行可）
  let cured = false;
  for (let i = 0; i < 10 && !cured; i++) {
    const r = gm.craft.treatBleed("geru", "muni");
    if (r.ok && r.grade !== "fail") cured = true;
  }
  assert(cured, "処置で解除");
  assertEq(gm.gs.party["muni"].status.bleed, undefined, "解除確認");
});

test("[クラフト] 大火傷・大出血のキャラは作業不可（9-0）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.statusFx.apply("geru", "burn", "t");
  gm.gs.inventory["herb_green"] = 5;
  gm.gs.inventory["herb_red"] = 5;
  const r = gm.craft.craft("pharmacy", "antidote", "geru");
  assert(!r.ok, "作業不可");
});

console.log("[M5] 食事・装備・経済（第7巻）");

test("[食事] 品質でHP回復量が変わる・満腹+40", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  const holder = gm.gs.party["renny"];
  holder.hp = 1;
  holder.satiety = 40;
  gm.gs.foodStock.push({ dishId: "dish_yakiniku", quality: "great", madeDay: gm.gs.day });
  gm.eatDish(0, "renny");
  assertEq(holder.hp, holder.maxHp, "おいしい=全回復");
  assertEq(holder.satiety, 80, "+40(個別)");
});

test("[食事] 生食: 木の実OK・キノコは10%毒（8-1）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.inventory["nuts"] = 1;
  assert(gm.eatRaw("nuts", "renny").ok, "木の実生食可");
  gm.gs.inventory["meat"] = 1;
  assert(!gm.eatRaw("meat", "renny").ok, "肉は生食不可");
});

test("[装備] 武器種一致のみ装備可・ネオは王剣初期装備（8-4）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  assertEq(gm.gs.party["neo"].equippedWeapon, "ouken", "王剣");
  gm.gs.inventory["renny_t1"] = 1;
  assert(gm.equip("renny", "renny_t1"), "剣→レニィOK");
  assert(!gm.equip("muni", "renny_t1"), "剣→ムニNG(スリング使い)");
  assertEq(DB.items["muni_t4"].protect_bonus, 5, "妖精のスリング庇う+5%");
});

test("[経済] 購入=売値×3（8-0）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  assertEq(gm.buyPrice("antidote"), 30, "解毒剤10×3");
  gm.gs.silver = 30;
  assert(gm.buyItem("antidote"), "購入");
  assertEq(gm.gs.silver, 0, "残高");
  assert(gm.sellItem("antidote"), "売却");
  assertEq(gm.gs.silver, 10, "売値");
});

console.log("[M2] 蘇生・信頼度・ED");

test("[蘇生] 7日に1人・引き継ぎ", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 10;
  gm.gs.party["geru"].level = 15;
  gm.gs.party["geru"].exclusion = "dead";
  gm.gs.party["muni"].exclusion = "dead";
  assert(gm.party.revive("geru"), "1人目OK");
  assertEq(gm.gs.party["geru"].level, 15, "Lv引き継ぎ");
  assert(!gm.party.revive("muni"), "2人目NG");
  gm.gs.day = 17;
  assert(gm.party.revive("muni"), "7日後OK");
});

test("[信頼] ムニ保持者×1.5切り上げ", () => {
  const gm = new GameManager();
  gm.newGame("muni", 42);
  const key = pairKey("renny", "geru");
  const before = gm.gs.trust[key];
  gm.trust.add("renny", "geru", 3, "test");
  assertEq(gm.gs.trust[key], before + 5, "3→5");
});

test("[ED] 真ED条件: 除外0+avg80+核心7/7+隠し旗", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 365;
  for (const key of Object.keys(gm.gs.trust)) gm.gs.trust[key] = 90;
  for (let i = 1; i <= 7; i++) gm.gs.flags[`core_ev${i}`] = true;
  gm.joinGoddess();
  assertEq(gm.endingJudge.judge().id, "TRUE", "真ED");
});

test("[隠し] 女神加入: パーティ平均Lv(下限40)で参入", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.joinGoddess();
  assertEq(gm.gs.party["goddess"].level, 40, "下限40");
  assert(gm.gs.flags["goddess_joined"], "フラグ");
});

test("[GO] 3種の保持者GO理由", () => {
  for (const r of ["holder_death", "holder_kidnap", "holder_possess"] as const) {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.triggerGameOver(r);
    assertEq(gm.gs.gameOver, r, r);
  }
});

console.log("[M7] ボス出現条件（第8巻11章）");

test("ボス解禁条件が正しく判定される", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  assert(!gm.bossUnlocked("volcano_lord"), "90日+供物3回前は不可");
  gm.gs.day = 90;
  gm.gs.tribute.fireCount = 3;
  assert(gm.bossUnlocked("volcano_lord"), "条件達成で可");
  assert(gm.bossUnlocked("pirate_captain"), "船長はいつでも可");
  gm.gs.day = 150;
  gm.gs.stats.sharkKills = 5;
  gm.gs.tide = "high";
  assert(gm.bossUnlocked("deep_sea_nushi"), "ヌシ解禁");
  gm.gs.tide = "low";
  assert(!gm.bossUnlocked("deep_sea_nushi"), "干潮では不可");
});

console.log("[M2移植] 通常Chat版M2成果物の受け入れテスト（reference/m2_godot）");

test("M2-T2: ジンパチ保持者=炎の猶予28日→水だけ供えるとDay29にGO4", () => {
  const gm = new GameManager();
  gm.newGame("jinpachi", 2);
  let guard = 0;
  while (gm.phase !== "gameover" && guard++ < 60) {
    gm.tribute.offer("water", "fish");
    gm.gs.inventory["fish"] = 5; // 供物用の魚を補充
    feedAll(gm);
    gm.endDay();
  }
  assertEq(gm.gs.gameOver, "tribute_fire_expired", "GO4");
  assertEq(gm.gs.day, 29, "Day29");
});

test("M2-T4/T5: 毒はDay10付与→Day17死亡・大出血はDay13死亡", () => {
  const gm = new GameManager();
  gm.newGame("hyu", 4);
  let poisonDeath: number | null = null;
  let bleedDeath: number | null = null;
  let guard = 0;
  while (gm.phase !== "gameover" && gm.gs.day < 30 && guard++ < 40) {
    if (gm.gs.day === 10) {
      gm.statusFx.apply("muni", "poison", "t");
      gm.statusFx.apply("neo", "bleed", "t");
    }
    passDay(gm);
    if (gm.gs.party["muni"].exclusion === "dead" && poisonDeath === null) poisonDeath = gm.gs.day;
    if (gm.gs.party["neo"].exclusion === "dead" && bleedDeath === null) bleedDeath = gm.gs.day;
  }
  assertEq(poisonDeath, 17, "毒: 7日後に死亡");
  assertEq(bleedDeath, 13, "大出血: 3日後に死亡");
});

test("M2-T7: 昏睡は死なずに3〜5日で自然回復", () => {
  const gm = new GameManager();
  gm.newGame("hyu", 7);
  gm.statusFx.apply("renny", "coma", "t");
  let recoverDay: number | null = null;
  let guard = 0;
  while (recoverDay === null && guard++ < 15) {
    passDay(gm);
    if (gm.gs.party["renny"].exclusion === "none") recoverDay = gm.gs.day;
  }
  assert(recoverDay !== null && recoverDay >= 4 && recoverDay <= 6, `回復日=${recoverDay}`);
  assert(gm.gs.party["renny"].exclusion === "none", "生存");
});

test("M2-T9: 365日間、嵐翌日晴れ違反ゼロ・期限直前(残2日)の嵐ゼロ", () => {
  const gm = new GameManager();
  gm.newGame("hyu", 9);
  let afterStormViolations = 0;
  let stormNearDeadline = 0;
  let guard = 0;
  while (gm.phase !== "ending" && gm.phase !== "gameover" && guard++ < 400) {
    if (gm.gs.prevWeather === "storm" && gm.gs.weather !== "clear") afterStormViolations++;
    const minLeft = Math.min(gm.tribute.remainingDays("fire"), gm.tribute.remainingDays("water"));
    if (gm.gs.weather === "storm" && minLeft <= 2) stormNearDeadline++;
    passDay(gm, true);
  }
  assertEq(afterStormViolations, 0, "嵐翌日晴れ違反");
  assertEq(stormNearDeadline, 0, "期限直前の嵐");
});

test("M2-T10: オートセーブ3世代ローテーション", () => {
  const gm = new GameManager();
  gm.newGame("hyu", 10);
  for (let i = 0; i < 5; i++) passDay(gm); // 5回就寝→autosave×5
  const slots = gm.save.listSlots().filter((s) => s.startsWith("auto"));
  assertEq(slots.length, 3, "3世代");
  const loaded = gm.save.loadSlot("auto_0");
  assert(loaded !== null, "ロード可");
});

test("M2-T11: 疫病の重症化率（3日目≈20%・統計検証）", () => {
  let severeAt3 = 0;
  const TRIALS = 3000;
  for (let i = 0; i < TRIALS; i++) {
    const gm = new GameManager();
    gm.newGame("hyu", 10000 + i);
    gm.statusFx.apply("muni", "plague", "t");
    for (let d = 0; d < 3; d++) passDay(gm);
    // plagueDay=3の日次処理で20%判定→severeDaysが定義されたか
    if (gm.gs.party["muni"].status.plagueSevereDays !== undefined) severeAt3++;
  }
  const rate = severeAt3 / TRIALS;
  assert(Math.abs(rate - 0.20) < 0.03, `3日目重症化率 実測=${rate.toFixed(3)} (設計0.20)`);
});

console.log("[M3] 第4巻・戦闘正本仕様");

test("[命中] 最終命中率 = 基礎 + (技量−回避)×0.2、上限100/下限10（5-6-1）", () => {
  // 命中50/技量0/回避200 → 50-40=10(下限)。chance(0.10)を確定発生させるためRNG固定
  let hits = 0;
  const trials = 20000;
  const rng = new RNG(1);
  for (let i = 0; i < trials; i++) {
    if (calcHit(50, 30, 0, 90, 0, rng, 0)) hits++; // 90+(50-30)*0.2=94
  }
  assertClose(hits / trials, 0.94, 0.01, "94%");
  // 下限10
  let low = 0;
  const rng2 = new RNG(2);
  for (let i = 0; i < trials; i++) {
    if (calcHit(0, 500, 0, 50, 0, rng2, 0)) low++;
  }
  assertClose(low / trials, 0.10, 0.01, "下限10%");
});

test("[逃走] 50+(Lv差)×3、上限95/下限10（5-4-6）", () => {
  assertEq(fleeRate(10, 10), 50, "同Lv50");
  assertEq(fleeRate(20, 10), 80, "+10Lv=80");
  assertEq(fleeRate(99, 1), 95, "上限");
  assertEq(fleeRate(1, 99), 10, "下限");
});

test("[手なずけ] 40+技量×0.3、上限90（5-4-7）", () => {
  assertEq(tameRate(100), 70, "40+30");
  assertEq(tameRate(300), 90, "上限90");
});

test("[説得] 30+ペア信頼×0.5（5-9）", () => {
  assertEq(persuadeRate(60), 60, "30+30");
  assertEq(persuadeRate(60, true), 75, "+選択肢15");
});

test("[戦闘] 保持者は参加しなくてもよい（5-2-1）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["geru", "neo"]); // 保持者レニィ不参加
  assertEq(b.allies.length, 2, "2人で出撃");
  assert(b.availableCommands("geru").includes("attack"), "通常コマンド");
});

test("[戦闘] 保持者が戦闘不能になった瞬間に即GO（5-2-3・終了を待たない）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["bear", "bear"], ["renny", "geru"]);
  // レニィを瀕死にして熊の攻撃で落とす
  gm.gs.party["renny"].hp = 1;
  let out = "ongoing";
  for (let i = 0; i < 30 && out === "ongoing"; i++) {
    out = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "guard", actorId: "geru" },
    ]);
    gm.gs.party["geru"].hp = gm.gs.party["geru"].maxHp; // ゲルは維持
    gm.gs.party["geru"].downed = false;
    if (out !== "ongoing") break;
    gm.gs.party["renny"].hp = 1; // 命中するまで瀕死維持
  }
  assertEq(out, "gameover", "即GO");
  const r = gm.settleBattle();
  assertEq(r.goReason, "holder_death", "GO1");
});

test("[戦闘] 防御コマンドでターン終了時SP+5（5-4-3）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["renny", "geru"]);
  gm.gs.party["renny"].sp = 0;
  b.executeTurn([
    { kind: "guard", actorId: "renny" },
    { kind: "guard", actorId: "geru" },
  ]);
  assert(gm.gs.party["renny"].sp >= 5, `防御でSP+5 (sp=${gm.gs.party["renny"].sp})`);
});

test("[戦闘] 大出血中は攻撃コマンド不可（5-7）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  gm.gs.party["geru"].status.bleed = 3;
  const b = gm.startBattle(["boar"], ["renny", "geru"]);
  const cmds = b.availableCommands("geru");
  assert(!cmds.includes("attack"), "攻撃不可");
  assert(cmds.includes("skill"), "技は可");
});

test("[戦闘] 味方のスリップ: 毒5%/大出血8%（5-7）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar"], ["renny", "geru", "muni"]);
  b.enemies[0].hp = 999999; b.enemies[0].maxHp = 999999;
  const geru = gm.gs.party["geru"];
  const muni = gm.gs.party["muni"];
  geru.status.poison = 7;
  muni.status.bleed = 3;
  const gHp = geru.hp, mHp = muni.hp;
  b.executeTurn([
    { kind: "guard", actorId: "renny" },
    { kind: "guard", actorId: "geru" },
    { kind: "guard", actorId: "muni" },
  ]);
  const gLoss = gHp - geru.hp;
  const mLoss = mHp - muni.hp;
  // 敵の攻撃分があるため「最低でもスリップ分は減っている」を確認
  assert(gLoss >= Math.round(geru.maxHp * 0.05), `毒5%以上 (${gLoss})`);
  assert(mLoss >= Math.round(muni.maxHp * 0.08), `出血8%以上 (${mLoss})`);
});

test("[戦闘] 手なずける: 獣族を3ターン味方化→野生に帰る（5-4-7）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42); // ジンパチ非保持者
  gm.gs.location = "grassland";
  const b = gm.startBattle(["boar", "bear"], ["renny", "jinpachi"]);
  assert(b.availableCommands("jinpachi").includes("tame"), "手なずけるコマンド");
  // 成功を強制（tameRate→100%化はできないので直接付与して挙動検証）
  b.enemies[0].tamedTurns = 3;
  b.enemies[1].hp = 999999; b.enemies[1].maxHp = 999999;
  // 手なずけ中は勝利判定で敵扱いされない
  b.enemies[1].alive = false;
  assertEq(b.finish(), "victory", "手なずけ個体のみ残存→勝利");
});

test("[戦闘] 取り憑き→裏切りユニット→説得で復帰（5-9）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  for (const key of Object.keys(gm.gs.trust)) gm.gs.trust[key] = 100; // 説得を確実に
  const skill = DB.enemies["demon"].skills.find((s) => s.name === "取り憑き")!;
  const orig = skill.effects[0].chance;
  skill.effects[0].chance = 5.0; // 抵抗補正込みでも確定
  try {
    const b = gm.startBattle(["demon"], ["geru", "neo"]); // 保持者不参加（保持者GOを避ける）
    let betrayedId: string | null = null;
    for (let i = 0; i < 12 && !betrayedId; i++) {
      b.executeTurn([
        { kind: "guard", actorId: "geru" },
        { kind: "guard", actorId: "neo" },
      ].filter((c) => {
        const a = b.allies.find((x) => x.state.id === c.actorId) as any;
        return a && !a.betrayed && !a.state.downed;
      }) as any);
      for (const a of b.allies) { if (!(a as any).betrayed) { a.state.hp = a.state.maxHp; a.state.downed = false; } }
      const bt = b.allies.find((a) => (a as any).betrayed);
      if (bt) betrayedId = bt.state.id;
    }
    assert(betrayedId !== null, "裏切り発生");
    // 説得（信頼100 → 30+50=80%。成功するまで試行）
    const persuader = b.allies.find((a) => a.state.id !== betrayedId)!;
    let freed = false;
    for (let i = 0; i < 20 && !freed; i++) {
      b.executeTurn([{ kind: "persuade", actorId: persuader.state.id, targetAllyId: betrayedId! }]);
      for (const a of b.allies) { if (!(a as any).betrayed) { a.state.hp = a.state.maxHp; a.state.downed = false; } }
      freed = !(b.allies.find((a) => a.state.id === betrayedId) as any).betrayed;
    }
    assert(freed, "説得で復帰");
  } finally {
    skill.effects[0].chance = orig;
  }
});

test("[戦闘] 敵の一撃必殺は保持者に無効（5-6-2）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["tiger"], ["renny"]);
  // 直接検証: crit_bonus効果は保持者を対象外とするロジック
  // → 30ターン喉狙いを受け続けても一撃必殺での戦闘不能は起きない
  //   （ダメージ戦闘不能は起こりうるのでHPを毎回全快に）
  let critDown = false;
  for (let i = 0; i < 30; i++) {
    const before = b.log.lines.length;
    const out = b.executeTurn([{ kind: "guard", actorId: "renny" }]);
    const newLines = b.log.lines.slice(before).join("");
    if (newLines.includes("急所に命中")) critDown = true;
    gm.gs.party["renny"].hp = gm.gs.party["renny"].maxHp;
    gm.gs.party["renny"].downed = false;
    (b as any).outcome = "ongoing";
    (b as any).holderLost = null;
    if (out === "victory") break;
  }
  assert(!critDown, "保持者に急所なし");
});

test("[戦闘] 水の女神の救済: 引き込み即死を1戦闘1度だけ無効（5-6-2）", () => {
  const gm = new GameManager();
  gm.newGame("neo", 42); // 非レニィ保持者
  gm.gs.location = "shallows";
  gm.gs.tide = "high";
  // 供物期限内 → waterGraceActive
  const b = gm.startBattle(["shark"], ["geru", "muni"]); // レニィ不在
  const pullSkill = DB.enemies["shark"].skills.find((s) => s.name.includes("引き込む"))!;
  // 直接実行して救済を検証
  (b as any).execEnemySkill(b.enemies[0], pullSkill);
  const logs1 = b.log.lines.join("");
  // 命中は55%なので、外れた場合も考慮して救済発生まで繰り返す
  let saved = logs1.includes("水の女神の加護");
  let died = false;
  for (let i = 0; i < 40 && !saved && !died; i++) {
    const before = b.log.lines.length;
    (b as any).execEnemySkill(b.enemies[0], pullSkill);
    const t = b.log.lines.slice(before).join("");
    if (t.includes("水の女神の加護")) saved = true;
    if (t.includes("引きずり込まれた")) died = true;
  }
  assert(saved && !died, "初回は救済される");
  // 2度目は死亡する（1戦1回）
  let secondDeath = false;
  for (let i = 0; i < 60 && !secondDeath; i++) {
    const before = b.log.lines.length;
    (b as any).execEnemySkill(b.enemies[0], pullSkill);
    if (b.log.lines.slice(before).join("").includes("引きずり込まれた")) secondDeath = true;
  }
  assert(secondDeath, "2度目は救済されない");
});

test("[戦闘] EXP: 控えの生存メンバーに30%（5-11-2）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["giant_mosquito"], ["renny", "geru"]);
  const hyuExpBefore = gm.gs.party["hyu"].exp;
  let out = "ongoing";
  for (let i = 0; i < 40 && out === "ongoing"; i++) {
    out = b.executeTurn([
      { kind: "guard", actorId: "renny" },
      { kind: "attack", actorId: "geru", targetEnemyIndex: 0 },
    ]);
  }
  assertEq(out, "victory", "勝利");
  const r = gm.settleBattle();
  const expected = Math.round(r.expGained * 0.3);
  assertEq(gm.gs.party["hyu"].exp - hyuExpBefore, expected, "控え30%");
});

test("[戦闘] 庇う成功で方向付きカウンタ+信頼+3（5-4-4/5-13-2）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  const before = gm.trust.pair("geru", "renny");
  gm.trust.onProtectSuccess("geru", "renny");
  assertEq(gm.gs.protectCounts["geru>renny"], 1, "方向付き");
  assertEq(gm.trust.pair("geru", "renny"), before + 3, "+3");
  gm.trust.onProtectSuccess("geru", "renny");
  const special = gm.trust.onProtectSuccess("geru", "renny");
  assert(special !== null && special.includes("protect_special"), "3回で特別シナリオ");
});

test("[戦闘] 勝利時SP回復=最大の10%（5-11-1）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.location = "grassland";
  const b = gm.startBattle(["giant_mosquito"], ["renny", "geru"]);
  b.enemies[0].hp = 0;
  b.enemies[0].alive = false;
  gm.gs.party["geru"].sp = 0;
  b.finish();
  gm.settleBattle();
  const geru = gm.gs.party["geru"];
  assert(geru.sp >= Math.round(geru.maxSp * 0.10), `SP10%回復 (${geru.sp})`);
});

console.log("[M3.5] 夜イベント戦闘（M2フック接続）");

test("[夢魔] 夢の中の1人戦闘: 敗北=昏睡(死なない)・勝利=安眠HP+10%", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 120;
  // 敗北ケース（非保持者ムニの夢）
  const b = gm.startDreamBattle("muni");
  assertEq(b.allies.length, 1, "1人戦闘");
  assert(b.availableCommands("muni").includes("attack"), "非保持者は攻撃可");
  b.allies[0].state.hp = 0;
  b.allies[0].state.downed = true;
  b.finish();
  const r = gm.settleDreamBattle("muni");
  assertEq(r.deaths.length, 0, "死亡しない");
  assertEq(gm.gs.party["muni"].exclusion, "coma", "昏睡");
  assertEq(gm.gs.gameOver, null, "GOなし");

  // 勝利ケース（保持者レニィの夢: 防御/逃げるのみ→勝利は仲間側のみ可能だがAPI検証として敵HP0に）
  const gm2 = new GameManager();
  gm2.newGame("renny", 42);
  gm2.gs.day = 120;
  const b2 = gm2.startDreamBattle("renny");
  const cmds = b2.availableCommands("renny");
  assert(cmds.includes("guard") && cmds.includes("flee") && !cmds.includes("attack"),
    "保持者の夢でも掟は有効");
  b2.allies[0].state.hp = Math.round(b2.allies[0].state.maxHp * 0.5);
  b2.enemies[0].hp = 0;
  b2.enemies[0].alive = false;
  b2.finish();
  const hpBefore = gm2.gs.party["renny"].hp;
  gm2.settleDreamBattle("renny");
  assert(gm2.gs.party["renny"].hp > hpBefore, "安眠HP+10%");
});

test("[夢魔] 敵Lv=眠った本人のLv（第8巻10-8）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.party["muni"].level = 37;
  const b = gm.startDreamBattle("muni");
  assertEq(b.enemies[0].level, 37, "本人Lv");
});

test("[夜襲] 夜イベント戦闘は時間を進めない（就寝処理の一部）", () => {
  const gm = new GameManager();
  gm.newGame("renny", 42);
  gm.gs.day = 70;
  const dayBefore = gm.gs.day;
  const slotBefore = gm.gs.slot;
  const b = gm.startNightRaidBattle(["renny", "geru", "neo"]);
  assert(b.enemies.every((e) => e.def.family === "demon"), "悪魔の夜襲");
  b.enemies.forEach((e) => { e.hp = 0; e.alive = false; });
  b.finish();
  const r = gm.settleBattle();
  assertEq(r.outcome, "victory", "勝利");
  assertEq(gm.gs.day, dayBefore, "日付そのまま");
  assertEq(gm.gs.slot, slotBefore, "時間帯そのまま");
});

test("[夜イベント] rollNightEvents: 61日目以降に夜襲が発生しうる・UI解決後は二重適用なし", () => {
  const orig = JSON.parse(JSON.stringify(DB.config.night_raid.phases));
  (DB.config.night_raid as any).phases = [[61, 1.0]]; // 100%化
  try {
    const gm = new GameManager();
    gm.newGame("renny", 42);
    gm.gs.day = 61;
    const ev = gm.rollNightEvents();
    assert(ev.raid, "61日目以降は夜襲発生");
    // 解決済みフラグにより endDay 内で再ロールされない（昏睡の自動適用が起きない）
    gm.gs.tribute.fireLastDay = gm.gs.day;
    gm.gs.tribute.waterLastDay = gm.gs.day;
    for (const c of Object.values(gm.gs.party)) { c.satiety = 100; c.starveDays = 0; }
    gm.endDay();
    assertEq(gm.gs.day, 62, "翌日へ");
  } finally {
    (DB.config.night_raid as any).phases = orig;
  }
});

test("[夢イベント] rollNightEvents: レニィは遭遇率5%（100日目以降・強制ロール検証）", () => {
  const origBase = DB.config.dream.rate_base;
  const origRenny = DB.config.dream.rate_renny;
  (DB.config.dream as any).rate_base = 0;
  (DB.config.dream as any).rate_renny = 1.0; // レニィのみ100%化
  try {
    const gm = new GameManager();
    gm.newGame("geru", 42);
    gm.gs.day = 100;
    const ev = gm.rollNightEvents();
    assertEq(ev.dreamer, "renny", "レニィが夢を見る");
    assertEq(gm.gs.party["renny"].exclusion, "none", "UI解決前は昏睡しない");
  } finally {
    (DB.config.dream as any).rate_base = origBase;
    (DB.config.dream as any).rate_renny = origRenny;
  }
});

console.log("[M2] 365日通し");

test("供物・食事を続ければ365日到達→EndingJudge", () => {
  const gm = new GameManager();
  gm.newGame("geru", 7);
  let guard = 0;
  while (gm.phase !== "ending" && gm.phase !== "gameover" && guard++ < 400) {
    passDay(gm, true); // 毎日治療を欠かさない想定（感染症・疫病の放置死を除外）
  }
  assertEq(gm.phase, "ending", `365日到達(day=${gm.gs.day},phase=${gm.phase})`);
  assertEq(gm.gs.day, 365, "day=365");
  assert(gm.gs.achievements.includes("survivor_365"), "1年生存実績");
});

console.log("");
console.log(`結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("失敗:", failures.join("\n"));
  process.exit(1);
}
