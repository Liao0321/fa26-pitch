// 參賽隊伍頁：顯示各組卡片，登入後可在卡片上直接投資
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  startPage, login, db, configReady, esc, toast, confirmDialog, watchSettings, quotaOf, coinify,
} from "./common.js";
import { renderTeamCard, teamDisplayName } from "./cards.js";
import { TEAM_IDS } from "./firebase-config.js";
import {
  watchMyInvestment, saveInvestment, zeroAmounts, sumOf, isPermissionError,
} from "./invest.js";

const grid = document.getElementById("teams");
const bar = document.getElementById("invest-bar");

let teams = {};
let profile = null;
let settings = null;
let mine = zeroAmounts();   // 資料庫裡我目前的投資
let mineLoaded = false;
let pending = {};           // 還沒確認的調整：{ team1: 5 }
let busy = false;
let stopMine = null;

// ---------- 計算 ----------
function quota() { return settings ? quotaOf(profile, settings) : 0; }
function remaining() { return Math.max(0, quota() - sumOf(mine)); }
function targetOf(t) { return pending[t] ?? mine[t]; }
function maxOf(t) { return mine[t] + remaining(); }

// ---------- 畫面 ----------
function renderCards() {
  grid.innerHTML = TEAM_IDS
    .map((id) => renderTeamCard(id, teams[id], `<div class="invest-slot" data-slot="${id}"></div>`))
    .join("");
  renderSlots();
}

function renderBar() {
  if (!configReady) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  if (!profile) {
    bar.innerHTML = `<div class="container invest-bar-inner">
      <span>登入後即可用 Flagship-coin 投資</span>
      <button class="btn btn-small btn-primary" data-act="login" type="button">登入</button></div>`;
    return;
  }
  const stateText = { notOpen: "投資尚未開放", open: "投資開放中", settled: "投資已結算" }[settings?.investState] || "";
  bar.innerHTML = `<div class="container invest-bar-inner">
    <div class="bar-me">
      <span class="muted small">我的身分</span>
      <b>${esc(profile.roles.join("・"))}</b>
    </div>
    <span class="badge ${settings?.investState === "open" ? "" : "badge-gray"}">${stateText}</span>
    <div class="bar-coins">
      <span class="coin-icon" aria-hidden="true"></span>
      <span class="muted small">剩餘</span>
      <b id="bar-remaining">${mineLoaded ? remaining() : "…"}</b>
      <span class="muted small">/ ${quota()}</span>
    </div>
  </div>`;
}

function slotHtml(t) {
  if (!configReady) return "";
  if (!profile) {
    return `<div class="invest-box is-off"><button class="btn btn-primary" data-act="login" type="button">登入後即可投資</button></div>`;
  }
  const state = settings?.investState;
  const mineLine = `<div class="invest-mine">我在這組投了 <b>${mine[t]}</b> 枚</div>`;
  if (profile.team === t) {
    return `<div class="invest-box is-off"><p>🙌 這是你的組別，不能投資自己的組喔！</p></div>`;
  }
  if (state !== "open") {
    const msg = state === "settled" ? "🔒 投資已結束" : "⏳ 投資尚未開放";
    return `<div class="invest-box is-off">${mineLine}<p class="invest-closed">${msg}</p></div>`;
  }
  if (!mineLoaded) return `<div class="invest-box is-off"><p class="muted">載入中…</p></div>`;

  const target = targetOf(t);
  const max = maxOf(t);
  const diff = target - mine[t];
  const quick = [1, 3, 5].filter((n) => n <= quota());
  return `
    <div class="invest-box">
      ${mineLine}
      <div class="stepper">
        <button class="btn" data-act="minus" type="button" ${target <= 0 ? "disabled" : ""} aria-label="減少">−</button>
        <output>${target}</output>
        <button class="btn" data-act="plus" type="button" ${target >= max ? "disabled" : ""} aria-label="增加">＋</button>
      </div>
      <div class="quick">
        ${quick.map((n) => `<button class="btn btn-small" data-add="${n}" type="button" ${target + n > max ? "disabled" : ""}>+${n}</button>`).join("")}
        <button class="btn btn-small btn-yellow" data-add="all" type="button" ${target >= max ? "disabled" : ""}>全部</button>
      </div>
      <div class="invest-diff ${diff > 0 ? "up" : diff < 0 ? "down" : ""}">
        ${diff === 0 ? "用 ＋／− 或快捷按鈕調整金額" : `調整為 ${target} 枚（${diff > 0 ? "+" : "−"}${Math.abs(diff)}）`}
      </div>
      <button class="btn btn-primary btn-big invest-confirm" data-act="confirm" type="button" ${diff === 0 || busy ? "disabled" : ""}>
        ${busy ? "處理中…" : diff < 0 ? "確認減少" : "確認投資"}
      </button>
    </div>`;
}

