class_name TributeManager
extends RefCounted
## 供物ノルマ（第1巻2-2）：14日周期／保持者加護で28日／期限超過でGO4・GO5

var holder_id: String
var last_offer := {"fire": 0, "water": 0}   # Day0=漂着時に挨拶済み扱い
var consecutive := {"fire": 0, "water": 0}

func _init(p_holder: String) -> void:
	holder_id = p_holder

func interval(goddess: String) -> int:
	var grace: Dictionary = Config.get_v("HOLDER_TRIBUTE_GRACE")
	if grace.get(holder_id, "") == goddess:
		return Config.get_i("TRIBUTE_INTERVAL_GRACE")   # 炎の加護/水の加護＝4週間に1度
	return Config.get_i("TRIBUTE_INTERVAL")

func remaining_days(goddess: String, day: int) -> int:
	return int(last_offer[goddess]) + interval(goddess) - day

func offer(goddess: String, day: int) -> void:
	last_offer[goddess] = day
	consecutive[goddess] = int(consecutive[goddess]) + 1

## 朝の期限チェック。超過があればGO理由を返す（無ければ ""）
func check_morning(day: int) -> String:
	if remaining_days("fire", day) < 0:
		return "TRIBUTE_FIRE"
	if remaining_days("water", day) < 0:
		return "TRIBUTE_WATER"
	return ""

func min_remaining(day: int) -> int:
	return mini(remaining_days("fire", day), remaining_days("water", day))
