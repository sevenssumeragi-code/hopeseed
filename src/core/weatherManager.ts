// WeatherManager（GDD第16巻20-2）。MorningTickで当日の天候を抽選（weather.json駆動）。

import { DB } from "../dataLoader.js";
import type { RNG } from "./rng.js";

export class WeatherManager {
  rollDaily(rng: RNG): string {
    const types = DB.weather.types as Record<string, { weight: number }>;
    const total = Object.values(types).reduce((s, t) => s + t.weight, 0);
    let roll = rng.next() * total;
    for (const [id, t] of Object.entries(types)) {
      roll -= t.weight;
      if (roll <= 0) return id;
    }
    return "clear";
  }

  effects(weatherId: string): Record<string, number | boolean> {
    return (DB.weather.types[weatherId]?.effects ?? {}) as Record<string, number | boolean>;
  }
}
