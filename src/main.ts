// ホープシード メインUI（GDD第16巻20-4-1 FSMに沿った画面遷移）。
// Title → HolderSelect → DayLoop(Base⇄Map⇄Battle) → Ending/GameOver。

import { DB, getEnemyDef } from "./dataLoader.js";
import { GameManager } from "./core/gameManager.js";
import { skillsForCharacter, enhancedSkill, statAtLevel } from "./core/stats.js";
import { FieldState, type FieldSymbol } from "./field/field.js";
import { rulebookText } from "./ui/rulebook.js";
import { readGallery } from "./core/saveManager.js";
import { globalCompletionRate } from "./core/achievementManager.js";
import type { BattleManager, Command } from "./core/battle/battleManager.js";
import type { CharacterState } from "./types.js";

const gm = new GameManager();
let field: FieldState | null = null;
let battle: BattleManager | null = null;
let battleMembers: string[] = [];
let nightBattle: { kind: "dream"; dreamer: string } | { kind: "raid" } | null = null;
let tideTimerStart = 0;        // 満潮浅瀬の滞在開始時刻(ms)・第3巻4-0-5
let lastRockfallCheck = 0;
let shrineCooldownUntil = 0;   // 参拝直後の再接触防止
let logBuffer: string[] = [];
let fieldRAF = 0;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const screen = () => $("#screen");
const keys = new Set<string>();

window.addEventListener("keydown", (e) => keys.add(e.key));
window.addEventListener("keyup", (e) => keys.delete(e.key));

// 戦闘・モーダルのキーボード操作:
//  - 数字キー1〜9: 戦闘コマンド/対象/モーダル内の選択肢を選ぶ（ボタンに数字を表示）
//  - Enter: 戦闘開始・迎え撃つ・挑む・就寝・モーダルを閉じる
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    for (const id of ["#battle-start", "#boss-start", "#raid-start", "#modal-close"]) {
      const btn = document.querySelector(id) as HTMLElement | null;
      if (btn) { btn.click(); e.preventDefault(); return; }
    }
    return;
  }
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > 9) return;
  // 戦闘中: コマンド欄の有効なボタンを数字で選択
  if (gm.phase === "battle" && !document.querySelector(".modal-back")) {
    const bar = document.querySelector("#battle-commands");
    if (bar) {
      const btns = [...bar.querySelectorAll("button:not([disabled])")] as HTMLElement[];
      if (btns[n - 1]) { btns[n - 1].click(); e.preventDefault(); }
      return;
    }
  }
  // モーダル（メンバー選択・夜襲の選択肢など）: 有効なボタンを数字で選択（マップ操作中は移動を優先）
  if (gm.phase !== "map") {
    const modal = document.querySelector(".modal-back:last-of-type .modal");
    if (modal) {
      const btns = [...modal.querySelectorAll("button:not([disabled])")] as HTMLElement[];
      if (btns[n - 1]) { btns[n - 1].click(); e.preventDefault(); }
    }
  }
});

// （数字キー1〜9も隠しショートカットとして使えるが、既定はマウスクリック操作）

function log(line: string, important = false): void {
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  const el = $("#log-panel");
  el.innerHTML = logBuffer.slice(-60)
    .map((l) => `<div class="log-line${important && l === line ? " important" : ""}">${l}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

// 状態異常アイコン（第13巻16-0: 色+形で区別）+ 放置死カウントダウン（16-1）
function statusBadges(c: CharacterState): string {
  const st = c.status;
  const parts: string[] = [];
  if (st.poison !== undefined) parts.push(`<span title="毒" style="color:#b76fd9">☠️あと${st.poison}日</span>`);
  if (st.burn !== undefined) parts.push(`<span title="大火傷" style="color:#ff9040">🔥あと${st.burn}日</span>`);
  if (st.bleed !== undefined) parts.push(`<span title="大出血" style="color:#ff5a5a">🩸あと${st.bleed}日</span>`);
  if ((st.paralysis ?? 0) > 0) parts.push(`<span title="しびれ" style="color:#ffd94a">⚡</span>`);
  if (st.plagueDay !== undefined) {
    const sev = st.plagueSevereDays !== undefined
      ? `重症あと${DB.config.status_timers.plague_severe_death_days - st.plagueSevereDays}日` : "";
    parts.push(`<span title="疫病" style="color:#6fd98f">🌀${sev}</span>`);
  }
  if (st.infectDay !== undefined) {
    const sev = st.infectSevereDays !== undefined
      ? `重症あと${DB.config.status_timers.infect_severe_death_days - st.infectSevereDays}日` : "";
    parts.push(`<span title="感染症" style="color:#5ad9c0">🦠${sev}</span>`);
  }
  if (st.obesity) parts.push(`<span title="肥満">🍔</span>`);
  if (c.exclusion === "coma") parts.push(`<span title="昏睡" style="color:#7aa8ff">💤${c.comaDaysLeft}日</span>`);
  if (c.exclusion === "betrayal") parts.push(`<span title="裏切り" style="color:#666">😈${c.betrayalDaysLeft}日</span>`);
  return parts.join(" ");
}

// 信頼度の段階名（第9巻12-2・正本: 他人/知人/仲間/友達/親友/絆）とハート表示（16-3）
function trustHearts(v: number): string {
  const full = Math.round(v / 20);
  const stages = DB.trust.stages as { min: number; name: string }[];
  let label = stages[0].name;
  for (const s of stages) if (v >= s.min) label = s.name;
  return `${"♥".repeat(Math.min(5, full))}${"♡".repeat(Math.max(0, 5 - full))} ${Math.round(v)} ${label}`;
}

// 実績解除トースト（第15巻19章: 画面右上に表示）
function showAchievementToasts(): void {
  if (!gm.gs || !gm.achievements) return;
  for (const id of gm.achievements.consumeToasts()) {
    const a = (DB.achievements as any[]).find((x) => x.id === id);
    if (!a) continue;
    let wrap = document.querySelector(".toast-wrap") as HTMLElement | null;
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = `🏆 実績解除「${a.name}」`;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
}

// ============ HUD ============
function renderHUD(): void {
  showAchievementToasts();
  const el = $("#hud");
  if (!gm.gs) { el.innerHTML = ""; return; }
  const slotNames: Record<string, string> = { morning: "朝", noon: "昼", evening: "夕", night: "夜" };
  const active = gm.party.getActiveMembers();
  const minSatiety = active.length > 0 ? Math.min(...active.map((c) => c.satiety)) : 0;
  const fireLeft = gm.tribute.remainingDays("fire");
  const waterLeft = gm.tribute.remainingDays("water");
  const holder = DB.characters[gm.gs.holder].name;
  el.innerHTML = `
    <div class="hud-item"><span class="hud-label">日数</span><span class="hud-value">${gm.gs.day}/${DB.config.DAY_MAX}日</span></div>
    <div class="hud-item"><span class="hud-label">時刻</span><span class="hud-value">${slotNames[gm.gs.slot]}</span></div>
    <div class="hud-item"><span class="hud-label">天候</span><span class="hud-value">${gm.weather.name(gm.gs.weather)}</span></div>
    <div class="hud-item"><span class="hud-label">潮</span><span class="hud-value">${gm.gs.tide === "high" ? "満潮" : "干潮"}</span></div>
    <div class="hud-item"><span class="hud-label">保持者</span><span class="hud-value">🌱${holder}</span></div>
    <div class="hud-item"><span class="hud-label">空腹(最少)</span><span class="hud-value ${minSatiety <= 30 ? "warn" : ""}">${minSatiety}/100</span></div>
    <div class="hud-item"><span class="hud-label">銀貨</span><span class="hud-value">${gm.gs.silver}</span></div>
    <div class="hud-item"><span class="hud-label">炎の供物</span><span class="hud-value ${fireLeft <= 3 ? "warn" : ""}">あと${fireLeft}日</span></div>
    <div class="hud-item"><span class="hud-label">水の供物</span><span class="hud-value ${waterLeft <= 3 ? "warn" : ""}">あと${waterLeft}日</span></div>
    <div class="hud-item"><button class="small" id="btn-rulebook">📖 ルール${rulebookMilestones() > (gm.gs.rulebookSeen ?? 1) ? '<span style="color:var(--accent)">！</span>' : ""}</button></div>
    <div class="hud-item"><button class="small" id="btn-status">👥 なかま</button></div>
    <div class="hud-item"><button class="small" id="btn-items">🎒 アイテム</button></div>
    <div class="hud-item"><button class="small" id="btn-journal">📓 日誌</button></div>
    <div class="hud-item"><button class="small" id="btn-save">💾 セーブ/ロード</button></div>
    <div class="hud-party">${partyMiniBars()}</div>
  `;
  $("#btn-rulebook").onclick = () => {
    gm.gs.rulebookSeen = rulebookMilestones(); // ！通知の既読化（第1巻1-7）
    renderHUD(); // バッジを即時消去
    showModal("ルールブック", rulebookText({
      fireLeft: gm.tribute.remainingDays("fire"),
      waterLeft: gm.tribute.remainingDays("water"),
      reviveIn: gm.gs.reviveLastDay === 0 ? 0
        : DB.config.revive.cooldown_days - (gm.gs.day - gm.gs.reviveLastDay),
    }));
  };
  $("#btn-status").onclick = () => showPartyStatus();
  $("#btn-items").onclick = () => showInventory();
  $("#btn-journal").onclick = () => showJournal();
  $("#btn-save").onclick = () => showSaveLoad(gm.phase === "base" || gm.phase === "map");
}

// パーティHP簡易バー×人数＋状態異常アイコン（第13巻16-1）
function partyMiniBars(): string {
  return Object.values(gm.gs.party).map((c) => {
    const d = DB.characters[c.id];
    if (c.exclusion === "dead" || c.exclusion === "kidnapped") {
      const label = c.exclusion === "dead" ? "死亡" : "誘拐中";
      return `<span class="mini-bar excluded">${d.name}【${label}】</span>`;
    }
    const pct = Math.round((c.hp / c.maxHp) * 100);
    return `<span class="mini-bar">${c.id === gm.gs.holder ? "🌱" : ""}${d.name}
      <span class="bar" style="width:40px;display:inline-block"><span class="bar-fill hp ${pct < 30 ? "low" : ""}" style="width:${pct}%;display:block;height:100%"></span></span>
      ${statusBadges(c)}</span>`;
  }).join("");
}

// ============ Modal ============
function showModal(title: string, body: string, onClose?: () => void): void {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><h2>${title}</h2><div>${body}</div>
    <div class="modal-actions"><button id="modal-close">閉じる</button></div></div>`;
  document.body.appendChild(back);
  (back.querySelector("#modal-close") as HTMLElement).onclick = () => {
    back.remove();
    onClose?.();
  };
}

// なかま画面（第13巻16-3: 詳細ステータス・信頼度ハート・技一覧・除外可視化）
function showPartyStatus(selectedId?: string): void {
  const ids = Object.keys(gm.gs.party);
  const sel = selectedId ?? ids[0];
  const c = gm.gs.party[sel];
  const d = DB.characters[sel];

  const nameList = ids.map((id) => {
    const p2 = gm.gs.party[id];
    const excl = p2.exclusion !== "none"
      ? { dead: "【死亡】", kidnapped: "【誘拐中】", betrayal: "【裏切り】", coma: "【昏睡】" }[p2.exclusion]
      : "";
    const gray = p2.exclusion !== "none" ? "opacity:.45" : "";
    return `<button class="small pt-sel ${id === sel ? "selected" : ""}" data-id="${id}" style="${gray}">
      ${id === gm.gs.holder ? "🌱" : ""}${DB.characters[id].name} Lv${p2.level}${excl}</button>`;
  }).join(" ");

  const S = (k: any) => Math.round(statAtLevelUI(sel, k, c.level));
  const w = c.equippedWeapon ? DB.items[c.equippedWeapon] : null;
  const trustRows = ids.filter((o) => o !== sel).map((o) =>
    `<tr><td>${DB.characters[o].name}</td><td>${trustHearts(gm.trust.pair(sel, o))}</td></tr>`).join("");
  const skills = skillsForCharacter(sel)
    .map(([, sk]) => {
      const learned = sk.learn_lv <= c.level;
      return `<tr style="${learned ? "" : "opacity:.4"}"><td>${learned ? sk.name : "？？？"}</td>
        <td>Lv${sk.learn_lv}</td><td>SP${sk.sp_cost}</td><td>${learned ? sk.desc : ""}</td></tr>`;
    }).join("");

  showModal(`なかま — ${d.name}`, `
    <div class="row">${nameList}</div>
    <p>HP ${c.hp}/${c.maxHp}　SP ${c.sp}/${c.maxSp}　満腹 ${Math.round(c.satiety)}%</p>
    <p>攻${S("atk")} 防${S("def")} 早${S("spd")} 技${S("skl")} 回${S("eva")} 一撃${statAtLevelUI(sel, "crit", c.level)}%${d.base.mag !== null ? ` 魔${S("mag")}` : ""}</p>
    <p>装備: ${w ? `${w.name}（攻+${w.atk_bonus ?? 0}${w.mag_bonus ? " 魔+" + w.mag_bonus : ""}${w.protect_bonus ? " 庇う+" + w.protect_bonus + "%" : ""}）` : "素手"}</p>
    <p>状態: ${statusBadges(c) || "健康"}</p>
    <h3 class="section-title">信頼度</h3>
    <table class="data">${trustRows}</table>
    <h3 class="section-title">技</h3>
    <div style="max-height:200px;overflow-y:auto"><table class="data">${skills}</table></div>
  `);
  document.querySelectorAll(".pt-sel").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      document.querySelector(".modal-back")?.remove();
      showPartyStatus((b as HTMLElement).dataset.id);
    };
  });
}

