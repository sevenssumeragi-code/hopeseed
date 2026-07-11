// CraftManager（GDD第16巻20-2）。調理/工作/薬草開発の3種（第0巻0-3-2 拠点フェーズ）。
// 担当キャラのcraft値がskill_req以上で成功（成功率詳細は第7巻未受領【AI提案・要差替】）。

import { DB } from "../dataLoader.js";
import type { GameState } from "../types.js";

export type CraftType = "cook" | "build" | "pharmacy";

export interface CraftResult { ok: boolean; message: string; resultItem?: string; }

export class CraftManager {
  constructor(private gs: GameState) {}

  availableRecipes(type: CraftType, crafterId: string): any[] {
    const skill = DB.characters[crafterId]?.craft[type] ?? 0;
    return (DB.recipes[type] ?? []).filter((r) => r.skill_req <= skill);
  }

  canCraft(recipe: any): boolean {
    return recipe.inputs.every(
      (inp: { item: string; qty: number }) => (this.gs.inventory[inp.item] ?? 0) >= inp.qty,
    );
  }

  craft(type: CraftType, recipeId: string, crafterId: string): CraftResult {
    const recipe = (DB.recipes[type] ?? []).find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, message: "レシピが見つからない。" };
    const skill = DB.characters[crafterId]?.craft[type] ?? 0;
    if (skill < recipe.skill_req) {
      return { ok: false, message: `${DB.characters[crafterId].name}にはまだ難しいようだ。` };
    }
    if (!this.canCraft(recipe)) return { ok: false, message: "素材が足りない。" };

    for (const inp of recipe.inputs) this.gs.inventory[inp.item] -= inp.qty;
    this.gs.inventory[recipe.result] = (this.gs.inventory[recipe.result] ?? 0) + 1;

    if (type === "cook") this.gs.stats.cooked++;
    else if (type === "build") this.gs.stats.built++;
    else this.gs.stats.brewed++;

    const item = DB.items[recipe.result];
    return { ok: true, message: `${item.name}を作った！`, resultItem: recipe.result };
  }
}
