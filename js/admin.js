// 管理後台
import {
  collection, doc, getDoc, getDocs, setDoc, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  startPage, login, db, esc, toast, confirmDialog, teamLabel, isSchoolEmail, DEFAULT_SETTINGS,
  watchSettings, watchContent, accountOf,
} from "./common.js";
import { SCHOOL_DOMAIN, TEAM_IDS, OWNER_ADMINS } from "./firebase-config.js";
import { DEFAULT_CONTENT } from "./defaults.js";
import { renderText, renderSchedule, teamDisplayName } from "./cards.js";
import { computeStats } from "./stats.js";

const gate = document.getElementById("gate");
const area = document.getElementById("admin-area");
const input = document.getElementById("roster-input");
const previewBox = document.getElementById("preview");
const currentBox = document.getElementById("current-roster");

let started = false;
let currentRoster = []; // [{ email, ...data }]
let parsed = null;

startPage({
  active: "admin",
  onProfile(p) {
    if (!p) {
      area.classList.add("hidden");
      gate.classList.remove("hidden");
      gate.innerHTML = `<p>請先登入管理員帳號。</p>
        <button class="btn btn-primary" id="gate-login" type="button">學校帳號登入</button>`;
      gate.querySelector("#gate-login").addEventListener("click", login);
      return;
    }
    if (!p.isAdmin) {
      area.classList.add("hidden");
      gate.classList.remove("hidden");
      gate.innerHTML = `<p>你目前的帳號（${esc(p.email)}）不是管理員，無法進入後台。</p>`;
      return;
    }
    gate.classList.add("hidden");
    area.classList.remove("hidden");
    if (!started) {
      started = true;
      ensureSettings();
      watchRoster();
      watchSettings((s) => { settings = s; renderSwitches(); renderContentPreview(); });
      watchContent(fillContentOnce);
      watchInvestments();
    }
  },
});

// ---------- 投資狀態、隱藏金額、額度 ----------
const STATE_LABEL = { notOpen: "尚未開放", open: "開放中", settled: "已結算" };

function renderInvestSwitches() {
  const state = settings.investState;
  const badge = document.getElementById("invest-state");
  badge.textContent = STATE_LABEL[state] || state;
  badge.className = `badge ${state === "open" ? "" : state === "settled" ? "badge-yellow" : "badge-gray"}`;
  const box = document.getElementById("invest-actions");
  if (state === "notOpen") {
    box.innerHTML = `<button class="btn btn-primary" data-invest="open" type="button">開放投資</button>`;
  } else if (state === "open") {
    box.innerHTML = `<button class="btn btn-danger" data-invest="settled" type="button">結算（永久鎖定）</button>`;
  } else {
    box.innerHTML = `<span class="muted small">已結算。賽前測試完要重來，請用下方「清除所有投資紀錄」。</span>`;
  }

  const hidden = settings.hideAmounts;
  const hb = document.getElementById("hide-state");
  hb.textContent = hidden ? "隱藏中" : "顯示中";
  hb.className = `badge ${hidden ? "badge-gray" : ""}`;
  const tb = document.getElementById("toggle-hide");
  tb.textContent = hidden ? "揭曉金額" : "隱藏金額";
  tb.className = `btn ${hidden ? "btn-yellow" : ""}`;

  const jc = document.getElementById("judge-coins");
  const dc = document.getElementById("default-coins");
  if (document.activeElement !== jc) jc.value = settings.judgeCoins;
  if (document.activeElement !== dc) dc.value = settings.defaultCoins;
}

async function updateSettings(patch, okMsg) {
  try {
    await setDoc(doc(db, "config", "settings"), patch, { merge: true });
    toast(okMsg, "ok");
  } catch (e) {
    toast(`更新失敗：${e.message}`, "error");
  }
}

