// 資金流動重播：依照逐筆紀錄，把整場的投資過程壓縮成 60 秒內的像素動畫
// - 畫面下方是投資人像素小人（頭上顯示名字或姓，評審戴皇冠、穿金色）
// - 新投入的錢：金幣從小人手中飛向該組
// - 換組的錢：金幣從 A 組直接飛到 B 組
// - 減少的錢：金幣飛回小人手中

const MAX_SECONDS = 50;     // 所有事件在 50 秒內播完（再加上飛行與結尾）
const MAX_GAP = 1.2;        // 事件很少時，每筆最多間隔 1.2 秒
const FLIGHT = 1.1;         // 每枚金幣飛行時間（秒）
const COIN_STAGGER = 0.07;  // 同一筆裡多枚金幣的間隔

const COLORS = {
  ink: "#141414",
  bg: "#f3f5ec",
  grid: "rgba(20,20,20,0.055)",
  green: "#5fd33a",
  greenDeep: "#2b9414",
  greenSoft: "#e4f7d8",
  coin: "#f6c945",
  coinShade: "#d9a520",
  muted: "#5d6459",
  skin: "#f2c9a0",
  shirts: ["#4f8df5", "#e5484d", "#9b6bf2", "#20a4a4", "#ff8a3d", "#5fd33a", "#e05fb8", "#7a8a99"],
};

// 8×10 像素小人：. 透明、h 頭髮、s 皮膚、b 衣服、l 褲子、c 皇冠
const PERSON = [
  "..hhhh..",
  ".hhhhhh.",
  ".hssssh.",
  ".ssssss.",
  "..ssss..",
  ".bbbbbb.",
  "sbbbbbbs",
  "sbbbbbbs",
  "..llll..",
  "..l..l..",
];
const CROWN = [
  "c.c..c.c",
  "cccccccc",
];

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 名字放不下時只顯示姓：中文取第一個字；英文取第一個單字
function surnameOf(name) {
  const s = String(name).trim();
  if (/^[㐀-鿿]/.test(s)) return s[0];
  if (/^\d+$/.test(s)) return null; // 學號帳號沒有姓
  return s.split(/[\s.-]+/)[0];
}

