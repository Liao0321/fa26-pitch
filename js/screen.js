// 投影模式：介紹／排行榜／頒獎／資金重播
// 需要管理員帳號（要讀取所有人的投資才能計算排行榜）
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { startPage, login, db, esc, watchSettings, teamLabel } from "./common.js";
import { teamDisplayName, teamNumber, plainText, isJudgeCardFilled } from "./cards.js";
import { computeStats } from "./stats.js";
import { startReplay } from "./replay.js";
import { TEAM_IDS, EVENT_NAME } from "./firebase-config.js";

const stage = document.getElementById("stage");
const toolbar = document.getElementById("toolbar");
const modeTools = document.getElementById("mode-tools");

// ---------- 資料 ----------
const data = {
  settings: null,
  judges: [],
  teams: {},
  investments: [],
  logs: [],
  roster: new Map(),
};
let stats = computeStats([], new Map());

let mode = new URLSearchParams(location.search).get("mode") || "intro";
let introIndex = 0;
let awardStep = 0;
let stopReplay = null;
let started = false;

startPage({
  active: "",
  onProfile(p) {
    if (!p) {
      stage.innerHTML = `<div class="stage-center">
        <h1 class="screen-title">${esc(EVENT_NAME)}</h1>
        <p class="screen-muted">投影模式需要管理員帳號</p>
        <button class="btn btn-primary btn-big" id="screen-login" type="button">管理員登入</button></div>`;
      stage.querySelector("#screen-login").addEventListener("click", login);
      return;
    }
    if (!p.isAdmin) {
      stage.innerHTML = `<div class="stage-center"><p class="screen-muted">${esc(p.email)} 不是管理員，無法開啟投影模式。</p></div>`;
      return;
    }
    if (!started) {
      started = true;
      subscribe();
      setMode(mode);
    }
  },
});

function subscribe() {
  watchSettings((s) => { data.settings = s; refresh("settings"); });
  onSnapshot(collection(db, "judgeCards"), (snap) => {
    data.judges = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.active !== false)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    refresh("cards");
  });
  onSnapshot(collection(db, "teams"), (snap) => {
    data.teams = {};
    snap.forEach((d) => { data.teams[d.id] = d.data(); });
    refresh("cards");
  });
  onSnapshot(collection(db, "roster"), (snap) => {
    data.roster = new Map(snap.docs.map((d) => [d.id, d.data()]));
    refresh("money");
  });
  onSnapshot(collection(db, "investments"), (snap) => {
    data.investments = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    refresh("money");
  });
  onSnapshot(collection(db, "investLogs"), (snap) => {
    data.logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.at?.toMillis?.() || 0) - (b.at?.toMillis?.() || 0));
    refresh("logs");
  });
}

function refresh(kind) {
  if (kind === "money") stats = computeStats(data.investments, data.roster);
  if (!started) return;
  if (mode === "intro" && kind === "cards") renderIntro();
  if (mode === "board" && (kind === "money" || kind === "settings" || kind === "cards")) renderBoard();
  if (mode === "awards" && (kind === "money" || kind === "cards" || kind === "settings")) renderAwards(false);
  // 直接用 ?mode=replay 開啟時，紀錄可能還沒載入：載入後再重新開始
  if (mode === "replay" && kind === "logs" && replayLogCount === 0 && data.logs.length) renderReplay();
}

const name = (t) => teamDisplayName(t, data.teams[t]);

// ---------- 模式切換 ----------
function setMode(m) {
  mode = m;
  stopReplay?.();
  stopReplay = null;
  const url = new URL(location.href);
  url.searchParams.set("mode", m);
  history.replaceState(null, "", url);
  toolbar.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("btn-primary", b.dataset.mode === m));
  stage.className = `stage mode-${m}`;
  modeTools.innerHTML = "";
  if (m === "intro") renderIntro();
  if (m === "board") renderBoard(true);
  if (m === "awards") { awardStep = 0; renderAwards(true); }
  if (m === "replay") renderReplay();
}

toolbar.addEventListener("click", (e) => {
  const m = e.target.closest("[data-mode]")?.dataset.mode;
  if (m) setMode(m);
});

