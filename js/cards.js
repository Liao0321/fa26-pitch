// 評審卡、隊伍卡、文字排版：公開頁面、編輯預覽、投影模式共用
import { esc, teamLabel, coinify } from "./common.js";
import { TEAM_IDS } from "./firebase-config.js";

// 字數上限（投影時塞得下）
export const LIMITS = {
  roleTitle: 20,
  bio: 150,
  projectName: 20,
  intro: 300,
};

// 簡易排版：空行分段、「## 」小標題、「- 」項目符號、**粗體**、[按鈕文字](網址)
// 項目符號的下一行如果不是「- 」開頭，就是同一點裡的換行
// {評審額度}、{一般額度} 會換成後台設定的數字
export function renderText(text, settings = {}) {
  const fill = (s) => s
    .replaceAll("{評審額度}", settings.judgeCoins ?? 20)
    .replaceAll("{一般額度}", settings.defaultCoins ?? 5);
  const inline = (s) => coinify(esc(fill(s))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // 只允許站內頁面或 https 網址
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|[\w-]+\.html)[^)\s]*)\)/g, '<a class="inline-btn" href="$2">$1</a>'));
  const out = [];
  let list = null; // 每一點是一個陣列，裡面是該點的每一行
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<ul>${list.map((li) => `<li>${li.map(inline).join("<br>")}</li>`).join("")}</ul>`); list = null; }
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    if (line.startsWith("## ")) { flushPara(); flushList(); out.push(`<h3>${inline(line.slice(3))}</h3>`); continue; }
    const bullet = line.match(/^[-・•]\s*(.+)$/);
    if (bullet) { flushPara(); (list ||= []).push([bullet[1]]); continue; }
    if (list) { list[list.length - 1].push(line); continue; }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("");
}

// 只保留換行的純文字（介紹、背景）
export function plainText(text) {
  return esc(text || "").replace(/\n/g, "<br>");
}

export function teamNumber(teamId) {
  return String(TEAM_IDS.indexOf(teamId) + 1).padStart(2, "0");
}

export function teamDisplayName(teamId, data) {
  return (data && data.projectName) || teamLabel(teamId);
}

// 名字來自名單，不算「已填寫」；有填身分、介紹或照片才算
export function isJudgeCardFilled(c) {
  return !!(c && (c.roleTitle || c.bio || c.photo));
}

// 評審顯示的名字：名單上的中文名字（舊資料可能只有 roleName）
export function judgeDisplayName(c) {
  return (c && (c.name || c.roleName)) || "";
}

// 賽程時間軸；cur = 「進行中」項目的位置（-1 表示不標示）
export function renderSchedule(rows, cur = -1) {
  if (!rows.length) return `<div class="empty-state">賽程即將公布，敬請期待！</div>`;
  return `<ol class="timeline">${rows.map((r, i) => `
    <li class="${i === cur ? "is-now" : ""} ${cur > -1 && i < cur ? "is-past" : ""}">
      <div class="tl-time">${esc(r.time)}</div>
      <div class="tl-body">
        <div class="tl-main">
          <b>${esc(r.title)}</b>${i === cur ? ` <span class="badge">進行中</span>` : ""}
          ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ""}
        </div>
        ${r.place ? `<span class="place-tag">📍 ${esc(r.place)}</span>` : ""}
      </div>
    </li>`).join("")}</ol>`;
}

// 評審卡
export function renderJudgeCard(card, index = 0) {
  const filled = isJudgeCardFilled(card);
  const no = String(index + 1).padStart(2, "0");
  if (!filled) {
    return `
      <article class="judge-card is-pending">
        <div class="judge-photo"><div class="img-placeholder"><span class="pixel">?</span></div></div>
        <div class="judge-body">
          <span class="tag">JUDGE ${no}</span>
          <h3>準備中…</h3>
          <p class="muted">這位評審還在設定角色，敬請期待！</p>
        </div>
      </article>`;
  }
  return `
    <article class="judge-card">
      <div class="judge-photo">
        ${card.photo ? `<img src="${card.photo}" alt="${esc(judgeDisplayName(card))}">` : `<div class="img-placeholder"><span class="pixel">NO PHOTO</span></div>`}
      </div>
      <div class="judge-body">
        <span class="tag">JUDGE ${no}</span>
        <h3>${esc(judgeDisplayName(card) || "評審")}</h3>
        ${card.roleTitle ? `<span class="role-title">${esc(card.roleTitle)}</span>` : ""}
        <p class="judge-bio">${plainText(card.bio)}</p>
      </div>
    </article>`;
}

// 隊伍卡；footer 用來放投資區（第三階段）
export function renderTeamCard(teamId, data, footer = "") {
  const d = data || {};
  return `
    <article class="team-card" data-team="${teamId}">
      <header class="team-card-head">
        <span class="pixel">TEAM ${teamNumber(teamId)}</span>
        <span>${esc(teamLabel(teamId))}</span>
      </header>
      <div class="team-image">
        ${d.image ? `<img src="${d.image}" alt="${esc(teamDisplayName(teamId, d))}">` : `<div class="img-placeholder"><span class="pixel">COMING SOON</span></div>`}
      </div>
      <div class="team-body">
        <h3>${esc(teamDisplayName(teamId, d))}</h3>
        ${d.intro ? `<p>${plainText(d.intro)}</p>` : `<p class="muted">項目介紹準備中…</p>`}
      </div>
      ${footer}
    </article>`;
}