document.getElementById("invest-actions").addEventListener("click", async (e) => {
  const next = e.target.closest("[data-invest]")?.dataset.invest;
  if (next === "open") {
    const ok = await confirmDialog({
      title: "開放投資？",
      body: "<p>所有登入的人都可以開始投資。</p>",
      okText: "開放",
    });
    if (ok) updateSettings({ investState: "open" }, "投資已開放");
  }
  if (next === "settled") {
    const ok = await confirmDialog({
      title: "結算投資？",
      body: "<p><b>結算後所有人的投資永久鎖定</b>，不能再加碼、減少或換組，也不能重新開放。</p>",
      okText: "結算",
      danger: true,
      requireText: "結算",
    });
    if (ok) updateSettings({ investState: "settled", settledAt: serverTimestamp() }, "已結算，投資已鎖定");
  }
});

document.getElementById("toggle-hide").addEventListener("click", async () => {
  const hide = !settings.hideAmounts;
  const ok = await confirmDialog({
    title: hide ? "隱藏金額？" : "揭曉金額？",
    body: hide
      ? "<p>投影幕的排行榜將只顯示全場總額。</p>"
      : "<p>投影幕的排行榜會<b>立刻顯示各組金額</b>。</p>",
    okText: hide ? "隱藏" : "揭曉",
  });
  if (ok) updateSettings({ hideAmounts: hide }, hide ? "已隱藏金額" : "已揭曉金額");
});

document.getElementById("save-quota").addEventListener("click", async () => {
  const judgeCoins = Number(document.getElementById("judge-coins").value);
  const defaultCoins = Number(document.getElementById("default-coins").value);
  if (!Number.isInteger(judgeCoins) || !Number.isInteger(defaultCoins) || judgeCoins < 1 || defaultCoins < 1) {
    toast("額度必須是 1 以上的整數", "error");
    return;
  }
  const ok = await confirmDialog({
    title: "儲存額度？",
    body: `<p>評審每人 <b>${judgeCoins}</b> 枚，其他人每人 <b>${defaultCoins}</b> 枚。</p>`,
    okText: "儲存",
  });
  if (ok) updateSettings({ judgeCoins, defaultCoins }, "額度已更新");
});

// ---------- 投資紀錄 ----------
let investments = [];
let logs = [];
let teamsData = {};

function teamName(t) {
  return teamDisplayName(t, teamsData[t]);
}

function rosterMap() {
  return new Map(currentRoster.map((r) => [r.email, r]));
}

function personRole(email) {
  const r = rosterMap().get(email) || {};
  const p = { ...r, isAdmin: r.isAdmin || OWNER_ADMINS.includes(email) };
  return rolesText({ ...p, isTeacher: p.isTeacher || p.isAdmin }) || "觀眾";
}

function personName(email) {
  return rosterMap().get(email)?.name || "";
}

function watchInvestments() {
  onSnapshot(collection(db, "investments"), (snap) => {
    investments = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    renderRecords();
  }, (e) => toast(`讀取投資失敗：${e.message}`, "error"));
  onSnapshot(collection(db, "investLogs"), (snap) => {
    logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.at?.toMillis?.() || 0) - (b.at?.toMillis?.() || 0));
    renderRecords();
  }, (e) => toast(`讀取紀錄失敗：${e.message}`, "error"));
  onSnapshot(collection(db, "teams"), (snap) => {
    teamsData = {};
    snap.forEach((d) => { teamsData[d.id] = d.data(); });
    renderRecords();
  });
}

function fmtTime(ts) {
  return ts?.toDate ? ts.toDate().toLocaleString("zh-TW", { hour12: false }) : "";
}

function changeText(log) {
  return TEAM_IDS
    .map((t) => [t, (log.after?.[t] || 0) - (log.before?.[t] || 0)])
    .filter(([, d]) => d)
    .map(([t, d]) => `${teamLabel(t)} ${d > 0 ? "+" : "−"}${Math.abs(d)}`)
    .join("；") || "（無變動）";
}

