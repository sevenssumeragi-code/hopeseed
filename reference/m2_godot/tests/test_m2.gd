extends SceneTree
## M2受け入れテスト（Godot 4ヘッドレス実行）
## 実行: godot4 --headless --path <プロジェクトルート> --script tests/test_m2.gd
## Pythonリファレンス（reference/test_m2.py）と同一のT1～T10を検証する

var fails := 0

func t(name: String, cond: bool, detail: String = "") -> void:
	print(("✔ PASS " if cond else "✘ FAIL ") + name + " " + detail)
	if not cond:
		fails += 1

func good_play(g) -> void:
	if g.time.day % 12 == 0:
		g.offer_tribute("fire")
		g.offer_tribute("water")
	g.eat_all()

func _init() -> void:
	Config.load_config("res://data/config.json")

	# T1: 供物ゼロ（食事あり）→ Day15にGO
	var gm := GameManager.new("hyu", 1, "user://t1")
	var r := gm.simulate(365, func(g): g.eat_all())
	t("T1 供物ゼロ→GO発火", (r == "TRIBUTE_FIRE" or r == "TRIBUTE_WATER") and gm.time.day == 15,
		"(result=%s, day=%d)" % [r, gm.time.day])

	# T2: ジンパチ保持者＝炎の猶予28日 → 水だけ供えると炎切れDay29
	gm = GameManager.new("jinpachi", 2, "user://t2")
	r = gm.simulate(365, func(g): g.offer_tribute("water"); g.eat_all())
	t("T2 炎の加護で猶予28日", r == "TRIBUTE_FIRE" and gm.time.day == 29,
		"(result=%s, day=%d)" % [r, gm.time.day])

	# T3: 供物維持＋食事 → 365日完走
	gm = GameManager.new("hyu", 3, "user://t3")
	r = gm.simulate(365, good_play)
	t("T3 供物維持で365日完走", r == "ENDING" and gm.time.day == 365,
		"(result=%s, day=%d)" % [r, gm.time.day])

	# T4: 毒放置7日で死亡（Day10付与→Day17）
	gm = GameManager.new("hyu", 4, "user://t4")
	var death_day := -1
	r = gm.simulate(30, func(g):
		if g.time.day == 10: g.char_by_id("muni").add_effect("poison", g.rng)
		if not g.char_by_id("muni").alive and death_day < 0: death_day = g.time.day
		good_play(g))
	t("T4 毒放置7日で死亡", death_day == 17, "(death_day=%d)" % death_day)

	# T5: 大出血3日で死亡（Day10付与→Day13）
	gm = GameManager.new("hyu", 5, "user://t5")
	death_day = -1
	r = gm.simulate(30, func(g):
		if g.time.day == 10: g.char_by_id("neo").add_effect("bleed", g.rng)
		if not g.char_by_id("neo").alive and death_day < 0: death_day = g.time.day
		good_play(g))
	t("T5 大出血放置3日で死亡", death_day == 13, "(death_day=%d)" % death_day)

	# T6: 全員絶食 → 保持者餓死GO1
	gm = GameManager.new("hyu", 6, "user://t6")
	r = gm.simulate(60, func(g):
		if g.time.day % 12 == 0:
			g.offer_tribute("fire"); g.offer_tribute("water"))
	t("T6 全員絶食→保持者死亡GO1", r == "HOLDER_DEATH" and gm.time.day >= 13 and gm.time.day <= 16,
		"(result=%s, day=%d)" % [r, gm.time.day])

	# T7: 昏睡は3～5日で自然回復
	gm = GameManager.new("hyu", 7, "user://t7")
	gm.char_by_id("renny").add_effect("coma", gm.rng)
	var recover_day := -1
	gm.simulate(15, func(g):
		if not g.char_by_id("renny").effects.has("coma") and recover_day < 0:
			recover_day = g.time.day
		good_play(g))
	t("T7 昏睡3～5日で自然回復", recover_day >= 4 and recover_day <= 6 and gm.char_by_id("renny").alive,
		"(recover_day=%d)" % recover_day)

	# T8: 潮汐＝朝昼干潮・夕夜満潮
	gm = GameManager.new("hyu", 8, "user://t8")
	var ok := true
	var expects := [false, false, true, true]
	for i in 4:
		gm.time.slot_idx = i
		if gm.time.is_high_tide() != expects[i]: ok = false
	t("T8 潮汐サイクル", ok)

	# T9: 嵐翌日晴れ／期限直前の嵐抑制
	gm = GameManager.new("hyu", 9, "user://t9")
	var v1 := 0; var v2 := 0; var prev := ""
	gm.simulate(365, func(g):
		if prev == "storm" and g.weather.today != "sunny": v1 += 1
		if g.weather.today == "storm" and g.tribute.min_remaining(g.time.day) <= 2: v2 += 1
		prev = g.weather.today
		good_play(g))
	t("T9 嵐翌日晴れ・期限直前抑制", v1 == 0 and v2 == 0, "(違反=%d/%d)" % [v1, v2])

	# T10: オートセーブ3世代＋チェックサム
	gm = GameManager.new("hyu", 10, "user://t10")
	gm.simulate(10, good_play)
	var loaded := gm.save.load_slot(0)
	t("T10 オートセーブ＋整合", loaded.has("meta"), "(day=%s)" % str(loaded["meta"]["day"]))

	print("")
	if fails == 0:
		print("ALL M2 ACCEPTANCE TESTS PASSED")
	else:
		print("%d TEST(S) FAILED" % fails)
	quit(fails)