document.getElementById("fullscreen").addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// 工具列：滑鼠不動 3 秒後自動隱藏
let hideTimer;
function showToolbar() {
  toolbar.classList.remove("is-hidden");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toolbar.classList.add("is-hidden"), 3000);
}
document.addEventListener("mousemove", showToolbar);
showToolbar();

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  const k = e.key;
  if (k === "f" || k === "F") return toggleFullscreen();
  if (["1", "2", "3", "4"].includes(k)) return setMode(["intro", "board", "awards", "replay"][Number(k) - 1]);
  const next = ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k);
  const prev = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k);
  if (!next && !prev) return;
  e.preventDefault();
  step(next ? 1 : -1);
});

stage.addEventListener("click", (e) => {
  if (e.target.closest("button, a")) return;
  // 點畫面右側＝下一張，左側＝上一張
  step(e.clientX > window.innerWidth / 3 ? 1 : -1);
});

function step(dir) {
  if (mode === "intro") {
    const total = introSlides().length;
    if (!total) return;
    introIndex = (introIndex + dir + total) % total;
    renderIntro();
  } else if (mode === "awards") {
    const steps = awardSteps();
    const nextStep = awardStep + dir;
    if (nextStep >= steps.length) return setMode("replay");
    awardStep = Math.max(0, nextStep);
    renderAwards(true);
  } else if (mode === "replay" && dir > 0) {
    stopReplay?.restartOrToggle?.();
  }
}

// ---------- 1. 介紹模式 ----------
function introSlides() {
  return [
    ...data.judges.map((j, i) => ({ type: "judge", card: j, index: i })),
    ...TEAM_IDS.map((t) => ({ type: "team", teamId: t })),
  ];
}

function renderIntro() {
  const slides = introSlides();
  if (introIndex >= slides.length) introIndex = 0;
  const judgeCount = data.judges.length;
  modeTools.innerHTML = `
    <button class="btn btn-small" data-jump="0" type="button">評審</button>
    <button class="btn btn-small" data-jump="${judgeCount}" type="button">參賽隊伍</button>
    <span class="toolbar-hint">${slides.length ? `${introIndex + 1} / ${slides.length}` : ""}</span>`;
  modeTools.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => {
    introIndex = Number(b.dataset.jump);
    renderIntro();
  }));
  const s = slides[introIndex];
  if (!s) { stage.innerHTML = `<div class="stage-center"><p class="screen-muted">還沒有資料</p></div>`; return; }

  if (s.type === "judge") {
    const c = s.card;
    const filled = isJudgeCardFilled(c);
    stage.innerHTML = `
      <section class="intro-slide slide-in">
        <div class="intro-media is-square">
          ${c.photo ? `<img src="${c.photo}" alt="">` : `<div class="img-placeholder"><span class="pixel">${filled ? "NO PHOTO" : "?"}</span></div>`}
        </div>
        <div class="intro-text">
          <span class="tag tag-xl">JUDGE ${String(s.index + 1).padStart(2, "0")} / ${String(judgeCount).padStart(2, "0")}</span>
          <h1>${esc(filled ? c.roleName || "（未命名）" : "準備中…")}</h1>
          ${c.roleTitle ? `<div class="role-title role-xl">${esc(c.roleTitle)}</div>` : ""}
          <p class="intro-desc">${filled ? plainText(c.bio) : "這位評審還在設定角色"}</p>
        </div>
      </section>`;
  } else {
    const d = data.teams[s.teamId] || {};
    stage.innerHTML = `
      <section class="intro-slide slide-in">
        <div class="intro-media">
          ${d.image ? `<img src="${d.image}" alt="">` : `<div class="img-placeholder"><span class="pixel">COMING SOON</span></div>`}
        </div>
        <div class="intro-text">
          <span class="tag tag-xl">TEAM ${teamNumber(s.teamId)}｜${esc(teamLabel(s.teamId))}</span>
          <h1>${esc(name(s.teamId))}</h1>
          <p class="intro-desc">${d.intro ? plainText(d.intro) : "項目介紹準備中…"}</p>
        </div>
      </section>`;
  }
}

