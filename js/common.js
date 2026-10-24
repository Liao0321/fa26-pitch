// 全站共用：Firebase 初始化、登入、身分判斷、頁首選單、提示視窗
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  firebaseConfig, EVENT_NAME, SCHOOL_DOMAIN, OWNER_ADMINS, TEAM_DEFAULT_NAMES,
} from "./firebase-config.js";
import { DEFAULT_CONTENT } from "./defaults.js";

export const configReady = !String(firebaseConfig.apiKey).includes("請貼上");
export const app = configReady ? initializeApp(firebaseConfig) : null;
export const auth = configReady ? getAuth(app) : null;
export const db = configReady ? getFirestore(app) : null;

export const DEFAULT_SETTINGS = {
  investState: "notOpen", // notOpen | open | settled
  editLocked: false,
  hideAmounts: true,
  judgeCoins: 20,
  defaultCoins: 3,
};

// ---------- 小工具 ----------
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function accountOf(email) {
  return String(email || "").split("@")[0];
}

export function isSchoolEmail(email) {
  return String(email || "").toLowerCase().endsWith("@" + SCHOOL_DOMAIN);
}

export function teamLabel(teamId) {
  return TEAM_DEFAULT_NAMES[teamId] || teamId;
}

// ---------- 內建瀏覽器偵測（LINE / FB / IG…） ----------
export function detectInAppBrowser() {
  const ua = navigator.userAgent || "";
  if (/\bLine\//i.test(ua)) return "LINE";
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return "Facebook";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/MicroMessenger/i.test(ua)) return "微信";
  if (/; wv\)/.test(ua)) return "App 內建瀏覽器";
  return null;
}

function handleInAppBrowser() {
  const inApp = detectInAppBrowser();
  if (!inApp) return null;
  // LINE：加上 openExternalBrowser=1 會自動改用手機預設瀏覽器開啟
  if (inApp === "LINE") {
    const url = new URL(location.href);
    if (url.searchParams.get("openExternalBrowser") !== "1") {
      url.searchParams.set("openExternalBrowser", "1");
      location.replace(url.toString());
    }
  }
  const bar = document.createElement("div");
  bar.className = "inapp-banner";
  bar.innerHTML = `
    <strong>⚠️ 你正在用 ${esc(inApp)} 內建瀏覽器開啟</strong>
    <span>Google 不允許在這裡登入。請點右上角「⋯」選擇「用 Safari / Chrome 開啟」，或複製網址貼到瀏覽器。</span>
    <button class="btn btn-small" type="button">複製網址</button>`;
  bar.querySelector("button").addEventListener("click", async () => {
    const clean = new URL(location.href);
    clean.searchParams.delete("openExternalBrowser");
    try {
      await navigator.clipboard.writeText(clean.toString());
      toast("已複製網址，請貼到 Safari 或 Chrome", "ok");
    } catch {
      prompt("請長按複製這個網址：", clean.toString());
    }
  });
  document.body.prepend(bar);
  return inApp;
}