function renderSlots() {
  grid.querySelectorAll(".invest-slot").forEach((el) => { el.innerHTML = slotHtml(el.dataset.slot); });
  renderBar();
}

// ---------- 操作 ----------
grid.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  if (btn.dataset.act === "login") return login();
  const slot = btn.closest(".invest-slot");
  if (!slot) return;
  const t = slot.dataset.slot;
  const max = maxOf(t);
  let target = targetOf(t);
  if (btn.dataset.act === "minus") target -= 1;
  else if (btn.dataset.act === "plus") target += 1;
  else if (btn.dataset.add === "all") target = max;
  else if (btn.dataset.add) target += Number(btn.dataset.add);
  else if (btn.dataset.act === "confirm") return confirmInvest(t);
  target = Math.max(0, Math.min(max, target));
  if (target === mine[t]) delete pending[t]; else pending[t] = target;
  slot.innerHTML = slotHtml(t);
});

bar.addEventListener("click", (e) => {
  if (e.target.closest('[data-act="login"]')) login();
});

async function confirmInvest(t) {
  const target = targetOf(t);
  const diff = target - mine[t];
  if (!diff) return;
  const remainAfter = remaining() - diff;
  const name = esc(teamDisplayName(t, teams[t]));
  const ok = await confirmDialog({
    title: diff > 0 ? "確認投資" : "確認減少投資",
    body: `
      <p style="font-size:18px">「<b>${name}</b>」<br>
        ${mine[t]} 枚 → <b style="font-size:24px">${target}</b> 枚
        <span class="badge ${diff > 0 ? "" : "badge-yellow"}">${diff > 0 ? "+" : "−"}${Math.abs(diff)}</span></p>
      <p class="muted">確認後，你的剩餘 ${coinify("Flagship-coin")}：${remaining()} → <b>${remainAfter}</b></p>`,
    okText: diff > 0 ? "投資！" : "確認減少",
  });
  if (!ok) return;

  busy = true;
  renderSlots();
  const before = { ...mine };
  const after = { ...mine, [t]: target };
  try {
    await saveInvestment(profile, before, after);
    delete pending[t];
    busy = false;
    mine = after; // 先更新畫面，資料庫的即時監聽會再確認一次
    renderSlots();
    celebrate(t, diff);
  } catch (err) {
    console.error(err);
    busy = false;
    renderSlots();
    let msg = `投資失敗：${err.message}`;
    if (isPermissionError(err)) {
      msg = settings?.investState !== "open"
        ? "投資已經關閉，無法再調整。"
        : "投資沒有成功，可能你在其他裝置上改過了。請重新整理頁面後再試一次。";
    }
    toast(msg, "error", 6000);
  }
}

// 成功動畫：金幣從卡片噴出
function celebrate(t, diff) {
  const card = grid.querySelector(`.team-card[data-team="${t}"]`);
  if (!card) return;
  const fx = document.createElement("div");
  fx.className = "coin-fx";
  const n = Math.min(14, Math.max(6, Math.abs(diff) * 3));
  let coins = "";
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 70 + Math.random() * 90;
    coins += `<span class="coin-fx-coin" style="--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist - 40}px;--d:${Math.random() * 0.15}s"></span>`;
  }
  fx.innerHTML = `${diff > 0 ? coins : ""}<div class="coin-fx-text ${diff > 0 ? "" : "down"}">${diff > 0 ? "+" : "−"}${Math.abs(diff)}</div>`;
  card.appendChild(fx);
  card.classList.add("just-invested");
  setTimeout(() => { fx.remove(); card.classList.remove("just-invested"); }, 1400);
  toast(diff > 0 ? `成功投資 ${diff} 枚 Flagship-coin！` : `已減少 ${-diff} 枚，退回到你的錢包`, "ok");
  if (navigator.vibrate) navigator.vibrate(60);
}

// ---------- 資料 ----------
watchSettings((s) => {
  settings = s;
  if (s.investState !== "open") pending = {};
  renderSlots();
});

startPage({
  active: "teams",
  onProfile(p) {
    const changedUser = (p?.uid || null) !== (profile?.uid || null);
    profile = p;
    if (changedUser) {
      stopMine?.();
      stopMine = null;
      mine = zeroAmounts();
      mineLoaded = false;
      pending = {};
      if (p) {
        stopMine = watchMyInvestment(p.uid, (amounts) => {
          mine = amounts;
          mineLoaded = true;
          for (const t of Object.keys(pending)) {
            if (pending[t] === mine[t] || pending[t] > maxOf(t)) delete pending[t];
          }
          renderSlots();
        });
      }
    }
    renderSlots();
  },
});

renderCards();

if (configReady) {
  onSnapshot(collection(db, "teams"), (snap) => {
    teams = {};
    snap.forEach((d) => { teams[d.id] = d.data(); });
    renderCards();
  }, (e) => console.error(e));
}