// ---------- 2. 排行榜 ----------
function animateNumber(el, to, ms = 900) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let boardHidden = null;

function renderBoard(fresh = false) {
  const hidden = data.settings?.hideAmounts !== false;
  if (fresh || hidden !== boardHidden || !stage.querySelector(".board")) {
    boardHidden = hidden;
    stage.innerHTML = hidden ? hiddenBoardHtml() : boardHtml();
  }
  if (hidden) {
    const totalEl = stage.querySelector("#grand-total");
    const before = Number(totalEl.dataset.value || 0);
    animateNumber(totalEl, stats.grandTotal, 1200);
    animateNumber(stage.querySelector("#investor-count"), stats.investorCount);
    if (stats.grandTotal > before && !fresh) popCoins();
    return;
  }
  const max = Math.max(1, ...TEAM_IDS.map((t) => stats.teams[t].total));
  for (const t of TEAM_IDS) {
    const s = stats.teams[t];
    const row = stage.querySelector(`.board-row[data-team="${t}"]`);
    row.querySelector(".board-name").textContent = name(t);
    row.querySelector(".bar-judge").style.width = `${(s.judge / max) * 100}%`;
    row.querySelector(".bar-aud").style.width = `${(s.audience / max) * 100}%`;
    animateNumber(row.querySelector(".num-judge"), s.judge);
    animateNumber(row.querySelector(".num-aud"), s.audience);
    animateNumber(row.querySelector(".num-total"), s.total);
    row.querySelector(".board-rank").textContent = s.total ? `#${s.rank}` : "";
    row.classList.toggle("is-top", s.rank === 1 && s.total > 0);
  }
}

function hiddenBoardHtml() {
  return `
    <section class="board board-hidden">
      <span class="tag tag-xl">LIVE FUNDING</span>
      <h2>今日已募得</h2>
      <div class="grand">
        <span class="coin-icon coin-xl" aria-hidden="true"></span>
        <b id="grand-total" data-value="0">0</b>
        <span class="grand-unit">Flagship-coin</span>
      </div>
      <p class="screen-muted"><b id="investor-count" data-value="0">0</b> 人參與投資・各組金額將在最後揭曉 🤫</p>
      <div id="coin-pop" class="coin-pop"></div>
    </section>`;
}

function popCoins() {
  const box = stage.querySelector("#coin-pop");
  if (!box) return;
  for (let i = 0; i < 10; i++) {
    const c = document.createElement("span");
    c.className = "coin-fx-coin";
    const a = Math.random() * Math.PI * 2;
    c.style.setProperty("--dx", `${Math.cos(a) * (120 + Math.random() * 160)}px`);
    c.style.setProperty("--dy", `${Math.sin(a) * (80 + Math.random() * 120) - 60}px`);
    c.style.setProperty("--d", `${Math.random() * 0.2}s`);
    box.appendChild(c);
    setTimeout(() => c.remove(), 1400);
  }
}

function boardHtml() {
  return `
    <section class="board">
      <div class="board-head">
        <h2>募資排行榜</h2>
        <div class="legend">
          <span><i class="sw sw-judge"></i>評審投資</span>
          <span><i class="sw sw-aud"></i>觀眾投資</span>
        </div>
      </div>
      ${TEAM_IDS.map((t) => `
        <div class="board-row" data-team="${t}">
          <div class="board-label">
            <span class="board-rank"></span>
            <span class="pixel board-no">TEAM ${teamNumber(t)}</span>
            <span class="board-name"></span>
          </div>
          <div class="board-bar">
            <div class="bar-judge"></div><div class="bar-aud"></div>
          </div>
          <div class="board-nums">
            <span class="small-num">評審 <b class="num-judge">0</b></span>
            <span class="small-num">觀眾 <b class="num-aud">0</b></span>
            <span class="total-num"><b class="num-total">0</b></span>
          </div>
        </div>`).join("")}
    </section>`;
}

