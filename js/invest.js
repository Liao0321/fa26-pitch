// 投資資料的讀寫（參賽隊伍頁、安全規則測試頁共用）
// 每次投資都用「批次寫入」同時更新 investments/{uid} 和新增一筆 investLogs，
// 安全規則會檢查兩者一致，所以紀錄不能被偽造
import {
  collection, doc, onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./common.js";
import { TEAM_IDS } from "./firebase-config.js";

export function zeroAmounts() {
  return Object.fromEntries(TEAM_IDS.map((t) => [t, 0]));
}

export function amountsOf(data) {
  return Object.fromEntries(TEAM_IDS.map((t) => [t, Number(data?.[t]) || 0]));
}

export function sumOf(amounts) {
  return TEAM_IDS.reduce((s, t) => s + (Number(amounts[t]) || 0), 0);
}

// 監聽自己的投資；cb(amounts, exists)
export function watchMyInvestment(uid, cb) {
  return onSnapshot(doc(db, "investments", uid), (snap) => {
    cb(amountsOf(snap.exists() ? snap.data() : null), snap.exists());
  }, (e) => {
    console.error(e);
    cb(zeroAmounts(), false);
  });
}

// before：資料庫裡目前的金額；after：新的金額
// tamper：測試頁用來故意送出錯誤資料（正常使用不要傳）
export async function saveInvestment(profile, before, after, tamper = {}) {
  const logRef = doc(collection(db, "investLogs"));
  const batch = writeBatch(db);
  batch.set(doc(db, "investments", tamper.uid || profile.uid), {
    email: profile.email,
    ...after,
    updatedAt: serverTimestamp(),
    logId: logRef.id,
    ...(tamper.investmentExtra || {}),
  });
  batch.set(logRef, {
    uid: profile.uid,
    email: profile.email,
    account: profile.account,
    name: String(profile.name || "").slice(0, 40), // 名單上的名字，沒有就用 Google 帳號名字（結尾動畫用）
    isJudge: profile.isJudge,
    isTeacher: profile.isTeacher,
    before,
    after: tamper.logAfter || after,
    at: serverTimestamp(),
  });
  await batch.commit();
}

export function isPermissionError(e) {
  return e?.code === "permission-denied" || /permission/i.test(e?.message || "");
}
