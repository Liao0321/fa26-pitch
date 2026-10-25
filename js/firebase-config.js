// ============================================================
// 這是整個網站「唯一需要你修改」的設定檔
// 請依照《部署與使用說明.md》第 1 章，把 Firebase 給你的設定貼進下面
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCoO6qcfDOlyMgxxfhQeyB5CVqbDKK-gT4",
  authDomain: "fa26-pitch.firebaseapp.com",
  projectId: "fa26-pitch",
  storageBucket: "fa26-pitch.firebasestorage.app",
  messagingSenderId: "231024665286",
  appId: "1:231024665286:web:cebe921b656f2b2fd7adc7",
};

// 活動名稱（首頁標題、瀏覽器分頁標題會用到）
export const EVENT_NAME = "FA26 G1 提案比賽";

// 比賽日期（首頁的賽程會在當天標出「進行中」的項目）
export const EVENT_DATE = "2026-11-06";

// 只允許這個網域的 Google 帳號登入
export const SCHOOL_DOMAIN = "g.nccu.edu.tw";

// 永遠是管理員的 email（就算名單還沒建立也能進後台）
// ⚠️ 如果要改，firestore.rules 裡的 isOwnerAdmin() 也要一起改
export const OWNER_ADMINS = ["s.w.liao@g.nccu.edu.tw"];

// 參賽組數（固定 5 組）
export const TEAM_IDS = ["team1", "team2", "team3", "team4", "team5"];
export const TEAM_DEFAULT_NAMES = {
  team1: "第一組",
  team2: "第二組",
  team3: "第三組",
  team4: "第四組",
  team5: "第五組",
};