// ---------- 3. 頒獎 ----------
// 步驟：標題 → 第三名 → 第二名 → 第一名（同名次並列時一起揭曉）
function awardSteps() {
  const groups = [];
  for (const s of stats.ranking) {
    if (s.rank > 3 || s.total === 0) continue;
    let g = groups.find((x) => x.rank === s.rank);
    if (!g) { g = { rank: s.rank, teams: [] }; groups.push(g); }
    g.teams.push(s);
  }
  groups.sort((a, b) => b.rank - a.rank);
  return [{ type: "title" }, ...groups.map((g) => ({ type: "place", ...g }))];
}

function renderAwards(animate) {
  const steps = awardSteps();
  if (awardStep >= steps.length) awardStep = steps.length - 1;
  const st = steps[awardStep];
  const settled = data.settings?.investState === "settled";
  modeTools.innerHTML = `
    <button class="btn btn-small" id="award-restart" type="button">從頭開始</button>
    <span class="toolbar-hint">${awardStep + 1} / ${steps.length}・最後一步再按 → 進入資金重播</span>`;
  modeTools.querySelector("#award-restart").addEventListener("click", () => { awardStep = 0; renderAwards(true); });

  if (st.type === "title") {
    stage.innerHTML = `
      <section class="stage-center ${animate ? "slide-in" : ""}">
        <span class="tag tag-xl">AWARD CEREMONY</span>
        <h1 class="screen-title">頒獎典禮</h1>
        <p class="screen-muted">全場共募得 <b>${stats.grandTotal}</b> 枚 Flagship-coin・${stats.investorCount} 人參與投資</p>
        ${settled ? "" : `<p class="badge badge-yellow">提醒：投資尚未結算，金額可能還會變動</p>`}
        <p class="screen-hint">按 → 揭曉第三名</p>
      </section>`;
    return;
  }
  const label = { 1: "第一名", 2: "第二名", 3: "第三名" }[st.rank];
  const isChamp = st.rank === 1;
  stage.innerHTML = `
    <section class="award ${isChamp ? "is-champ" : ""} ${animate ? "award-in" : ""}">
      <div class="award-place">${isChamp ? "🏆 " : ""}${label}${st.teams.length > 1 ? "（並列）" : ""}</div>
      <div class="award-teams">
        ${st.teams.map((s) => {
          const d = data.teams[s.teamId] || {};
          return `
          <div class="award-card">
            <div class="award-media">${d.image ? `<img src="${d.image}" alt="">` : `<div class="img-placeholder"><span class="pixel">TEAM ${teamNumber(s.teamId)}</span></div>`}</div>
            <div class="award-body">
              <span class="tag">TEAM ${teamNumber(s.teamId)}｜${esc(teamLabel(s.teamId))}</span>
              <h2>${esc(name(s.teamId))}</h2>
              <div class="award-total"><span class="coin-icon coin-lg"></span><b>${s.total}</b> Flagship-coin</div>
              <div class="screen-muted">評審 ${s.judge}・觀眾 ${s.audience}・${s.supporters} 位支持者</div>
            </div>
          </div>`;
        }).join("")}
      </div>
      ${isChamp && animate ? `<div class="coin-rain">${Array.from({ length: 40 }, () =>
        `<span style="left:${Math.random() * 100}%;animation-delay:${Math.random() * 2.5}s;animation-duration:${2 + Math.random() * 2}s"></span>`).join("")}</div>` : ""}
    </section>`;
}

// ---------- 4. 資金重播 ----------
let replayLogCount = 0;

function renderReplay() {
  replayLogCount = data.logs.length;
  stage.innerHTML = `<div class="replay-wrap"><canvas id="replay-canvas"></canvas></div>`;
  modeTools.innerHTML = `
    <button class="btn btn-small" id="replay-restart" type="button">⟲ 重新播放</button>
    <span class="toolbar-hint">空白鍵：暫停／繼續</span>`;
  const run = () => {
    stopReplay?.();
    stopReplay = startReplay(stage.querySelector("#replay-canvas"), {
      logs: data.logs,
      settings: data.settings,
      teamIds: TEAM_IDS,
      teamName: name,
      // 小人頭上的名字：名單上的名字 → Google 帳號名字 → 帳號
      personName: (log) => data.roster.get(log.email)?.name || log.name || log.account,
    });
  };
  modeTools.querySelector("#replay-restart").addEventListener("click", run);
  run();
}
