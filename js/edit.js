// 編輯我的卡片：評審編輯評審卡、組員編輯組別卡；管理員可以編輯任何一張
import {
  collection, doc, getDocs, onSnapshot, setDoc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  startPage, login, db, esc, toast, confirmDialog, teamLabel, watchSettings,
} from "./common.js";
import { LIMITS, renderJudgeCard, renderTeamCard } from "./cards.js";
import { compressImage } from "./image.js";
import { TEAM_IDS } from "./firebase-config.js";

const root = document.getElementById("edit-root");
const picker = document.getElementById("picker");

let profile = null;
let settings = null;
let target = null;      // { type: "judge" | "team", id, index }
let stopDoc = null;
let draft = null;       // 表單目前的內容
let loadedStamp = null; // 載入時的 updatedAt，用來偵測別人是否更新
let profileKey = null;

const FIELDS = {
  judge: [
    { key: "roleName", label: "角色名稱", hint: "例如：王董、林部長", type: "text" },
    { key: "roleTitle", label: "角色身分", hint: "例如：商業大佬、政府官員", type: "text" },
    { key: "bio", label: "人物背景", hint: "介紹這個角色的經歷、個性、投資偏好", type: "textarea" },
  ],
  team: [
    { key: "projectName", label: "項目名稱", hint: "會顯示在網站和投影幕上，取代「第N組」", type: "text" },
    { key: "intro", label: "項目介紹", hint: "你們的案子或商品是什麼？解決什麼問題？", type: "textarea" },
  ],
};
const IMAGE_KEY = { judge: "photo", team: "image" };
const IMAGE_LABEL = { judge: "評審照片", team: "項目圖片" };

watchSettings((s) => {
  const lockChanged = settings && settings.editLocked !== s.editLocked;
  settings = s;
  if (lockChanged && draft) renderForm();
});

startPage({
  active: "edit",
  onProfile(p) {
    profile = p;
    // 名單身分有變才重新整理頁面，避免打字打到一半被清掉
    const key = p ? `${p.uid}|${p.judgeSlot}|${p.team}|${p.isAdmin}` : "";
    if (key === profileKey) return;
    profileKey = key;
    setup();
  },
});

async function setup() {
  stopDoc?.();
  stopDoc = null;
  draft = null;
  picker.classList.add("hidden");

  if (!profile) {
    root.innerHTML = `<div class="card"><p>請先登入。</p>
      <button class="btn btn-primary" id="edit-login" type="button">學校帳號登入</button></div>`;
    root.querySelector("#edit-login").addEventListener("click", login);
    return;
  }
  if (profile.isJudge) return openTarget({ type: "judge", id: profile.judgeSlot });
  if (profile.team) return openTarget({ type: "team", id: profile.team });
  if (profile.isAdmin) return setupAdminPicker();
  root.innerHTML = `<div class="empty-state">你目前的身分是「${esc(profile.roles.join("・"))}」，沒有需要編輯的卡片。<br>只有評審和參賽組員需要填寫。</div>`;
}

// 管理員：可以選擇要編輯哪一張卡片
async function setupAdminPicker() {
  const snap = await getDocs(collection(db, "judgeCards"));
  const judges = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => c.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const options = [
    ...TEAM_IDS.map((t) => `<option value="team:${t}">${esc(teamLabel(t))}</option>`),
    ...judges.map((j, i) => `<option value="judge:${j.id}">評審卡 ${i + 1}${j.roleName ? `（${esc(j.roleName)}）` : ""}</option>`),
  ];
  picker.innerHTML = `
    <label for="pick">管理員模式：選擇要編輯的卡片</label>
    <select id="pick"><option value="">— 請選擇 —</option>${options.join("")}</select>`;
  picker.classList.remove("hidden");
  root.innerHTML = `<div class="empty-state">請從上方選擇一張卡片。</div>`;
  picker.querySelector("#pick").addEventListener("change", (e) => {
    const [type, id] = e.target.value.split(":");
    if (type) openTarget({ type, id });
  });
}

