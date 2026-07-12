class_name Config
extends RefCounted
## data/config.json のローダ（第14巻18-12が正本。数値のハードコード禁止）

static var _data: Dictionary = {}

static func load_config(path: String = "res://data/config.json") -> void:
	var txt := FileAccess.get_file_as_string(path)
	_data = JSON.parse_string(txt)

static func get_v(key: String) -> Variant: return _data[key]
static func get_i(key: String) -> int: return int(_data[key])
static func get_f(key: String) -> float: return float(_data[key])
