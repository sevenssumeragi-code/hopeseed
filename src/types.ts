// ホープシード 型定義
// GDD第16巻20-3/20-4/20-5 + 第5〜8巻・第14巻の正データ対応版。

export type TimeSlot = "morning" | "noon" | "evening" | "night";
export type Tide = "low" | "high";
export type Goddess = "fire" | "water";

export type SkillKind = "physical" | "magic" | "support" | "heal";
export type SkillTarget =
  | "enemy_single" | "enemy_all"
  | "ally_single" | "ally_all" | "self" | "holder";

// 第6巻7-0-1 効果対応表 + 第8巻敵特殊効果
export type EffectType =
  | "buff" | "debuff" | "ally_buff" | "self_buff"
  | "poison" | "burn" | "bleed" | "paralysis" | "plague"
  | "heal" | "cure" | "protect_rate" | "crit_bonus"
  | "anti_demon" | "night_bonus" | "hp_scaling" | "instant_death"
  | "hit_debuff" | "lifesteal" | "self_status_bonus" | "poison_target_bonus"
  | "party_attack" | "possess" | "kidnap" | "sleep_skip" | "summon" | "hope_devour";

export interface SkillEffect {
  type: EffectType;
  chance?: number;
  stats?: string[];
  stage?: number;
  turns?: number;
  coef?: number;      // heal: 技量×coef（第6巻7-0-2）
  amount?: number;    // crit_bonus / protect_rate / hit_debuff
  mult?: number;      // night_bonus / anti_demon / hp_scaling / poison_target_bonus / self_status_bonus
  mode?: string;      // hp_scaling: below_half / missing
  ratio?: number;     // lifesteal
  statuses?: string[]; // cure対象
  condition?: string;
  enemy?: string;     // summon
  count?: number;
  guard_negates?: boolean;
  protect_negates?: boolean;
  renny_immune?: boolean;
}

export interface Skill {
  name: string;
  owner: string;
  learn_lv: number;
  kind: SkillKind;
  target: SkillTarget;
  accuracy: number;
  power: number | null;
  hits?: number;
  sp_cost: number;
  effects: SkillEffect[];
  desc: string;
  song_id?: string;
}

export interface StatBlock {
  hp: number; sp: number; atk: number; def: number;
  spd: number; skl: number; eva: number; crit: number;
  mag: number | null;
}

export interface CharacterDef {
  name: string;
  pronoun: string;
  hidden?: boolean;
  base: StatBlock;
  growth: StatBlock;
  derived?: Record<string, [string, number]>;   // 女神(第5巻6-7)
  crit_formula?: { base: number; per_lv: number };
  join_min_lv?: number;
  craft: { cook: number; build: number; pharmacy: number };
  weakness: { battle_family: string | null; type: string; detail: string };
  ability_battle: Record<string, unknown> & { id: string };
  ability_holder: Record<string, unknown> & { id: string };
  ability_passive?: Record<string, unknown> & { id: string };
  weapon_type: string;
  initial_weapon?: string;
  route_id: string | null;
}

export type ExclusionKind = "none" | "dead" | "kidnapped" | "betrayal" | "coma";

// 状態異常（第14巻18-4タイマー管理）
export interface StatusState {
  poison?: number;            // 残り日数(7)
  burn?: number;              // 残り日数(7)・作業不可
  bleed?: number;             // 残り日数(3)・作業不可・拠点治療のみ
  paralysis?: number;         // 残りターン(戦闘)／日(移動リスク)
  plagueDay?: number;         // 発症からの日数
  plagueSevereDays?: number;  // 重症化してからの日数
  infectDay?: number;
  infectSevereDays?: number;
  obesityPlainDays?: number;  // 肥満: 粗食日数(7で解消)
  obesity?: boolean;
}

export interface CharacterState {
  id: string;
  level: number;
  exp: number;
  hp: number;
  sp: number;
  maxHp: number;
  maxSp: number;
  exclusion: ExclusionKind;
  comaDaysLeft: number;
  betrayalDaysLeft: number;
  status: StatusState;
  buffs: Record<string, number>;       // 段階 -2..+2
  buffTurns: Record<string, number>;   // 残ターン
  hitDebuff: number;                   // 命中低下%(残ターンはhitDebuffTurns)
  hitDebuffTurns: number;
  protectRateBuff: number;             // 庇う成功率補正%
  protectRateTurns: number;
  satiety: number;                     // 空腹ゲージ(キャラ個別・M2仕様)
  starveDays: number;                  // 満腹0の連続日数(7で餓死)
  atkBuffNextBattle: number;           // 海賊風煮込み
  equippedWeapon: string | null;
  downed: boolean;
}

export interface EnemyDef {
  name: string;
  family: string;
  boss?: boolean;
  base?: { hp: number; atk: number; def: number; spd: number; skl: number; eva: number };
  min_lv?: number;
  hp_fixed?: number;
  stat_ref?: string;
  stat_mult?: Record<string, number>;
  ai: string;
  ai_plan?: Record<string, unknown> & { type: string };
  exp_base: number;
  tide_exempt?: boolean;
  light_damage_mult?: number;
  victory?: string;
  unlock?: Record<string, unknown>;
  special_rule?: Record<string, unknown>;
  on_defeat?: Record<string, unknown>;
  skills: EnemySkill[];
  drops: { item: string; rate: number }[];
  silver?: [number, number];
  silver_reward?: number;
  spawn?: {
    areas: string[]; time?: string; tide_multiplier?: number;
    from_day?: number; stationary?: boolean;
  };
  location?: string;
}