function statAtLevelUI(id: string, stat: string, level: number): number {
  return statAtLevel(id, stat as any, level);
}

// アイテム画面（第13巻16-6: 原設定の7分類タブ・保存日数・供物可バッジ）
const ITEM_TABS: [string, string[]][] = [
  ["食料素材", ["food_material"]],
  ["食料", ["food"]],
  ["武器素材", ["weapon_material"]],
  ["武器", ["weapon"]],
  ["薬草", ["herb"]],
  ["薬", ["medicine"]],
  ["重要", ["key_item", "treasure", "boss_material"]],
];

function showInventory(tabIndex = 0): void {
  const [, cats] = ITEM_TABS[tabIndex];
  const tabs = ITEM_TABS.map(([name], i) =>
    `<button class="small inv-tab ${i === tabIndex ? "selected" : ""}" data-i="${i}">${name}</button>`).join(" ");

  let rows: string;
  if (cats.includes("food")) {
    // 料理はfoodStockから（保存残り日数・期限当日は赤）
    rows = gm.gs.foodStock.map((f) => {
      const item = DB.items[f.dishId];
      const left = DB.config.craft.food_expire_days - (gm.gs.day - f.madeDay);
      const q = { great: "◎", normal: "○", poor: "△" }[f.quality];
      const style = left <= 1 ? 'style="color:var(--danger)"' : "";
      return `<tr><td>${q} ${f.quality === "great" ? item.great_name : item.name}</td>
        <td ${style}>あと${left}日</td><td>${item.desc}</td></tr>`;
    }).join("");
  } else {
    rows = Object.entries(gm.gs.inventory)
      .filter(([id, n]) => n > 0 && cats.includes(DB.items[id]?.category ?? ""))
      .map(([id, n]) => {
        const item = DB.items[id];
        const badge = item.family === "meat" ? ' <span style="color:var(--accent)">[供物可🔥]</span>'
          : item.family === "fish" ? ' <span style="color:var(--accent)">[供物可💧]</span>' : "";
        return `<tr><td>${item.name}${badge}</td><td>×${n}</td><td>${item.desc}</td></tr>`;
      }).join("");
  }
  showModal("アイテム", `<div class="row">${tabs}</div>
    <table class="data"><tr><th>アイテム</th><th>数/期限</th><th>説明</th></tr>${rows || "<tr><td colspan=3>なし</td></tr>"}</table>`);
  document.querySelectorAll(".inv-tab").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      document.querySelector(".modal-back")?.remove();
      showInventory(Number((b as HTMLElement).dataset.i));
    };
  });
}

// 日誌（第13巻16-2: 供物・蘇生の履歴／視聴済みイベント／本日のログ）
function showJournal(): void {
  const j = gm.gs.journal;
  const tributes = j.tributes.slice(-10).map((t) =>
    `<li>Day${t.day}: ${t.goddess === "fire" ? "炎の女神🔥" : "水の女神💧"}に供物を捧げた</li>`).join("");
  const revives = j.revives.map((r) =>
    `<li>Day${r.day}: ${DB.characters[r.charId].name}が湖の祠で生き返った</li>`).join("");
  const events = j.events.slice(-10).map((e) =>
    `<li>Day${e.day}: ${e.id}</li>`).join("");
  const todayLog = logBuffer.slice(-8).map((l) => `<li>${l}</li>`).join("");
  // 実績ページ（第15巻: 通常50＋隠し15。隠しは解除まで？？？）
  const achRows = (DB.achievements as any[]).map((a) => {
    const got = gm.gs.achievements.includes(a.id);
    const name = got ? a.name : (a.hidden ? "？？？" : a.name);
    return `<tr><td>${a.id}</td><td>${name}</td><td>${got ? "🏆" : ""}</td></tr>`;
  }).join("");
  showModal("📓 日誌", `
    <h3 class="section-title">供物の記録</h3><ul>${tributes || "<li>まだない</li>"}</ul>
    <h3 class="section-title">蘇生の記録</h3><ul>${revives || "<li>まだない</li>"}</ul>
    <h3 class="section-title">出来事</h3><ul>${events || "<li>まだない</li>"}</ul>
    <h3 class="section-title">本日のログ</h3><ul style="font-size:12px">${todayLog}</ul>
    <h3 class="section-title">実績（島の記録: ${gm.achievements.completionRate()}%）</h3>
    <div style="max-height:240px;overflow-y:auto"><table class="data"><tr><th>ID</th><th>名称</th><th></th></tr>${achRows}</table></div>`);
}

// セーブ/ロード画面（第13巻17-2/17-3: オート3+手動10=13スロット・メタ表示）
function showSaveLoad(canSave: boolean): void {
  const slotRow = (id: string) => {
    const meta = gm.save.readMeta(id);
    const label = id.startsWith("auto") ? `オート${Number(id.split("_")[1]) + 1}` : `手動${id.split("_")[1]}`;
    const info = meta
      ? `Day${meta.day}・🌱${DB.characters[meta.holder]?.name ?? meta.holder}・生存${meta.aliveCount}人・${trustHearts(meta.trustAvg).split(" ")[0]}`
      : "（空き）";
    const saveBtn = canSave && id.startsWith("manual")
      ? `<button class="small sv-btn" data-id="${id}">保存</button>` : "";
    const loadBtn = meta ? `<button class="small ld-btn" data-id="${id}">ロード</button>` : "";
    return `<tr><td>${label}</td><td>${info}</td><td>${saveBtn} ${loadBtn}</td></tr>`;
  };
  const rows = gm.save.allSlotIds().map(slotRow).join("");
  showModal("💾 セーブ / ロード", `<table class="data"><tr><th>スロット</th><th>内容</th><th></th></tr>${rows}</table>`);
  document.querySelectorAll(".sv-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      gm.save.saveManual(Number(id.split("_")[1]), gm.gs);
      log(`セーブした。（${id.replace("manual_", "手動スロット")}）`, true);
      document.querySelector(".modal-back")?.remove();
      showSaveLoad(canSave);
    };
  });
  document.querySelectorAll(".ld-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (gm.loadGame(id)) {
        document.querySelector(".modal-back")?.remove();
        log("記録を読み込んだ。", true);
        // ロード時: 現在の供物締切を復元表示（第13巻17-3）
        log(`供物の締切——炎: あと${gm.tribute.remainingDays("fire")}日／水: あと${gm.tribute.remainingDays("water")}日`);
        field = null;
        renderPhase();
      }
    };
  });
}

// ============ Title ============
function renderTitle(): void {
  cancelAnimationFrame(fieldRAF);
  screen().innerHTML = `
    <div class="screen-inner">
      <h1 class="title-logo">${globalCompletionRate() >= 100 ? "🌸" : ""}ホープシード${globalCompletionRate() >= 100 ? "🌸" : ""}</h1>
      <p class="subtitle">～無人島サバイバルRPG～</p>
      <p class="subtitle" style="font-size:12px">島の記録: ${globalCompletionRate()}%${globalCompletionRate() >= 100 ? "（満開）" : ""}</p>
      <div class="menu-list">
        <button id="btn-new">はじめから</button>
        <button id="btn-load">つづきから</button>
        <button id="btn-gallery">ギャラリー</button>
      </div>
    </div>`;
  $("#btn-new").onclick = renderPrologue;
  $("#btn-load").onclick = () => {
    if (gm.save.allSlotIds().some((id) => gm.save.readMeta(id))) {
      showSaveLoad(false);
    } else {
      showModal("つづきから", "セーブデータが見つからない。");
    }
  };
  // ギャラリー: ED22種＋GO演出の回収状況（第12巻15-5。周回でも引き継ぎ15-7）
  $("#btn-gallery").onclick = () => {
    const g = readGallery();
    const names = DB.endings.ed_names as Record<string, string>;
    const rows = Object.keys(names).map((id) => {
      const got = g.endings.includes(id);
      return `<tr><td>${id}</td><td>${got ? names[id] : "？？？"}</td><td>${got ? "✅" : ""}</td></tr>`;
    }).join("");
    const goNames: Record<string, string> = { GO1: "保持者の死亡", GO2: "保持者の誘拐", GO3: "もう一人の首魁", GO4: "火山噴火", GO5: "島の水没" };
    const goRows = Object.keys(goNames).map((id) =>
      `<tr><td>${id}</td><td>${g.goSeen.includes(id) ? goNames[id] : "？？？"}</td><td>${g.goSeen.includes(id) ? "✅" : ""}</td></tr>`).join("");
    showModal("🖼️ ギャラリー",
      `島の記録: ${globalCompletionRate()}%\nエンディング回収: ${g.endings.length}/22\n<table class="data"><tr><th>ID</th><th>名称</th><th></th></tr>${rows}</table>\n\nゲームオーバー演出: ${g.goSeen.length}/5\n<table class="data"><tr><th>ID</th><th>名称</th><th></th></tr>${goRows}</table>`);
  };
}