function docRef(t) {
  return doc(db, t.type === "judge" ? "judgeCards" : "teams", t.id);
}

function openTarget(t) {
  stopDoc?.();
  target = t;
  draft = null;
  loadedStamp = null;
  root.innerHTML = `<div class="card"><p class="muted">載入中…</p></div>`;
  stopDoc = onSnapshot(docRef(t), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    target.index = (data.order || 1) - 1;
    const stamp = data.updatedAt?.toMillis?.() || 0;
    if (!draft) {
      draft = pickFields(data);
      loadedStamp = stamp;
      renderForm();
      return;
    }
    // 別人（例如同組組員）剛剛存檔
    if (!snap.metadata.hasPendingWrites && stamp && stamp !== loadedStamp && data.updatedBy !== profile.account) {
      showRemoteNotice(data);
    }
  }, (e) => {
    root.innerHTML = `<div class="card"><p class="badge badge-red">讀取失敗：${esc(e.message)}</p></div>`;
  });
}

function pickFields(data) {
  const out = {};
  for (const f of FIELDS[target.type]) out[f.key] = data[f.key] || "";
  out.image = data[IMAGE_KEY[target.type]] || "";
  out.updatedBy = data.updatedBy || "";
  out.updatedAt = data.updatedAt || null;
  return out;
}

function isLocked() {
  return settings?.editLocked && !profile?.isAdmin;
}

function renderForm() {
  const type = target.type;
  const locked = isLocked();
  const who = type === "judge" ? "你的評審卡" : `${teamLabel(target.id)}的組別卡（同組任何一位組員都能編輯）`;
  const last = draft.updatedAt?.toDate
    ? `最後更新：${draft.updatedAt.toDate().toLocaleString("zh-TW", { hour12: false })}（${esc(draft.updatedBy)}）`
    : "尚未填寫過";

  root.innerHTML = `
    ${locked ? `<div class="card notice-locked"><b>🔒 管理員已鎖定編輯</b><p style="margin:4px 0 0">目前只能檢視，不能修改。</p></div>` : ""}
    ${settings?.editLocked && profile.isAdmin ? `<div class="card notice-locked"><b>🔒 編輯已鎖定</b><p style="margin:4px 0 0">你是管理員，仍然可以修改。</p></div>` : ""}
    <div id="remote-notice"></div>
    <div class="edit-layout">
      <form class="card" id="edit-form" autocomplete="off">
        <p class="muted small" style="margin-top:0">正在編輯：<b>${esc(who)}</b><br>${last}</p>
        <div class="field">
          <label>${IMAGE_LABEL[type]}</label>
          <div class="image-picker">
            <div class="image-thumb ${type === "judge" ? "is-square" : ""}">
              ${draft.image ? `<img src="${draft.image}" alt="">` : `<div class="img-placeholder"><span class="pixel">NO IMAGE</span></div>`}
            </div>
            <div>
              <label class="btn btn-small ${locked ? "is-disabled" : ""}">
                選擇圖片
                <input type="file" accept="image/*" id="image-input" hidden ${locked ? "disabled" : ""}>
              </label>
              ${draft.image && !locked ? `<button class="btn btn-small btn-ghost" type="button" id="image-remove">移除</button>` : ""}
              <div class="hint" id="image-status">會自動縮小壓縮，手機直接拍照也可以。</div>
            </div>
          </div>
        </div>
        ${FIELDS[type].map((f) => `
          <div class="field">
            <label for="f-${f.key}">${f.label}</label>
            ${f.type === "textarea"
              ? `<textarea id="f-${f.key}" data-key="${f.key}" maxlength="${LIMITS[f.key]}" rows="5" ${locked ? "disabled" : ""}>${esc(draft[f.key])}</textarea>`
              : `<input type="text" id="f-${f.key}" data-key="${f.key}" maxlength="${LIMITS[f.key]}" value="${esc(draft[f.key])}" ${locked ? "disabled" : ""}>`}
            <div class="hint row"><span>${f.hint}</span><span class="spacer"></span><span data-count="${f.key}"></span></div>
          </div>`).join("")}
        ${locked ? "" : `<button class="btn btn-primary btn-big" type="submit" id="save-btn">儲存</button>`}
      </form>
      <div>
        <p class="preview-label">▼ 預覽（網站上看起來的樣子）</p>
        <div id="preview" class="${type === "judge" ? "" : "team-grid"}"></div>
      </div>
    </div>`;

  const form = root.querySelector("#edit-form");
  form.addEventListener("input", (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    draft[key] = e.target.value;
    updateCounts();
    updatePreview();
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  root.querySelector("#image-input")?.addEventListener("change", onImage);
  root.querySelector("#image-remove")?.addEventListener("click", () => {
    draft.image = "";
    renderForm();
  });
  updateCounts();
  updatePreview();
}

function updateCounts() {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const key = el.dataset.count;
    const n = [...(draft[key] || "")].length;
    el.textContent = `${n} / ${LIMITS[key]}`;
    el.classList.toggle("over", n >= LIMITS[key]);
  });
}

