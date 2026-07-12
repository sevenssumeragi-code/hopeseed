class_name WeatherManager
extends RefCounted
## 天候決定（第14巻18-9）：季節テーブル／嵐翌日晴れ／期限直前の嵐抑制

var rng: RandomNumberGenerator
var today: String = "sunny"
var yesterday: String = ""

func _init(p_rng: RandomNumberGenerator) -> void:
	rng = p_rng

func season(day: int) -> String:
	for s in Config.get_v("WEATHER_SEASONS"):
		if int(s["from_day"]) <= day and day <= int(s["to_day"]):
			return s["name"]
	return "winter"

func decide(day: int, suppress_storm: bool) -> String:
	yesterday = today
	if yesterday == "storm":          # 嵐の翌日は必ず晴れ
		today = "sunny"
		return today
	var table: Dictionary = (Config.get_v("WEATHER_TABLE")[season(day)] as Dictionary).duplicate()
	if suppress_storm:                 # 供物期限残り2日以内は嵐抑制（詰み防止）
		table["sunny"] = float(table["sunny"]) + float(table.get("storm", 0.0))
		table.erase("storm")
	var r := rng.randf()
	var acc := 0.0
	for w in table.keys():
		acc += float(table[w])
		if r <= acc:
			today = w
			return today
	today = "sunny"
	return today
