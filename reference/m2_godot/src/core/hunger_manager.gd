class_name HungerManager
extends RefCounted
## 空腹ゲージ（第14巻18-4）：1日−15%（探索日−20%）／食事+40%／0%が7日で死亡

func daily_tick(party: Array, explored_today: bool) -> Array:
	var deaths: Array = []
	var decay := Config.get_f("HUNGER_DECAY_EXPLORE") if explored_today else Config.get_f("HUNGER_DECAY_BASE")
	for c in party:
		if not c.alive:
			continue
		c.satiety = maxf(0.0, c.satiety - decay)
		if c.satiety <= 0.0:
			c.starve_days += 1
			c.hp = maxi(1, c.hp - int(c.hp_max * Config.get_f("HUNGER_ZERO_HP_LOSS")))
			if c.starve_days >= Config.get_i("STARVE_DAYS"):
				deaths.append({"char": c, "cause": "飢餓"})
		else:
			c.starve_days = 0
	return deaths

func eat(c: CharacterState) -> void:
	c.satiety = minf(100.0, c.satiety + Config.get_f("HUNGER_MEAL_RECOVER"))
