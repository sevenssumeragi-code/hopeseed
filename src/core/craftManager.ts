// CraftManager（第7巻9章・正本）。
// 品質判定式(9-0-1): 適性 = craft値 + ゲル保持者15 + ムニ同行5 + レシピ補正 − 疫病20
//   大成功: roll ≤ 適性×0.35 ／ 失敗: roll > 100 − max(5, 40 − 適性×0.35)
// 成果(9-0-2): 調理=品質3種／工作=大成功で素材1種返却・失敗で素材消失／薬草=大成功2個・失敗で薬草消失
// 治療(9-4): 処置(大出血・拠点限定)・看病。

import { DB } from "../dataLoader.js";
import type { RNG } from "./rng.js";
import type { GameState, FoodQuality } from "../types.js";

export type CraftType = "cook" | "build" | "pharmacy";
export type CraftGrade = "great" | "success" | "fail";

export interface CraftResult {
  ok: boolean;
  grade?: CraftGrade;
  message: string;
  resultItem?: string;
  quality?: FoodQuality;
}

export class CraftManager {
  constructor(private gs: GameState, private rng: RNG) {}

  // 適性値（9-0-1）
  aptitude(type: CraftType, crafterId: string, recipeBonus = 0): number {
    const c = this.gs.party[crafterId];
    let apt = (DB.characters[crafterId]?.craft[type] ?? 0) + recipeBonus;
    if (this.gs.holder === "geru") apt += DB.config.craft.geru_holder_bonus;   // マルチタスク
    const muni = this.gs.party["muni"];
    if (muni && muni.exclusion === "none" && muni.comaDaysLeft === 0 && crafterId !== "muni") {
      apt += DB.config.craft.muni_assist_bonus;                                 // ムニ同行
    }
    if (c && c.status.plagueDay !== undefined) apt -= DB.config.status_timers.plague_craft_penalty;
    // 個人イベント: ジンパチ「肉の焼き方」調理+5／ゲル「薬草ノート」薬学+5（第2巻）
    if (crafterId === "jinpachi" && type === "cook" && this.gs.flags["eff_jinpachi_cook_up"]) apt += 5;
    if (crafterId === "geru" && type === "pharmacy" && this.gs.flags["eff_geru_pharmacy_up"]) apt += 5;
    if (this.gs.weather === "rain") apt += 5; // 雨の日は作業に最適（第3巻4-5【AI提案】）
    return apt;
  }

  judge(apt: number): CraftGrade {
    const roll = this.rng.int(1, 100);
    const greatLine = apt * DB.config.craft.great_coef;
    const failLine = 100 - Math.max(DB.config.craft.fail_floor, DB.config.craft.fail_base - greatLine);
    if (roll <= greatLine) return "great";
    if (roll > failLine) return "fail";
    return "success";
  }

  // 大火傷・大出血のキャラは作業不可（第7巻9-0）
  canWork(crafterId: string): boolean {
    const c = this.gs.party[crafterId];
    if (!c || c.exclusion !== "none" || c.comaDaysLeft > 0) return false;
    return c.status.burn === undefined && c.status.bleed === undefined;
  }

  availableRecipes(type: CraftType, crafterId: string): any[] {
    const skill = DB.characters[crafterId]?.craft[type] ?? 0;
    return (DB.recipes[type] ?? []).filter((r) => {
      if (r.skill_req > skill) return false;             // 適性未満は選択不可（9-3）
      if (r.for && r.for !== crafterId && type === "build") return true; // 武器は他人の分も作れる
      return true;
    });
  }

  canCraft(recipe: any): boolean {
    return recipe.inputs.every(
      (inp: { item: string; qty: number }) => (this.gs.inventory[inp.item] ?? 0) >= inp.qty,
    );
  }

  // 成功率プレビュー（第13巻16-7: 実行キャラ切替でリアルタイム再計算）
  ratesFor(type: CraftType, crafterId: string, recipe: any): { great: number; success: number; fail: number } {
    let bonus = recipe?.craft_bonus ?? 0;
    if (recipe?.catalyst && (this.gs.inventory[recipe.catalyst.item] ?? 0) > 0) {
      bonus += recipe.catalyst.bonus;
    }
    const apt = this.aptitude(type, crafterId, bonus);
    const greatLine = apt * DB.config.craft.great_coef;
    const failPct = Math.max(DB.config.craft.fail_floor, DB.config.craft.fail_base - greatLine);
    const great = Math.min(100, Math.max(0, greatLine));
    const fail = Math.min(100 - great, failPct);
    return { great: Math.round(great), success: Math.round(100 - great - fail), fail: Math.round(fail) };
  }

  // ひらめき（第7巻9-3: 素材が揃った状態で調合台を調べると解放）
  isRecipeKnown(recipe: any): boolean {
    if (this.gs.flags[`recipe_known_${recipe.id}`]) return true;
    if (this.canCraft(recipe)) {
      this.gs.flags[`recipe_known_${recipe.id}`] = true;
      return true;
    }
    return false;
  }