export interface EnemySkill {
  name: string;
  accuracy: number;
  power: number | null;
  hits?: number;
  target?: string;
  condition?: string;
  cooldown?: number;
  once?: boolean;
  telegraph?: string;
  effects: SkillEffect[];
}

export interface EnemyState {
  id: string;
  defId: string;
  tamedTurns?: number;          // 手なずけ残ターン(第4巻5-4-7)
  def: EnemyDef;
  level: number;
  hp: number;
  maxHp: number;
  atk: number; defStat: number; spd: number; skl: number; eva: number;
  buffs: Record<string, number>;
  status: StatusState;
  alive: boolean;
  cooldowns: Record<string, number>;
  usedOnce: Set<string>;
  telegraphed: string | null;   // 予告中の技名
}

export interface ItemDef {
  name: string;
  category: string;
  family?: string;
  sell?: number | null;
  desc: string;
  dish?: boolean;
  great_name?: string;
  special?: Record<string, unknown>;
  craft_bonus?: number;
  raw_edible?: { hp_ratio: number };
  raw_risk?: Record<string, number>;
  cure?: string[];
  field_only?: boolean;
  weapon_type?: string;
  tier?: number;
  atk_bonus?: number;
  mag_bonus?: number;
  protect_bonus?: number;
  effect?: Record<string, unknown>;
  catalyst?: { recipe: string; bonus: number };
}

export interface MapDef {
  name: string;
  area_type: string;
  size: [number, number];
  density_day: number;
  density_night: number;
  enemies: string[];
  night_enemies?: string[];
  night_no_pirates?: boolean;
  night_fireball_bonus?: number;   // 夜の火の玉密度+30%（第3巻4-2）
  ash_density_bonus?: number;      // 火山灰で敵密度+20%（第3巻4-2）
  no_respawn?: boolean;
  gather: { item: string; rate: number; respawn?: string; low_tide_only?: boolean; risk_battle?: number }[];
  connections: string[];
  costs: Record<string, number>;   // 移動コスト(時間帯・第3巻4-0-2。0.5は2回で1)
  is_base?: boolean;
  tidal?: boolean;
  high_tide_timer_sec?: number;    // 満潮滞在制限（第3巻4-0-5: 90秒）
  low_tide_only_to?: string[];     // 干潮時のみ通行可能な接続先（第3巻4-0-2）
  has_shrine?: Goddess;
  boss?: string;
  drift_point?: boolean;           // 漂着物ポイント（第3巻4-8）
  fishing?: boolean;               // 釣り可能（第3巻4-4/4-9・釣り竿所持で解放）
  lava_hazard?: boolean;           // 溶岩流（第3巻4-1）
  rockfall?: boolean;              // 落石地帯（第3巻4-2）
  fire_grace?: boolean;            // 炎の女神の加護演出（第3巻4-2）
  fog_wander?: boolean;            // 霧で迷う（第3巻4-4）
  sanctuary?: boolean;             // 聖域（敵なし）
  sea_area?: boolean;              // 嵐で進入不可（第3巻4-0-4）
  paralysis_death_zone?: boolean;
  paralysis_death_zone_high_tide?: boolean;
  requires_for?: Record<string, string>;
}

export interface ScenarioEvent {
  id: string;
  trigger: {
    day_min?: number; day_max?: number;
    location?: string; slot?: string[];
    flags_all?: string[]; flags_none?: string[];
    trust_min?: number;
  };
  requires_alive?: string[];
  variants: { key: string; cond: string; text: string }[];
  rewards?: { trust?: { pair: string; amount: number }[] };
  sets_flags?: string[];
  pair?: string;
  core?: boolean;
}

export type GOReason =
  | "holder_death" | "holder_kidnap" | "holder_possess"
  | "tribute_fire_expired" | "tribute_water_expired";

export type FoodQuality = "great" | "normal" | "poor";

export interface FoodStockEntry {
  dishId: string;
  quality: FoodQuality;
  madeDay: number;
}

export interface GameState {
  day: number;
  slot: TimeSlot;
  tide: Tide;
  weather: string;
  prevWeather: string;
  holder: string;
  location: string;
  party: Record<string, CharacterState>;
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  foodStock: FoodStockEntry[];
  silver: number;
  trust: Record<string, number>;
  tribute: {
    fireLastDay: number; waterLastDay: number;
    fireCount: number; waterCount: number;
  };
  exploredToday: boolean;
  reviveLastDay: number;
  stats: {
    battlesWon: number; cooked: number; built: number; brewed: number;
    revived: number; protectSuccess: number;
    sharkKills: number; comaTotal: number;
  };
  achievements: string[];
  protectCounts: Record<string, number>;   // 庇う成功回数 "from>to"（第4巻5-4-4）
  halfTimeAccrued: boolean;                // 0.5時間帯コストの繰越（第3巻4-0-2）
  lastDriftDay: number;                    // 漂着物の最終取得日（第3巻4-8: 毎日1回）
  gameOver: GOReason | null;
  rngSeed: number;
  version: number;
}
