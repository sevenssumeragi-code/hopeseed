# -*- coding: utf-8 -*-
"""
ホープシード M2リファレンス実装（Python）
- GDD第1・3・13・14巻の「時間・サバイバル骨格」を忠実に実装
- 目的：GDScript移植前のロジック検証（tests参照）
- 乱数はシード指定で再現可能
"""
import json, random, hashlib, os

CFG = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "config.json"), encoding="utf-8"))

GO = {"TRIBUTE_FIRE": "GO4:火山噴火", "TRIBUTE_WATER": "GO5:島の水没",
      "HOLDER_DEATH": "GO1:保持者死亡"}

CHAR_IDS = ["renny", "jinpachi", "hyu", "muni", "geru", "neo"]

# ---------- キャラ状態（M2で必要な最小限） ----------
class CharacterState:
    def __init__(self, cid, hp_max=100):
        self.id = cid
        self.hp_max = hp_max
        self.hp = hp_max
        self.alive = True          # False = 死亡（除外）
        self.satiety = 100.0       # 空腹ゲージ
        self.starve_days = 0
        self.effects = {}          # {"poison": {"days":0, "severe":False, "severe_days":0}, ...}

    def add_effect(self, name, rng=None):
        if name in self.effects: 
            self.effects[name]["days"] = 0  # 再付与は持続リセット（第4巻）
            return
        e = {"days": 0, "severe": False, "severe_days": 0}
        if name == "coma":
            e["recover_at"] = rng.randint(CFG["COMA_RECOVER_MIN_DAYS"], CFG["COMA_RECOVER_MAX_DAYS"])
        self.effects[name] = e

    def cure(self, name):
        self.effects.pop(name, None)

# ---------- 時間 ----------
class TimeManager:
    SLOTS = None
    def __init__(self):
        TimeManager.SLOTS = CFG["TIME_SLOTS"]
        self.day = 1
        self.slot_idx = 0
    @property
    def slot(self): return self.SLOTS[self.slot_idx]
    def is_high_tide(self): return self.slot in CFG["TIDE_HIGH_SLOTS"]   # 夕・夜=満潮（第3巻）
    def is_night(self): return self.slot == "night"
    def advance(self, slots=1):
        """時間帯を進める。日をまたぐ場合はTrueを返す（end_dayはGameManager経由）"""
        self.slot_idx += slots
        return self.slot_idx >= len(self.SLOTS)
    def new_day(self):
        self.day += 1
        self.slot_idx = 0

# ---------- 天候（第14巻18-9） ----------
class WeatherManager:
    def __init__(self, rng):
        self.rng = rng
        self.today = "sunny"
        self.yesterday = None
    def season(self, day):
        for s in CFG["WEATHER_SEASONS"]:
            if s["from_day"] <= day <= s["to_day"]: return s["name"]
        return "winter"
    def decide(self, day, suppress_storm):
        self.yesterday = self.today
        if self.yesterday == "storm":            # 嵐の翌日は必ず晴れ
            self.today = "sunny"; return self.today
        table = dict(CFG["WEATHER_TABLE"][self.season(day)])
        if suppress_storm:                        # 供物期限直前は嵐を抑制（詰み防止）
            table["sunny"] += table.pop("storm", 0.0)
        r = self.rng.random(); acc = 0.0
        for w, p in table.items():
            acc += p
            if r <= acc: self.today = w; return self.today
        self.today = "sunny"; return self.today

# ---------- 供物（第1巻2-2／第14巻） ----------
class TributeManager:
    def __init__(self, holder_id):
        self.holder_id = holder_id
        self.last_offer = {"fire": 0, "water": 0}   # Day0=漂着時に女神へ挨拶済み扱い
        self.consecutive = {"fire": 0, "water": 0}
    def interval(self, goddess):
        grace = CFG["HOLDER_TRIBUTE_GRACE"].get(self.holder_id)
        return CFG["TRIBUTE_INTERVAL_GRACE"] if grace == goddess else CFG["TRIBUTE_INTERVAL"]
    def remaining_days(self, goddess, day):
        return self.last_offer[goddess] + self.interval(goddess) - day
    def offer(self, goddess, day):
        self.last_offer[goddess] = day
        self.consecutive[goddess] += 1
    def check_morning(self, day):
        """期限超過チェック。超過した女神のGO理由を返す（無ければNone）"""
        if self.remaining_days("fire", day) < 0:  return "TRIBUTE_FIRE"
        if self.remaining_days("water", day) < 0: return "TRIBUTE_WATER"
        return None
    def min_remaining(self, day):
        return min(self.remaining_days("fire", day), self.remaining_days("water", day))