export function startReplay(canvas, { logs, settings, teamIds, teamName, personName = (l) => l.account }) {
  const ctx = canvas.getContext("2d");
  const judgeQuota = settings?.judgeCoins ?? 20;
  const defaultQuota = settings?.defaultCoins ?? 3;

  // ---------- 整理事件 ----------
  const people = new Map(); // account → { account, isJudge, wallet, x, y }
  const events = [];
  for (const log of logs) {
    if (!log.account) continue;
    if (!people.has(log.account)) {
      people.set(log.account, {
        account: log.account,
        name: personName(log) || log.account,
        isJudge: !!log.isJudge,
        wallet: log.isJudge ? judgeQuota : defaultQuota,
        color: COLORS.shirts[hash(log.account) % COLORS.shirts.length],
      });
    }
    const diffs = teamIds.map((t) => ({ t, d: (log.after?.[t] || 0) - (log.before?.[t] || 0) }));
    const ups = diffs.filter((x) => x.d > 0).map((x) => ({ ...x }));
    const downs = diffs.filter((x) => x.d < 0).map((x) => ({ t: x.t, d: -x.d }));
    if (!ups.length && !downs.length) continue;
    // 先配對「從 A 組移到 B 組」，剩下的才是從錢包投入或退回錢包
    const moves = [];
    for (const dn of downs) {
      for (const up of ups) {
        const n = Math.min(dn.d, up.d);
        if (n > 0) { moves.push({ from: dn.t, to: up.t, n }); dn.d -= n; up.d -= n; }
      }
    }
    const flights = [];
    for (const m of moves) for (let i = 0; i < m.n; i++) flights.push({ from: { team: m.from }, to: { team: m.to } });
    for (const up of ups) for (let i = 0; i < up.d; i++) flights.push({ from: { person: log.account }, to: { team: up.t } });
    for (const dn of downs) for (let i = 0; i < dn.d; i++) flights.push({ from: { team: dn.t }, to: { person: log.account } });
    events.push({ at: log.at?.toMillis?.() || 0, flights });
  }
  const gap = events.length ? Math.min(MAX_GAP, MAX_SECONDS / events.length) : 0;
  events.forEach((e, i) => { e.start = 1.5 + i * gap; });
  const endTime = events.length ? events[events.length - 1].start + 3 : 2;

  // 評審排中間，其他人分在兩側
  const all = [...people.values()].sort((a, b) => a.account.localeCompare(b.account));
  const judges = all.filter((p) => p.isJudge);
  const others = all.filter((p) => !p.isJudge);
  const half = Math.ceil(others.length / 2);
  const ordered = [...others.slice(0, half), ...judges, ...others.slice(half)];

  // ---------- 狀態 ----------
  const pile = Object.fromEntries(teamIds.map((t) => [t, 0]));
  let coins = [];       // 飛行中的金幣
  let queue = [];       // 尚未發射的金幣 { launch, from, to }
  for (const e of events) {
    e.flights.forEach((f, i) => queue.push({ launch: e.start + i * COIN_STAGGER, from: f.from, to: f.to, at: e.at }));
  }
  let time = 0;
  let paused = false;
  let lastFrame = null;
  let raf = null;
  let clock = events[0]?.at || 0;
  let W = 0, H = 0, layout = null;

  // ---------- 版面 ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colW = W / teamIds.length;
    const coinR = Math.max(5, Math.min(13, colW / 22));
    const baseY = H * 0.56;
    const teams = Object.fromEntries(teamIds.map((t, i) => [t, { x: colW * i + colW / 2, baseY, w: colW * 0.78 }]));

    // 所有人排成一排。名字放得下就顯示全名；放不下只顯示姓；連姓都放不下（例如學號）就不顯示，避免畫面太亂
    const n = Math.max(1, ordered.length);
    const slot = W / n;
    const px = Math.max(2, Math.min(6, Math.floor(slot / 11)));
    const fontSize = Math.max(11, Math.min(16, W / 100));
    ctx.font = `900 ${fontSize}px "Noto Sans TC", sans-serif`;
    const room = slot * 0.92;
    ordered.forEach((p, i) => {
      p.scale = p.isJudge ? px + 1 : px;
      p.x = slot * (i + 0.5);
      p.y = H - 18;
      p.label = p.name;
      if (ctx.measureText(p.name).width > room) {
        const short = surnameOf(p.name);
        p.label = short && ctx.measureText(short).width <= room ? short : null;
      }
    });
    layout = {
      teams, coinR, fontSize,
      perRow: Math.max(4, Math.floor(colW * 0.78 / (coinR * 2.1))),
    };
  }

  function pileTop(t, index) {
    const L = layout.teams[t];
    const r = layout.coinR;
    const col = index % layout.perRow;
    const layer = Math.floor(index / layout.perRow);
    const rowW = layout.perRow * r * 2.1;
    return {
      x: L.x - rowW / 2 + r * 1.05 + col * r * 2.1 + (layer % 2 ? r * 0.5 : 0),
      y: L.baseY - r - layer * r * 1.25,
    };
  }

  function posOf(end, forLanding) {
    if (end.person) {
      const p = people.get(end.person);
      return { x: p.x, y: p.y - p.scale * 7 };
    }
    return pileTop(end.team, forLanding ? pile[end.team] : Math.max(0, pile[end.team] - 1));
  }

  // ---------- 繪圖 ----------
  function drawCoin(x, y, r) {
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath(); ctx.ellipse(x, y, r + 2, r * 0.75 + 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.coinShade;
    ctx.beginPath(); ctx.ellipse(x, y + 1.5, r, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.coin;
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.86, r * 0.62, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawPixels(map, x, y, s, colorOf) {
    map.forEach((line, row) => {
      [...line].forEach((ch, col) => {
        const c = colorOf(ch);
        if (!c) return;
        ctx.fillStyle = c;
        ctx.fillRect(Math.round(x + col * s), Math.round(y + row * s), s, s);
      });
    });
  }

  function drawPerson(p) {
    const s = p.scale;
    const w = 8 * s;
    const top = p.y - PERSON.length * s;
    const colorOf = (ch) => ({
      h: p.isJudge ? "#3a2a10" : "#2a2a2a",
      s: COLORS.skin,
      b: p.isJudge ? COLORS.coin : p.color,
      l: COLORS.ink,
    }[ch]);
    // 黑色外框（往四個方向各畫一次）
    const outline = (ch) => (ch === "." ? null : COLORS.ink);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) drawPixels(PERSON, p.x - w / 2 + dx * 2, top + dy * 2, s, outline);
    drawPixels(PERSON, p.x - w / 2, top, s, colorOf);
    if (p.isJudge) drawPixels(CROWN, p.x - w / 2, top - 2 * s, s, (ch) => (ch === "c" ? COLORS.coin : null));
    // 手上的錢包金幣
    if (p.wallet > 0) drawCoin(p.x + w / 2 + s, top + 6 * s, Math.max(3, s * 1.2));
    // 名字
    if (!p.label) return;
    ctx.font = `${p.isJudge ? 900 : 700} ${layout.fontSize}px "Noto Sans TC", sans-serif`;
    ctx.fillStyle = p.isJudge ? COLORS.greenDeep : COLORS.ink;
    ctx.textAlign = "center";
    ctx.fillText(p.label, p.x, top - (p.isJudge ? 3 * s : s) - 4);
  }

  function drawTeams(final) {
    const r = layout.coinR;
    for (const t of teamIds) {
      const L = layout.teams[t];
      // 平台
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(L.x - L.w / 2, L.baseY, L.w, 8);
      ctx.fillStyle = COLORS.green;
      ctx.fillRect(L.x - L.w / 2, L.baseY + 8, L.w, 6);
      // 金幣堆
      for (let i = 0; i < pile[t]; i++) {
        const p = pileTop(t, i);
        drawCoin(p.x, p.y, r);
      }
      // 組名
      ctx.textAlign = "center";
      ctx.fillStyle = COLORS.ink;
      ctx.font = `900 ${Math.max(14, Math.min(26, W / 55))}px "Noto Sans TC", sans-serif`;
      ctx.fillText(teamName(t), L.x, L.baseY + 42, L.w);
      if (final) {
        ctx.font = `900 ${Math.max(18, Math.min(40, W / 38))}px "Noto Sans TC", sans-serif`;
        ctx.fillStyle = COLORS.greenDeep;
        const top = pileTop(t, Math.max(0, pile[t] - 1));
        ctx.fillText(`${pile[t]}`, L.x, top.y - r - 14);
      }
    }
  }

  function drawBackground(final) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
    // 標題與時鐘
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.ink;
    ctx.font = `900 ${Math.max(18, Math.min(34, W / 45))}px "Noto Sans TC", sans-serif`;
    ctx.fillText(final ? "資金流動・最終結果" : "資金流動重播", 24, 48);
    if (clock && !final) {
      ctx.font = `${Math.max(12, Math.min(20, W / 80))}px "Press Start 2P", monospace`;
      ctx.fillStyle = COLORS.greenDeep;
      ctx.fillText(fmtClock(clock), 24, 84);
    }
    if (!events.length) {
      ctx.textAlign = "center";
      ctx.font = `700 24px "Noto Sans TC", sans-serif`;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText("還沒有投資紀錄", W / 2, H / 2);
    }
  }

  function frame(now) {
    if (lastFrame == null) lastFrame = now;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!paused) time += dt;

    // 發射金幣
    while (queue.length && queue[0].launch <= time) {
      const q = queue.shift();
      const from = posOf(q.from, false);
      if (q.from.team) pile[q.from.team] = Math.max(0, pile[q.from.team] - 1);
      if (q.from.person) people.get(q.from.person).wallet -= 1;
      coins.push({ ...q, sx: from.x, sy: from.y, t0: q.launch });
      clock = q.at;
    }

    const final = time >= endTime && !coins.length && !queue.length;
    drawBackground(final);
    drawTeams(final);
    ordered.forEach(drawPerson);

    // 飛行中的金幣（拋物線）
    const r = layout.coinR;
    coins = coins.filter((c) => {
      const p = Math.min(1, (time - c.t0) / FLIGHT);
      const to = posOf(c.to, true);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const x = c.sx + (to.x - c.sx) * e;
      const lift = Math.min(H * 0.35, Math.abs(to.x - c.sx) * 0.35 + 80);
      const y = c.sy + (to.y - c.sy) * e - Math.sin(Math.PI * p) * lift;
      drawCoin(x, y, r * 0.9);
      if (p >= 1) {
        if (c.to.team) pile[c.to.team] += 1;
        if (c.to.person) people.get(c.to.person).wallet += 1;
        return false;
      }
      return true;
    });

    if (paused) {
      ctx.fillStyle = "rgba(20,20,20,0.5)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = `900 48px "Noto Sans TC", sans-serif`;
      ctx.fillText("暫停", W / 2, H / 2);
    }
    raf = requestAnimationFrame(frame);
  }

  function onKey(e) {
    if (e.key === " ") { e.preventDefault(); e.stopImmediatePropagation(); paused = !paused; }
  }

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKey, true);
  raf = requestAnimationFrame(frame);

  const stop = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKey, true);
  };
  stop.restartOrToggle = () => { paused = !paused; };
  return stop;
}
