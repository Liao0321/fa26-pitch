// 各組募資統計與排名（管理後台、投影模式共用，需要管理員權限讀取全部投資）
import { TEAM_IDS } from "./firebase-config.js";

// investments：[{ email, team1..team5 }]；roster：Map(email → 名單資料)
export function computeStats(investments, roster) {
  const teams = Object.fromEntries(TEAM_IDS.map((t) => [t, {
    teamId: t, judge: 0, audience: 0, total: 0, supporters: 0,
  }]));
  let grandTotal = 0;
  let investorCount = 0;

  for (const inv of investments) {
    const r = roster.get(inv.email) || {};
    const isJudge = !!r.judgeSlot;
    let any = false;
    for (const t of TEAM_IDS) {
      const v = Number(inv[t]) || 0;
      if (v <= 0) continue;
      any = true;
      const s = teams[t];
      if (isJudge) s.judge += v; else s.audience += v;
      s.total += v;
      s.supporters += 1;
      grandTotal += v;
    }
    if (any) investorCount += 1;
  }

  // 排名：總額 → 支持人數 → 評審投資（排除觀眾）
  const ranking = TEAM_IDS.map((t) => teams[t]).sort((a, b) =>
    b.total - a.total || b.supporters - a.supporters || b.judge - a.judge);
  ranking.forEach((s, i) => {
    const prev = ranking[i - 1];
    // 三個條件都相同才算並列
    s.rank = prev && prev.total === s.total && prev.supporters === s.supporters && prev.judge === s.judge
      ? prev.rank : i + 1;
  });

  return { teams, ranking, grandTotal, investorCount };
}
