// ホープシード メインUI（GDD第16巻20-4-1 FSMに沿った画面遷移）。
// Title → HolderSelect → DayLoop(Base⇄Map⇄Battle) → Ending/GameOver。

import { DB } from "./dataLoader.js";
import { GameManager } from "./core/gameManager.js";
import { FieldState, type FieldSymbol } from "./field/field.js";
import { rulebookText } from "./ui/rulebook.js";
import type { BattleManager, Command } from "./core/battle/battleManager.js";
import type { CharacterState } from "./types.js";

const gm = new GameManager();
let field: FieldState | null = null;
let battle: BattleManager | null = null;
let battleMembers: string[] = [];
let logBuffer: string[] = [];
let fieldRAF = 0;

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const screen = () => $("#screen");
const keys = new Set<string>();

window.addEventListener("keydown", (e) => keys.add(e.key));
window.addEventListener("keyup", (e) => keys.delete(e.key));

function log(line: string, important = false): void {
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  const el = $("#log-panel");
  el.innerHTML = logBuffer.slice(-60)
    .map((l) => `<div class="log-line${important && l === line ? " important" : ""}">${l}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

// ============ HUD ============
function renderHUD(): void {
  const el = $("#hud");
  if (!gm.gs) { el.innerHTML = ""; return; }
  const slotNames: Record<string, string> = { morning: "朝", noon: "昼", evening: "夕", night: "夜" };
  const weatherNames: Record<string, string> = DB.weather.types;
  const fireLeft = gm.tribute.remainingDays("fire");
  const waterLeft = gm.tribute.remainingDays("water");
  const holder = DB.characters[gm.gs.holder].name;
  el.innerHTML = `
    <div class="hud-item"><span class="hud-label">日数</span><span class="hud-value">${gm.gs.day}/${DB.config.DAY_MAX}日</span></div>
    <div class="hud-item"><span class="hud-label">時刻</span><span class="hud-value">${slotNames[gm.gs.slot]}</span></div>
    <div class="hud-item"><span class="hud-label">天候</span><span class="hud-value">${(weatherNames as any)[gm.gs.weather]?.name ?? gm.gs.weather}</span></div>
    <div class="hud-item"><span class="hud-label">潮</span><span class="hud-value">${gm.gs.tide === "high" ? "満潮" : "干潮"}</span></div>
    <div class="hud-item"><span class="hud-label">保持者</span><span class="hud-value">🌱${holder}</span></div>
    <div class="hud-item"><span class="hud-label">空腹</span><span class="hud-value ${gm.gs.hunger <= 20 ? "warn" : ""}">${gm.gs.hunger}/100</span></div>
    <div class="hud-item"><span class="hud-label">炎の供物</span><span class="hud-value ${fireLeft <= 3 ? "warn" : ""}">あと${fireLeft}日</span></div>
    <div class="hud-item"><span class="hud-label">水の供物</span><span class="hud-value ${waterLeft <= 3 ? "warn" : ""}">あと${waterLeft}日</span></div>
    <div class="hud-item"><button class="small" id="btn-rulebook">📖 ルールブック</button></div>
    <div class="hud-item"><button class="small" id="btn-status">👥 なかま</button></div>
    <div class="hud-item"><button class="small" id="btn-items">🎒 もちもの</button></div>
    <div class="hud-item"><button class="small" id="btn-save">💾 セーブ</button></div>
  `;
  $("#btn-rulebook").onclick = () => showModal("ルールブック", rulebookText());
  $("#btn-status").onclick = showPartyStatus;
  $("#btn-items").onclick = showInventory;
  $("#btn-save").onclick = () => {
    gm.save.saveManual(1, gm.gs);
    log("セーブした。（手動スロット1）", true);
  };
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

function showPartyStatus(): void {
  const rows = Object.values(gm.gs.party).map((c) => {
    const d = DB.characters[c.id];
    const st = c.exclusion !== "none"
      ? { dead: "死亡", kidnapped: "誘拐", betrayal: "裏切り", coma: "昏睡" }[c.exclusion]
      : Object.keys(c.status).length > 0 ? Object.keys(c.status).join("/") : "正常";
    return `<tr><td>${c.id === gm.gs.holder ? "🌱" : ""}${d.name}</td><td>Lv${c.level}</td>
      <td>${c.hp}/${c.maxHp}</td><td>${c.sp}/${c.maxSp}</td><td>${st}</td></tr>`;
  }).join("");
  showModal("なかま", `<table class="data"><tr><th>名前</th><th>Lv</th><th>HP</th><th>SP</th><th>状態</th></tr>${rows}</table>
    <p style="margin-top:10px;font-size:12px">保持者との平均信頼度: ${gm.trust.avgHolder().toFixed(1)}</p>`);
}

function showInventory(): void {
  const rows = Object.entries(gm.gs.inventory)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `<tr><td>${DB.items[id]?.name ?? id}</td><td>×${n}</td><td>${DB.items[id]?.desc ?? ""}</td></tr>`)
    .join("");
  showModal("もちもの", `<table class="data"><tr><th>アイテム</th><th>数</th><th>説明</th></tr>${rows || "<tr><td colspan=3>なにも持っていない</td></tr>"}</table>`);
}

// ============ Title ============
function renderTitle(): void {
  cancelAnimationFrame(fieldRAF);
  screen().innerHTML = `
    <div class="screen-inner">
      <h1 class="title-logo">ホープシード</h1>
      <p class="subtitle">～無人島サバイバルRPG～</p>
      <div class="menu-list">
        <button id="btn-new">はじめから</button>
        <button id="btn-load">つづきから</button>
      </div>
    </div>`;
  $("#btn-new").onclick = renderPrologue;
  $("#btn-load").onclick = () => {
    if (gm.loadGame("manual_1") || gm.loadGame("auto_0")) {
      log("記録を読み込んだ。", true);
      renderPhase();
    } else {
      showModal("つづきから", "セーブデータが見つからない。");
    }
  };
}

function renderPrologue(): void {
  screen().innerHTML = `
    <div class="screen-inner" style="max-width:760px;margin:0 auto;padding-top:60px;line-height:2.2">
      <p>嵐の夜、船は砕けた。</p>
      <p>気がつくと、6人は見知らぬ島の湖のほとりに打ち上げられていた。</p>
      <p>そして誰かの手の中に、淡く光る種がひとつ——<b style="color:var(--accent)">ホープシード</b>。</p>
      <p>「その種を持つ者が生きる限り、仲間の魂は何度でも呼び戻せる」</p>
      <p>湖の女神はそう告げた。だが、種を持つ者が失われれば、すべてが終わる。</p>
      <p>365日。救援が来るまでの1年を、この島で生き延びなければならない。</p>
      <div class="menu-list" style="margin-top:32px"><button id="btn-next">ホープシードを託す仲間を選ぶ</button></div>
    </div>`;
  $("#btn-next").onclick = renderHolderSelect;
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
      showModal("確認", `${d.name}にホープシードを託す。\nこの選択はエンディングまで変更できない。よいか？\n\n<button id="confirm-holder">託す</button>`);
      (document.querySelector("#confirm-holder") as HTMLElement).onclick = () => {
        document.querySelector(".modal-back")?.remove();
        gm.newGame(id, Date.now() >>> 0);
        log(`${d.name}がホープシードの保持者となった。`, true);
        checkEvents();
        renderPhase();
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
  const foods = Object.entries(gm.gs.inventory)
    .filter(([id, n]) => n > 0 && DB.items[id]?.category === "food");
  const deadMembers = Object.values(gm.gs.party).filter((c) => c.exclusion === "dead");
  const reviveReady = deadMembers.length > 0
    && (gm.gs.reviveLastDay === 0 || gm.gs.day - gm.gs.reviveLastDay >= DB.config.revive.cooldown_days);

  screen().innerHTML = `
    <div class="screen-inner">
      <h2 class="section-title">🏕️ 湖畔の拠点</h2>
      <div class="row">
        <button id="b-craft-cook">🍳 調理</button>
        <button id="b-craft-build">🔨 工作</button>
        <button id="b-craft-pharmacy">🌿 薬草開発</button>
        <button id="b-eat" ${foods.length === 0 ? "disabled" : ""}>🍖 食事</button>
        <button id="b-revive" ${reviveReady ? "" : "disabled"}>⛩️ 湖の祠（蘇生）</button>
        <button id="b-talk">💬 会話</button>
        <button id="b-rest">😴 休息（就寝して翌日へ）</button>
        <button id="b-out">🗺️ 島へ出る</button>
      </div>
      <div id="base-detail"></div>
    </div>`;

  $("#b-craft-cook").onclick = () => renderCraft("cook");
  $("#b-craft-build").onclick = () => renderCraft("build");
  $("#b-craft-pharmacy").onclick = () => renderCraft("pharmacy");
  $("#b-eat").onclick = () => {
    const detail = $("#base-detail");
    detail.innerHTML = `<h3 class="section-title">なにを食べる？</h3><div class="row">` +
      foods.map(([id, n]) => `<button class="small food-btn" data-id="${id}">${DB.items[id].name} ×${n}</button>`).join("") + "</div>";
    detail.querySelectorAll(".food-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const id = (b as HTMLElement).dataset.id!;
        if (gm.eat(id)) {
          log(`${DB.items[id].name}をみんなで食べた。空腹 ${gm.gs.hunger}/100`);
          gm.advanceTime(1);
          checkEvents();
          renderPhase();
        }
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
          log(DB.npcLines.lake_goddess.revive, true);
          log(`${DB.characters[id].name}が生き返った！`, true);
          gm.trust.add(gm.gs.holder, id, DB.trust.gain.revive, "revive");
          renderPhase();
        }
      };
    });
  };
  $("#b-talk").onclick = () => {
    const evs = gm.events.evaluateTriggers().filter((e) => e.pair || e.id.startsWith("talk"));
    if (evs.length === 0) {
      const all = gm.events.evaluateTriggers();
      if (all.length > 0) { playEvent(all[0].id); return; }
      showModal("会話", "いまは特に話すことがないようだ。（信頼度を上げると会話が生まれる）");
      return;
    }
    playEvent(evs[0].id);
  };
  $("#b-rest").onclick = () => {
    log("みんなで眠りについた…");
    gm.endDay();
    checkEvents();
    renderPhase();
    if (gm.gs && !gm.gs.gameOver) log(`${gm.gs.day}日目の朝。天候は${(DB.weather.types as any)[gm.gs.weather].name}。`);
  };
  $("#b-out").onclick = () => {
    // 拠点からの行き先を選ぶ（拠点マップの接続先）
    const conns = DB.maps["base"].connections;
    const detail = $("#base-detail");
    detail.innerHTML = `<h3 class="section-title">どこへ向かう？（移動で時間が進む）</h3><div class="row">` +
      conns.map((to) => `<button class="small dest-btn" data-to="${to}">${DB.maps[to].name}</button>`).join(" ") + "</div>";
    detail.querySelectorAll(".dest-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const to = (b as HTMLElement).dataset.to!;
        log(`${DB.maps[to].name}へ向かった。`);
        gm.advanceTime(1);
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
      const recipes = gm.craft.availableRecipes(type, crafterId);
      const list = $("#recipe-list");
      list.innerHTML = `<div class="row" style="margin-top:10px">` + (recipes.length === 0
        ? "<p>作れるものがない。</p>"
        : recipes.map((r) => {
          const can = gm.craft.canCraft(r);
          const inputs = r.inputs.map((i: any) => `${DB.items[i.item].name}×${i.qty}`).join(" ");
          return `<button class="small recipe-btn" data-id="${r.id}" ${can ? "" : "disabled"}>${DB.items[r.result].name}（${inputs}）</button>`;
        }).join("")) + "</div>";
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
  const bossDefeated = mapId === "pirate_ship" && !!gm.gs.flags["pirate_captain_defeated"];
  field = new FieldState(mapId, gm.rng, gm.gs.slot, { bossDefeated });
  gm.phase = DB.maps[mapId].is_base ? "base" : "map";
  if (gm.phase === "base") { renderPhase(); return; }
  renderField();
}

function renderField(): void {
  if (!field) { startField(gm.gs.location); return; }
  screen().innerHTML = `
    <canvas id="field-canvas"></canvas>
    <div class="field-overlay">
      <b>${field.map.name}</b><br>
      <span style="font-size:11px">矢印キー/WASDで移動。旗で移動、🌿で採取${field.map.has_shrine ? "、⛩️で参拝" : ""}</span>
    </div>
    <div class="field-actions">
      <button class="small" id="f-back">🏕️ 拠点へ戻る</button>
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

  const loop = () => {
    if (gm.phase !== "map" || !field) return;
    let dx = 0, dy = 0;
    const sp = 0.12;
    if (keys.has("ArrowUp") || keys.has("w")) dy -= sp;
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

function handleFieldContact(s: FieldSymbol): void {
  if (!field) return;
  switch (s.kind) {
    case "exit": {
      cancelAnimationFrame(fieldRAF);
      log(`${DB.maps[s.exitTo!].name}へ移動した。`);
      gm.advanceTime(1);
      if (gm.phase === "gameover") { renderPhase(); return; }
      startField(s.exitTo!);
      checkEvents();
      renderHUD();
      return;
    }
    case "gather": {
      const item = s.gatherItem!;
      gm.gs.inventory[item] = (gm.gs.inventory[item] ?? 0) + 1;
      log(`${DB.items[item].name}を手に入れた。`);
      field.removeSymbol(s);
      fieldRAF = requestAnimationFrame(() => renderFieldLoopResume());
      return;
    }
    case "shrine": {
      cancelAnimationFrame(fieldRAF);
      openShrine(s.shrine as "fire" | "water");
      return;
    }
    case "enemy": case "boss": {
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
    let dx = 0, dy = 0;
    const sp = 0.12;
    if (keys.has("ArrowUp") || keys.has("w")) dy -= sp;
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
    () => { gm.phase = "map"; renderFieldLoopResume(); });
  document.querySelectorAll(".offer-btn").forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const r = gm.tribute.offer(goddess, (b as HTMLElement).dataset.id!);
      log(r.line, true);
      document.querySelector(".modal-back")?.remove();
      renderHUD();
      gm.phase = "map";
      renderFieldLoopResume();
    };
  });
}

// ============ Battle ============
function openMemberSelect(enemyIds: string[], isBoss: boolean, bossId?: string): void {
  const active = gm.party.getActiveMembers();
  const enemyNames = enemyIds.map((id) => (DB.enemies[id] ?? DB.bosses[id]).name).join("、");
  battleMembers = [gm.gs.holder];
  const back = document.createElement("div");
  back.className = "modal-back";
  const memberBtns = active.map((c) => {
    const isHolder = c.id === gm.gs.holder;
    return `<button class="small mem-btn ${isHolder ? "selected" : ""}" data-id="${c.id}" ${isHolder ? "disabled" : ""}>
      ${isHolder ? "🌱" : ""}${DB.characters[c.id].name} Lv${c.level}</button>`;
  }).join(" ");
  back.innerHTML = `<div class="modal"><h2>⚔️ ${enemyNames}が現れた！</h2>
    <p>戦闘に参加するメンバーを選べ（最大${DB.config.BATTLE_MEMBERS_MAX}人・保持者は必ず参加）</p>
    <div class="row" style="margin-top:10px">${memberBtns}</div>
    <div class="modal-actions"><button id="battle-start">戦闘開始</button></div></div>`;
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
  (back.querySelector("#battle-start") as HTMLElement).onclick = () => {
    back.remove();
    battle = gm.startBattle(enemyIds, battleMembers, isBoss, bossId);
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
  const actors = b.allies.filter((a) => !a.state.downed);
  const actor = actors[commandIndex];

  const allyCards = b.allies.map((a) => {
    const d = DB.characters[a.state.id];
    const hpPct = Math.round((a.state.hp / a.state.maxHp) * 100);
    const spPct = Math.round((a.state.sp / a.state.maxSp) * 100);
    return `<div class="unit-card ${a.state.downed ? "downed" : ""} ${a.state.id === gm.gs.holder ? "holder" : ""}">
      <div class="name">${d.name} Lv${a.state.level}</div>
      <div class="bar"><div class="bar-fill hp ${hpPct < 30 ? "low" : ""}" style="width:${hpPct}%"></div></div>
      <div style="font-size:11px">HP ${a.state.hp}/${a.state.maxHp}</div>
      <div class="bar"><div class="bar-fill sp" style="width:${spPct}%"></div></div>
      <div style="font-size:11px">SP ${a.state.sp}/${a.state.maxSp}</div>
    </div>`;
  }).join("");

  const enemyCards = b.enemies.map((e, i) => {
    const hpPct = Math.round((e.hp / e.maxHp) * 100);
    return `<div class="unit-card enemy ${e.alive ? "" : "downed"}" data-ei="${i}">
      <div class="name">${e.def.name}</div>
      <div class="bar"><div class="bar-fill hp ${hpPct < 30 ? "low" : ""}" style="width:${hpPct}%"></div></div>
    </div>`;
  }).join("");

  let commandHtml = "";
  if (actor) {
    const d = DB.characters[actor.state.id];
    const cmds = b.availableCommands(actor.state.id);
    commandHtml = `<b>${d.name}のコマンド:</b> ` + cmds.map((c) => {
      const names: Record<string, string> = {
        attack: "⚔️ 攻撃", skill: "✨ 技", guard: "🛡️ 防御",
        protect: "🤝 庇う", item: "🎒 アイテム", flee: "🏃 逃げる",
      };
      return `<button class="small cmd-btn" data-cmd="${c}">${names[c]}</button>`;
    }).join(" ");
  }

  screen().innerHTML = `
    <div class="battle-wrap">
      <div class="battle-field">
        <div class="battle-side">${allyCards}</div>
        <div style="font-size:40px">⚔️</div>
        <div class="battle-side">${enemyCards}</div>
      </div>
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
    const actors = b.allies.filter((a) => !a.state.downed);
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
    case "attack": {
      const targets = b.enemies.map((e, i) => e.alive
        ? `<button class="small t-btn" data-i="${i}">${e.def.name}</button>` : "").join(" ");
      cmdBar.innerHTML = `<b>どの敵を攻撃？</b> ${targets}`;
      cmdBar.querySelectorAll(".t-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetEnemyIndex: Number((t as HTMLElement).dataset.i) });
      });
      return;
    }
    case "skill": {
      const learned = DB.characters[actor.id].skills
        .filter((sid) => DB.skills[sid] && DB.skills[sid].learn_lv <= actor.level);
      const btns = learned.map((sid) => {
        const s = DB.skills[sid];
        const ok = actor.sp >= s.sp_cost;
        return `<button class="small sk-btn" data-sid="${sid}" ${ok ? "" : "disabled"}>${s.name}（SP${s.sp_cost}）</button>`;
      }).join(" ");
      cmdBar.innerHTML = `<b>どの技？</b> ${btns} <button class="small" id="sk-back">戻る</button>`;
      ($("#sk-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".sk-btn").forEach((t) => {
        (t as HTMLElement).onclick = () => {
          const sid = (t as HTMLElement).dataset.sid!;
          const s = DB.skills[sid];
          if (s.kind === "support" && (s.target === "ally_all" || s.target === "self")) {
            pushAndNext({ kind, actorId: actor.id, skillId: sid });
          } else if (s.kind === "support" && s.target === "ally_single") {
            const allies = b.allies.filter((a) => !a.state.downed).map((a) =>
              `<button class="small at-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}</button>`).join(" ");
            cmdBar.innerHTML = `<b>誰に？</b> ${allies}`;
            cmdBar.querySelectorAll(".at-btn").forEach((ab) => {
              (ab as HTMLElement).onclick = () =>
                pushAndNext({ kind, actorId: actor.id, skillId: sid, targetAllyId: (ab as HTMLElement).dataset.id });
            });
          } else {
            const targets = b.enemies.map((e, i) => e.alive
              ? `<button class="small t-btn" data-i="${i}">${e.def.name}</button>` : "").join(" ");
            cmdBar.innerHTML = `<b>どの敵に？</b> ${targets}`;
            cmdBar.querySelectorAll(".t-btn").forEach((tb) => {
              (tb as HTMLElement).onclick = () =>
                pushAndNext({ kind, actorId: actor.id, skillId: sid, targetEnemyIndex: Number((tb as HTMLElement).dataset.i) });
            });
          }
        };
      });
      return;
    }
    case "protect": {
      const others = b.allies.filter((a) => !a.state.downed && a.state.id !== actor.id);
      const btns = others.map((a) =>
        `<button class="small p-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}</button>`).join(" ");
      cmdBar.innerHTML = `<b>誰を庇う？</b> ${btns} <button class="small" id="p-back">戻る</button>`;
      ($("#p-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".p-btn").forEach((t) => {
        (t as HTMLElement).onclick = () =>
          pushAndNext({ kind, actorId: actor.id, targetAllyId: (t as HTMLElement).dataset.id });
      });
      return;
    }
    case "item": {
      const usable = Object.entries(gm.gs.inventory).filter(([id, n]) =>
        n > 0 && (DB.items[id]?.category === "medicine" || DB.items[id]?.category === "food"));
      if (usable.length === 0) { cmdBar.innerHTML += " <i>使えるものがない</i>"; return; }
      const btns = usable.map(([id, n]) =>
        `<button class="small i-btn" data-id="${id}">${DB.items[id].name}×${n}</button>`).join(" ");
      cmdBar.innerHTML = `<b>どれを使う？</b> ${btns} <button class="small" id="i-back">戻る</button>`;
      ($("#i-back")).onclick = () => renderBattle();
      cmdBar.querySelectorAll(".i-btn").forEach((t) => {
        (t as HTMLElement).onclick = () => {
          const itemId = (t as HTMLElement).dataset.id!;
          const allies = b.allies.map((a) =>
            `<button class="small at-btn" data-id="${a.state.id}">${DB.characters[a.state.id].name}${a.state.downed ? "(戦闘不能)" : ""}</button>`).join(" ");
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
  const result = gm.settleBattle();
  for (const line of b.log.lines.slice(beforeSettle)) log(line, true);
  battle = null;

  if (gm.phase === "gameover") { renderPhase(); return; }
  for (const dead of result.deaths) {
    log(`${DB.characters[dead].name}は帰らぬ人となった…（湖の祠で蘇生できる）`, true);
  }
  for (const k of result.kidnapped) {
    log(`${DB.characters[k].name}が海賊にさらわれた！ 海賊船の最深部で船長を倒せば取り戻せる。`, true);
  }
  checkEvents();
  renderPhase();
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
  showModal("💬", played.text, () => {
    if (id === "hidden_goddess") {
      gm.joinGoddess();
      log("湖の女神が仲間に加わった！", true);
      renderHUD();
    }
  });
  log(`（イベント: ${id}）`);
}

// ============ Ending / GameOver ============
function renderEnding(): void {
  cancelAnimationFrame(fieldRAF);
  const ed = gm.endingJudge.judge();
  screen().innerHTML = `
    <div class="screen-inner" style="text-align:center;padding-top:100px">
      <h1 class="title-logo" style="font-size:36px">${ed.name}</h1>
      <p style="max-width:640px;margin:24px auto;line-height:2.2">${ed.desc}</p>
      <p style="color:#9ab">365日を生き延びた。実績解除数: ${gm.gs.achievements.length}/${DB.achievements.length}</p>
      <div class="menu-list" style="margin-top:32px"><button id="ed-title">タイトルへ</button></div>
    </div>`;
  $("#ed-title").onclick = () => { gm.phase = "title"; renderTitle(); };
}

function renderGameOver(): void {
  cancelAnimationFrame(fieldRAF);
  const go = DB.endings.gameover;
  const reason = gm.gs.gameOver;
  const info = Object.values(go).find((g: any) => g.reason === reason) as any;
  const flavor: Record<string, string> = {
    holder_death: "ホープシードの光が消えた。希望とともに。",
    holder_kidnap: "ホープシードは波の彼方へ連れ去られた。",
    holder_possess: "ホープシードは闇に呑まれた。",
    tribute_fire_expired: "山が怒りに震え、灼熱がすべてを呑み込んだ。",
    tribute_water_expired: "海が静かに、しかし確実に、島を呑み込んでいった。",
  };
  screen().innerHTML = `
    <div class="screen-inner" style="text-align:center;padding-top:100px">
      <h1 class="title-logo" style="font-size:40px;color:var(--danger)">GAME OVER</h1>
      <p style="font-size:18px;margin:16px">${info?.name ?? ""}</p>
      <p style="color:#9ab">${flavor[reason ?? ""] ?? ""}</p>
      <p style="color:#9ab;margin-top:8px">${gm.gs.day}日目のことだった。</p>
      <div class="menu-list" style="margin-top:32px">
        <button id="go-load">オートセーブから再開</button>
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