function renderRecords() {
  const stats = computeStats(investments, rosterMap());
  document.getElementById("stats-box").innerHTML = `
    <div class="stat-grid" style="margin:0 0 16px">
      <div class="stat"><b>${stats.grandTotal}</b><span>全場已投入 coin</span></div>
      <div class="stat"><b>${stats.investorCount}</b><span>參與投資人數</span></div>
      <div class="stat"><b>${logs.length}</b><span>變動次數</span></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>名次</th><th>組別</th><th>評審投資</th><th>觀眾投資</th><th>總額</th><th>支持人數</th></tr></thead>
      <tbody>${stats.ranking.map((s) => `
        <tr><td>${s.rank}</td><td>${esc(teamLabel(s.teamId))}｜${esc(teamName(s.teamId))}</td>
        <td>${s.judge}</td><td>${s.audience}</td><td><b>${s.total}</b></td><td>${s.supporters}</td></tr>`).join("")}
      </tbody></table></div>
    <p class="muted small">排名依序比較：總額 → 支持人數 → 評審投資。三項都相同才會並列。「觀眾投資」包含老師與組員。</p>`;

  const people = investments
    .map((inv) => ({ ...inv, total: TEAM_IDS.reduce((s, t) => s + (inv[t] || 0), 0) }))
    .sort((a, b) => b.total - a.total);
  document.getElementById("people-count").textContent = `（${people.length} 人）`;
  document.getElementById("people-box").innerHTML = people.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>帳號</th><th>名字</th><th>身分</th>${TEAM_IDS.map((t) => `<th>${esc(teamLabel(t))}</th>`).join("")}<th>合計</th><th>最後更新</th></tr></thead>
      <tbody>${people.map((p) => `
        <tr><td>${esc(accountOf(p.email))}</td><td>${esc(personName(p.email))}</td><td>${esc(personRole(p.email))}</td>
        ${TEAM_IDS.map((t) => `<td>${p[t] || ""}</td>`).join("")}<td><b>${p.total}</b></td><td>${fmtTime(p.updatedAt)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">還沒有人投資。</p>`;

  const recent = logs.slice(-100).reverse();
  document.getElementById("logs-count").textContent = `（共 ${logs.length} 筆）`;
  document.getElementById("logs-box").innerHTML = recent.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>時間</th><th>帳號</th><th>身分</th><th>變動</th></tr></thead>
      <tbody>${recent.map((l) => `
        <tr><td>${fmtTime(l.at)}</td><td>${esc(l.account)}</td><td>${l.isJudge ? "評審" : l.isTeacher ? "老師" : "一般"}</td><td>${esc(changeText(l))}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">還沒有紀錄。</p>`;
}

// ---------- CSV ----------
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  // 開頭加 BOM，Excel 開啟中文才不會亂碼
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

document.getElementById("csv-current").addEventListener("click", () => {
  const header = ["帳號", "名字", "email", "身分", ...TEAM_IDS.map((t) => `${teamLabel(t)}（${teamName(t)}）`), "合計", "最後更新"];
  const rows = investments.map((inv) => [
    accountOf(inv.email), personName(inv.email), inv.email, personRole(inv.email),
    ...TEAM_IDS.map((t) => inv[t] || 0),
    TEAM_IDS.reduce((s, t) => s + (inv[t] || 0), 0),
    fmtTime(inv.updatedAt),
  ]);
  downloadCsv(`投資_每人目前_${stamp()}.csv`, [header, ...rows]);
});

document.getElementById("csv-logs").addEventListener("click", () => {
  const header = ["時間", "帳號", "名字", "email", "身分", "變動", ...TEAM_IDS.map((t) => `變動後_${teamLabel(t)}`)];
  const rows = logs.map((l) => [
    fmtTime(l.at), l.account, personName(l.email), l.email,
    l.isJudge ? "評審" : l.isTeacher ? "老師" : "一般",
    changeText(l),
    ...TEAM_IDS.map((t) => l.after?.[t] || 0),
  ]);
  downloadCsv(`投資_逐筆紀錄_${stamp()}.csv`, [header, ...rows]);
});

// ---------- 清除所有投資 ----------
document.getElementById("clear-all").addEventListener("click", async () => {
  const first = await confirmDialog({
    title: "清除所有投資紀錄？",
    body: `<p>將刪除 <b>${investments.length}</b> 人的投資、<b>${logs.length}</b> 筆變動紀錄，並把投資狀態改回「尚未開放」。</p>
      <p>建議先按「匯出 CSV」備份。</p>`,
    okText: "下一步",
    danger: true,
  });
  if (!first) return;
  const second = await confirmDialog({
    title: "最後確認",
    body: "<p><b>刪除後無法復原。</b>比賽當天請不要執行。</p>",
    okText: "永久刪除",
    danger: true,
    requireText: "清除",
  });
  if (!second) return;
  try {
    const refs = [
      ...(await getDocs(collection(db, "investments"))).docs.map((d) => d.ref),
      ...(await getDocs(collection(db, "investLogs"))).docs.map((d) => d.ref),
    ];
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    await setDoc(doc(db, "config", "settings"), { investState: "notOpen", hideAmounts: true }, { merge: true });
    toast(`已清除 ${refs.length} 筆資料，投資狀態已改回「尚未開放」`, "ok", 5000);
  } catch (e) {
    toast(`清除失敗：${e.message}`, "error", 6000);
  }
});

// ---------- 活動開關 ----------
let settings = { ...DEFAULT_SETTINGS };

function renderSwitches() {
  const locked = settings.editLocked;
  const badge = document.getElementById("edit-state");
  badge.textContent = locked ? "已鎖定" : "開放編輯中";
  badge.className = `badge ${locked ? "badge-red" : ""}`;
  const btn = document.getElementById("toggle-edit");
  btn.textContent = locked ? "開放編輯" : "鎖定編輯";
  btn.className = `btn ${locked ? "btn-primary" : "btn-danger"}`;
  renderInvestSwitches();
}

document.getElementById("toggle-edit").addEventListener("click", async () => {
  const lock = !settings.editLocked;
  const ok = await confirmDialog({
    title: lock ? "鎖定編輯？" : "開放編輯？",
    body: lock
      ? "<p>評審和組員將不能再修改卡片內容。</p>"
      : "<p>評審和組員可以修改自己的卡片。</p>",
    okText: lock ? "鎖定" : "開放",
    danger: lock,
  });
  if (!ok) return;
  try {
    await setDoc(doc(db, "config", "settings"), { editLocked: lock }, { merge: true });
    toast(lock ? "已鎖定編輯" : "已開放編輯", "ok");
  } catch (e) {
    toast(`更新失敗：${e.message}`, "error");
  }
});

// ---------- 首頁文字 ----------
const introInput = document.getElementById("intro-input");
const rulesInput = document.getElementById("rules-input");
let contentFilled = false;

// 只在第一次載入時填入，避免打字打到一半被覆蓋
function fillContentOnce(c) {
  if (contentFilled) return;
  contentFilled = true;
  introInput.value = c.intro;
  rulesInput.value = c.rules;
  scheduleInput.value = (c.schedule || [])
    .map((r) => {
      const cells = [r.time, r.title, r.note || "", r.place || ""];
      while (cells.length > 2 && !cells[cells.length - 1]) cells.pop();
      return cells.join("｜");
    })
    .join("\n");
  renderContentPreview();
  renderSchedulePreview();
}

function renderContentPreview() {
  document.getElementById("intro-preview").innerHTML = renderText(introInput.value, settings);
  document.getElementById("rules-preview").innerHTML = renderText(rulesInput.value, settings);
}
introInput.addEventListener("input", renderContentPreview);
rulesInput.addEventListener("input", renderContentPreview);

document.getElementById("save-content").addEventListener("click", async () => {
  try {
    await setDoc(doc(db, "config", "content"),
      { intro: introInput.value, rules: rulesInput.value, updatedAt: serverTimestamp() }, { merge: true });
    toast("首頁文字已儲存", "ok");
  } catch (e) {
    toast(`儲存失敗：${e.message}`, "error");
  }
});

document.getElementById("reset-content").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "還原成預設文字？",
    body: "<p>輸入框會換回預設的介紹與規則（還沒儲存前不會影響網站）。</p>",
    okText: "還原",
  });
  if (!ok) return;
  introInput.value = DEFAULT_CONTENT.intro;
  rulesInput.value = DEFAULT_CONTENT.rules;
  renderContentPreview();
});