# ---------- 状態異常デイリー処理（第14巻18-4） ----------
class StatusEffectManager:
    def __init__(self, rng): self.rng = rng
    def daily_tick(self, party):
        deaths = []
        infected_exists = any("infection" in c.effects for c in party if c.alive)
        for c in party:
            if not c.alive: continue
            for name in list(c.effects.keys()):
                e = c.effects[name]; e["days"] += 1; d = e["days"]
                if name == "poison" and d >= CFG["POISON_DAYS"]: deaths.append((c, "毒の放置"))
                elif name == "burn" and d >= CFG["BURN_DAYS"]: deaths.append((c, "大火傷の放置"))
                elif name == "bleed" and d >= CFG["BLEED_DAYS"]: deaths.append((c, "大出血の放置"))
                elif name == "plague":
                    if e["severe"]:
                        e["severe_days"] += 1
                        if e["severe_days"] >= CFG["PLAGUE_SEVERE_DEATH_DAYS"]: deaths.append((c, "疫病の重症化"))
                    elif d >= CFG["PLAGUE_SEVERE_START_DAY"]:
                        p = CFG["PLAGUE_SEVERE_BASE"] + CFG["PLAGUE_SEVERE_STEP"] * (d - CFG["PLAGUE_SEVERE_START_DAY"])
                        if self.rng.random() < p: e["severe"] = True
                elif name == "infection":
                    if e["severe"]:
                        e["severe_days"] += 1
                        if e["severe_days"] >= CFG["INFECT_SEVERE_DEATH_DAYS"]: deaths.append((c, "感染症の重症化"))
                    elif d >= CFG["INFECT_SEVERE_START_DAY"]:
                        p = CFG["INFECT_SEVERE_BASE"] + CFG["INFECT_SEVERE_STEP"] * (d - CFG["INFECT_SEVERE_START_DAY"])
                        if self.rng.random() < p: e["severe"] = True
                elif name == "coma" and d >= e["recover_at"]:
                    c.cure("coma")
        # 感染症の伝染（未治療者がいる間、毎日10%で味方1人へ）
        if infected_exists and self.rng.random() < CFG["INFECT_SPREAD_RATE"]:
            targets = [c for c in party if c.alive and "infection" not in c.effects]
            if targets: self.rng.choice(targets).add_effect("infection")
        return deaths

# ---------- 空腹（第14巻18-4） ----------
class HungerManager:
    def daily_tick(self, party, explored_today):
        deaths = []
        decay = CFG["HUNGER_DECAY_EXPLORE"] if explored_today else CFG["HUNGER_DECAY_BASE"]
        for c in party:
            if not c.alive: continue
            c.satiety = max(0.0, c.satiety - decay)
            if c.satiety <= 0:
                c.starve_days += 1
                c.hp = max(1, int(c.hp - c.hp_max * CFG["HUNGER_ZERO_HP_LOSS"]))
                if c.starve_days >= CFG["STARVE_DAYS"]: deaths.append((c, "飢餓"))
            else:
                c.starve_days = 0
        return deaths
    def eat(self, char): char.satiety = min(100.0, char.satiety + CFG["HUNGER_MEAL_RECOVER"])