// プロローグ（第1巻2-1「漂流の経緯」準拠）
function renderPrologue(): void {
  const island = DB.config.ISLAND_NAME;
  screen().innerHTML = `
    <div class="screen-inner" style="max-width:760px;margin:0 auto;padding-top:48px;line-height:2.2">
      <p>嵐の夜、客船は砕けた。</p>
      <p>同じ船に乗り合わせた5人は、ばらばらに波へ投げ出され——</p>
      <p>幼いムニは、その腕から両親が引き離されるのを見た。</p>
      <p>気がつくと、そこは地図に載らない絶海の孤島<b>「${island}」</b>。湖のほとりだった。</p>
      <p>そしてもう一人。空の裂け目から落ちてきた金色の魔法剣士が、6人目としてそこにいた。</p>
      <p>瀕死の6人の前に、湖の女神が現れ、淡く光る種を差し出す——<b style="color:var(--accent)">ホープシード</b>。</p>
      <p>「これを託された者が生きる限り、あなたたちの命の灯は消えない」</p>
      <p>だが、種を持つ者が失われれば、その瞬間すべてが終わる。</p>
      <p>365日。海流が変わり救援の可能性が開けるまでの1年を、この島で生き延びなければならない。</p>
      <div class="menu-list" style="margin-top:28px"><button id="btn-next">ホープシードを託す仲間を選ぶ</button></div>
    </div>`;
  $("#btn-next").onclick = renderHolderSelect;
}

// ルールブックの新要素解禁マイルストーン（第1巻1-7【AI提案】: 解禁時に「！」通知）
function rulebookMilestones(): number {
  let n = 1; // 基本ルール
  if (gm.gs.tribute.fireCount + gm.gs.tribute.waterCount > 0) n++; // 供物を初奉納
  if (gm.gs.day >= DB.config.kidnap.pirate_active_from_day) n++;   // 海賊出現(40日)
  if (gm.gs.day >= (DB.config.night_raid.phases as [number, number][])[0][0]) n++; // 悪魔の夜襲(61日)
  if (gm.gs.day >= DB.config.dream.active_from_day) n++;           // 夢魔(100日)
  if (gm.gs.stats.revived > 0) n++;                                 // 初蘇生
  if (gm.gs.flags["goddess_joined"]) n++;                           // 女神加入
  return n;
}

// ============ HolderSelect ============
function renderHolderSelect(): void {
  const candidates = ["renny", "hyu", "jinpachi", "muni", "geru", "neo"];
  const cards = candidates.map((id) => {
    const d = DB.characters[id];
    const holderNote = id === "renny" ? "水の加護：水の供物が28日おきでよく、誰も溺れない"
      : id === "jinpachi" ? "炎の加護：炎の供物が28日おきでよい"
      : id === "muni" ? "絆の力：すべての信頼度上昇が1.5倍"
      : "";
    return `<div class="char-card" data-id="${id}">
      <h3>${d.name}</h3>
      <p>一人称「${d.pronoun}」／得意: 調理${d.craft.cook} 工作${d.craft.build} 薬${d.craft.pharmacy}</p>
      <p>${holderNote ? "🌟 " + holderNote : "&nbsp;"}</p>
    </div>`;
  }).join("");
  screen().innerHTML = `
    <div class="screen-inner">
      <h2 class="section-title" style="text-align:center;border:none">ホープシードを託す者を選べ（以後変更できない）</h2>
      <div class="char-grid">${cards}</div>
    </div>`;
  screen().querySelectorAll(".char-card").forEach((el) => {
    (el as HTMLElement).onclick = () => {
      const id = (el as HTMLElement).dataset.id!;
      const d = DB.characters[id];
      // 二重確認（第13巻16-9: 保持者選択は取り返しがつかないため2段階）
      showModal("確認", `${d.name}にホープシードを託す。\nこの選択はエンディングまで変更できない。よいか？\n\n<button id="confirm-holder">託す</button>`);
      (document.querySelector("#confirm-holder") as HTMLElement).onclick = () => {
        document.querySelector(".modal-back")?.remove();
        showModal("最終確認", `本当に${d.name}でよいか？\n保持者が失われたとき、すべてが終わる。\n\n<button id="confirm-holder2">はい——${d.name}に託す</button>`);
        (document.querySelector("#confirm-holder2") as HTMLElement).onclick = () => {
          document.querySelector(".modal-back")?.remove();
          gm.newGame(id, Date.now() >>> 0);
          log(`${d.name}がホープシードの保持者となった。`, true);
          checkEvents();
          renderPhase();
        };
      };
    };
  });
}

// ============ Phase router ============
function renderPhase(): void {
  renderHUD();
  switch (gm.phase) {
    case "title": renderTitle(); break;
    case "base": renderBase(); break;
    case "map": renderField(); break;
    case "battle": renderBattle(); break;
    case "ending": renderEnding(); break;
    case "gameover": renderGameOver(); break;
    default: renderTitle();
  }
}

