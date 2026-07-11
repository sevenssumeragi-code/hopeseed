// ホープシード 型定義
// GDD第16巻20-3(JSONスキーマ)・20-4(状態遷移)・20-5(クラス設計)に対応。

export type TimeSlot = "morning" | "noon" | "evening" | "night";
export type Tide = "low" | "high";
export type Goddess = "fire" | "water";

export type SkillKind = "physical" | "magic" | "support";
export type SkillTarget =
  | "enemy_single" | "enemy_all"
  | "ally_single" | "ally_all" | "self";

// 第16巻20-3-2 effects.type 列挙(1対1)
export type EffectType =
  | "buff" | "debuff" | "poison" | "burn" | "bleed" | "paralysis"
  | "plague" | "heal" | "cure" | "protect_rate" | "crit_bonus"
  | "anti_demon" | "night_bonus" | "hp_scaling" | "instant_death"
  | "possess" | "coma_battle";

export interface SkillEffect {
  type: EffectType;
  chance?: number;
  stats?: string[];
  stage?: number;
  turns?: number;
  ratio?: number;   // heal 割合
  amount?: number;  // crit_bonus 等
  mult?: number;    // night_bonus / anti_demon
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
  craft: { cook: number; build: number; pharmacy: number };
  weakness: { type: string; detail: string };
  ability_battle: Record<string, unknown> & { id: string };
  ability_holder: Record<string, unknown> & { id: string };
  skills: string[];
  weapon_type: string;
  route_id: string | null;
}

export type ExclusionKind = "none" | "dead" | "kidnapped" | "betrayal" | "coma";

export interface StatusState {
  poison?: number;   // 残り日数
  bleed?: number;
  plague?: number;   // 重症化進行度(0..1) 実装では発症日数で管理
  paralysis?: number;
  plague_chance?: number;
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
  // 戦闘中バフ段階(-2..+2)
  buffs: Record<string, number>;
  equippedWeapon: string | null;
  downed: boolean; // 戦闘不能(HP0)。戦闘終了時にdead確定
}

export interface EnemyDef {
  name: string;
  family: string;
  boss?: boolean;
  base: { hp: number; atk: number; def: number; spd: number; skl: number; eva: number };
  ai: string;
  exp_base: number;
  weakness?: string;
  tide_exempt?: boolean;
  victory?: string;
  skills: EnemySkill[];
  drops: { item: string; rate: number }[];
  spawn?: { areas: string[]; time: string; tide_multiplier?: number };
  location?: string;
}

export interface EnemySkill {
  name: string;
  accuracy: number;
  power: number | null;
  target?: string;
  condition?: string;
  effects: SkillEffect[];
}

export interface EnemyState {
  id: string;
  def: EnemyDef;
  hp: number;
  maxHp: number;
  buffs: Record<string, number>;
  status: StatusState;
  alive: boolean;
}

export interface ItemDef {
  name: string;
  category: string;
  family?: string;
  desc: string;
  hunger_restore?: number;
  hp_restore?: number;
  sp_restore?: number;
  cure?: string[];
  revive?: boolean;
  weapon_type?: string;
  atk_bonus?: number;
}

export interface MapDef {
  name: string;
  area_type: string;
  size: [number, number];
  encounter_rate: number;
  enemies: string[];
  night_enemies?: string[];
  gather: { item: string; rate: number }[];
  connections: string[];
  is_base?: boolean;
  tidal?: boolean;
  has_shrine?: Goddess;
  boss?: string;
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

export interface GameState {
  day: number;
  slot: TimeSlot;
  tide: Tide;
  weather: string;
  holder: string;
  location: string;
  party: Record<string, CharacterState>;
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  trust: Record<string, number>;
  tribute: { fireLastDay: number; waterLastDay: number };
  hunger: number;
  starvingDays: number;
  reviveLastDay: number;
  stats: {
    battlesWon: number; cooked: number; built: number; brewed: number;
    revived: number; protectSuccess: number;
  };
  achievements: string[];
  gameOver: GOReason | null;
  rngSeed: number;
  version: number;
}