# ---------- セーブ（第13巻17章：3世代ローテ＋チェックサム） ----------
class SaveManager:
    def __init__(self, save_dir):
        self.dir = save_dir; os.makedirs(save_dir, exist_ok=True)
        self.rotation = 0
    def snapshot(self, gm):
        return {"meta": {"day": gm.time.day, "slot": gm.time.slot, "weather": gm.weather.today},
                "party": [{"id": c.id, "hp": c.hp, "alive": c.alive, "satiety": c.satiety,
                           "effects": c.effects} for c in gm.party],
                "world": {"tribute_last": gm.tribute.last_offer, "holder": gm.tribute.holder_id}}
    def autosave(self, gm):
        slot = self.rotation % CFG["AUTOSAVE_SLOTS"]; self.rotation += 1
        body = json.dumps(self.snapshot(gm), ensure_ascii=False, sort_keys=True)
        payload = {"checksum": hashlib.md5(body.encode()).hexdigest(), "body": body}
        path = os.path.join(self.dir, f"auto{slot}.json")
        tmp = path + ".tmp"
        open(tmp, "w", encoding="utf-8").write(json.dumps(payload, ensure_ascii=False))
        os.replace(tmp, path)   # 安全書き込み
        return path
    def load(self, slot):
        payload = json.load(open(os.path.join(self.dir, f"auto{slot}.json"), encoding="utf-8"))
        assert hashlib.md5(payload["body"].encode()).hexdigest() == payload["checksum"], "セーブ破損"
        return json.loads(payload["body"])

# ---------- ゲーム統括（DayLoop：第16巻20-4-1） ----------
class GameManager:
    def __init__(self, holder_id="hyu", seed=1, save_dir="/tmp/hs_save"):
        self.rng = random.Random(seed)
        self.time = TimeManager()
        self.weather = WeatherManager(self.rng)
        self.tribute = TributeManager(holder_id)
        self.status = StatusEffectManager(self.rng)
        self.hunger = HungerManager()
        self.save = SaveManager(save_dir)
        self.party = [CharacterState(cid) for cid in CHAR_IDS]
        self.holder = next(c for c in self.party if c.id == holder_id)
        self.game_over = None
        self.ending = False
        self.log = []
        self.explored_today = False
        self.morning_tick()  # Day1 開始処理

    def char(self, cid): return next(c for c in self.party if c.id == cid)

    # --- 朝：判定の集中点 ---
    def morning_tick(self):
        d = self.time.day
        # 1) 供物期限（GO4/GO5）
        reason = self.tribute.check_morning(d)
        if reason: return self._go(reason)
        # 2) 天候（期限残り2日以内は嵐抑制＝第14巻18-9）
        suppress = self.tribute.min_remaining(d) <= CFG["TRIBUTE_STORM_SUPPRESS_DAYS"]
        w = self.weather.decide(d, suppress)
        self.log.append(f"Day{d}: 天候={w} 供物残(炎{self.tribute.remaining_days('fire', d)}/水{self.tribute.remaining_days('water', d)})")
        # 3) 状態異常タイマー
        for c, cause in self.status.daily_tick(self.party): self._kill(c, cause)
        # 4) 空腹
        for c, cause in self.hunger.daily_tick(self.party, self.explored_today): self._kill(c, cause)
        self.explored_today = False

    def _kill(self, c, cause):
        if not c.alive: return
        c.alive = False; c.hp = 0
        self.log.append(f"  ✝ {c.id} は{cause}で死亡（除外）")
        if c is self.holder: self._go("HOLDER_DEATH")

    def _go(self, reason):
        if self.game_over is None:
            self.game_over = reason
            self.log.append(f"◆ GAME OVER: {GO.get(reason, reason)}（Day{self.time.day}）")
        return reason

    # --- 行動API（M2の外部インターフェース） ---
    def explore(self): self.explored_today = True; self.time.advance(1)
    def offer_tribute(self, goddess): self.tribute.offer(goddess, self.time.day)
    def eat_all(self):
        for c in self.party:
            if c.alive: self.hunger.eat(c)

    def end_day(self):
        """SleepTick→オートセーブ→翌日morning_tick"""
        if self.game_over or self.ending: return
        self.save.autosave(self)
        if self.time.day >= CFG["DAY_MAX"]:
            self.ending = True; self.log.append("★ Day365到達：エンディング判定へ"); return
        self.time.new_day()
        self.morning_tick()

    # --- 検証用：365日自動スキップ（受け入れ基準M2） ---
    def simulate(self, days=365, policy=None):
        for _ in range(days):
            if self.game_over or self.ending: break
            if policy: policy(self)
            self.end_day()
        return self.game_over or ("ENDING" if self.ending else "RUNNING")