// ============ Base ============
function renderBase(): void {
  cancelAnimationFrame(fieldRAF);
  const foods = gm.gs.foodStock;
  const raws = Object.entries(gm.gs.inventory)
    .filter(([id, n]) => n > 0 && (DB.items[id]?.raw_edible || DB.items[id]?.raw_risk));
  const deadMembers = Object.values(gm.gs.party).filter((c) => c.exclusion === "dead");
  const reviveReady = deadMembers.length > 0
    && (gm.gs.reviveLastDay === 0 || gm.gs.day - gm.gs.reviveLastDay >= DB.config.revive.cooldown_days);
  const bleeding = Object.values(gm.gs.party).filter((c) => c.status.bleed !== undefined && c.exclusion === "none");
  // 看病対象: 昏睡または感染症（第7巻9-4）
  const needCare = Object.values(gm.gs.party).filter((c) =>
    c.exclusion !== "kidnapped" && c.exclusion !== "dead"
    && (c.comaDaysLeft > 0 || c.status.infectDay !== undefined));
  // 祠の蘇生カウントダウン（第13巻16-5: 「あとN日で祈り可能」）
  const reviveIn = gm.gs.reviveLastDay === 0 ? 0
    : Math.max(0, DB.config.revive.cooldown_days - (gm.gs.day - gm.gs.reviveLastDay));
  const reviveLabel = deadMembers.length === 0 ? "⛩️ 湖の祠（蘇生）"
    : reviveIn <= 0 ? "⛩️ 湖の祠（祈り可能）" : `⛩️ 湖の祠（あと${reviveIn}日で祈り可能）`;
  // 会話イベントの！通知（第13巻16-5。ルート＋掛け合い/個人/隠し=第9巻12-4）
  const evCount = gm.events.evaluateTriggers().length + gm.talks.available().length;

  screen().innerHTML = `
    <div class="screen-inner">
      <h2 class="section-title">🏕️ 湖畔の拠点</h2>
      <div class="row">
        <button id="b-craft-cook">🍳 調理</button>
        <button id="b-craft-build">🔨 工作</button>
        <button id="b-craft-pharmacy">🌿 薬草開発</button>
        <button id="b-eat" ${foods.length === 0 && raws.length === 0 ? "disabled" : ""}>🍖 食事</button>
        <button id="b-treat" ${bleeding.length === 0 ? "disabled" : ""}>🩹 治療（大出血の処置）</button>
        <button id="b-nurse" ${needCare.length === 0 ? "disabled" : ""}>🛌 看病</button>
        <button id="b-medicine">💊 薬を使う</button>
        <button id="b-equip">⚔️ 装備</button>
        <button id="b-revive" ${reviveReady ? "" : "disabled"}>${reviveLabel}</button>
        <button id="b-talk">💬 会話${evCount > 0 ? `<span style="color:var(--accent)">！${evCount}</span>` : ""}</button>
        <button id="b-rest">😴 休息（就寝して翌日へ）</button>
        <button id="b-out">🗺️ 島へ出る</button>
        ${gm.gs.day >= 350 && gm.gs.flags["final_scene_done"] && !gm.gs.flags["demon_lord_defeated"]
          ? '<button id="b-final">⚔️ 決戦（悪魔の首魁）</button>' : ""}
      </div>
      <div id="base-detail"></div>
    </div>`;

  $("#b-craft-cook").onclick = () => renderCraft("cook");
  $("#b-craft-build").onclick = () => renderCraft("build");
  $("#b-craft-pharmacy").onclick = () => renderCraft("pharmacy");
  $("#b-eat").onclick = () => {
    const detail = $("#base-detail");
    const qLabel = { great: "◎おいしい", normal: "○ふつう", poor: "△かろうじて" } as const;
    const dishBtns = foods.map((f, i) => {
      const item = DB.items[f.dishId];
      const left = DB.config.craft.food_expire_days - (gm.gs.day - f.madeDay);
      return `<button class="small dish-btn" data-i="${i}">${qLabel[f.quality]} ${f.quality === "great" ? item.great_name : item.name}（あと${left}日）</button>`;
    }).join(" ");
    const rawBtns = raws.map(([id, n]) =>
      `<button class="small raw-btn" data-id="${id}">${DB.items[id].name} ×${n}（生食）</button>`).join(" ");
    detail.innerHTML = `<h3 class="section-title">なにを食べる？（料理は保存3日）</h3>
      <div class="row">${dishBtns || "<i>料理のストックがない。調理しよう。</i>"}</div>
      <div class="row">${rawBtns}</div>`;
    const pickEater = (onPick: (id: string) => void) => {
      const members = gm.party.getActiveMembers();
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = "<b>誰が食べる？</b> " + members.map((c) =>
        `<button class="small eater-btn" data-id="${c.id}">${DB.characters[c.id].name}（満腹${Math.round(c.satiety)}）</button>`).join(" ");
      detail.appendChild(row);
      row.querySelectorAll(".eater-btn").forEach((eb) => {
        (eb as HTMLElement).onclick = () => onPick((eb as HTMLElement).dataset.id!);
      });
    };
    detail.querySelectorAll(".dish-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const i = Number((b as HTMLElement).dataset.i);
        pickEater((eaterId) => {
          const r = gm.eatDish(i, eaterId);
          log(r.message);
          gm.advanceTime(1);
          checkEvents();
          renderPhase();
        });
      };
    });
    detail.querySelectorAll(".raw-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const id = (b as HTMLElement).dataset.id!;
        pickEater((eaterId) => {
          const r = gm.eatRaw(id, eaterId);
          log(r.message);
          renderPhase();
        });
      };
    });
  };
  $("#b-treat").onclick = () => {
    const detail = $("#base-detail");
    const healers = gm.party.getActiveMembers().filter((c) => gm.craft.canWork(c.id));
    detail.innerHTML = `<h3 class="section-title">処置（大出血は薬では治らない）— 誰が処置する？</h3><div class="row">` +
      healers.map((c) => `<button class="small healer-btn" data-id="${c.id}">${DB.characters[c.id].name}（薬学${DB.characters[c.id].craft.pharmacy}）</button>`).join(" ") + "</div><div id=\"patient-list\"></div>";
    detail.querySelectorAll(".healer-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const healerId = (b as HTMLElement).dataset.id!;
        const list = $("#patient-list");
        list.innerHTML = `<div class="row" style="margin-top:8px">` +
          bleeding.map((c) => `<button class="small patient-btn" data-id="${c.id}">${DB.characters[c.id].name}</button>`).join(" ") + "</div>";
        list.querySelectorAll(".patient-btn").forEach((pb) => {
          (pb as HTMLElement).onclick = () => {
            const r = gm.craft.treatBleed(healerId, (pb as HTMLElement).dataset.id!);
            log(r.message, r.ok);
            gm.advanceTime(1);
            renderPhase();
          };
        });
      };
    });
  };
  $("#b-nurse").onclick = () => {
    const detail = $("#base-detail");
    const nurses = gm.party.getActiveMembers().filter((c) => gm.craft.canWork(c.id));
    detail.innerHTML = `<h3 class="section-title">看病（昏睡・感染症の重症化をその日1回防ぐ）— 誰が付き添う？</h3><div class="row">` +
      nurses.map((c) => `<button class="small nurse-btn" data-id="${c.id}">${DB.characters[c.id].name}</button>`).join(" ") + "</div><div id=\"care-list\"></div>";
    detail.querySelectorAll(".nurse-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const nurseId = (b as HTMLElement).dataset.id!;
        const list = $("#care-list");
        list.innerHTML = `<div class="row" style="margin-top:8px"><b>誰に付き添う？</b> ` +
          needCare.filter((c) => c.id !== nurseId)
            .map((c) => `<button class="small care-btn" data-id="${c.id}">${DB.characters[c.id].name} ${statusBadges(c)}</button>`).join(" ") + "</div>";
        list.querySelectorAll(".care-btn").forEach((cb) => {
          (cb as HTMLElement).onclick = () => {
            const r = gm.nurse(nurseId, (cb as HTMLElement).dataset.id!);
            log(r.message, r.ok);
            if (r.ok) { checkEvents(); renderPhase(); }
          };
        });
      };
    });
  };
  $("#b-medicine").onclick = () => {
    const detail = $("#base-detail");
    const meds = Object.entries(gm.gs.inventory)
      .filter(([id, n]) => n > 0 && DB.items[id]?.category === "medicine");
    if (meds.length === 0) { detail.innerHTML = "<p>薬を持っていない。薬草開発で作ろう。</p>"; return; }
    detail.innerHTML = `<h3 class="section-title">どの薬を使う？</h3><div class="row">` +
      meds.map(([id, n]) => `<button class="small med-btn" data-id="${id}">${DB.items[id].name} ×${n}</button>`).join(" ") + "</div><div id=\"med-target\"></div>";
    detail.querySelectorAll(".med-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const medId = (b as HTMLElement).dataset.id!;
        const targets = gm.party.getActiveMembers();
        const t = $("#med-target");
        t.innerHTML = `<div class="row" style="margin-top:8px">` +
          targets.map((c) => `<button class="cmd-btn mt-btn" data-id="${c.id}">${DB.characters[c.id].name}</button>`).join(" ") + "</div>";
        t.querySelectorAll(".mt-btn").forEach((tb) => {
          (tb as HTMLElement).onclick = () => {
            const r = gm.useMedicine(medId, (tb as HTMLElement).dataset.id!);
            log(r.message, r.ok);
            renderPhase();
          };
        });
      };
    });
  };
  $("#b-equip").onclick = () => {
    const detail = $("#base-detail");
    const members = gm.party.getActiveMembers();
    detail.innerHTML = `<h3 class="section-title">誰の装備を替える？</h3><div class="row">` +
      members.map((c) => `<button class="small eq-btn" data-id="${c.id}">${DB.characters[c.id].name}（${c.equippedWeapon ? DB.items[c.equippedWeapon].name : "素手"}）</button>`).join(" ") + "</div><div id=\"eq-list\"></div>";
    detail.querySelectorAll(".eq-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const charId = (b as HTMLElement).dataset.id!;
        const wtype = DB.characters[charId].weapon_type;
        const weapons = Object.entries(gm.gs.inventory)
          .filter(([id, n]) => n > 0 && DB.items[id]?.category === "weapon" && DB.items[id].weapon_type === wtype);
        const list = $("#eq-list");
        list.innerHTML = weapons.length === 0 ? "<p>この武器種の持ち合わせがない。工作で作ろう。</p>"
          : `<div class="row" style="margin-top:8px">` +
            weapons.map(([id]) => `<button class="small wp-btn" data-id="${id}">${DB.items[id].name}（攻+${DB.items[id].atk_bonus ?? 0}${DB.items[id].mag_bonus ? " 魔+" + DB.items[id].mag_bonus : ""}）</button>`).join(" ") + "</div>";
        list.querySelectorAll(".wp-btn").forEach((wb) => {
          (wb as HTMLElement).onclick = () => {
            if (gm.equip(charId, (wb as HTMLElement).dataset.id!)) {
              log(`${DB.characters[charId].name}の装備を替えた。`);
              renderPhase();
            }
          };
        });
      };
    });
  };
  $("#b-revive").onclick = () => {
    const detail = $("#base-detail");
    detail.innerHTML = `<h3 class="section-title">誰を呼び戻す？（7日に1人）</h3><div class="row">` +
      deadMembers.map((c) => `<button class="small rev-btn" data-id="${c.id}">${DB.characters[c.id].name}</button>`).join("") + "</div>";
    detail.querySelectorAll(".rev-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const id = (b as HTMLElement).dataset.id!;
        if (gm.party.revive(id)) {
          // 信頼度+5（復活者⇔全員）はPartyManager側で適用（第9巻12-3-1）
          log(DB.npcLines.lake_goddess.revive.replace("{name}", DB.characters[id].name), true);
          log(`${DB.characters[id].name}が生き返った！`, true);
          renderPhase();
        }
      };
    });
  };
  $("#b-talk").onclick = () => {
    const detail = $("#base-detail");
    const routeEvs = gm.events.evaluateTriggers();
    const talks = gm.talks.available();
    if (routeEvs.length === 0 && talks.length === 0) {
      // 信頼度帯のランダム会話（第9巻12-5-1: A/B/Cセット）
      const others = gm.party.getActiveMembers().filter((c) => c.id !== "goddess");
      if (others.length >= 2) {
        const i = gm.rng.int(0, others.length - 1);
        let j = gm.rng.int(0, others.length - 2);
        if (j >= i) j++;
        showModal("会話", gm.talks.flavorLine(others[i].id, others[j].id)
          + "\n\n（信頼度が上がると、特別な掛け合いが生まれる）");
      } else {
        showModal("会話", "いまは特に話すことがないようだ。");
      }
      return;
    }
    // 優先度: メイン（ルート）＞個人＞掛け合い＞庇う特別（第9巻12-4）
    const kindLabels: Record<string, string> = {
      party: "🎉", hidden: "✨", personal: "👤", pair: "💬", group: "👥", protect_special: "🛡️",
    };
    const routeBtns = routeEvs.map((e) =>
      `<button class="small route-ev-btn" data-id="${e.id}">📖 ${e.id}</button>`).join(" ");
    const talkBtns = talks.map((t) =>
      `<button class="small talk-btn" data-id="${t.id}">${kindLabels[t.kind] ?? ""} ${t.title}</button>`).join(" ");
    detail.innerHTML = `<h3 class="section-title">だれかの声がする——（発生中のイベント）</h3>
      <div class="row">${routeBtns} ${talkBtns}</div>`;
    detail.querySelectorAll(".route-ev-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => { playEvent((b as HTMLElement).dataset.id!); renderPhase(); };
    });
    detail.querySelectorAll(".talk-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => playTalk((b as HTMLElement).dataset.id!);
    });
  };
  $("#b-rest").onclick = () => {
    // 就寝確認（第13巻16-5: 誤操作で1日を失わないための二段確認）
    const detail = $("#base-detail");
    detail.innerHTML = `<h3 class="section-title">今日を終えますか？（オートセーブされます）</h3>
      <div class="row"><button id="rest-yes">はい、眠る</button><button id="rest-no">まだ起きている</button></div>`;
    $("#rest-no").onclick = () => { detail.innerHTML = ""; };
    $("#rest-yes").onclick = () => doRest();
  };
  const doRest = () => {
    const ev = gm.rollNightEvents();
    if (ev.raid) {
      log("闇の気配——悪魔の夜襲だ！", true);
      openNightRaidChoice();
      return;
    }
    if (ev.dreamer) {
      const name = DB.characters[ev.dreamer].name;
      log(`${name}は不穏な夢に呑まれていく——夢魔との戦いだ！`, true);
      nightBattle = { kind: "dream", dreamer: ev.dreamer };
      battle = gm.startDreamBattle(ev.dreamer);
      for (const line of battle.log.lines) log(line, true);
      pendingCommands = [];
      commandIndex = 0;
      renderPhase();
      return;
    }
    finishSleep();
  };
  const bFinal = document.querySelector("#b-final") as HTMLElement | null;
  if (bFinal) bFinal.onclick = () => openBossBattleSelect("demon_lord");
  $("#b-out").onclick = () => {
    // 拠点からの行き先を選ぶ（拠点マップの接続先）
    const conns = DB.maps["base"].connections;
    const detail = $("#base-detail");
    detail.innerHTML = `<h3 class="section-title">どこへ向かう？（移動で時間が進む）</h3><div class="row">` +
      conns.map((to) => `<button class="small dest-btn" data-to="${to}">${DB.maps[to].name}</button>`).join(" ") + "</div>";
    detail.querySelectorAll(".dest-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const to = (b as HTMLElement).dataset.to!;
        const r = gm.moveTo(to);
        if (!r.ok) { log(MOVE_FAIL_REASONS[r.reason ?? ""] ?? "そこへはまだ行けない。"); return; }
        log(`${DB.maps[to].name}へ向かった。`);
        for (const d of r.deaths) log(`${DB.characters[d].name}はしびれたまま危険地帯に踏み込み、還らなかった…`, true);
        if (gm.phase === ("gameover" as typeof gm.phase)) { renderPhase(); return; }
        gm.phase = "map";
        startField(to);
        renderHUD();
      };
    });
  };
}

