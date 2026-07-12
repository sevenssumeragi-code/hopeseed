# ホープシード M2：時間・サバイバル骨格

GDD第1巻（概要）・第3巻（時間帯/潮汐/天候）・第13巻17章（セーブ）・第14巻（タイマー/確率/config）を実装したコアモジュール。
**受け入れ基準：「365日を自動スキップして供物切れGO4/GO5が正しく発火する」を満たす。**

## 構成
```
hopeseed_m2/
├─ project.godot
├─ data/config.json          # 第14巻18-12（数値は全てここ。コードにハードコード禁止）
├─ src/core/                 # Godot 4 GDScript本実装
│  ├─ config.gd              # configローダ
│  ├─ time_manager.gd        # 日数・4時間帯・潮汐（朝昼=干潮/夕夜=満潮）
│  ├─ weather_manager.gd     # 季節別天候・嵐翌日晴れ・期限直前の嵐抑制
│  ├─ tribute_manager.gd     # 供物14日周期・加護28日・期限超過GO
│  ├─ status_effect_manager.gd # 毒7日/大出血3日/疫病/感染症(伝染)/昏睡 の日次処理
│  ├─ hunger_manager.gd      # 空腹−15%/日(探索−20%)・食事+40%・絶食7日死亡
│  ├─ save_manager.gd        # オートセーブ3世代ローテ＋チェックサム＋安全書き込み
│  ├─ character_state.gd
│  └─ game_manager.gd        # DayLoop統括（MorningTick→行動→SleepTick）
├─ tests/test_m2.gd          # ヘッドレス受け入れテスト（T1〜T10）
└─ reference/                # 検証済みPythonリファレンス（移植原本）
   ├─ m2_core.py
   └─ test_m2.py             # 実行済み・全12テストPASS
```

## テスト実行
```bash
# Godot（要 Godot 4.2+）
godot4 --headless --path . --script tests/test_m2.gd

# Pythonリファレンス（Godot不要・同一ロジックの検証）
python3 reference/test_m2.py
```

## 検証済みの挙動（Pythonリファレンスで実測）
| テスト | 結果 |
|---|---|
| T1 供物を捧げない | Day15の朝にGO4発火（期限=Day14） |
| T2 ジンパチ保持者の炎の加護 | 猶予28日→Day29にGO4 |
| T3 供物12日周期＋毎日食事 | Day365完走→エンディング判定 |
| T4 毒の放置 | 付与から7日目に死亡 |
| T5 大出血の放置 | 付与から3日目に死亡 |
| T6 全員絶食 | 満腹0到達後7日で餓死→保持者死亡GO1 |
| T7 昏睡 | 死亡せず3〜5日で自然回復 |
| T8 潮汐 | 朝昼=干潮／夕夜=満潮 |
| T9 天候 | 嵐翌日は必ず晴れ・供物期限残り2日以内は嵐ゼロ |
| T10 セーブ | auto0〜2の3世代ローテ・チェックサム整合 |
| T11 疫病 | 3日目の重症化率 実測20.6%（設計20%） |

## 次工程（M3）との接続
- `GameManager.explore()` が戦闘フェーズの入口（敵シンボル接触→BattleManagerへ）
- `_kill()` / `_trigger_go()` が戦闘側の死亡・保持者喪失処理と共通化される
- 夜襲・夢魔判定は `end_day()` のSleepTick内にフック済み位置がある（NIGHT_RAID_RATE等はconfigに定義済み）
