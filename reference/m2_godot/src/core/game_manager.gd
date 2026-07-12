class_name GameManager
extends RefCounted
## DayLoop統括（第16巻20-4-1）：MorningTick→行動→SleepTick→翌日
## M2受け入れ基準：365日を自動スキップしてGO4/GO5が正しく発火すること

const CHAR_IDS := ["renny", "jinpachi", "hyu", "muni", "geru", "neo"]
const GO_LABEL := {
	"TRIBUTE_FIRE": "GO4:火山噴火", "TRIBUTE_WATER": "GO5:島の水没",
	"HOLDER_DEATH": "GO1:保持者死亡"
}

var rng := RandomNumberGenerator.new()
var time := TimeManager.new()
var weather: WeatherManager
var tribute: TributeManager
var status: StatusEffectManager
var hunger := HungerManager.new()
var save: SaveManager
var party: Array = []
var holder: CharacterState
var game_over: String = ""
var ending: bool = false
var explored_today: bool = false
var log: Array = []

func _init(holder_id: String = "hyu", p_seed: int = 1, save_dir: String = "user://saves") -> void:
	rng.seed = p_seed
	weather = WeatherManager.new(rng)
	tribute = TributeManager.new(holder_id)
	status = StatusEffectManager.new(rng)
	save = SaveManager.new(save_dir)
	for cid in CHAR_IDS:
		party.append(CharacterState.new(cid))
	for c in party:
		if c.id == holder_id:
			holder = c
	morning_tick()   # Day1開始処理

func char_by_id(cid: String) -> CharacterState:
	for c in party:
		if c.id == cid:
			return c
	return null

## --- 朝：判定の集中点 ---
func morning_tick() -> void:
	var d := time.day
	# 1) 供物期限（GO4/GO5）
	var reason := tribute.check_morning(d)
	if reason != "":
		_trigger_go(reason)
		return
	# 2) 天候（期限残り2日以内は嵐抑制）
	var suppress := tribute.min_remaining(d) <= Config.get_i("TRIBUTE_STORM_SUPPRESS_DAYS")
	var w := weather.decide(d, suppress)
	log.append("Day%d: 天候=%s 供物残(炎%d/水%d)" % [d, w, tribute.remaining_days("fire", d), tribute.remaining_days("water", d)])
	# 3) 状態異常タイマー
	for ev in status.daily_tick(party):
		_kill(ev["char"], ev["cause"])
	# 4) 空腹
	for ev in hunger.daily_tick(party, explored_today):
		_kill(ev["char"], ev["cause"])
	explored_today = false

func _kill(c: CharacterState, cause: String) -> void:
	if not c.alive:
		return
	c.alive = false
	c.hp = 0
	log.append("  ✝ %s は%sで死亡（除外）" % [c.id, cause])
	if c == holder:
		_trigger_go("HOLDER_DEATH")

func _trigger_go(reason: String) -> void:
	if game_over == "":
		game_over = reason
		log.append("◆ GAME OVER: %s（Day%d）" % [GO_LABEL.get(reason, reason), time.day])

## --- 行動API ---
func explore() -> void:
	explored_today = true
	time.advance(1)

func offer_tribute(goddess: String) -> void:
	tribute.offer(goddess, time.day)

func eat_all() -> void:
	for c in party:
		if c.alive:
			hunger.eat(c)

## --- SleepTick→オートセーブ→翌日 ---
func end_day() -> void:
	if game_over != "" or ending:
		return
	save.autosave(self)
	if time.day >= Config.get_i("DAY_MAX"):
		ending = true
		log.append("★ Day365到達：エンディング判定へ")
		return
	time.new_day()
	morning_tick()

## --- 検証用：365日自動スキップ ---
func simulate(days: int = 365, policy: Callable = Callable()) -> String:
	for i in days:
		if game_over != "" or ending:
			break
		if policy.is_valid():
			policy.call(self)
		end_day()
	if game_over != "":
		return game_over
	return "ENDING" if ending else "RUNNING"