// ---------- 賽程 ----------
const scheduleInput = document.getElementById("schedule-input");

function parseSchedule(text) {
  return text.split(/\r?\n/)
    .map((line) => line.split(/\t|｜|\|/).map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean))
    .map(([time = "", title = "", note = "", place = ""]) => ({ time, title, note, place }));
}

function renderSchedulePreview() {
  document.getElementById("schedule-preview").innerHTML = renderSchedule(parseSchedule(scheduleInput.value));
}
scheduleInput.addEventListener("input", renderSchedulePreview);

document.getElementById("save-schedule").addEventListener("click", async () => {
  try {
    await setDoc(doc(db, "config", "content"),
      { schedule: parseSchedule(scheduleInput.value), updatedAt: serverTimestamp() }, { merge: true });
    toast("賽程已儲存", "ok");
  } catch (e) {
    toast(`儲存失敗：${e.message}`, "error");
  }
});

// 第一次使用時建立預設設定
async function ensureSettings() {
  const ref = doc(db, "config", "settings");
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { ...DEFAULT_SETTINGS, createdAt: serverTimestamp() });
    toast("已建立預設活動設定", "ok");
  }
}

// ---------- 解析貼上的名單 ----------
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };

function parseCategory(text) {
  const t = text.replace(/\s/g, "").toLowerCase();
  if (["管理員", "管理者", "admin"].includes(t)) return { kind: "admin" };
  if (["老師", "教師", "teacher"].includes(t)) return { kind: "teacher" };
  if (["評審", "judge"].includes(t)) return { kind: "judge" };
  const m = t.match(/^(?:第)?([一二三四五1-5])組?$/) || t.match(/^team([1-5])$/);
  if (m) {
    const n = CN_NUM[m[1]] || Number(m[1]);
    if (TEAM_IDS[n - 1]) return { kind: "team", team: TEAM_IDS[n - 1] };
  }
  return null;
}

