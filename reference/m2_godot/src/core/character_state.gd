class_name CharacterState
extends RefCounted
## M2最小限のキャラ状態（第13巻17-5 partyブロックの骨格）

var id: String
var hp_max: int = 100
var hp: int = 100
var alive: bool = true          # false = 死亡（除外）
var satiety: float = 100.0      # 空腹ゲージ（第14巻18-4）
var starve_days: int = 0
var effects: Dictionary = {}    # {"poison": {"days":0,"severe":false,"severe_days":0}, ...}

func _init(cid: String) -> void:
	id = cid

func add_effect(name: String, rng: RandomNumberGenerator = null) -> void:
	if effects.has(name):
		effects[name]["days"] = 0   # 再付与は持続リセット（第4巻5-7）
		return
	var e := {"days": 0, "severe": false, "severe_days": 0}
	if name == "coma":
		e["recover_at"] = rng.randi_range(Config.get_i("COMA_RECOVER_MIN_DAYS"), Config.get_i("COMA_RECOVER_MAX_DAYS"))
	effects[name] = e

func cure(name: String) -> void:
	effects.erase(name)
