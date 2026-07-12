// WeatherManager（第14巻18-9・正本）。季節別確率・嵐の翌日は必ず晴れ・供物期限残り2日は嵐抑制。

import { DB } from "../dataLoader.js";
import type { RNG } from "./rng.js";

export class WeatherManager {
  rollDaily(rng: RNG, day: number, prevWeather: string, tributeDaysLeft: number): string {
    // 嵐の翌日は必ず晴れ（漂着物2倍は採取側で処理）
    if (prevWeather === "storm") return "clear";

    const season = (DB.weather.seasons as any[]).find(
      (s) => day >= s.day_min && day <= s.day_max) ?? DB.weather.seasons[0];
    const weights: Record<string, number> = { ...season.weights };

    // 供物期限残り2日は嵐を抑制
    if (tributeDaysLeft <= DB.weather.storm_suppress_tribute_days_left) {
      weights["clear"] = (weights["clear"] ?? 0) + (weights["storm"] ?? 0);
      weights["storm"] = 0;
    }

    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    let roll = rng.next() * total;
    for (const [id, w] of Object.entries(weights)) {
      roll -= w;
      if (roll <= 0) return id;
    }
    return "clear";
  }

  effects(weatherId: string): Record<string, number | boolean> {
    return (DB.weather.types[weatherId]?.effects ?? {}) as Record<string, number | boolean>;
  }

  name(weatherId: string): string {
    return DB.weather.types[weatherId]?.name ?? weatherId;
  }
}