function parseRoster(text) {
  const people = new Map(); // email -> person
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = (line.includes("\t") ? line.split("\t") : line.split(/[,，]/))
      .map((c) => c.trim())
      .filter(Boolean);
    const row = { line: i + 1, raw: line, cells, error: null };
    const emailCell = cells.find((c) => c.includes("@"));
    if (!emailCell) {
      // 沒有 email 的列：多半是標題列，略過
      if (/email|信箱|類別|名字|姓名/i.test(line)) return;
      row.error = "找不到 email";
      rows.push(row);
      return;
    }
    const email = emailCell.toLowerCase();
    let category = null;
    let name = "";
    for (const c of cells) {
      if (c === emailCell) continue;
      const cat = parseCategory(c);
      if (cat && !category) category = cat;
      else if (!name) name = c;
    }
    row.email = email;
    row.name = name;
    row.category = category;
    if (!isSchoolEmail(email)) row.error = `不是 @${SCHOOL_DOMAIN} 帳號`;
    else if (!category) row.error = "看不懂類別（請填 管理員／老師／評審／第一組～第五組）";
    rows.push(row);
    if (row.error) return;

    const p = people.get(email) || {
      email, name: "", isAdmin: false, isTeacher: false, isJudge: false, team: null, errors: [],
    };
    if (name && !p.name) p.name = name;
    if (category.kind === "admin") { p.isAdmin = true; p.isTeacher = true; }
    if (category.kind === "teacher") p.isTeacher = true;
    if (category.kind === "judge") p.isJudge = true;
    if (category.kind === "team") {
      if (p.team && p.team !== category.team) {
        p.errors.push(`同時在 ${teamLabel(p.team)} 和 ${teamLabel(category.team)}`);
      }
      p.team = category.team;
    }
    people.set(email, p);
  });

  for (const p of people.values()) {
    if (p.isJudge && p.team) p.errors.push("評審不能同時是組員");
  }
  const list = [...people.values()];
  const rowErrors = rows.filter((r) => r.error);
  const personErrors = list.filter((p) => p.errors.length);
  return { rows, list, rowErrors, personErrors, ok: !rowErrors.length && !personErrors.length };
}

