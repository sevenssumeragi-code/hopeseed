class_name SaveManager
extends RefCounted
## セーブ（第13巻17章）：3世代ローテ／チェックサム／安全書き込み

var dir: String
var rotation: int = 0

func _init(p_dir: String = "user://saves") -> void:
	dir = p_dir
	DirAccess.make_dir_recursive_absolute(dir)

func snapshot(gm) -> Dictionary:
	var party_arr: Array = []
	for c in gm.party:
		party_arr.append({"id": c.id, "hp": c.hp, "alive": c.alive, "satiety": c.satiety, "effects": c.effects})
	return {
		"meta": {"day": gm.time.day, "slot": gm.time.slot(), "weather": gm.weather.today},
		"party": party_arr,
		"world": {"tribute_last": gm.tribute.last_offer, "holder": gm.tribute.holder_id}
	}

func autosave(gm) -> String:
	var slot := rotation % Config.get_i("AUTOSAVE_SLOTS")
	rotation += 1
	var body := JSON.stringify(snapshot(gm), "", false)
	var payload := {"checksum": body.md5_text(), "body": body}
	var path := "%s/auto%d.json" % [dir, slot]
	var tmp := path + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	f.store_string(JSON.stringify(payload))
	f.close()
	DirAccess.rename_absolute(ProjectSettings.globalize_path(tmp), ProjectSettings.globalize_path(path))   # 安全書き込み
	return path

func load_slot(slot: int) -> Dictionary:
	var path := "%s/auto%d.json" % [dir, slot]
	var payload: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
	assert(String(payload["body"]).md5_text() == String(payload["checksum"]), "セーブ破損")
	return JSON.parse_string(payload["body"])