function renderCraft(type: "cook" | "build" | "pharmacy"): void {
  const names = { cook: "調理", build: "工作", pharmacy: "薬草開発" };
  const active = gm.party.getActiveMembers();
  const detail = $("#base-detail");
  const crafterBtns = active.map((c) =>
    `<button class="small crafter-btn" data-id="${c.id}">${DB.characters[c.id].name}（${DB.characters[c.id].craft[type]}）</button>`).join("");
  detail.innerHTML = `<h3 class="section-title">${names[type]} — 誰が作業する？</h3><div class="row">${crafterBtns}</div><div id="recipe-list"></div>`;
  detail.querySelectorAll(".crafter-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const crafterId = (b as HTMLElement).dataset.id!;
      const skill = DB.characters[crafterId].craft[type];
      const list = $("#recipe-list");
      // 全レシピを列挙: 🔒=適性不足／？？？=未ひらめき／成功率プレビュー（第13巻16-7）
      const rows = (DB.recipes[type] ?? []).map((r: any) => {
        const locked = r.skill_req > skill;
        const known = gm.craft.isRecipeKnown(r);
        if (!known) {
          return `<tr><td>？？？</td><td>—</td><td>—</td><td><i>素材が揃うとひらめく</i></td></tr>`;
        }
        const inputs = r.inputs.map((i: any) => `${DB.items[i.item].name}×${i.qty}`).join(" ");
        if (locked) {
          return `<tr style="opacity:.5"><td>🔒 ${DB.items[r.result].name}</td><td>必要適性${r.skill_req}</td><td>${inputs}</td><td>—</td></tr>`;
        }
        const can = gm.craft.canCraft(r);
        const rates = gm.craft.ratesFor(type, crafterId, r);
        return `<tr><td><button class="small recipe-btn" data-id="${r.id}" ${can ? "" : "disabled"}>${DB.items[r.result].name}</button></td>
          <td>大成功${rates.great}%／成功${rates.success}%／失敗${rates.fail}%</td>
          <td>${inputs}</td><td>${can ? "" : "素材不足"}</td></tr>`;
      }).join("");
      list.innerHTML = `<table class="data" style="margin-top:10px"><tr><th>レシピ</th><th>成功率（${DB.characters[crafterId].name}）</th><th>素材</th><th></th></tr>${rows}</table>`;
      list.querySelectorAll(".recipe-btn").forEach((rb) => {
        (rb as HTMLElement).onclick = () => {
          const res = gm.craft.craft(type, (rb as HTMLElement).dataset.id!, crafterId);
          log(res.message, res.ok);
          if (res.ok) { gm.advanceTime(1); checkEvents(); renderPhase(); }
        };
      });
    };
  });
}

// ============ Field ============
function startField(mapId: string): void {
  gm.gs.location = mapId;
  const bossDefeated = !!gm.gs.flags[`${DB.maps[mapId].boss}_defeated`];
  // 加護のエンカウント補正（第14巻18-2: ジンパチ保持者=登山道−40%/レニィ保持者=浅瀬−40%）
  let densityMult = 1.0;
  if (gm.gs.holder === "jinpachi" && mapId === "trail") densityMult = 0.6;
  if (gm.gs.holder === "renny" && mapId === "shallows") densityMult = 0.6;
  if ((gm.gs.inventory["torch"] ?? 0) > 0 && gm.gs.slot === "night") densityMult -= 0.10;
  field = new FieldState(mapId, gm.rng, gm.gs.slot, {
    bossDefeated, day: gm.gs.day, densityMult,
    piratesStopped: !!gm.gs.flags["pirates_stopped"],
    weather: gm.gs.weather,
    hasFishingRod: (gm.gs.inventory["fishing_rod"] ?? 0) > 0,
    driftAvailable: gm.gs.lastDriftDay < gm.gs.day,
  });
  // 炎の女神の加護（第3巻4-2: 供物継続時、まれに敵を焼き払う・固定文言）
  if (DB.maps[mapId].fire_grace && gm.tribute.remainingDays("fire") >= 0) {
    // 隠し「炎と水の姉妹」達成で加護率+10%（第11巻14-4 #3）
    const burned = field.applyFireGrace(gm.gs.flags["grace_boost"] ? 0.10 : 0);
    if (burned) log("火の女神の力で敵が炎に包まれる！", true);
  }
  tideTimerStart = 0;
  gm.phase = DB.maps[mapId].is_base ? "base" : "map";
  if (gm.phase === "base") { renderPhase(); return; }
  renderField();
}

// フィールド毎フレーム処理: 満潮タイマー（第3巻4-0-5）・落石（第3巻4-2）
function fieldTick(): "drown" | null {
  if (!field) return null;
  const map = field.map;
  const now = performance.now();
  // 満潮の浅瀬: 実時間90秒制限
  if (map.high_tide_timer_sec && gm.gs.tide === "high" && gm.gs.holder !== "renny") {
    if (tideTimerStart === 0) tideTimerStart = now;
    const left = map.high_tide_timer_sec - (now - tideTimerStart) / 1000;
    const el = document.querySelector("#tide-timer");
    if (el) el.textContent = `🌊 水かさが増している……残り${Math.max(0, Math.ceil(left))}秒`;
    if (left <= 0) return "drown";
  } else {
    tideTimerStart = 0;
    const el = document.querySelector("#tide-timer");
    if (el) el.textContent = "";
  }
  // 落石地帯: ランダムで落石→技量判定（第3巻4-2）
  if (map.rockfall && now - lastRockfallCheck > 1000) {
    lastRockfallCheck = now;
    const f = DB.config.field;
    if (gm.rng.chance(f.rockfall_chance_per_sec)) {
      const holder = gm.party.getHolder();
      const dodge = f.rockfall_dodge_base + effectiveSkl(holder) * f.rockfall_dodge_skl_factor;
      if (gm.rng.chance(Math.min(95, dodge) / 100)) {
        log("落石だ！　間一髪でかわした！");
      } else {
        const dmg = Math.max(1, Math.round(holder.maxHp * f.rockfall_damage_ratio));
        holder.hp = Math.max(1, holder.hp - dmg);
        log(`落石だ！　${DB.characters[holder.id].name}に${dmg}のダメージ！`, true);
        renderHUD();
      }
    }
  }
  return null;
}

function effectiveSkl(c: CharacterState): number {
  return Math.round(DB.characters[c.id].base.skl + DB.characters[c.id].growth.skl * (c.level - 1));
}

function handleFieldDrown(): void {
  cancelAnimationFrame(fieldRAF);
  const r = gm.fieldDrownCheck();
  if (r.saved) {
    log("水の女神の加護でみんなは溺死から救われた！　砂浜へ押し流された……", true);
    gm.gs.location = "beach";
    gm.phase = "map";
    startField("beach");
    renderHUD();
    return;
  }
  for (const d of r.deaths) log(`${DB.characters[d].name}は波に呑まれた……`, true);
  if (gm.phase === "gameover") { renderPhase(); return; }
  gm.gs.location = "beach";
  gm.phase = "map";
  startField("beach");
  renderHUD();
}

function renderField(): void {
  if (!field) { startField(gm.gs.location); return; }
  screen().innerHTML = `
    <canvas id="field-canvas"></canvas>
    <div class="field-overlay">
      <b>${field.map.name}</b><br>
      <span style="font-size:11px">矢印キー/WASDで移動。旗で移動、🌿で採取${field.map.has_shrine ? "、⛩️で参拝" : ""}</span>
      <div id="tide-timer" style="color:var(--danger);font-weight:bold"></div>
    </div>
    <div class="field-actions">
      <button class="small" id="f-back">🏕️ 拠点へ戻る</button>
      ${gm.dogAvailable() ? '<button class="small" id="f-shop">🏪 ドグの店</button>' : ""}
    </div>`;
  const canvas = $("#field-canvas") as HTMLCanvasElement;
  const resize = () => {
    canvas.width = screen().clientWidth;
    canvas.height = screen().clientHeight;
  };
  resize();
  window.onresize = resize;
  $("#f-back").onclick = () => {
    cancelAnimationFrame(fieldRAF);
    gm.gs.location = "base";
    gm.phase = "base";
    gm.advanceTime(1);
    checkEvents();
    renderPhase();
  };
  const shopBtn = document.querySelector("#f-shop") as HTMLElement | null;
  if (shopBtn) shopBtn.onclick = () => { cancelAnimationFrame(fieldRAF); openDogShop(); };

  const loop = () => {
    if (gm.phase !== "map" || !field) return;
    if (fieldTick() === "drown") { handleFieldDrown(); return; }
    let dx = 0, dy = 0;
    const sp = 0.12;
    if (keys.has("ArrowUp") || keys.has("w") || keys.has("1")) dy -= sp; // 1=上移動（ユーザー指定）
    if (keys.has("ArrowDown") || keys.has("s")) dy += sp;
    if (keys.has("ArrowLeft") || keys.has("a")) dx -= sp;
    if (keys.has("ArrowRight") || keys.has("d")) dx += sp;
    const hit = field.move(dx, dy);
    field.render(canvas, gm.gs.slot);
    if (hit) { handleFieldContact(hit); return; }
    fieldRAF = requestAnimationFrame(loop);
  };
  fieldRAF = requestAnimationFrame(loop);
}

const MOVE_FAIL_REASONS: Record<string, string> = {
  storm: "嵐だ……海には近づけない。",
  high_tide: "満潮で徒歩ルートが水没している。干潮（朝・昼）を待とう。",
  need_boat: "小舟の修理材がないと渡れない。（工作: 木材×5+帆布×1）",
  holder_coma: "保持者が昏睡していて、みんなを導けない……",
};

function handleFieldContact(s: FieldSymbol): void {
  if (!field) return;
  switch (s.kind) {
    case "hazard": {
      // 溶岩流（第3巻4-1: 触れるとダメージ+大火傷判定）
      const f = DB.config.field;
      const holder = gm.party.getHolder();
      const dmg = Math.max(1, Math.round(holder.maxHp * f.lava_damage_ratio));
      holder.hp = Math.max(1, holder.hp - dmg);
      let msg = `溶岩流だ！　${DB.characters[holder.id].name}に${dmg}のダメージ！`;
      const burnImmune = holder.id === "jinpachi"
        && (DB.characters["jinpachi"].ability_battle as any).burn_immunity;
      if (!burnImmune && holder.status.burn === undefined && gm.rng.chance(f.lava_burn_chance)) {
        holder.status.burn = DB.config.status_timers.burn_death_days;
        msg += "　大火傷を負った！";
      }
      log(msg, true);
      renderHUD();
      field.removeSymbol(s);
      fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
      return;
    }
    case "drift": {
      // 漂着物（第3巻4-8: 毎日1回・嵐翌日2倍）
      const found = gm.collectDrift();
      for (const id of found) log(`浜辺に${DB.items[id].name}が流れ着いていた！`);
      field.removeSymbol(s);
      fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
      return;
    }
    case "fishing": {
      // 釣り（第3巻4-4: 供物の魚を安定確保）
      gm.gs.inventory["fish"] = (gm.gs.inventory["fish"] ?? 0) + 1;
      log("魚を釣り上げた！（供物にも食料にもなる）");
      field.removeSymbol(s);
      fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
      return;
    }
    case "exit": {
      cancelAnimationFrame(fieldRAF);
      const r = gm.moveTo(s.exitTo!);
      if (!r.ok) {
        log(MOVE_FAIL_REASONS[r.reason ?? ""] ?? `${DB.maps[s.exitTo!].name}へは渡れない。`);
        gm.phase = "map";
        renderFieldLoopResume();
        return;
      }
      log(`${DB.maps[s.exitTo!].name}へ移動した。`);
      for (const d of r.deaths) log(`${DB.characters[d].name}はしびれたまま危険地帯に踏み込み、還らなかった…`, true);
      if (gm.phase === "gameover") { renderPhase(); return; }
      startField(s.exitTo!);
      checkEvents();
      renderHUD();
      return;
    }
    case "gather": {
      const item = s.gatherItem!;
      // ムニ「おてつだい」: ムニ同行時、採取量+1（第2巻）
      const muniBonus = gm.gs.flags["eff_muni_gather_up"]
        && gm.party.getActiveMembers().some((c) => c.id === "muni") ? 1 : 0;
      gm.gs.inventory[item] = (gm.gs.inventory[item] ?? 0) + 1 + muniBonus;
      log(`${DB.items[item].name}を手に入れた。${muniBonus ? "（ムニが余分に見つけた！）" : ""}`);
      field.removeSymbol(s);
      fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
      return;
    }
    case "shrine": {
      if (performance.now() < shrineCooldownUntil) {
        fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
        return;
      }
      cancelAnimationFrame(fieldRAF);
      openShrine(s.shrine as "fire" | "water");
      return;
    }
    case "enemy": case "boss": {
      if (s.kind === "boss" && !gm.bossUnlocked(s.bossId!)) {
        log("……まだその時ではないようだ。（出現条件未達成）");
        field.removeSymbol(s);
        fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
        return;
      }
      cancelAnimationFrame(fieldRAF);
      const enc = field.buildEncounter(s, gm.gs.tide);
      field.removeSymbol(s);
      openMemberSelect(enc.enemyIds, enc.isBoss, enc.bossId);
      return;
    }
  }
}