function updatePreview() {
  const box = root.querySelector("#preview");
  if (!box) return;
  const data = { ...draft, [IMAGE_KEY[target.type]]: draft.image };
  box.innerHTML = target.type === "judge"
    ? renderJudgeCard(data, target.index || 0)
    : renderTeamCard(target.id, data);
}

async function onImage(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = root.querySelector("#image-status");
  status.textContent = "壓縮中…";
  try {
    const result = await compressImage(file);
    draft.image = result.dataUrl;
    renderForm();
    root.querySelector("#image-status").textContent =
      `已壓縮為 ${result.width}×${result.height}，約 ${Math.round(result.bytes / 1024)} KB（按「儲存」後才會上傳）`;
  } catch (err) {
    status.textContent = err.message;
    toast(err.message, "error");
  }
}

function showRemoteNotice(data) {
  const box = root.querySelector("#remote-notice");
  if (!box) return;
  box.innerHTML = `
    <div class="card notice-locked">
      <b>${esc(data.updatedBy || "其他人")} 剛剛更新了這張卡片</b>
      <p style="margin:4px 0 8px">如果你現在儲存，會覆蓋對方的內容。</p>
      <button class="btn btn-small btn-yellow" type="button" id="reload-remote">載入最新內容（放棄我的修改）</button>
    </div>`;
  box.querySelector("#reload-remote").addEventListener("click", () => {
    draft = pickFields(data);
    loadedStamp = data.updatedAt?.toMillis?.() || 0;
    renderForm();
  });
}

async function save() {
  if (isLocked()) return;
  for (const f of FIELDS[target.type]) {
    if ([...(draft[f.key] || "")].length > LIMITS[f.key]) {
      toast(`${f.label}超過 ${LIMITS[f.key]} 字`, "error");
      return;
    }
  }
  const ok = await confirmDialog({
    title: "確定要儲存嗎？",
    body: `<p>儲存後，網站和投影幕會立刻更新。</p>`,
    okText: "儲存",
  });
  if (!ok) return;

  const btn = root.querySelector("#save-btn");
  btn.disabled = true;
  btn.textContent = "儲存中…";
  const payload = {};
  for (const f of FIELDS[target.type]) payload[f.key] = (draft[f.key] || "").trim();
  payload[IMAGE_KEY[target.type]] = draft.image || "";
  payload.updatedAt = serverTimestamp();
  payload.updatedBy = profile.account;
  try {
    if (target.type === "judge") await updateDoc(docRef(target), payload);
    else await setDoc(docRef(target), payload);
    draft.updatedBy = profile.account;
    toast("已儲存！", "ok");
    root.querySelector("#remote-notice").innerHTML = "";
  } catch (e) {
    console.error(e);
    const msg = /permission/i.test(e.message)
      ? "沒有權限儲存（可能管理員剛剛鎖定了編輯）"
      : `儲存失敗：${e.message}`;
    toast(msg, "error", 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = "儲存";
  }
}
