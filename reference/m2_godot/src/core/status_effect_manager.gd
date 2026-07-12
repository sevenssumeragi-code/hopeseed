class_name StatusEffectManager
extends RefCounted
## 状態異常の戦闘外デイリー処理（第14巻18-4が正本）
## 返り値：死亡イベント配列 [{char, cause}]

var rng: RandomNumberGenerator

func _init(p_rng: RandomNumberGenerator) -> void:
	rng = p_rng

func daily_tick(party: Array) -> Array:
	var deaths: Array = []
	var infected_exists := false
	for c in party:
		if c.alive and c.effects.has("infection"):
			infected_exists = true
	for c in party:
		if not c.alive:
			continue
		for name in c.effects.keys().duplicate():
			var e: Dictionary = c.effects[name]
			e["days"] = int(e["days"]) + 1
			var d: int = e["days"]
			match name:
				"poison":
					if d >= Config.get_i("POISON_DAYS"): deaths.append({"char": c, "cause": "毒の放置"})
				"burn":
					if d >= Config.get_i("BURN_DAYS"): deaths.append({"char": c, "cause": "大火傷の放置"})
				"bleed":
					if d >= Config.get_i("BLEED_DAYS"): deaths.append({"char": c, "cause": "大出血の放置"})
				"plague":
					if e["severe"]:
						e["severe_days"] = int(e["severe_days"]) + 1
						if int(e["severe_days"]) >= Config.get_i("PLAGUE_SEVERE_DEATH_DAYS"):
							deaths.append({"char": c, "cause": "疫病の重症化"})
					elif d >= Config.get_i("PLAGUE_SEVERE_START_DAY"):
						var p := Config.get_f("PLAGUE_SEVERE_BASE") + Config.get_f("PLAGUE_SEVERE_STEP") * float(d - Config.get_i("PLAGUE_SEVERE_START_DAY"))
						if rng.randf() < p: e["severe"] = true
				"infection":
					if e["severe"]:
						e["severe_days"] = int(e["severe_days"]) + 1
						if int(e["severe_days"]) >= Config.get_i("INFECT_SEVERE_DEATH_DAYS"):
							deaths.append({"char": c, "cause": "感染症の重症化"})
					elif d >= Config.get_i("INFECT_SEVERE_START_DAY"):
						var p2 := Config.get_f("INFECT_SEVERE_BASE") + Config.get_f("INFECT_SEVERE_STEP") * float(d - Config.get_i("INFECT_SEVERE_START_DAY"))
						if rng.randf() < p2: e["severe"] = true
				"coma":
					if d >= int(e["recover_at"]):
						c.cure("coma")   # 昏睡は死なない・自然回復（原設定）
	# 感染症の伝染：未治療者がいる間、毎日10%で味方1人へ（原設定）
	if infected_exists and rng.randf() < Config.get_f("INFECT_SPREAD_RATE"):
		var targets: Array = []
		for c in party:
			if c.alive and not c.effects.has("infection"):
				targets.append(c)
		if targets.size() > 0:
			targets[rng.randi_range(0, targets.size() - 1)].add_effect("infection")
	return deaths