function rolesText(p) {
  const r = [];
  if (p.isAdmin) r.push("管理員");
  if (p.isTeacher) r.push("老師");
  if (p.isJudge || p.judgeSlot) r.push("評審");
  if (p.team) r.push(teamLabel(p.team));
  return r.join("、");
}

function summaryText(list) {
  const judges = list.filter((p) => p.isJudge || p.judgeSlot).length;
  const teachers = list.filter((p) => p.isTeacher).length;
  const teams = TEAM_IDS.map((t) => `${teamLabel(t)} ${list.filter((p) => p.team === t).length} 人`);
  return `共 ${list.length} 人：評審 ${judges} 位、老師 ${teachers} 位（含管理員）；${teams.join("、")}`;
}

document.getElementById("preview-btn").addEventListener("click", () => {
  parsed = parseRoster(input.value);
  previewBox.classList.remove("hidden");
  if (!parsed.rows.length) {
    previewBox.innerHTML = `<p class="muted">沒有讀到任何資料。</p>`;
    return;
  }
  const errorRows = parsed.rowErrors.map((r) =>
    `<tr class="row-error"><td>第 ${r.line} 行</td><td>${esc(r.raw)}</td><td>${esc(r.error)}</td></tr>`).join("");
  const personErrRows = parsed.personErrors.map((p) =>
    `<tr class="row-error"><td>${esc(p.email)}</td><td>${esc(p.name)}</td><td>${esc(p.errors.join("；"))}</td></tr>`).join("");
  const okRows = parsed.list.map((p) => `
    <tr class="${p.errors.length ? "row-error" : ""}">
      <td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${esc(rolesText(p))}</td>
    </tr>`).join("");
  const missingTeams = TEAM_IDS.filter((t) => !parsed.list.some((p) => p.team === t));

  previewBox.innerHTML = `
    ${parsed.ok ? "" : `
      <div class="card" style="background:var(--red-soft);margin-bottom:16px">
        <h3>⚠️ 有 ${parsed.rowErrors.length + parsed.personErrors.length} 個問題要先修正</h3>
        <div class="table-wrap"><table><thead><tr><th>位置</th><th>內容</th><th>問題</th></tr></thead>
        <tbody>${errorRows}${personErrRows}</tbody></table></div>
      </div>`}
    <p><b>${esc(summaryText(parsed.list))}</b></p>
    ${missingTeams.length ? `<p class="badge badge-yellow">提醒：${missingTeams.map(teamLabel).join("、")} 還沒有組員</p>` : ""}
    <div class="table-wrap" style="margin:12px 0"><table>
      <thead><tr><th>名字</th><th>email</th><th>身分</th></tr></thead>
      <tbody>${okRows}</tbody></table></div>
    <button class="btn btn-primary btn-big" id="save-roster-btn" type="button" ${parsed.ok ? "" : "disabled"}>
      儲存名單（取代目前全部名單）
    </button>`;
  document.getElementById("save-roster-btn").addEventListener("click", saveRoster);
});