function renderFieldLoopResume(): void {
  // 採取後にループ再開
  const canvas = $("#field-canvas") as HTMLCanvasElement | null;
  if (!canvas || !field) return;
  const loop = () => {
    if (gm.phase !== "map" || !field) return;
    if (fieldTick() === "drown") { handleFieldDrown(); return; }
    let dx = 0, dy = 0;
    const sp = 0.12;
    if (keys.has("ArrowUp") || keys.has("w") || keys.has("1")) dy -= sp; // 1=上移動（ユーザー指定）
    if (keys.has("ArrowDown") || keys.has("s")) dy += sp;
    if (keys.has("ArrowLeft") || keys.has("a")) dx -= sp;
    if (keys.has("ArrowRight") || keys.has("d")) dx += sp;
    const hit = field.move(dx, dy);
    field.render(canvas, gm.gs.slot);
    if (hit) { handleFieldContact(hit); return; }
    fieldRAF = requestAnimationFrame(loop);
  };
  fieldRAF = requestAnimationFrame(loop);
}

function nudgeAwayFromShrine(): void {
  // 参拝後にプレイヤーを祠の接触半径外へ＋数秒の再接触クールダウン
  if (field) field.py = Math.min(field.map.size[1] - 1, field.py + 2.5);
  shrineCooldownUntil = performance.now() + 4000;
}

function openShrine(goddess: "fire" | "water"): void {
  const name = goddess === "fire" ? "炎の女神の祠" : "水の女神の祠";
  const family = goddess === "fire" ? "meat" : "fish";
  const offers = Object.entries(gm.gs.inventory)
    .filter(([id, n]) => n > 0 && DB.items[id]?.family === family);
  const left = gm.tribute.remainingDays(goddess);
  showModal(name,
    `供物の期限：あと${left}日\n\n` +
    (offers.length === 0 ? "捧げられる供物を持っていない…\n" :
      offers.map(([id, n]) => `<button class="small offer-btn" data-id="${id}">${DB.items[id].name} ×${n} を捧げる</button>`).join(" ")),
    () => { nudgeAwayFromShrine(); gm.phase = "map"; renderFieldLoopResume(); });
  document.querySelectorAll(".offer-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const r = gm.tribute.offer(goddess, (b as HTMLElement).dataset.id!);
      log(r.line, true);
      document.querySelector(".modal-back")?.remove();
      renderHUD();
      nudgeAwayFromShrine();
      gm.phase = "map";
      renderFieldLoopResume();
    };
  });
}

// ============ Battle ============
function openMemberSelect(enemyIds: string[], isBoss: boolean, bossId?: string): void {
  const active = gm.party.getActiveMembers();
  const enemyNames = enemyIds.map((id) => getEnemyDef(id).name).join("、");
  // 初期選択: 保持者＋保持者との信頼度上位（最大4人）。
  // 保持者単独では防御/逃げるしかできず「操作不能」に見えるため（第4巻5-2-2の掟）
  const others = active.filter((c) => c.id !== gm.gs.holder)
    .sort((x, y) => gm.trust.pair(gm.gs.holder, y.id) - gm.trust.pair(gm.gs.holder, x.id));
  battleMembers = [gm.gs.holder, ...others.slice(0, DB.config.BATTLE_MEMBERS_MAX - 1).map((c) => c.id)];
  const back = document.createElement("div");
  back.className = "modal-back";
  const memberBtns = active.map((c) => {
    const isHolder = c.id === gm.gs.holder;
    return `<button class="small mem-btn ${battleMembers.includes(c.id) ? "selected" : ""}" data-id="${c.id}">
      ${isHolder ? "🌱" : ""}${DB.characters[c.id].name} Lv${c.level}</button>`;
  }).join(" ");
  back.innerHTML = `<div class="modal"><h2>⚔️ ${enemyNames}が現れた！</h2>
    <p>戦闘に参加するメンバーを選べ（最大${DB.config.BATTLE_MEMBERS_MAX}人・保持者の参加は任意）</p>
    <p style="font-size:12px;color:#9ab">クリックで選択／Enterキーですぐ戦闘開始</p>
    <div class="row" style="margin-top:10px">${memberBtns}</div>
    <div class="modal-actions"><button id="battle-start">戦闘開始</button></div></div>`;
  document.body.appendChild(back);
  back.querySelectorAll(".mem-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (battleMembers.includes(id)) {
        battleMembers = battleMembers.filter((x) => x !== id);
        b.classList.remove("selected");
      } else if (battleMembers.length < DB.config.BATTLE_MEMBERS_MAX) {
        battleMembers.push(id);
        b.classList.add("selected");
      }
    };
  });
  (back.querySelector("#battle-start") as HTMLElement).onclick = () => {
    if (battleMembers.length === 0) return;
    back.remove();
    battle = gm.startBattle(enemyIds, battleMembers, isBoss, bossId);
    for (const line of battle.log.lines) log(line, true);
    pendingCommands = [];
    commandIndex = 0;
    renderPhase();
  };
}

let pendingCommands: Command[] = [];
let commandIndex = 0;

function renderBattle(): void {
  if (!battle) return;
  const b = battle;
  const actors = b.allies.filter((a) => !a.state.downed && !(a as any).betrayed);
  const actor = actors[commandIndex];

  const allyCards = b.allies.map((a) => {
    const d = DB.characters[a.state.id];
    const hpPct = Math.round((a.state.hp / a.state.maxHp) * 100);
    const spPct = Math.round((a.state.sp / a.state.maxSp) * 100);
    const betrayed = (a as any).betrayed ? " 😈裏切り" : "";
    const isActive = actor && a.state.id === actor.state.id;
    return `<div class="unit-card ${a.state.downed ? "downed" : ""} ${a.state.id === gm.gs.holder ? "holder" : ""} ${isActive ? "active" : ""}">
      <div class="name">${isActive ? "▶ " : ""}${d.name} Lv${a.state.level}${betrayed} ${statusBadges(a.state)}</div>
      <div class="bar"><div class="bar-fill hp ${hpPct < 30 ? "low" : ""}" style="width:${hpPct}%"></div></div>
      <div style="font-size:11px">HP ${a.state.hp}/${a.state.maxHp}</div>
      <div class="bar"><div class="bar-fill sp" style="width:${spPct}%"></div></div>
      <div style="font-size:11px">SP ${a.state.sp}/${a.state.maxSp}</div>
    </div>`;
  }).join("");

  // 敵HPバーは表示しない（第13巻16-4: ダメージログと外見で推測）。Lv表示・予告は「！」
  const enemyCards = b.enemies.map((e, i) => {
    const mark = e.telegraphed ? ' <span style="color:var(--danger);font-size:18px">！</span>' : "";
    const tamed = e.tamedTurns ? ` 🐾あと${e.tamedTurns}T` : "";
    return `<div class="unit-card enemy ${e.alive ? "" : "downed"}" data-ei="${i}">
      <div class="name">${e.def.name} Lv${e.level}${mark}${tamed}</div>
    </div>`;
  }).join("");

  // 戦闘中ミニログ（直近の出来事を戦場内に表示。下部ログと二重掲示で見落とし防止）
  const recentLog = b.log.lines.slice(-4)
    .map((l) => `<div class="battle-log-line">${l}</div>`).join("");

  // ターン順表示（第13巻16-4: 素早さ降順プレビュー）
  const order = [
    ...b.allies.filter((a) => !a.state.downed).map((a) => ({
      name: DB.characters[a.state.id].name,
      spd: statAtLevelUI(a.state.id, "spd", a.state.level),
    })),
    ...b.enemies.filter((e) => e.alive).map((e) => ({ name: e.def.name, spd: e.spd })),
  ].sort((x, y) => y.spd - x.spd).map((x) => x.name).join("→");

  let commandHtml = "";
  if (actor) {
    const d = DB.characters[actor.state.id];
    const cmds = b.availableCommands(actor.state.id);
    const isHolder = actor.state.id === gm.gs.holder;
    const names: Record<string, string> = {
      attack: "⚔️ たたかう", skill: "✨ わざ", guard: "🛡️ ぼうぎょ",
      protect: "🤝 かばう", item: "🎒 アイテム", flee: "🏃 にげる",
      tame: "🐾 手なずける", persuade: "💬 説得",
    };
    // 保持者は「たたかう/わざ」をグレーアウト表示（第13巻16-4・原設定）
    const display: string[] = isHolder
      ? ["attack", "skill", ...cmds.filter((c) => c !== "attack" && c !== "skill")]
      : [...cmds];
    const btns = display.map((c) => {
      const enabled = cmds.includes(c as any);
      return `<button class="cmd-btn" data-cmd="${c}" ${enabled ? "" : "disabled"}>${names[c]}</button>`;
    }).join("");
    // 保持者の掟の明示（たたかう/わざが灰色の理由。第0巻0-3-6）
    const hint = isHolder
      ? `<div class="cmd-hint">🌱 保持者は掟により「たたかう」「わざ」を使えない ― 防御・庇う・アイテム・逃げるで戦おう</div>`
      : "";
    commandHtml = `<div class="cmd-actor">▶ <b>${d.name}</b> のばん　<span class="cmd-sub">コマンドを選んでね</span></div>${hint}<div class="cmd-row">${btns}</div>`;
  }

  screen().innerHTML = `
    <div class="battle-wrap">
      <div class="turn-order">ターン${b.turn + 1}　|　行動順: ${order}</div>
      <div class="battle-field">
        <div class="battle-side">${allyCards}</div>
        <div style="font-size:40px">⚔️</div>
        <div class="battle-side">${enemyCards}</div>
      </div>
      <div class="battle-log-mini">${recentLog || "<div class=\"battle-log-line\">戦闘開始——コマンドを選ぼう</div>"}</div>
      <div class="battle-commands" id="battle-commands">${commandHtml}</div>
    </div>`;

  if (!actor) return;
  screen().querySelectorAll(".cmd-btn").forEach((btn) => {
    (btn as HTMLElement).onclick = () => selectCommand(actor.state, (btn as HTMLElement).dataset.cmd as Command["kind"]);
  });
}