  craft(type: CraftType, recipeId: string, crafterId: string): CraftResult {
    const recipe = (DB.recipes[type] ?? []).find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, message: "レシピが見つからない。" };
    if (!this.canWork(crafterId)) {
      return { ok: false, message: `${DB.characters[crafterId].name}は今、作業ができる状態ではない。` };
    }
    const skill = DB.characters[crafterId]?.craft[type] ?? 0;
    if (skill < recipe.skill_req) {
      return { ok: false, message: `${DB.characters[crafterId].name}にはまだ難しいようだ。` };
    }
    if (!this.canCraft(recipe)) return { ok: false, message: "素材が足りない。" };

    // 触媒（硫黄/聖なる水: 所持していれば自動使用・判定ボーナス）
    let bonus = recipe.craft_bonus ?? 0;
    if (recipe.catalyst && (this.gs.inventory[recipe.catalyst.item] ?? 0) > 0) {
      this.gs.inventory[recipe.catalyst.item]--;
      bonus += recipe.catalyst.bonus;
    }

    for (const inp of recipe.inputs) this.gs.inventory[inp.item] -= inp.qty;

    const grade = this.judge(this.aptitude(type, crafterId, bonus));
    const name = DB.characters[crafterId].name;
    const itemName = DB.items[recipe.result]?.name ?? recipe.result;

    if (type === "cook") {
      this.gs.stats.cooked++;
      const quality: FoodQuality = grade === "great" ? "great" : grade === "success" ? "normal" : "poor";
      this.gs.foodStock.push({ dishId: recipe.result, quality, madeDay: this.gs.day });
      const label = quality === "great"
        ? `${name}は料理を作った！　……大成功だ！　「${DB.items[recipe.result].great_name}」`
        : quality === "normal"
          ? `${name}は${itemName}を作った。`
          : `${name}の料理は、かろうじて食べられる何かになった。`;
      return { ok: true, grade, quality, message: label, resultItem: recipe.result };
    }

    if (type === "build") {
      if (grade === "fail") {
        this.gs.stats.built++;
        return { ok: true, grade, message: `${name}の工作は失敗し、素材が壊れてしまった…` };
      }
      this.gs.inventory[recipe.result] = (this.gs.inventory[recipe.result] ?? 0) + 1;
      this.gs.stats.built++;
      if (grade === "great" && recipe.inputs.length > 0) {
        const back = recipe.inputs[0];
        this.gs.inventory[back.item] = (this.gs.inventory[back.item] ?? 0) + 1;
        return { ok: true, grade, message: `${name}は${itemName}を完成させた！　大成功で${DB.items[back.item].name}が残った！`, resultItem: recipe.result };
      }
      return { ok: true, grade, message: `${name}は${itemName}を完成させた。`, resultItem: recipe.result };
    }

    // pharmacy
    this.gs.stats.brewed++;
    if (grade === "fail") {
      return { ok: true, grade, message: `${name}の調合は失敗し、薬草が無駄になった…` };
    }
    const count = grade === "great" ? 2 : 1;
    this.gs.inventory[recipe.result] = (this.gs.inventory[recipe.result] ?? 0) + count;
    return {
      ok: true, grade,
      message: grade === "great"
        ? `${name}は薬剤を調合、開発した。大成功で${itemName}が2つできた！`
        : `${name}は薬剤を調合、開発した。（${itemName}）`,
      resultItem: recipe.result,
    };
  }

  // 処置（大出血・拠点限定・9-4）: 分野適性=薬学。成功で解除(HP−5%)・大成功で無傷解除
  treatBleed(healerId: string, patientId: string): CraftResult {
    const patient = this.gs.party[patientId];
    if (!patient || patient.status.bleed === undefined) {
      return { ok: false, message: "処置の必要はないようだ。" };
    }
    if (!this.canWork(healerId)) {
      return { ok: false, message: `${DB.characters[healerId].name}は処置ができる状態ではない。` };
    }
    const grade = this.judge(this.aptitude("pharmacy", healerId));
    const hName = DB.characters[healerId].name;
    const pName = DB.characters[patientId].name;
    if (grade === "fail") {
      return { ok: true, grade, message: `${hName}の処置は失敗した…（再試行できる）` };
    }
    delete patient.status.bleed;
    if (grade === "success") {
      patient.hp = Math.max(1, patient.hp - Math.round(patient.maxHp * DB.config.craft.treatment_pain_hp));
      return { ok: true, grade, message: `${hName}は${pName}の傷を縫い合わせた。（痛みでHPが少し減った）` };
    }
    return { ok: true, grade, message: `${hName}の見事な処置で${pName}の出血が止まった！` };
  }
}
