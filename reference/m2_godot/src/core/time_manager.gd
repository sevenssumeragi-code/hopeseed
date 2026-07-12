class_name TimeManager
extends RefCounted
## 日数・時間帯・潮汐（第0巻0-3-3／第3巻4-0-5）

var day: int = 1
var slot_idx: int = 0

func slots() -> Array: return Config.get_v("TIME_SLOTS")
func slot() -> String: return slots()[slot_idx]
func is_high_tide() -> bool: return Config.get_v("TIDE_HIGH_SLOTS").has(slot())  # 夕・夜=満潮
func is_night() -> bool: return slot() == "night"

## 時間帯を進める。日をまたぐ必要が生じたら true（end_dayはGameManager経由）
func advance(n: int = 1) -> bool:
	slot_idx += n
	return slot_idx >= slots().size()

func new_day() -> void:
	day += 1
	slot_idx = 0