function selectCommand(actor: CharacterState, kind: Command["kind"]): void {
  const b = battle!;
  const cmdBar = $("#battle-commands");

  const pushAndNext = (cmd: Command) => {
    pendingCommands.push(cmd);
    commandIndex++;
    const actors = b.allies.filter((a) => !a.state.downed && !(a as any).betrayed);
    if (commandIndex >= actors.length) {
      execBattleTurn();
    } else {
      renderBattle();
    }
  };

  switch (kind) {
    case "guard": case "flee":
      pushAndNext({ kind, actorId: actor.id });
      return;
    case "tame": {
      const beasts = b.enemies.map((e, i) =>
        e.alive && !e.tamedTurns && e.def.family === "beast" && !e.def.boss
          ? `<button class="cmd-btn t-btn" data-i="${i}">${e.def.name}</button>` : "").join(" ");
      cmdBar.innerHTML = `<b>どの獣を手なずける？</b> ${beasts} <button class="cmd-btn cmd-back" id="tm-back">↩ 戻る</button>`;
      ($("#tm-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".t-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetEnemyIndex: Number((t as HTMLElement).dataset.i) });
      });
      return;
    }
    case "persuade": {
      const betrayed = b.allies.filter((a) => (a as any).betrayed).map((a) =>
        `<button class="cmd-btn p-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}</button>`).join(" ");
      cmdBar.innerHTML = `<b>誰を説得する？</b> ${betrayed} <button class="cmd-btn cmd-back" id="ps-back">↩ 戻る</button>`;
      ($("#ps-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".p-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetAllyId: (t as HTMLElement).dataset.id });
      });
      return;
    }
    case "attack": {
      const targets = b.enemies.map((e, i) => e.alive && !e.tamedTurns
        ? `<button class="cmd-btn t-btn" data-i="${i}">${e.def.name}</button>` : "").join(" ");
      cmdBar.innerHTML = `<b>どの敵を攻撃？</b> ${targets}`;
      cmdBar.querySelectorAll(".t-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetEnemyIndex: Number((t as HTMLElement).dataset.i) });
      });
      return;
    }
    case "skill": {
      const learned = skillsForCharacter(actor.id)
        .filter(([, sk]) => sk.learn_lv <= actor.level);
      const btns = learned.map(([sid, raw]) => {
        const s = enhancedSkill(raw, actor.level);
        const ok = actor.sp >= s.sp_cost;
        return `<button class="cmd-btn sk-btn" data-sid="${sid}" ${ok ? "" : "disabled"}>${s.name}（SP${s.sp_cost}）</button>`;
      }).join(" ");
      cmdBar.innerHTML = `<b>どの技？</b> ${btns} <button class="cmd-btn cmd-back" id="sk-back">↩ 戻る</button>`;
      ($("#sk-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".sk-btn").forEach((t) => {
        (t as HTMLElement).onclick = () => {
          const sid = (t as HTMLElement).dataset.sid!;
          const s = DB.skills[sid];
          if ((s.kind === "support" || s.kind === "heal") && (s.target === "ally_all" || s.target === "self")) {
            pushAndNext({ kind, actorId: actor.id, skillId: sid });
          } else if ((s.kind === "support" || s.kind === "heal") && s.target === "ally_single") {
            const allies = b.allies.filter((a) => !a.state.downed).map((a) =>
              `<button class="cmd-btn at-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}</button>`).join(" ");
            cmdBar.innerHTML = `<b>誰に？</b> ${allies}`;
            cmdBar.querySelectorAll(".at-btn").forEach((ab) => {
              (ab as HTMLElement).onclick = () =>
                pushAndNext({ kind, actorId: actor.id, skillId: sid, targetAllyId: (ab as HTMLElement).dataset.id });
            });
          } else {
            const targets = b.enemies.map((e, i) => e.alive && !e.tamedTurns
              ? `<button class="cmd-btn t-btn" data-i="${i}">${e.def.name}</button>` : "").join(" ");
            // 光属性技は裏切り味方への浄化にも使える（第4巻5-9）
            const isLight = s.effects.some((e2) => e2.type === "anti_demon");
            const betrayedBtns = isLight
              ? b.allies.filter((a) => (a as any).betrayed).map((a) =>
                `<button class="cmd-btn bt-btn" data-id="${a.state.id}">✨${DB.characters[a.state.id].name}を浄化</button>`).join(" ")
              : "";
            cmdBar.innerHTML = `<b>どの敵に？</b> ${targets} ${betrayedBtns}`;
            cmdBar.querySelectorAll(".t-btn").forEach((tb) => {
              (tb as HTMLElement).onclick = () =>
                pushAndNext({ kind, actorId: actor.id, skillId: sid, targetEnemyIndex: Number((tb as HTMLElement).dataset.i) });
            });
            cmdBar.querySelectorAll(".bt-btn").forEach((tb) => {
              (tb as HTMLElement).onclick = () =>
                pushAndNext({ kind, actorId: actor.id, skillId: sid, targetAllyId: (tb as HTMLElement).dataset.id });
            });
          }
        };
      });
      return;
    }
    case "protect": {
      const others = b.allies.filter((a) => !a.state.downed && !(a as any).betrayed && a.state.id !== actor.id);
      // 対象ごとの成功率%をリアルタイム表示（第13巻16-4: 信頼度が数字で効く実感）
      const btns = others.map((a) =>
        `<button class="cmd-btn p-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}（${b.protectRatePreview(actor.id, a.state.id)}%）</button>`).join(" ");
      cmdBar.innerHTML = `<b>誰を庇う？</b> ${btns} <button class="cmd-btn cmd-back" id="p-back">↩ 戻る</button>`;
      ($("#p-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".p-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetAllyId: (t as HTMLElement).dataset.id });
      });
      return;
    }
    case "item": {
      const usable = Object.entries(gm.gs.inventory).filter(([id, n]) =>
        n > 0 && DB.items[id]?.category === "medicine" && !DB.items[id]?.field_only);
      if (usable.length === 0) { cmdBar.innerHTML += " <i>使えるものがない</i>"; return; }
      const btns = usable.map(([id, n]) =>
        `<button class="cmd-btn i-btn" data-id="${id}">${DB.items[id].name}×${n}</button>`).join(" ");
      cmdBar.innerHTML = `<b>どれを使う？</b> ${btns} <button class="cmd-btn cmd-back" id="i-back">↩ 戻る</button>`;
      ($("#i-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".i-btn").forEach((t) => {
        (t as HTMLElement).onclick = () => {
          const itemId = (t as HTMLElement).dataset.id!;
          const allies = b.allies.filter((a) => !a.state.downed).map((a) =>
            `<button class="cmd-btn at-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}</button>`).join(" ");
          cmdBar.innerHTML = `<b>誰に使う？</b> ${allies}`;
          cmdBar.querySelectorAll(".at-btn").forEach((ab) => {
            (ab as HTMLElement).onclick = () => {
              gm.gs.inventory[itemId]--;
              pushAndNext({ kind, actorId: actor.id, itemId, targetAllyId: (ab as HTMLElement).dataset.id });
            };
          });
        };
      });
      return;
    }
  }
}

function execBattleTurn(): void {
  const b = battle!;
  const before = b.log.lines.length;
  const outcome = b.executeTurn(pendingCommands);
  for (const line of b.log.lines.slice(before)) log(line);
  pendingCommands = [];
  commandIndex = 0;

  if (outcome === "ongoing") { renderBattle(); return; }

  // 戦闘終了
  const beforeSettle = b.log.lines.length;
  const nb = nightBattle;
  nightBattle = null;
  const result = nb?.kind === "dream"
    ? gm.settleDreamBattle(nb.dreamer)
    : gm.settleBattle();
  for (const line of b.log.lines.slice(beforeSettle)) log(line, true);
  battle = null;

  if (gm.phase === "gameover") { renderPhase(); return; }
  if (nb) {
    if (nb.kind === "dream") {
      const name = DB.characters[nb.dreamer].name;
      if (result.outcome === "victory") log(`${name}は夢魔を打ち払い、安らかな眠りについた。（HP+10%）`, true);
      else if (result.outcome === "defeat") log(`${name}は悪夢に呑まれ、昏睡状態に陥った…（3〜5日で目覚める）`, true);
      else log(`${name}は夢から逃れ、浅い眠りについた。`);
    } else {
      if (result.outcome === "victory") log("悪魔の夜襲を退けた！", true);
    }
    finishSleep();
    return;
  }
  for (const dead of result.deaths) {
    log(`${DB.characters[dead].name}は帰らぬ人となった…（湖の祠で蘇生できる）`, true);
  }
  for (const k of result.kidnapped) {
    log(`${DB.characters[k].name}が海賊にさらわれた！ 海賊船の最深部で船長を倒せば取り戻せる。`, true);
  }
  for (const p of result.possessed) {
    if (p !== gm.gs.holder) log(`${DB.characters[p].name}が悪魔に取り憑かれた…放置すれば3日で島を去ってしまう。ネオの光か説得で救えるはずだ。`, true);
  }
  checkEvents();
  renderPhase();
}

// ============ 夜イベント（M2 SleepTickフック接続）============
function finishSleep(): void {
  log("みんなで眠りについた…");
  gm.endDay();
  // 絆の要約（第9巻12-7:「AとBの絆が深まった気がする」）
  for (const line of gm.lastBondSummary) log(line);
  checkEvents();
  renderPhase();
  if (gm.gs && !gm.gs.gameOver && gm.phase !== "ending") {
    log(`${gm.gs.day}日目の朝。天候は${gm.weather.name(gm.gs.weather)}。`);
  }
}