// ---------- 提示訊息 ----------
export function toast(message, type = "info", ms = 3200) {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// 確認視窗：回傳 Promise<boolean>
// requireText：必須輸入這段文字才能按確認（用於危險操作）
export function confirmDialog({ title, body = "", okText = "確認", cancelText = "取消", danger = false, requireText = "" }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${body}</div>
        ${requireText ? `<div class="field" style="margin-top:12px">
          <label>請輸入「${esc(requireText)}」以確認</label>
          <input type="text" data-require autocomplete="off">
        </div>` : ""}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="no" type="button">${esc(cancelText)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="yes" type="button">${esc(okText)}</button>
        </div>
      </div>`;
    const close = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close(false);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) close(act === "yes");
    });
    document.body.appendChild(wrap);
    const yes = wrap.querySelector('[data-act="yes"]');
    const typed = wrap.querySelector("[data-require]");
    if (typed) {
      yes.disabled = true;
      typed.addEventListener("input", () => { yes.disabled = typed.value.trim() !== requireText; });
      typed.focus();
    } else {
      yes.focus();
    }
  });
}

// ---------- 登入 ----------
let inAppName = null;

export async function login() {
  if (!configReady) {
    toast("網站尚未設定 Firebase，請先完成 firebase-config.js", "error");
    return;
  }
  if (inAppName) {
    await confirmDialog({
      title: "請改用 Safari / Chrome 開啟",
      body: `<p>你目前在 ${esc(inAppName)} 的內建瀏覽器，Google 會擋下登入。</p>
             <p>請點右上角「⋯」→「用瀏覽器開啟」，或用上方的「複製網址」按鈕。</p>`,
      okText: "我知道了",
      cancelText: "關閉",
    });
    return;
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: SCHOOL_DOMAIN, prompt: "select_account" });
  try {
    const result = await signInWithPopup(auth, provider);
    const u = result.user;
    if (!isSchoolEmail(u.email) || !u.emailVerified) {
      await signOut(auth);
      toast(`只能使用 @${SCHOOL_DOMAIN} 的學校帳號登入`, "error", 5000);
    }
  } catch (e) {
    const messages = {
      "auth/popup-blocked": "登入視窗被瀏覽器擋住了，請允許「彈出式視窗」後再按一次登入。",
      "auth/popup-closed-by-user": "登入視窗被關閉了，請再按一次登入。",
      "auth/cancelled-popup-request": "",
      "auth/unauthorized-domain": "這個網址還沒加入 Firebase「已授權網域」，請通知管理員。",
      "auth/network-request-failed": "網路連線失敗，請確認網路後再試一次。",
      "auth/web-storage-unsupported": "瀏覽器封鎖了必要的儲存功能，請關閉無痕模式或改用 Chrome / Safari。",
    };
    const msg = e.code in messages ? messages[e.code] : `登入失敗（${e.code || e.message}），請改用 Chrome / Safari 再試一次。`;
    if (msg) toast(msg, "error", 6000);
  }
}

export function logout() {
  return signOut(auth);
}

// ---------- 身分 ----------
// profile = null（未登入）或
// { uid, email, account, name, isAdmin, isTeacher, isJudge, judgeSlot, team, roles: [...] }
export function buildProfile(user, roster) {
  const email = user.email.toLowerCase();
  const r = roster || {};
  const isAdmin = OWNER_ADMINS.includes(email) || r.isAdmin === true;
  const p = {
    uid: user.uid,
    email,
    account: accountOf(email),
    name: r.name || user.displayName || accountOf(email),
    isAdmin,
    isTeacher: isAdmin || r.isTeacher === true,
    judgeSlot: r.judgeSlot || null,
    isJudge: !!r.judgeSlot,
    team: r.team || null,
  };
  p.roles = [];
  if (p.isAdmin) p.roles.push("管理員");
  if (p.isTeacher) p.roles.push("老師");
  if (p.isJudge) p.roles.push("評審");
  if (p.team) p.roles.push(`${teamLabel(p.team)}組員`);
  if (!p.isJudge && !p.team && !p.isTeacher) p.roles.push("觀眾");
  return p;
}

export function quotaOf(profile, settings) {
  if (!profile) return 0;
  return profile.isJudge ? settings.judgeCoins : settings.defaultCoins;
}

export function watchSettings(cb) {
  if (!configReady) { cb({ ...DEFAULT_SETTINGS }); return () => {}; }
  return onSnapshot(doc(db, "config", "settings"), (snap) => {
    cb({ ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}), _exists: snap.exists() });
  }, (err) => {
    console.error(err);
    cb({ ...DEFAULT_SETTINGS });
  });
}

// 首頁文字與賽程（config/content），還沒編輯過就用 defaults.js 的預設內容
export function watchContent(cb) {
  if (!configReady) { cb({ ...DEFAULT_CONTENT }); return () => {}; }
  return onSnapshot(doc(db, "config", "content"), (snap) => {
    cb({ ...DEFAULT_CONTENT, ...(snap.exists() ? snap.data() : {}) });
  }, (err) => {
    console.error(err);
    cb({ ...DEFAULT_CONTENT });
  });
}

// ---------- 頁首 ----------
const NAV = [
  { id: "home", href: "index.html", label: "首頁" },
  { id: "schedule", href: "schedule.html", label: "賽程" },
  { id: "judges", href: "judges.html", label: "評審" },
  { id: "teams", href: "teams.html", label: "參賽隊伍" },
  { id: "edit", href: "edit.html", label: "編輯我的卡片", show: (p) => p && (p.isJudge || p.team || p.isAdmin) },
  { id: "admin", href: "admin.html", label: "管理後台", show: (p) => p && p.isAdmin },
];

function renderHeader(active, profile) {
  const header = document.getElementById("site-header");
  if (!header) return;
  const links = NAV.filter((n) => !n.show || n.show(profile))
    .map((n) => `<a href="${n.href}" class="${n.id === active ? "active" : ""}">${n.label}</a>`)
    .join("");
  const user = profile
    ? `<div class="user-chip">
         <span class="user-account">${esc(profile.account)}</span>
         <span class="user-roles">${profile.roles.map(esc).join("・")}</span>
       </div>
       <button class="btn btn-small btn-ghost" id="logout-btn" type="button">登出</button>`
    : `<button class="btn btn-small btn-primary" id="login-btn" type="button">學校帳號登入</button>`;
  header.innerHTML = `
    <div class="header-row container">
      <a class="brand" href="index.html">
        <span class="brand-mark">FS</span>
        <span class="brand-text">${esc(EVENT_NAME)}</span>
      </a>
      <div class="header-user">${user}</div>
    </div>
    <nav class="main-nav"><div class="container nav-scroll">${links}</div></nav>`;
  header.querySelector("#login-btn")?.addEventListener("click", login);
  header.querySelector("#logout-btn")?.addEventListener("click", logout);
  document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
}

// 每一頁都呼叫：startPage({ active: "home", onProfile: (profile) => {...} })
// onProfile 會在「登入狀態或名單身分」改變時再次被呼叫
export function startPage({ active, onProfile = () => {} }) {
  document.title = document.title || EVENT_NAME;
  inAppName = handleInAppBrowser();
  renderHeader(active, null);

  if (!configReady) {
    const warn = document.createElement("div");
    warn.className = "inapp-banner";
    warn.innerHTML = `<strong>網站尚未設定 Firebase</strong><span>請依《部署與使用說明.md》第 1 章，把設定貼進 js/firebase-config.js。</span>`;
    document.body.prepend(warn);
    onProfile(null);
    return;
  }

  let stopRoster = null;
  onAuthStateChanged(auth, (user) => {
    stopRoster?.();
    stopRoster = null;
    if (!user || !isSchoolEmail(user.email)) {
      renderHeader(active, null);
      onProfile(null);
      return;
    }
    const email = user.email.toLowerCase();
    stopRoster = onSnapshot(doc(db, "roster", email), (snap) => {
      const profile = buildProfile(user, snap.exists() ? snap.data() : null);
      renderHeader(active, profile);
      onProfile(profile);
    }, (err) => {
      console.error(err);
      const profile = buildProfile(user, null);
      renderHeader(active, profile);
      onProfile(profile);
    });
  });
}