// ---------- 儲存名單 ----------
async function saveRoster() {
  if (!parsed?.ok) return;
  const list = parsed.list;
  const newEmails = new Set(list.map((p) => p.email));
  const removed = currentRoster.filter((r) => !newEmails.has(r.email));
  const yes = await confirmDialog({
    title: "確定要儲存名單嗎？",
    body: `<p>${esc(summaryText(list))}</p>
      ${removed.length ? `<p>將移除 ${removed.length} 人：${removed.map((r) => esc(r.name || r.email)).join("、")}</p>` : ""}
      <p class="small muted">評審原本填好的評審卡內容會保留，不會被清掉。</p>`,
    okText: "儲存",
  });
  if (!yes) return;

  try {
    // 評審卡位置（judge01, judge02…）：原本有位置的評審沿用，新評審補上空位
    const cardsSnap = await getDocs(collection(db, "judgeCards"));
    const existingSlotByEmail = new Map(currentRoster.filter((r) => r.judgeSlot).map((r) => [r.email, r.judgeSlot]));
    const usedSlots = new Set();
    const judges = list.filter((p) => p.isJudge);
    for (const j of judges) {
      const s = existingSlotByEmail.get(j.email);
      if (s) { j.judgeSlot = s; usedSlots.add(s); }
    }
    let n = 1;
    for (const j of judges) {
      if (j.judgeSlot) continue;
      let slot;
      do { slot = `judge${String(n++).padStart(2, "0")}`; } while (usedSlots.has(slot));
      j.judgeSlot = slot;
      usedSlots.add(slot);
    }

    const ops = [];
    list.forEach((p) => {
      ops.push((b) => b.set(doc(db, "roster", p.email), {
        name: p.name || "",
        isAdmin: p.isAdmin,
        isTeacher: p.isTeacher,
        judgeSlot: p.judgeSlot || null,
        team: p.team || null,
        updatedAt: serverTimestamp(),
      }));
    });
    removed.forEach((r) => ops.push((b) => b.delete(doc(db, "roster", r.email))));
    judges.forEach((j, i) => {
      ops.push((b) => b.set(doc(db, "judgeCards", j.judgeSlot), { active: true, order: i + 1 }, { merge: true }));
    });
    cardsSnap.forEach((c) => {
      if (!usedSlots.has(c.id) && c.data().active !== false) {
        ops.push((b) => b.set(doc(db, "judgeCards", c.id), { active: false }, { merge: true }));
      }
    });

    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => op(batch));
      await batch.commit();
    }
    toast("名單已儲存", "ok");
    previewBox.classList.add("hidden");
  } catch (e) {
    console.error(e);
    toast(`儲存失敗：${e.message}`, "error", 6000);
  }
}

// ---------- 目前名單 ----------
function watchRoster() {
  onSnapshot(collection(db, "roster"), (snap) => {
    currentRoster = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
    renderCurrent();
    renderRecords();
  }, (e) => {
    currentBox.innerHTML = `<p class="badge badge-red">讀取名單失敗：${esc(e.message)}</p>`;
  });
}

function renderCurrent() {
  if (!currentRoster.length) {
    currentBox.innerHTML = `<div class="empty-state">目前沒有名單，請在上方貼上後儲存。</div>`;
    return;
  }
  const byName = (a, b) => (a.name || a.email).localeCompare(b.name || b.email, "zh-Hant");
  const group = (title, people, extra = () => "") => `
    <div class="card">
      <h3>${esc(title)} <span class="badge">${people.length} 人</span></h3>
      ${people.length ? `<div class="table-wrap"><table>
        <thead><tr><th>名字</th><th>email</th><th>身分</th>${extra.header || ""}</tr></thead>
        <tbody>${people.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${esc(rolesText(p))}</td>${extra(p)}</tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted">（尚無）</p>`}
    </div>`;

  const judgeExtra = (p) => `<td>${esc(p.judgeSlot)}</td>`;
  judgeExtra.header = "<th>評審卡</th>";

  currentBox.innerHTML = `
    <p><b>${esc(summaryText(currentRoster))}</b></p>
    ${group("管理員／老師", currentRoster.filter((p) => p.isTeacher || p.isAdmin).sort(byName))}
    ${group("評審", currentRoster.filter((p) => p.judgeSlot).sort((a, b) => a.judgeSlot.localeCompare(b.judgeSlot)), judgeExtra)}
    ${TEAM_IDS.map((t) => group(teamLabel(t), currentRoster.filter((p) => p.team === t).sort(byName))).join("")}`;
}

document.getElementById("load-current-btn").addEventListener("click", () => {
  const lines = [];
  for (const p of currentRoster) {
    if (p.isAdmin) lines.push(`管理員\t${p.name || ""}\t${p.email}`);
    else if (p.isTeacher) lines.push(`老師\t${p.name || ""}\t${p.email}`);
    if (p.judgeSlot) lines.push(`評審\t${p.name || ""}\t${p.email}`);
    if (p.team) lines.push(`${teamLabel(p.team)}\t${p.name || ""}\t${p.email}`);
  }
  input.value = lines.join("\n");
  toast("已把目前名單填回輸入框，可以修改後再預覽儲存", "ok");
});
