# reference/

## m2_godot/
通常Chatで作成されたM2成果物（Godot 4 GDScript実装＋Pythonリファレンス）。
本プロジェクト（Web/TypeScript版）へは以下を反映済み:
- 空腹ゲージのキャラ個別管理（satiety/starveDays）
- 供物期限の起点=Day0（供物ゼロ→Day15朝にGO4/GO5）
- 感染症伝染のグローバル日次判定（感染者がいる限り1日10%で1人へ）
- 受け入れテストT1〜T11の移植（tests/run.ts の[M2移植]セクション）
GDScript側は将来のGodot移植時の原本として保存。
