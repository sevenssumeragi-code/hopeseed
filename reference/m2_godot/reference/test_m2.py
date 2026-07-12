# -*- coding: utf-8 -*-
"""M2受け入れテスト：365日自動スキップで供物切れGO等が正しく発火することの検証"""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from m2_core import GameManager, CFG

def t(name, cond, detail=""):
    print(("✔ PASS" if cond else "✘ FAIL"), name, detail)
    assert cond, name

# T1: 供物を一切捧げない（食事はする） → Day15の朝にGO（期限=Day14、超過で発火）
gm = GameManager(holder_id="hyu", seed=1, save_dir="/tmp/hs1")
result = gm.simulate(365, lambda g: g.eat_all())
t("T1 供物ゼロ→GO発火", result in ("TRIBUTE_FIRE", "TRIBUTE_WATER") and gm.time.day == 15,
  f"(result={result}, day={gm.time.day})")

# T2: ジンパチ保持者＝炎の猶予28日。水だけ毎日供える→炎切れはDay29
gm = GameManager(holder_id="jinpachi", seed=2, save_dir="/tmp/hs2")
def water_only(g): g.offer_tribute("water"); g.eat_all()
result = gm.simulate(365, water_only)
t("T2 炎の加護で猶予28日", result == "TRIBUTE_FIRE" and gm.time.day == 29,
  f"(result={result}, day={gm.time.day})")

# T3: 両供物を12日周期で維持＋毎日食事 → 365日完走でENDING
gm = GameManager(holder_id="hyu", seed=3, save_dir="/tmp/hs3")
def good_play(g):
    if g.time.day % 12 == 0:
        g.offer_tribute("fire"); g.offer_tribute("water")
    g.eat_all()
result = gm.simulate(365, good_play)
t("T3 供物維持で365日完走", result == "ENDING" and gm.time.day == 365,
  f"(result={result}, day={gm.time.day})")

# T4: 毒の放置 → 付与から7日で死亡（Day10付与→Day17死亡）
gm = GameManager(holder_id="hyu", seed=4, save_dir="/tmp/hs4")
death_day = None
def poison_watch(g):
    global death_day
    if g.time.day == 10: g.char("muni").add_effect("poison", g.rng)
    if not g.char("muni").alive and death_day is None: death_day = g.time.day
    good_play(g)
gm.simulate(30, poison_watch)
t("T4 毒放置7日で死亡", death_day == 17, f"(death_day={death_day})")

# T5: 大出血は3日で死亡（Day10付与→Day13死亡）
gm = GameManager(holder_id="hyu", seed=5, save_dir="/tmp/hs5")
death_day = None
def bleed_watch(g):
    global death_day
    if g.time.day == 10: g.char("neo").add_effect("bleed", g.rng)
    if not g.char("neo").alive and death_day is None: death_day = g.time.day
    good_play(g)
gm.simulate(30, bleed_watch)
t("T5 大出血放置3日で死亡", death_day == 13, f"(death_day={death_day})")

# T6: 飢餓＝満腹0のまま7日で死亡。保持者が餓死→GO1
gm = GameManager(holder_id="hyu", seed=6, save_dir="/tmp/hs6")
def tribute_only(g):
    if g.time.day % 12 == 0:
        g.offer_tribute("fire"); g.offer_tribute("water")
result = gm.simulate(60, tribute_only)  # 誰も食べない
t("T6 全員絶食→飢餓死→保持者死亡GO1", result == "HOLDER_DEATH",
  f"(result={result}, day={gm.time.day})")
# 満腹100→0に約7日、その後カウント7日 → Day14前後で死亡ラッシュ
t("T6b 餓死時期の妥当性", 13 <= gm.time.day <= 16, f"(day={gm.time.day})")

# T7: 昏睡は死なずに3～5日で自然回復
gm = GameManager(holder_id="hyu", seed=7, save_dir="/tmp/hs7")
gm.char("renny").add_effect("coma", gm.rng)
recover_day = None
def coma_watch(g):
    global recover_day
    if "coma" not in g.char("renny").effects and recover_day is None:
        recover_day = g.time.day
    good_play(g)
gm.simulate(15, coma_watch)
t("T7 昏睡は3～5日で自然回復・死亡なし",
  recover_day is not None and 4 <= recover_day <= 6 and gm.char("renny").alive,
  f"(recover_day={recover_day})")

# T8: 潮汐＝朝昼干潮・夕夜満潮
gm = GameManager(holder_id="hyu", seed=8, save_dir="/tmp/hs8")
tides = []
for _ in range(4):
    tides.append((gm.time.slot, gm.time.is_high_tide()))
    gm.time.advance(1) if gm.time.slot_idx < 3 else None
t("T8 潮汐サイクル", tides == [("morning", False), ("noon", False), ("evening", True), ("night", True)],
  f"({tides})")

# T9: 嵐の翌日は必ず晴れ／供物期限残り2日以内は嵐が出ない
gm = GameManager(holder_id="hyu", seed=9, save_dir="/tmp/hs9")
violations_after_storm, storm_near_deadline = 0, 0
prev = None
def weather_watch(g):
    global violations_after_storm, storm_near_deadline, prev
    if prev == "storm" and g.weather.today != "sunny": violations_after_storm += 1
    if g.weather.today == "storm" and g.tribute.min_remaining(g.time.day) <= 2: storm_near_deadline += 1
    prev = g.weather.today
    good_play(g)
gm.simulate(365, weather_watch)
t("T9 嵐翌日晴れ・期限直前の嵐抑制", violations_after_storm == 0 and storm_near_deadline == 0,
  f"(after_storm違反={violations_after_storm}, 期限直前嵐={storm_near_deadline})")

# T10: オートセーブ3世代ローテ＋チェックサム整合
gm = GameManager(holder_id="hyu", seed=10, save_dir="/tmp/hs10")
gm.simulate(10, good_play)
files = sorted(os.listdir("/tmp/hs10"))
data = gm.save.load(0)
t("T10 オートセーブ3世代＋破損検証", files == ["auto0.json", "auto1.json", "auto2.json"] and "meta" in data,
  f"(files={files}, loaded_day={data['meta']['day']})")

# T11: 疫病の重症化曲線（統計検証：Day3で20%、以降+10%/日）
from m2_core import StatusEffectManager, CharacterState
import random as _r
severe_by_day = {3:0, 4:0, 5:0}
TRIALS = 20000
for i in range(TRIALS):
    rng = _r.Random(i); sem = StatusEffectManager(rng)
    c = CharacterState("x"); c.add_effect("plague", rng)
    for day in range(1, 6):
        sem.daily_tick([c])
        if c.effects.get("plague", {}).get("severe") and day in severe_by_day:
            severe_by_day[day] += 1; break
p3 = severe_by_day[3]/TRIALS
t("T11 疫病重症化率（3日目≈20%）", abs(p3 - 0.20) < 0.01, f"(実測={p3:.3f})")

print("\n=== 365日フルログのサンプル（T3良プレイの末尾5行） ===")
gm = GameManager(holder_id="hyu", seed=3, save_dir="/tmp/hs3b")
gm.simulate(365, good_play)
for line in gm.log[-5:]: print(line)
print("\nALL M2 ACCEPTANCE TESTS PASSED")