// 悪魔の夜襲: 選択肢と信頼度で裏切り回避（第9巻12-5-2・正本）
function openNightRaidChoice(): void {
  const targetId = gm.nightRaidTarget();
  const name = DB.characters[targetId].name;
  // 3択構成: 正解/中立/不正解（12-5-1。文言は【AI提案】）
  const choices: { text: string; grade: "correct" | "neutral" | "wrong" }[] = [
    { text: `「${name}、そばにいる。大丈夫だ」——名前を呼び、隣に立つ`, grade: "correct" },
    { text: "無言で武器を構え、周囲を警戒する", grade: "neutral" },
    { text: "とっさに距離を取って様子を見る", grade: "wrong" },
  ];
  // 並び順はランダム（正解の位置を固定しない）
  for (let i = choices.length - 1; i > 0; i--) {
    const j = gm.rng.int(0, i);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><h2>😈 悪魔の囁き</h2>
    <p>闇の中、悪魔が${name}に狙いを定めた。${name}の目が虚ろに揺れている——どうする？</p>
    <div class="menu-list" style="margin-top:14px">${choices.map((c, i) =>
      `<button class="raid-choice" data-i="${i}" style="min-width:420px">${c.text}</button>`).join("")}</div></div>`;
  document.body.appendChild(back);
  back.querySelectorAll(".raid-choice").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      back.remove();
      const grade = choices[Number((b as HTMLElement).dataset.i)].grade;
      const r = gm.resolveNightRaidChoice(targetId, grade);
      if (gm.phase === "gameover") { renderPhase(); return; } // 保持者で失敗=即GO
      if (r.possessed) {
        log(`${name}は悪魔に取り憑かれてしまった…（回避率${Math.round(r.rate)}%）`, true);
        log("3日以内にネオの光か説得で救わなければ、島を去ってしまう。", true);
      } else {
        log(`${name}は踏みとどまった！（回避率${Math.round(r.rate)}%）`, true);
      }
      openNightRaidSelect();
    };
  });
}

function openNightRaidSelect(): void {
  const active = gm.party.getActiveMembers();
  const raidOthers = active.filter((c) => c.id !== gm.gs.holder)
    .sort((x, y) => gm.trust.pair(gm.gs.holder, y.id) - gm.trust.pair(gm.gs.holder, x.id));
  battleMembers = [gm.gs.holder, ...raidOthers.slice(0, DB.config.BATTLE_MEMBERS_MAX - 1).map((c) => c.id)];
  const back = document.createElement("div");
  back.className = "modal-back";
  const memberBtns = active.map((c) => {
    const isHolder = c.id === gm.gs.holder;
    return `<button class="small mem-btn ${battleMembers.includes(c.id) ? "selected" : ""}" data-id="${c.id}" ${isHolder ? "disabled" : ""}>
      ${isHolder ? "🌱" : ""}${DB.characters[c.id].name} Lv${c.level}</button>`;
  }).join(" ");
  back.innerHTML = `<div class="modal"><h2>😈 悪魔の夜襲！</h2>
    <p>拠点を守るメンバーを選べ（最大${DB.config.BATTLE_MEMBERS_MAX}人・保持者は必ず参加）</p>
    <div class="row" style="margin-top:10px">${memberBtns}</div>
    <div class="modal-actions"><button id="raid-start">迎え撃つ</button></div></div>`;
  document.body.appendChild(back);
  back.querySelectorAll(".mem-btn:not([disabled])").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (battleMembers.includes(id)) {
        battleMembers = battleMembers.filter((x) => x !== id);
        b.classList.remove("selected");
      } else if (battleMembers.length < DB.config.BATTLE_MEMBERS_MAX) {
        battleMembers.push(id);
        b.classList.add("selected");
      }
    };
  });
  (back.querySelector("#raid-start") as HTMLElement).onclick = () => {
    back.remove();
    nightBattle = { kind: "raid" };
    battle = gm.startNightRaidBattle(battleMembers);
    for (const line of battle.log.lines) log(line, true);
    pendingCommands = [];
    commandIndex = 0;
    renderPhase();
  };
}

// ============ ドグの店（第7巻8-0: 購入=売値×3）============
function openDogShop(): void {
  const stock = ["antidote", "burn_salve", "numb_cure", "plague_cure", "herb_red", "herb_blue", "herb_green", "herb_yellow", "wood", "iron_ore", "rum"];
  const buyRows = stock.map((id) =>
    `<button class="small buy-btn" data-id="${id}">${DB.items[id].name} — ${gm.buyPrice(id)}銀貨</button>`).join(" ");
  const sellables = Object.entries(gm.gs.inventory)
    .filter(([id, n]) => n > 0 && DB.items[id]?.sell != null && DB.items[id].category !== "key_item");
  const sellRows = sellables.map(([id, n]) =>
    `<button class="small sell-btn" data-id="${id}">${DB.items[id].name}×${n} — ${DB.items[id].sell}銀貨で売る</button>`).join(" ");
  const discount = gm.gs.flags["dog_discount"];
  showModal("🏪 海賊商人ドグ",
    `${DB.npcLines.dog.open}（所持: ${gm.gs.silver}銀貨）\n\n【買う（売値の${discount ? "2.5倍・お得意様価格" : "3倍"}）】\n${buyRows}\n\n【売る】\n${sellRows || "<i>売れるものがない</i>"}`,
    () => { gm.phase = "map"; renderFieldLoopResume(); });
  document.querySelectorAll(".buy-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (gm.buyItem(id)) log(`${DB.items[id].name}を買った。（残り${gm.gs.silver}銀貨）`);
      else log("銀貨が足りない。");
      renderHUD();
    };
  });
  document.querySelectorAll(".sell-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (gm.sellItem(id)) log(`${DB.items[id].name}を売った。（所持${gm.gs.silver}銀貨）`);
      renderHUD();
    };
  });
}

// ============ Events ============
function checkEvents(): void {
  if (!gm.gs || gm.phase === "gameover" || gm.phase === "ending") return;
  const evs = gm.events.evaluateTriggers();
  for (const ev of evs.slice(0, 1)) {
    playEvent(ev.id);
  }
}

function playEvent(id: string): void {
  const played = gm.events.play(id);
  if (!played) return;
  showModal(played.title ?? "💬", played.text, () => {
    // 350日決戦: シーン再生後に強制ボス戦（第10巻）
    if (played.startsBoss) openBossBattleSelect(played.startsBoss);
  });
  log(`（イベント: ${played.title ?? id}）`);
}

// 強制ボス戦のメンバー選択（第10巻: 350日決戦「悪魔の首魁」等）
function openBossBattleSelect(bossId: string): void {
  const bossDef = getEnemyDef(bossId);
  const active = gm.party.getActiveMembers();
  battleMembers = [gm.gs.holder];
  const back = document.createElement("div");
  back.className = "modal-back";
  const memberBtns = active.map((c) => {
    const isHolder = c.id === gm.gs.holder;
    return `<button class="small mem-btn ${isHolder ? "selected" : ""}" data-id="${c.id}" ${isHolder ? "disabled" : ""}>
      ${isHolder ? "🌱" : ""}${DB.characters[c.id].name} Lv${c.level}</button>`;
  }).join(" ");
  back.innerHTML = `<div class="modal"><h2>⚔️ 決戦 — ${bossDef.name}</h2>
    <p>出撃メンバーを選べ（最大${DB.config.BATTLE_MEMBERS_MAX}人・保持者は必ず参加）</p>
    <div class="row" style="margin-top:10px">${memberBtns}</div>
    <div class="modal-actions"><button id="boss-start">挑む</button></div></div>`;
  document.body.appendChild(back);
  back.querySelectorAll(".mem-btn:not([disabled])").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const id = (b as HTMLElement).dataset.id!;
      if (battleMembers.includes(id)) {
        battleMembers = battleMembers.filter((x) => x !== id);
        b.classList.remove("selected");
      } else if (battleMembers.length < DB.config.BATTLE_MEMBERS_MAX) {
        battleMembers.push(id);
        b.classList.add("selected");
      }
    };
  });
  (back.querySelector("#boss-start") as HTMLElement).onclick = () => {
    back.remove();
    nightBattle = null;
    battle = gm.startBattle([bossId], battleMembers, true, bossId);
    for (const line of battle.log.lines) log(line, true);
    pendingCommands = [];
    commandIndex = 0;
    renderPhase();
  };
}

// 掛け合い・個人・隠し・庇う特別の再生（第11巻・TalkManager）
function playTalk(id: string): void {
  const played = gm.talks.play(id);
  if (!played) return;
  const body = played.text + (played.rewardLines.length > 0 ? "\n\n" + played.rewardLines.join("\n") : "");
  showModal(played.title, body, () => {
    if (id === "hidden_goddess") {
      gm.joinGoddess();
      log("湖の女神が仲間に加わった！", true);
    }
    renderPhase();
  });
  log(`（会話: ${played.title}）`);
}

// ============ Ending / GameOver ============
function renderEnding(neoChoice?: "return" | "stay"): void {
  cancelAnimationFrame(fieldRAF);
  const ed = gm.finalizeEnding(neoChoice);
  // ネオルート: 帰還/残留の選択（第12巻15-4-1）
  if (ed.needsNeoChoice) {
    screen().innerHTML = `
      <div class="screen-inner" style="text-align:center;padding-top:80px">
        <h2 class="section-title" style="border:none;text-align:center">「帰り道の裂け目」の前で</h2>
        <p style="max-width:640px;margin:24px auto;line-height:2.2">365日目。次元の裂け目が、静かに口を開けている。
王子は、種を仲間に返し、裂け目と焚き火を交互に見た。
——選ぶのは、いまだ。</p>
        <div class="menu-list" style="margin-top:32px">
          <button id="neo-return">アルカディアへ帰還する</button>
          <button id="neo-stay">この世界に残る</button>
        </div>
      </div>`;
    $("#neo-return").onclick = () => renderEnding("return");
    $("#neo-stay").onclick = () => renderEnding("stay");
    return;
  }
  const body = ed.texts.filter(Boolean).join("\n\n＊　＊　＊\n\n");
  screen().innerHTML = `
    <div class="screen-inner" style="max-width:760px;margin:0 auto">
      <h1 class="title-logo" style="font-size:32px;margin-top:40px">${ed.gradeName}</h1>
      <p class="subtitle">${ed.name}（${ed.id}）</p>
      <div style="line-height:2.2;white-space:pre-wrap;margin:24px 0">${body}</div>
      <p style="color:#9ab;text-align:center">365日を生き延びた。実績解除数: ${gm.gs.achievements.length}/${DB.achievements.length}</p>
      <div class="menu-list" style="margin:32px 0"><button id="ed-title">タイトルへ（周回: ギャラリー・実績は引き継ぎ）</button></div>
    </div>`;
  $("#ed-title").onclick = () => { gm.phase = "title"; renderTitle(); };
}

function renderGameOver(): void {
  cancelAnimationFrame(fieldRAF);
  const go = DB.endings.gameover;
  const reason = gm.gs.gameOver;
  const info = Object.values(go).find((g: any) => g.reason === reason) as any;
  screen().innerHTML = `
    <div class="screen-inner" style="text-align:center;padding-top:80px">
      <h1 class="title-logo" style="font-size:40px;color:var(--danger)">GAME OVER</h1>
      <p style="font-size:18px;margin:16px">${info?.name ?? ""}</p>
      <p style="color:#9ab;white-space:pre-wrap;max-width:640px;margin:0 auto;line-height:2.0">${info?.text ?? ""}</p>
      <p style="color:#9ab;margin-top:16px">${gm.gs.day}日目のことだった。</p>
      <div class="menu-list" style="margin-top:32px">
        <button id="go-load">オートセーブから再開（最大1日分の巻き戻し）</button>
        <button id="go-title">タイトルへ</button>
      </div>
    </div>`;
  $("#go-load").onclick = () => {
    if (gm.loadGame("auto_0") || gm.loadGame("auto_1") || gm.loadGame("auto_2")) {
      log("オートセーブから再開した。", true);
      renderPhase();
    }
  };
  $("#go-title").onclick = () => { gm.phase = "title"; renderTitle(); };
}

// ============ Boot ============
renderTitle();
log("ホープシード ～無人島サバイバルRPG～");

// E2E/デバッグ用フック（ゲームロジックには不使用）
(window as any).__hopeseed = { gm, getField: () => field };
