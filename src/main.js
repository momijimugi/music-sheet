import "./style.css";
import "tabulator-tables/dist/css/tabulator.min.css";
import { TabulatorFull as Tabulator } from "tabulator-tables";

// Firebase npm版
import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getFirestore, collection, doc, addDoc, updateDoc, setDoc, deleteDoc,
  getDoc, writeBatch,
  serverTimestamp, onSnapshot, query, orderBy, Timestamp
} from "firebase/firestore";

// envは後述のdotenvから読む
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const $ = (id) => document.getElementById(id);
const msg = (t) => ($("msg").textContent = t || "");

const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(user) {
  return !!user?.email && ADMIN_EMAILS.includes(user.email);
}

let debugGuestMode = localStorage.getItem("debugGuestMode") === "1";

function canEditAll() {
  return !!currentUser && isAdmin(currentUser) && !debugGuestMode;
}
function canEditLimited() {
  return !!currentUser && !canEditAll();
}
function canEditField(field) {
  if (!currentUser) return false;
  if (canEditAll()) return true;
  return field === "reference";
}
function canEditDirector() {
  return !!currentUser && (canEditAll() || canEditLimited());
}
function canEditComment() {
  return canEditAll();
}

function who() {
  return currentUser?.displayName || currentUser?.email || currentUser?.uid || "";
}
function fmtUpdated(d){
  const at = d?.updatedAt?.toDate ? d.updatedAt.toDate() : null;
  const t = at ? at.toLocaleString() : "";
  const by = d?.updatedBy || "";
  return `${t} ${by}`.trim();
}

const lastUpdatedEl = $("lastUpdated");
let lastCueUpdatedAt = null;
let lastCueUpdatedBy = "";
let lastUiUpdatedAt = null;
let lastUiUpdatedBy = "";

function tsValue(ts){
  if (!ts) return 0;
  if (ts?.seconds != null) return ts.seconds * 1000 + (ts.nanoseconds || 0) / 1e6;
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

function setLastUpdated(ts, by){
  if (!lastUpdatedEl) return;
  if (!ts) {
    lastUpdatedEl.textContent = "更新: --";
    return;
  }
  const name = formatByName(by);
  const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
  const t = d ? d.toLocaleString() : "";
  const label = [t, name].filter(Boolean).join(" ");
  lastUpdatedEl.textContent = `更新: ${label || "--"}`;
}

function formatByName(by){
  const s = String(by || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s.split("@")[0];
  return s;
}

function updateHeaderUpdated(){
  const cueVal = tsValue(lastCueUpdatedAt);
  const uiVal = tsValue(lastUiUpdatedAt);
  if (cueVal >= uiVal) {
    setLastUpdated(lastCueUpdatedAt, lastCueUpdatedBy);
  } else {
    setLastUpdated(lastUiUpdatedAt, lastUiUpdatedBy);
  }
}

function previewText(text, max = 40) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function latestLogText(list) {
  const arr = Array.isArray(list) ? list : [];
  const active = arr.filter((item) => !(item?.archived || item?.archivedAt));
  if (!active.length) return "";
  const latest = active.reduce((a, b) =>
    (a?.at?.seconds || 0) >= (b?.at?.seconds || 0) ? a : b
  );
  return latest?.text || "";
}

function buildLogPreview(list, fallback, max) {
  return previewText(latestLogText(list) || fallback || "", max);
}

// ===== status config (editable, per project) =====
const defaultStatuses = [
  { value: "wip", label: "wip", color: "#f59e0b" },
  { value: "rev", label: "rev", color: "#60a5fa" },
  { value: "fix", label: "fix", color: "#2dd4bf" },
];

let statuses = [...defaultStatuses];
let statusMap = new Map();
let unsubUI = null;

function hexToRgb(hex){
  const h = (hex || "").replace("#","").trim();
  if(h.length !== 6) return {r:0,g:0,b:0};
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
function pickTextColor(bgHex){
  const {r,g,b} = hexToRgb(bgHex);
  const lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255;
  return lum > 0.65 ? "rgba(15,23,42,.85)" : "white";
}
function rebuildStatusMap(){
  statusMap = new Map(statuses.map(s => [s.value, s]));
}

function renderStatusTag(value){
  const s = statusMap.get(value);
  if(!value) return `<span class="tagPill">—</span>`;
  if(!s) return `<span class="tagPill">${value}</span>`;
  // ほんのり色つけ（背景薄め + 枠濃いめ）
  const bg = s.color + "22";
  const bd = s.color + "55";
  return `<span class="tagPill" style="background:${bg};border-color:${bd};color:var(--tag-text)">${s.label}</span>`;
  }

  function parseDateISO(dateStr){
    const parts = String(dateStr || "").split("-").map((v) => parseInt(v, 10));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    const [y, m, d] = parts;
    return new Date(y, m - 1, d);
  }

  function formatDateShort(dt){
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "";
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}/${m}/${d}`;
  }

  function renderNextScheduleTag(value){
    if (!value || !value.status) return `<span class="muted">—</span>`;
    const color = value.color || "#6fd6ff";
    const bg = color + "22";
    const bd = color + "55";
    const label = `${value.dateLabel || value.date || ""} ${value.status}`.trim();
    return `<span class="tagPill" style="background:${bg};border-color:${bd};color:var(--tag-text)">${escapeHtml(label)}</span>`;
  }

  function renderSelectCell(innerHtml){
  const v = innerHtml || `<span class="muted">&mdash;</span>`;
  return `
    <div class="ddCell">
      <div class="ddValue">${v}</div>
      <button class="ddBtn" type="button" tabindex="-1">&#9662;</button>
    </div>
  `;
}

function selectEditor(cell, onRendered, success, cancel, editorParams){
  const params = (typeof editorParams === "function") ? editorParams(cell) : (editorParams || {});
  const valuesSrc = params.values ?? params;
  const select = document.createElement("select");
  select.className = "sheetSelect";

  select.style.width = "100%";
  select.style.height = "28px";
  select.style.borderRadius = "8px";
  select.style.border = "1px solid var(--line)";
  select.style.background = "var(--panel)";
  select.style.color = "var(--text)";

  const addOption = (value, label) => {
    const opt = document.createElement("option");
    opt.value = value ?? "";
    opt.textContent = label ?? "";
    select.appendChild(opt);
  };

  addOption("", "");

  if (Array.isArray(valuesSrc)) {
    valuesSrc.forEach((item) => {
      if (item && typeof item === "object") {
        addOption(item.value ?? item.label ?? "", item.label ?? item.value ?? "");
      } else {
        addOption(item, item);
      }
    });
  } else if (valuesSrc && typeof valuesSrc === "object") {
    Object.entries(valuesSrc).forEach(([value, label]) => addOption(value, label));
  }

  select.value = cell.getValue() ?? "";

  onRendered(() => {
    select.focus();
  });

  select.addEventListener("change", () => success(select.value));
  select.addEventListener("blur", () => cancel());
  select.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      success(select.value);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  return select;
}


const lenOptions = [
  { value:"very_long", label:"very long", color:"#ef4444" },
  { value:"long", label:"long", color:"#f97316" },
  { value:"mid", label:"mid", color:"#60a5fa" },
  { value:"short", label:"short", color:"#34d399" },
];
const lenMap = new Map(lenOptions.map(x=>[x.value,x]));

function renderLenTag(v){
  if(!v) return `<span class="tagPill">&mdash;</span>`;
  const s = lenMap.get(v);
  if(!s) return `<span class="tagPill">${v}</span>`;
  return `<span class="tagPill" style="background:${s.color}22;border-color:${s.color}55;color:var(--tag-text)">${s.label}</span>`;
}

function applyLenUI(){
  const sel = $("f_len");
  if(!sel) return;
  sel.innerHTML =
    `<option value=""></option>` +
    lenOptions.map(s => `<option value="${s.value}">${s.label}</option>`).join("");
}

function applyStatusUI(){
  rebuildStatusMap();

  // 右パネル select
  const sel = $("f_status");
  if(sel){
    sel.innerHTML = `<option value=""></option>` + statuses.map(s => `<option value="${s.value}">${s.label}</option>`).join("");
  }

  // 上部フィルタ select
  const f = $("statusFilter");
  if(f){
    const cur = f.value;
    f.innerHTML = `<option value="">進捗：すべて</option>` + statuses.map(s => `<option value="${s.value}">${s.label}</option>`).join("");
    f.value = cur;
  }

  // タグプレビュー
  updateStatusPreview();

  // Tabulator column update（statusを“タグ表示 + ドロップダウン編集”に）
  try{
    table.updateColumnDefinition("status", {
      title: "進捗",
      field: "status",
      width: 130,
      formatter: (cell) => renderSelectCell(renderStatusTag(cell.getValue())),
      editor: selectEditor,
      editable: () => canEditField("status"),
      editorParams: () => {
        const values = {};
        statuses.forEach((s) => {
          values[s.value] = s.label;
        });
        return { values };
      },
      cellClick: (e, cell) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canEditField("status")) return;
        cell.edit(true);
      },
    });
  }catch(_){ }
}

function openStatusModal(){
  $("overlay").classList.remove("hidden");
  $("statusModal").classList.remove("hidden");
  renderStatusList();
  updateBulkToggle();
  updateGuestToggle();
  applyPermissionUI();
}
function closeStatusModal(){
  $("overlay").classList.add("hidden");
  $("statusModal").classList.add("hidden");
}

function renderStatusList(){
  const host = $("statusList");
  host.innerHTML = "";
  const editable = canEditAll();

  statuses.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "statusRow";
    row.innerHTML = `
      <input type="text" value="${s.label || s.value || ""}" data-k="label" data-i="${idx}" placeholder="表示名" ${editable ? "" : "disabled"} />
      <input type="color" value="${s.color}" data-k="color" data-i="${idx}" ${editable ? "" : "disabled"} />
      <button class="smallBtn" data-act="del" data-i="${idx}" ${editable ? "" : "disabled"}>削除</button>
    `;
    host.appendChild(row);
  });

  if (!editable) {
    host.oninput = null;
    host.onclick = null;
    return;
  }

  host.oninput = (e) => {
    const t = e.target;
    const i = Number(t?.dataset?.i);
    const k = t?.dataset?.k;
    if(Number.isNaN(i) || !k) return;
    if (k === "label") {
      const v = t.value;
      statuses[i] = { ...statuses[i], label: v, value: v };
      return;
    }
    statuses[i] = { ...statuses[i], [k]: t.value };
  };

  host.onclick = (e) => {
    const btn = e.target?.closest("button");
    if(!btn) return;
    if(btn.dataset.act === "del"){
      const i = Number(btn.dataset.i);
      statuses.splice(i,1);
      renderStatusList();
    }
  };
}

async function saveStatuses(){
  if (!canEditAll()) {
    msg("管理者のみ変更できます");
    return;
  }
  // value重複を軽くケア（空は消す）
  statuses = statuses
    .map(s => {
      const label = (s.label || s.value || "").trim();
      const value = label;
      return { ...s, label, value };
    })
    .filter(s => s.value && s.label);

  const seen = new Set();
  statuses = statuses.filter(s => (seen.has(s.value) ? false : (seen.add(s.value), true)));

  const ref = doc(db, "projects", currentProjectId, "settings", "ui");
  await setDoc(ref, {
    statuses,
    fpsDefault: $("fpsDefault")?.value || "24",
    updatedAt: serverTimestamp(),
    updatedBy: who(),
  }, { merge:true });

  applyStatusUI();
  closeStatusModal();
  msg("進捗設定を保存しました");
}

function listenUISettings(projectId){
  if(unsubUI) unsubUI();
  const ref = doc(db, "projects", projectId, "settings", "ui");

  unsubUI = onSnapshot(ref, async (snap) => {
    if(snap.exists()){
      const d = snap.data();
      if (d?.updatedAt) {
        lastUiUpdatedAt = d.updatedAt;
        lastUiUpdatedBy = d.updatedBy || "";
        updateHeaderUpdated();
      }
      if(Array.isArray(d.statuses) && d.statuses.length){
        statuses = d.statuses;
      }else{
        statuses = [...defaultStatuses];
      }
      const fps = String(d.fpsDefault ?? "24");
      if ($("fpsDefault")) $("fpsDefault").value = fps;
      window.__FPS_DEFAULT__ = fps;
    }else{
      statuses = [...defaultStatuses];
      const fps = "24";
      if ($("fpsDefault")) $("fpsDefault").value = fps;
      window.__FPS_DEFAULT__ = fps;
      // 初回はデフォルトを書いておく（共有に便利）
      await setDoc(ref, { statuses, fpsDefault: "24", createdAt: serverTimestamp() }, { merge:true });
    }
    applyStatusUI();
  }, (err) => {
    console.error(err);
    msg(`設定同期エラー: ${err.code || err.message}`);
  });
}

function buildNextScheduleMap(state){
  scheduleStatusMap = new Map();
  (state?.statuses || []).forEach((st) => {
    if (!st || !st.name) return;
    scheduleStatusMap.set(st.name, st.color || "#6fd6ff");
  });

  const schedule = state?.schedule || {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nextMap = new Map();
  Object.keys(schedule).forEach((trackId) => {
    const sched = schedule[trackId];
    if (!sched || typeof sched !== "object") return;
    let closest = null;
    Object.keys(sched).forEach((dateStr) => {
      const status = sched[dateStr];
      if (!status || status === "none") return;
      const dt = parseDateISO(dateStr);
      if (!dt) return;
      if (dt < today) return;
      if (!closest || dt < closest.dt) {
        closest = { dt, dateStr, status };
      }
    });
    if (!closest) return;
    const color = scheduleStatusMap.get(closest.status) || "#6fd6ff";
    nextMap.set(trackId, {
      status: closest.status,
      date: closest.dateStr,
      dateLabel: formatDateShort(closest.dt),
      color,
    });
  });

  scheduleNextMap = nextMap;
}

function applyScheduleNextToRows(){
  if (!table || !table.getData) return;
  const rows = table.getData();
  if (!rows.length) return;
  const updates = rows.map((r) => ({
    id: r.id,
    nextSchedule: scheduleNextMap.get(r.id) || null,
  }));
  table.updateData(updates);
}

function listenScheduleBoard(projectId){
  if (scheduleUnsub) scheduleUnsub();
  scheduleNextMap = new Map();
  scheduleStatusMap = new Map();
  if (!projectId) {
    applyScheduleNextToRows();
    return;
  }

  const ref = doc(db, "projects", projectId, "scheduleBoard", "state");
  scheduleUnsub = onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      scheduleNextMap = new Map();
      scheduleStatusMap = new Map();
      applyScheduleNextToRows();
      return;
    }
    const data = snap.data() || {};
    const state = data.state || data;
    buildNextScheduleMap(state);
    applyScheduleNextToRows();
  }, (err) => {
    console.error(err);
  });
}

function updateStatusPreview(){
  const v = $("f_status")?.value || "";
  $("statusTagPreview").outerHTML = `<span id="statusTagPreview" class="tagPill">${(statusMap.get(v)?.label || v || "—")}</span>`;
  // 上で差し替わったので再参照不要（次回はapplyStatusUIが再生成）
}

let currentUser = null;
// ===== project from URL =====
const sp = new URLSearchParams(location.search);
const urlProject = (sp.get("project") || "").trim();
const urlCue = (sp.get("cue") || "").trim();
if (urlProject) {
  $("projectId").value = urlProject;
  $("projectId").disabled = true;
  localStorage.setItem("lastProject", urlProject);
}
let currentProjectId = $("projectId").value.trim();
let unsub = null;
let pendingSelectId = null;
if (urlCue) pendingSelectId = urlCue;
let projectNameLoaded = false;
let scheduleUnsub = null;
let scheduleNextMap = new Map();
let scheduleStatusMap = new Map();

const table = new Tabulator("#grid", {
  height: "100%",
  layout: "fitColumns",
  rowHeight: 40,
  selectable: true,
  selectableRangeMode: "click",
  movableRows: true,
  index: "id",
  columns: [
    {
      formatter: "handle",
      field: "__handle",
      width: 34,
      hozAlign: "center",
      headerSort: false,
      rowHandle: true,
      frozen: true,
    },
    { title: "#M", field: "m", width: 70, headerSort: true, frozen: true },
    { title: "V", field: "v", width: 55, editor: "input", editable: () => canEditField("v"), frozen: true },
    { title: "demo", field: "demo", width: 80, editor: "input", editable: () => canEditField("demo"), frozen: true },
    { title: "scene", field: "scene", minWidth: 180, editor: "input", editable: () => canEditField("scene") },
    { title:"長さ", field:"len", width:120,
      formatter:(cell)=>renderSelectCell(renderLenTag(cell.getValue())),
      editor: selectEditor,
      editable: () => canEditField("len"),
      editorParams: () => {
        const values = {};
        lenOptions.forEach((s) => {
          values[s.value] = s.label;
        });
        return { values };
      },
      cellClick: (e, cell) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canEditField("len")) return;
        cell.edit(true);
      },
    },
    {
      title: "進捗",
      field: "status",
      width: 130,
      formatter: (cell) => renderSelectCell(renderStatusTag(cell.getValue())),
      editor: selectEditor,
      editable: () => canEditField("status"),
      editorParams: () => {
        const values = {};
        statuses.forEach((s) => {
          values[s.value] = s.label;
        });
        return { values };
      },
      cellClick: (e, cell) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canEditField("status")) return;
        cell.edit(true);
      },
    },
    {
      title: "直近予定",
      field: "nextSchedule",
      width: 180,
      headerSort: false,
      formatter: (cell) => renderNextScheduleTag(cell.getValue()),
    },
    { title: "監督FB(省略)", field: "director", minWidth: 220,
      headerSort: false,
      formatter: (cell) => {
        const row = cell.getData();
        return buildLogPreview(row.directorLog, row.director, 40);
      },
    },
    { title: "コメント(省略)", field: "commentLog", minWidth: 220,
      headerSort: false,
      formatter: (cell) => {
        const row = cell.getData();
        return buildLogPreview(row.commentLog, row.comment, 40);
      },
    },
    { title: "参考曲", field: "reference", minWidth: 200, headerSort: false,
      editor: "input",
      editable: () => canEditField("reference"),
      formatter: formatReferenceCell,
    },
    {
      title: "更新",
      field: "updatedAt",
      width: 190,
      headerSort: false,
      formatter: (cell) => {
        const d = cell.getData();
        const at = d.updatedAt?.toDate ? d.updatedAt.toDate() : null;
        const t = at ? at.toLocaleString() : "";
        const by = d.updatedBy || "";
        return `<div style="font-size:12px;line-height:1.15">
          <div>${t}</div><div style="opacity:.75">${by}</div>
        </div>`;
      },
    },
    { title: "IN TC", field: "in", width: 110, editor: "input", editable: () => canEditField("in") },
    { title: "OUT TC", field: "out", width: 110, editor: "input", editable: () => canEditField("out") },
    { title: "INT TC", field: "interval", width: 110, headerSort: false },
  ],
});

applyLenUI();

let bulkMode = false;
let applying = false;
const undoStack = [];
const UNDO_MAX = 50;
const BULK_FIELDS = new Set(["status", "len", "scene", "demo", "in", "out"]);

function updateBulkToggle(){
  const el = $("toggleBulk");
  if (el) el.checked = bulkMode;
  const label = $("bulkState");
  if (label) label.textContent = bulkMode ? "ON" : "OFF";
}

function setBulkMode(next){
  bulkMode = !!next;
  updateBulkToggle();
}

$("toggleBulk")?.addEventListener("change", () => {
  if (!canEditAll()) {
    setBulkMode(false);
    return;
  }
  setBulkMode($("toggleBulk").checked);
});

function updateGuestToggle(){
  const el = $("toggleGuest");
  if (!el) return;
  el.checked = debugGuestMode;
  el.disabled = !isAdmin(currentUser);
  const label = $("guestState");
  if (label) label.textContent = debugGuestMode ? "ON" : "OFF";
}

function setDebugGuestMode(next){
  debugGuestMode = !!next;
  localStorage.setItem("debugGuestMode", debugGuestMode ? "1" : "0");
  updateGuestToggle();
  applyPermissionUI();
}

$("toggleGuest")?.addEventListener("change", () => {
  if (!isAdmin(currentUser)) {
    updateGuestToggle();
    return;
  }
  setDebugGuestMode($("toggleGuest").checked);
});

function applyPermissionUI(){
  const adminUser = isAdmin(currentUser);
  const canAll = canEditAll();
  const guestView = !!currentUser && !canAll;

  const settingsBtn = $("btnSettings");
  if (settingsBtn) settingsBtn.style.display = adminUser ? "" : "none";

  const btnAdd = $("btnAddRow");
  if (btnAdd) btnAdd.style.display = canAll ? "" : "none";
  const btnDel = $("btnDeleteRow");
  if (btnDel) btnDel.style.display = canAll ? "" : "none";
  const btnUndo = $("btnUndo");
  if (btnUndo) btnUndo.style.display = canAll ? "" : "none";

  if (!canAll) setBulkMode(false);
  const bulkToggle = $("toggleBulk");
  if (bulkToggle) bulkToggle.disabled = !canAll;
  updateBulkToggle();

  const fps = $("fpsDefault");
  if (fps) fps.disabled = !canAll;

  const dirInput = $("f_director_new");
  if (dirInput) dirInput.disabled = !canEditDirector();
  const dirBtn = $("btnAddDirectorFB");
  if (dirBtn) dirBtn.disabled = !canEditDirector();

  const commentInput = $("f_comment_new");
  if (commentInput) commentInput.disabled = guestView || !currentUser;
  const commentBtn = $("btnAddComment");
  if (commentBtn) commentBtn.disabled = guestView || !currentUser;

  const refInput = $("f_reference");
  if (refInput) refInput.disabled = !currentUser;
  const refShared = $("f_reference_shared");
  if (refShared) refShared.disabled = !currentUser;

  ["f_len", "f_status", "f_note", "f_in", "f_out"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = guestView;
  });

  const statusList = $("statusList");
  if (statusList) {
    statusList.querySelectorAll("input, button").forEach((el) => {
      el.disabled = !canAll;
    });
  }
  const btnAddStatus = $("btnAddStatus");
  if (btnAddStatus) btnAddStatus.disabled = !canAll;
  const btnSaveStatuses = $("btnSaveStatuses");
  if (btnSaveStatuses) btnSaveStatuses.disabled = !canAll;

  updateGuestToggle();

  try{
    table.updateColumnDefinition("__handle", { visible: canAll });
  }catch(_){}

  if (selectedId) {
    const row = table.getRow(selectedId);
    const data = row?.getData?.() || {};
    renderDirectorLog(data.directorLog || []);
    renderCommentLog(data.commentLog || []);
  }
}

$("btnUndo")?.addEventListener("click", () => {
  undo().catch(console.error);
});

async function applyBatch(changes, { pushUndo = true } = {}) {
  if (!changes || changes.length === 0) return;
  const b = writeBatch(db);
  const by = who();

  for (const ch of changes) {
    const ref = doc(db, "projects", currentProjectId, "cues", ch.id);
    b.update(ref, {
      ...ch.after,
      updatedAt: serverTimestamp(),
      updatedBy: by,
    });
  }
  await b.commit();

  if (pushUndo) {
    undoStack.push(
      changes.map((ch) => ({
        id: ch.id,
        before: { ...ch.before },
        after: { ...ch.after },
      }))
    );
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
}

async function undo() {
  if (!currentUser) {
    msg("ログインしてね");
    return;
  }
  if (!canEditAll()) {
    msg("管理者のみ利用できます");
    return;
  }
  const last = undoStack.pop();
  if (!last) {
    msg("Undoできる操作がありません");
    return;
  }

  const b = writeBatch(db);
  const by = who();

  for (const ch of last) {
    const ref = doc(db, "projects", currentProjectId, "cues", ch.id);
    b.update(ref, {
      ...ch.before,
      updatedAt: serverTimestamp(),
      updatedBy: by,
    });
  }
  await b.commit();
  msg("Undoしました");
  setTimeout(() => msg(""), 800);
}

table.on("cellEdited", async (cell) => {
  if (applying) return;

  try {
    const row = cell.getRow().getData();
    if (!row?.id) return;

    if (!currentUser) {
      msg("ログインしてね（保存できない）");
      return;
    }

    const field = cell.getField();
    const value = cell.getValue();
    const old = cell.getOldValue?.() ?? row[field];
    const fps = (window.__FPS_DEFAULT__ || "24");

    if (!canEditField(field)) {
      applying = true;
      cell.setValue(old, true);
      applying = false;
      msg("ゲストは監督FBと参考曲のみ編集できます");
      setTimeout(() => msg(""), 900);
      return;
    }

    if (field === "reference" && selectedId === row.id) {
      setReferenceValue(value ?? "");
    }

    const selectedRows = table.getSelectedRows().map((r) => r.getData()).filter((d) => d?.id);
    const isBulk = bulkMode && selectedRows.length >= 2 && BULK_FIELDS.has(field);
    const isIntervalField = field === "in" || field === "out";

    if (isBulk) {
      applying = true;
      const changes = selectedRows.map((d) => {
        const before = { [field]: d.id === row.id ? old : (d[field] ?? "") };
        const after = { [field]: value };

        if (isIntervalField) {
          const inTc = field === "in" ? value : (d.in || "");
          const outTc = field === "out" ? value : (d.out || "");
          const interval = calcInterval(inTc, outTc, fps);
          before.interval = d.interval ?? "";
          after.interval = interval;
        }

        return { id: d.id, before, after };
      });

      selectedRows.forEach((d) => {
        if (d.id === row.id) return;
        const r = table.getRow(d.id);
        r?.getCell(field)?.setValue(value, true);
        if (isIntervalField) {
          const inTc = field === "in" ? value : (d.in || "");
          const outTc = field === "out" ? value : (d.out || "");
          const interval = calcInterval(inTc, outTc, fps);
          r?.getCell("interval")?.setValue(interval, true);
        }
      });
      applying = false;

      await applyBatch(changes, { pushUndo: true });
      msg(`一括反映しました（${selectedRows.length}行）`);
      setTimeout(() => msg(""), 900);
      return;
    }

    const before = { [field]: old };
    const after = { [field]: value };
    if (isIntervalField) {
      const inTc = field === "in" ? value : (row.in || "");
      const outTc = field === "out" ? value : (row.out || "");
      const interval = calcInterval(inTc, outTc, fps);
      before.interval = row.interval ?? "";
      after.interval = interval;
      const r = table.getRow(row.id);
      r?.getCell("interval")?.setValue(interval, true);
    }

    await applyBatch([{ id: row.id, before, after }], { pushUndo: true });
    msg("保存しました");
    setTimeout(() => msg(""), 800);
  } catch (e) {
    console.error(e);
    msg(`保存エラー: ${e.code || e.message}`);
  }
});

function nextMNumber() {
  const rows = table?.getData?.() || [];
  let max = 0;
  for (const r of rows) {
    const n = parseInt((r.m ?? r.M ?? r["#M"] ?? "").toString(), 10);
    if (!Number.isNaN(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

let selectedId = null;

function setInspector(row){
  if(!row){
    selectedId = null;
    if ($("selMeta")) {
      $("selMeta").textContent = "行を選択すると表示されます";
      $("selMeta").classList.add("selMetaEmpty");
    }
    renderDirectorLog([]);
    renderCommentLog([]);
    $("f_director_new").value = "";
    $("f_comment_new").value = "";
    setReferenceValue("");
    $("f_in").value = "";
    $("f_out").value = "";
    $("f_interval").value = "";
    return;
  }
    const d = row.getData();
    selectedId = d.id;
    if ($("selMeta")) {
      const parts = [];
      if (d.m != null && String(d.m).trim() !== "") parts.push(`#M ${d.m}`);
      if (d.demo) parts.push(String(d.demo).trim());
      const label = parts.length ? parts.join(" / ") : "選択中の行";
      $("selMeta").textContent = `選択中: ${label}`;
      $("selMeta").classList.remove("selMetaEmpty");
    }
  if ($("f_m")) $("f_m").value = d.m ?? "";
  if ($("f_v")) $("f_v").value = d.v ?? "";
  if ($("f_demo")) $("f_demo").value = d.demo ?? "";
  if ($("f_scene")) $("f_scene").value = d.scene ?? "";
  $("f_status").value = d.status ?? "";
  $("f_len").value = d.len ?? "";
  $("f_note").value = d.note ?? "";
  setReferenceValue(d.reference ?? "");
  $("f_in").value = d.in ?? "";
  $("f_out").value = d.out ?? "";
  const fps = (window.__FPS_DEFAULT__ || "24");
  $("f_interval").value = d.interval ?? calcInterval(d.in || "", d.out || "", fps);
  renderDirectorLog(d.directorLog || []);
  renderCommentLog(d.commentLog || []);
  $("f_director_new").value = "";
  $("f_comment_new").value = "";
}

const inspectorTabs = Array.from(document.querySelectorAll(".insTab"));
const inspectorPanels = Array.from(document.querySelectorAll(".insTabPanel"));

function setInspectorTab(tabId, { persist = true } = {}) {
  if (!tabId) return;
  let found = false;
  inspectorTabs.forEach((btn) => {
    const active = btn.dataset.tab === tabId;
    if (active) found = true;
    btn.classList.toggle("is-active", active);
  });
  inspectorPanels.forEach((panel) => {
    const active = panel.dataset.tab === tabId;
    panel.classList.toggle("is-active", active);
  });
  if (found && persist) {
    localStorage.setItem("inspectorTab", tabId);
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target?.closest?.(".insTab");
  if (!btn) return;
  const tabId = btn.dataset.tab;
  setInspectorTab(tabId);
});

const storedTab = localStorage.getItem("inspectorTab");
if (storedTab) setInspectorTab(storedTab, { persist: false });


function extractUrls(text){
  const s = String(text||"");
  const m = s.match(/https?:\/\/[^\s<>"']+/g);
  return m ? [...new Set(m)] : [];
}
function youtubeId(url){
  try{
    const u = new URL(url);
    if(u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if(u.hostname.includes("youtube.com")){
      const v = u.searchParams.get("v"); if(v) return v;
      const s = u.pathname.match(/\/shorts\/([^\/]+)/); if(s) return s[1];
      const e = u.pathname.match(/\/embed\/([^\/]+)/);  if(e) return e[1];
    }
  }catch{}
  return null;
}
function buildLinkPreviews(text){
  const urls = extractUrls(text).slice(0,4);
  if(urls.length===0) return "";
  const cards = urls.map(u=>{
    const yid = youtubeId(u);
    if(yid){
      const thumb = `https://img.youtube.com/vi/${yid}/hqdefault.jpg`;
      return `
        <a class="linkCard" href="${u}" target="_blank" rel="noopener">
          <img class="linkThumb" src="${thumb}" loading="lazy" alt="YouTube">
          <div class="linkMeta">
            <div class="linkTitle">YouTube</div>
            <div class="linkUrl">${escapeHtml(u)}</div>
          </div>
        </a>`;
    }
    return `
      <a class="linkCard" href="${u}" target="_blank" rel="noopener">
        <div class="linkMeta">
          <div class="linkTitle">リンク</div>
          <div class="linkUrl">${escapeHtml(u)}</div>
        </div>
      </a>`;
  }).join("");
  return `<div class="linkPreviewGrid">${cards}</div>`;
}

const referenceTitleCache = new Map();
const referenceTitlePending = new Set();

function normalizeReferenceUrl(raw){
  const s = String(raw || "").trim();
  if (!s) return "";
  try{
    return new URL(s).toString();
  }catch{
    return s;
  }
}

function referenceProviderLabel(url){
  if (youtubeId(url)) return "YouTube";
  try{
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("spotify.com")) return "Spotify";
    if (host.includes("music.apple.com")) return "Apple Music";
    return host || "Link";
  }catch{
    return "Link";
  }
}

async function fetchReferenceTitle(url){
  const encoded = encodeURIComponent(url);
  const isYoutube = youtubeId(url);
  const isSpotify = /spotify\.com/i.test(url);
  const isApple = /music\.apple\.com/i.test(url);
  let endpoint = "";

  if (isYoutube) {
    endpoint = `https://www.youtube.com/oembed?format=json&url=${encoded}`;
  } else if (isSpotify) {
    endpoint = `https://open.spotify.com/oembed?url=${encoded}`;
  } else if (isApple) {
    endpoint = `https://embed.music.apple.com/oembed?url=${encoded}`;
  }

  if (!endpoint) return "";
  const res = await fetch(endpoint);
  if (!res.ok) return "";
  const data = await res.json().catch(() => null);
  return (data && data.title) ? String(data.title).trim() : "";
}

function buildReferenceCellHtml(raw, url, title){
  const provider = referenceProviderLabel(url);
  const label = title ? previewText(title, 30) : previewText(url || raw, 34);
  const text = `${provider}: ${label}`;
  return `<a class="linkMini" href="${url}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
}

function formatReferenceCell(cell, formatterParams, onRendered){
  const raw = String(cell.getValue() || "").trim();
  if(!raw) return "";
  const urls = extractUrls(raw);
  const link = urls[0] || "";
  if(!link){
    const display = previewText(raw, 34);
    return `<span class="muted">${escapeHtml(display)}</span>`;
  }

  const normalized = normalizeReferenceUrl(link);
  const hasCache = referenceTitleCache.has(normalized);
  const cachedTitle = hasCache ? referenceTitleCache.get(normalized) : "";

  if(!hasCache && !referenceTitlePending.has(normalized)){
    referenceTitlePending.add(normalized);
    const valueSnapshot = raw;
    onRendered(() => {
      fetchReferenceTitle(normalized)
        .then((title) => {
          referenceTitlePending.delete(normalized);
          referenceTitleCache.set(normalized, title || "");
          if (String(cell.getValue() || "").trim() !== valueSnapshot) return;
          if (!title) return;
          const el = cell.getElement();
          if (el) el.innerHTML = buildReferenceCellHtml(valueSnapshot, normalized, title);
        })
        .catch(() => {
          referenceTitlePending.delete(normalized);
        });
    });
  }

  return buildReferenceCellHtml(raw, normalized, cachedTitle || "");
}

function renderReferencePreview(value, host = $("referencePreview")){
  if(!host) return;
  const raw = String(value || "").trim();
  const urls = extractUrls(raw);
  if(!raw){
    host.innerHTML = `<div class="muted">YouTubeリンクを入れるとプレビューできます</div>`;
    return;
  }
  if(urls.length === 0){
    host.innerHTML = `<div class="muted">${escapeHtml(raw)}</div>`;
    return;
  }
  const yt = urls.find((u) => youtubeId(u));
  if(yt){
    const id = youtubeId(yt);
    host.innerHTML = `<iframe src="https://www.youtube.com/embed/${id}" title="YouTube preview" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    return;
  }
  const link = urls[0];
  host.innerHTML = `<a href="${link}" target="_blank" rel="noopener">リンクを開く</a>`;
}

function renderReferencePreviews(value){
  renderReferencePreview(value, $("referencePreview"));
  renderReferencePreview(value, $("referencePreviewShared"));
}

function setReferenceValue(value, sourceId){
  const v = value ?? "";
  const main = $("f_reference");
  const shared = $("f_reference_shared");
  if (main && main.id !== sourceId) main.value = v;
  if (shared && shared.id !== sourceId) shared.value = v;
  renderReferencePreviews(v);
}

function getReferenceValue(){
  const el = $("f_reference") || $("f_reference_shared");
  return el?.value || "";
}

function renderDirectorLog(list){
  const host = document.getElementById("directorLog");
  const showArchived = document.getElementById("showDirectorArchived")?.checked;
  const rowMeta = selectedId ? table.getRow(selectedId)?.getData?.() : {};
  const rowVersion = rowMeta?.v ? String(rowMeta.v).trim() : "";

  if(!host) return;
  const arr = Array.isArray(list) ? list.slice() : [];
  const view = showArchived ? arr : arr.filter(x=>!(x?.archived || x?.archivedAt));

  if(view.length === 0){
    host.innerHTML = `<div class="muted">まだFBはありません</div>`;
    host.onclick = null;
    return;
  }

  const viewSorted = view
    .sort((a, b) => (a?.at?.seconds || 0) - (b?.at?.seconds || 0));

  const canEdit = canEditDirector();
  host.innerHTML = viewSorted
    .map((item, idx) => {
      const by = item.by || "";
      const at = item.at?.toDate ? item.at.toDate() : null;
      const t  = at ? at.toLocaleString() : "";
      const text = item.text || "";
      const entryVersion = item?.v != null ? String(item.v).trim() : "";
      const version = entryVersion || rowVersion;
      const archived = !!item.archived || !!item.archivedAt;
      const action = archived ? "restoreDirector" : "archiveDirector";
      const actionLabel = archived ? "戻す" : "アーカイブ";
      const metaParts = [];
      if (version) metaParts.push(`V:${escapeHtml(version)}`);
      if (t) metaParts.push(t);
      if (by) metaParts.push(escapeHtml(by));
      const actions = canEdit
        ? `
          <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
            <button class="smallBtn" type="button" data-act="${action}" data-idx="${idx}">${actionLabel}</button>
            <button class="smallBtn danger" type="button" data-act="deleteDirector" data-idx="${idx}">消去</button>
          </div>
        `
        : "";
      return `
        <div class="logItem">
          <div class="logMeta">${metaParts.join(" / ")}${archived ? ' <span class="muted">（アーカイブ）</span>' : ""}</div>
          <div class="logText">${escapeHtml(text)}</div>
          ${buildLinkPreviews(text)}
          ${actions}
        </div>
      `;
    }).join("");

  if (!canEdit) {
    host.onclick = null;
    return;
  }

  host.onclick = async (e)=>{
    const btn = e.target?.closest("button[data-act]");
    if(!btn) return;
    if(!currentUser || !selectedId) return;

    const idx = Number(btn.dataset.idx);
    const act = btn.dataset.act;
    const row = table.getRow(selectedId);
    const cur = row?.getData?.() || {};
    const list0 = Array.isArray(cur.directorLog) ? cur.directorLog.slice() : [];

    const target = viewSorted[idx];
    if(!target) return;

    const i = list0.findIndex(x =>
      (x?.text||"") === (target.text||"") &&
      (x?.by||"") === (target.by||"") &&
      (x?.at?.seconds||0) === (target.at?.seconds||0)
    );
    if(i < 0) return;

    if (act === "deleteDirector") {
      if (!confirm("このFBを消去しますか？")) return;
      list0.splice(i, 1);
    } else {
      const nextArchived = act === "archiveDirector";
      list0[i] = {
        ...list0[i],
        archived: nextArchived,
        archivedAt: nextArchived ? Timestamp.now() : null,
        archivedBy: nextArchived ? who() : null,
      };
    }

    try{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selectedId), {
        directorLog: list0,
        updatedAt: serverTimestamp(),
        updatedBy: who(),
      });
      table.updateData([{ id: selectedId, directorLog: list0 }]);
      renderDirectorLog(list0);
    }catch(e){
      console.error(e);
      const label = act === "deleteDirector" ? "消去" : (act === "archiveDirector" ? "アーカイブ" : "復帰");
      msg(`${label}失敗: ${e.code || e.message}`);
    }
  };
}

function renderCommentLog(list){
  const host = document.getElementById("commentLog");
  const showArchived = document.getElementById("showCommentArchived")?.checked;
  const rowMeta = selectedId ? table.getRow(selectedId)?.getData?.() : {};
  const rowVersion = rowMeta?.v ? String(rowMeta.v).trim() : "";

  if(!host) return;
  const arr = Array.isArray(list) ? list.slice() : [];
  const view = showArchived ? arr : arr.filter(x=>!(x?.archived || x?.archivedAt));

  if(view.length === 0){
    host.innerHTML = `<div class="muted">まだコメントはありません</div>`;
    host.onclick = null;
    return;
  }

  const viewSorted = view
    .sort((a, b) => (a?.at?.seconds || 0) - (b?.at?.seconds || 0));

  const canEdit = canEditComment();
  host.innerHTML = viewSorted
    .map((item, idx) => {
      const by = item.by || "";
      const at = item.at?.toDate ? item.at.toDate() : null;
      const t  = at ? at.toLocaleString() : "";
      const text = item.text || "";
      const entryVersion = item?.v != null ? String(item.v).trim() : "";
      const version = entryVersion || rowVersion;
      const archived = !!item.archived || !!item.archivedAt;
      const action = archived ? "restoreComment" : "archiveComment";
      const actionLabel = archived ? "戻す" : "アーカイブ";
      const metaParts = [];
      if (version) metaParts.push(`V:${escapeHtml(version)}`);
      if (t) metaParts.push(t);
      if (by) metaParts.push(escapeHtml(by));
      const actions = canEdit
        ? `
          <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
            <button class="smallBtn" type="button" data-act="${action}" data-idx="${idx}">${actionLabel}</button>
            <button class="smallBtn danger" type="button" data-act="deleteComment" data-idx="${idx}">消去</button>
          </div>
        `
        : "";
      return `
        <div class="logItem">
          <div class="logMeta">${metaParts.join(" / ")}${archived ? ' <span class="muted">（アーカイブ）</span>' : ""}</div>
          <div class="logText">${escapeHtml(text)}</div>
          ${buildLinkPreviews(text)}
          ${actions}
        </div>
      `;
    }).join("");

  if (!canEdit) {
    host.onclick = null;
    return;
  }

  host.onclick = async (e)=>{
    const btn = e.target?.closest("button[data-act]");
    if(!btn) return;
    if(!currentUser || !selectedId) return;

    const idx = Number(btn.dataset.idx);
    const act = btn.dataset.act;
    const row = table.getRow(selectedId);
    const cur = row?.getData?.() || {};
    const list0 = Array.isArray(cur.commentLog) ? cur.commentLog.slice() : [];

    const target = viewSorted[idx];
    if(!target) return;

    const i = list0.findIndex(x =>
      (x?.text||"") === (target.text||"") &&
      (x?.by||"") === (target.by||"") &&
      (x?.at?.seconds||0) === (target.at?.seconds||0)
    );
    if(i < 0) return;

    if (act === "deleteComment") {
      if (!confirm("このコメントを消去しますか？")) return;
      list0.splice(i, 1);
    } else {
      const nextArchived = act === "archiveComment";
      list0[i] = {
        ...list0[i],
        archived: nextArchived,
        archivedAt: nextArchived ? Timestamp.now() : null,
        archivedBy: nextArchived ? who() : null,
      };
    }

    try{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selectedId), {
        commentLog: list0,
        updatedAt: serverTimestamp(),
        updatedBy: who(),
      });
      table.updateData([{ id: selectedId, commentLog: list0 }]);
      renderCommentLog(list0);
    }catch(e){
      console.error(e);
      const label = act === "deleteComment" ? "消去" : (act === "archiveComment" ? "アーカイブ" : "復帰");
      msg(`${label}失敗: ${e.code || e.message}`);
    }
  };
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function parseTC(tc, fps){
  const m = String(tc||"").trim().match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if(!m) return null;
  const [_, hh, mm, ss, ff] = m;
  const f = Number(String(fps||"24").trim());
  if(!f || Number.isNaN(f)) return null;
  const frames = (Number(hh)*3600 + Number(mm)*60 + Number(ss))*f + Number(ff);
  return { frames, fps: f };
}
function fmtTC(frames, fps){
  const f = Number(String(fps||"24").trim());
  if(!f || Number.isNaN(f)) return "";
  const sign = frames < 0 ? "-" : "";
  frames = Math.abs(frames);
  const totalSec = Math.floor(frames / f);
  const ff = frames % f;
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad = (n)=>String(n).padStart(2,"0");
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}
function calcInterval(inTc,outTc,fps){
  const a = parseTC(inTc,fps), b = parseTC(outTc,fps);
  if(!a || !b) return "";
  return fmtTC(b.frames - a.frames, fps);
}

table.on("rowClick", (e, row) => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const multi = e.shiftKey || (isMac ? e.metaKey : e.ctrlKey);

  if (!multi) table.deselectRow();
  row.select();
  setInspector(row);
});

document.addEventListener("mousedown", (e) => {
  const insideGrid = e.target.closest("#grid");
  const insideInspector = e.target.closest("#inspector");
  const keep = e.target.closest("button, input, select, textarea, a, .cardHead, .modal");
  if (!insideGrid && !insideInspector && !keep) table.deselectRow();
});

let moving = false;
table.on("rowMoved", async () => {
  if(!currentUser || !canEditAll()) return;
  if(moving) return;
  moving = true;
  try{
    await renumberM();
    msg("並び替えを保存しました");
    setTimeout(()=>msg(""), 800);
  }catch(e){
    console.error(e);
    msg(`並び替え保存失敗: ${e.code || e.message}`);
  }finally{
    moving = false;
  }
});

function listen(projectId){
  if(unsub) unsub();
  currentProjectId = projectId;
  listenUISettings(projectId);
  listenScheduleBoard(projectId);

  const q = query(collection(db, "projects", projectId, "cues"), orderBy("m"));
  unsub = onSnapshot(q, (snap) => {
    const rows = [];
    let latestAt = null;
    let latestBy = "";
    snap.forEach(d => {
      const row = { id: d.id, ...d.data() };
      row.nextSchedule = scheduleNextMap.get(d.id) || null;
      rows.push(row);

      const at = row.updatedAt;
      if (tsValue(at) > tsValue(latestAt)) {
        latestAt = at;
        latestBy = row.updatedBy || "";
      }
    });
    table.replaceData(rows);
    if (latestAt) {
      lastCueUpdatedAt = latestAt;
      lastCueUpdatedBy = latestBy;
      updateHeaderUpdated();
    }
    if(pendingSelectId){
      const r = table.getRow(pendingSelectId);
      if(r){
        r.select();
        setInspector(r);
        pendingSelectId = null;
      }
    }
    msg("");
  }, (err) => {
    console.error(err);
    msg(`同期エラー: ${err.code || err.message}`);
  });
}

// ログイン
$("btnLogin").onclick = async () => {
  try { await signInWithPopup(auth, provider); }
  catch(e){ console.error(e); msg(`ログイン失敗: ${e.code||e.message}`); }
};
$("btnLogout").onclick = async () => { await signOut(auth); };

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if(user){
    $("userPill").textContent = user.email || user.uid;
    $("btnLogin").style.display = "none";
    $("btnLogout").style.display = "inline-block";
    if (!projectNameLoaded) {
      projectNameLoaded = true;
      // プロジェクト名をヘッダーに反映
      (async () => {
        const pid = $("projectId").value.trim();
        if (!pid) return;
        try {
          const pSnap = await getDoc(doc(db, "projects", pid));
          const pName = pSnap.exists() ? (pSnap.data().name || pid) : pid;

          const pill = document.getElementById("projectNamePill");
          if (pill) pill.textContent = pName;
          const titleEl = document.getElementById("sheetTitle");
          if (titleEl) titleEl.textContent = pName;
          document.title = `Music Sheet | ${pName}`;
        } catch (e) {
          console.warn(e);
        }
      })();
    }
    listen($("projectId").value.trim());
  }else{
    $("userPill").textContent = "未ログイン";
    $("btnLogin").style.display = "inline-block";
    $("btnLogout").style.display = "none";
    if(unsub) unsub();
    table.replaceData([]);
    setInspector(null);
  }
  applyPermissionUI();
});

// 行追加（失敗時はエラーを表示）
$("btnAddRow").onclick = async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  if(!canEditAll()){ msg("管理者のみ追加できます"); return; }
  try{
    const m = nextMNumber();
    const ref = await addDoc(collection(db,"projects",currentProjectId,"cues"),{
      m,
      v: "",
      demo: "",
      status: "",
      scene: "",
      len: "",
      reference: "",
      in: "",
      out: "",
      interval: "",
      note: "",
      createdAt: serverTimestamp(),
      createdBy: who(),
      updatedAt: serverTimestamp(),
      updatedBy: who(),
    });
    pendingSelectId = ref.id;
    msg("行を追加しました");
  }catch(e){
    console.error(e);
    msg(`追加失敗: ${e.code || e.message}`);
  }
};

async function renumberM() {
  if(!currentUser) return;
  const rows = table.getRows();
  const batch = writeBatch(db);
  rows.forEach((r, i) => {
    const d = r.getData();
    batch.update(doc(db,"projects",currentProjectId,"cues",d.id), {
      m: String(i+1),
      updatedAt: serverTimestamp(),
      updatedBy: who(),
    });
  });
  await batch.commit();
}

$("btnDeleteRow")?.addEventListener("click", async (e) => {
  e.preventDefault();
  if(!currentUser){ msg("ログインしてね"); return; }
  if(!canEditAll()){ msg("管理者のみ削除できます"); return; }

  const selectedRows = table.getSelectedRows?.() || [];
  const ids = selectedRows.map((r) => r.getData?.()?.id).filter(Boolean);
  if(ids.length === 0 && selectedId) ids.push(selectedId);
  if(ids.length === 0){ msg("削除する行を選択してね"); return; }

  if(ids.length === 1){
    const r = table.getRow(ids[0]);
    const d = r?.getData?.() || {};
    if(!confirm(`#M ${d.m || ""} を削除する？`)) return;
  }else{
    if(!confirm(`選択中の${ids.length}行を削除する？`)) return;
  }

  try{
    const b = writeBatch(db);
    ids.forEach((id) => {
      b.delete(doc(db,"projects",currentProjectId,"cues", id));
    });
    await b.commit();
    if(selectedId && ids.includes(selectedId)){
      selectedId = null;
      setInspector(null);
    }
    msg(ids.length > 1 ? `削除しました（${ids.length}行）` : "削除しました");
    setTimeout(()=>msg(""), 900);
  }catch(err){
    console.error(err);
    msg(`削除失敗: ${err.code || err.message}`);
  }
});

// 詳細保存（未選択なら新規行を作る）
$("btnSaveDetail").onclick = async () => {
  if(!currentUser){ msg("ログインしてね"); return; }

  const fps = (window.__FPS_DEFAULT__ || "24");
  const inTc = $("f_in").value.trim() || "";
  const outTc = $("f_out").value.trim() || "";
  const interval = calcInterval(inTc, outTc, fps);
  $("f_interval").value = interval;

  const rowData = selectedId ? table.getRow(selectedId)?.getData?.() : {};
  const mValue = $("f_m") ? $("f_m").value.trim() : (rowData?.m ?? "");
  const vValue = $("f_v") ? $("f_v").value.trim() : (rowData?.v ?? "");
  const demoValue = $("f_demo") ? $("f_demo").value.trim() : (rowData?.demo ?? "");
  const sceneValue = $("f_scene") ? $("f_scene").value.trim() : (rowData?.scene ?? "");
  const referenceValue = getReferenceValue().trim();

  const fullPatch = {
    m: mValue || null,
    v: vValue || null,
    demo: demoValue || "",
    scene: sceneValue || "",
    status: $("f_status").value.trim() || "",
    len: $("f_len").value.trim() || "",
    note: $("f_note").value || "",
    reference: referenceValue,
    in: inTc,
    out: outTc,
    interval,
    updatedAt: serverTimestamp(),
    updatedBy: who(),
  };
  const patch = canEditAll()
    ? fullPatch
    : {
        reference: referenceValue,
        updatedAt: serverTimestamp(),
        updatedBy: who(),
      };

  try{
    if(!selectedId){
      if (!canEditAll()) {
        msg("ゲストは新規行を作成できません");
        return;
      }
      await addDoc(collection(db,"projects",currentProjectId,"cues"),{
        ...patch, createdAt: serverTimestamp(), createdBy: who()
      });
      msg("新規行を作って保存しました");
    }else{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selectedId), patch);
      msg("保存しました");
    }
  }catch(e){
    console.error(e);
    msg(`保存失敗: ${e.code || e.message}`);
  }
};

$("btnAddDirectorFB")?.addEventListener("click", async ()=>{
  if(!currentUser){ msg("ログインしてね"); return; }
  if(!canEditDirector()){ msg("ゲストは監督FBと参考曲のみ編集できます"); return; }
  if(!selectedId){ msg("行を選択してね"); return; }

  const text = ($("f_director_new")?.value || "").trim();
  if(!text){ msg("追加するFBを入力してね"); return; }

  const whoName = who();
  const ref = doc(db, "projects", currentProjectId, "cues", selectedId);

  const row = table.getRow(selectedId);
  const cur = row?.getData?.() || {};
  const list = Array.isArray(cur.directorLog) ? cur.directorLog.slice() : [];
  const version = cur?.v != null ? String(cur.v).trim() : "";

  const entry = { text, at: Timestamp.now(), by: whoName, archived: false };
  if (version) entry.v = version;
  list.push(entry);

  try{
    await updateDoc(ref, {
      directorLog: list,
      updatedAt: serverTimestamp(),
      updatedBy: whoName,
    });
    table.updateData([{ id: selectedId, directorLog: list }]);
    renderDirectorLog(list);
    $("f_director_new").value = "";
    msg("FBを追加しました");
    setTimeout(()=>msg(""), 900);
  }catch(e){
    console.error(e);
    msg(`FBの追加に失敗: ${e.code || e.message}`);
  }
});

$("btnAddComment")?.addEventListener("click", async ()=>{
  if(!currentUser){ msg("ログインしてね"); return; }
  if(!canEditComment()){ msg("コメントは管理者のみ編集できます"); return; }
  if(!selectedId){ msg("行を選択してね"); return; }

  const text = ($("f_comment_new")?.value || "").trim();
  if(!text){ msg("追加するコメントを入力してね"); return; }

  const ref = doc(db, "projects", currentProjectId, "cues", selectedId);
  const row = table.getRow(selectedId);
  const cur = row?.getData?.() || {};
  const list = Array.isArray(cur.commentLog) ? cur.commentLog.slice() : [];
  const version = cur?.v != null ? String(cur.v).trim() : "";

  const entry = { text, at: Timestamp.now(), by: who(), archived: false };
  if (version) entry.v = version;
  list.push(entry);

  try{
    await updateDoc(ref, {
      commentLog: list,
      updatedAt: serverTimestamp(),
      updatedBy: who(),
    });
    table.updateData([{ id: selectedId, commentLog: list }]);
    renderCommentLog(list);
    $("f_comment_new").value = "";
    msg("コメントを追加しました");
    setTimeout(()=>msg(""), 900);
  }catch(e){
    console.error(e);
    msg(`コメントの追加に失敗: ${e.code || e.message}`);
  }
});

document.getElementById("showDirectorArchived")?.addEventListener("change", () => {
  const row = selectedId ? table.getRow(selectedId) : null;
  renderDirectorLog(row?.getData?.().directorLog || []);
});

document.getElementById("showCommentArchived")?.addEventListener("change", () => {
  const row = selectedId ? table.getRow(selectedId) : null;
  renderCommentLog(row?.getData?.().commentLog || []);
});

// ===== inspector resizer =====
const divider = document.getElementById("divider");
let dragging = false;
let inspectorOpen = (localStorage.getItem("inspectorOpen") || "0") === "1";
let inspectorWidth = Number(localStorage.getItem("inspectorWidth") || "420");

function applyInspector(){
  const layout = document.querySelector(".layout");
  if(!layout) return;

  if(!inspectorOpen){
    layout.classList.add("inspectorClosed");
    $("btnToggleInspector").textContent = "詳細を開く";
  }else{
    layout.classList.remove("inspectorClosed");
    const w = Math.min(560, Math.max(320, inspectorWidth));
    layout.style.gridTemplateColumns = `1fr 10px ${w}px`;
    $("btnToggleInspector").textContent = "詳細を閉じる";
  }

  localStorage.setItem("inspectorOpen", inspectorOpen ? "1" : "0");
  localStorage.setItem("inspectorWidth", String(inspectorWidth));
}

$("btnToggleInspector")?.addEventListener("click", () => {
  inspectorOpen = !inspectorOpen;
  applyInspector();
});

applyInspector();

divider?.addEventListener("mousedown", () => { if(inspectorOpen) dragging = true; });
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("mousemove", (e) => {
  if(!dragging || !inspectorOpen) return;
  // 右パネル幅（ざっくり 320-560px の範囲で調整）
  const w = Math.min(560, Math.max(320, window.innerWidth - e.clientX - 12));
  inspectorWidth = w;
  document.querySelector(".layout").style.gridTemplateColumns = `1fr 10px ${w}px`;
  localStorage.setItem("inspectorWidth", String(inspectorWidth));
});

// ===== shortcuts =====
window.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? e.metaKey : e.ctrlKey;

  if(mod && e.key.toLowerCase() === "s"){
    e.preventDefault();
    document.getElementById("btnSaveDetail")?.click();
  }
  if(mod && e.key.toLowerCase() === "n"){
    e.preventDefault();
    document.getElementById("btnAddRow")?.click();
  }
  if(mod && e.key.toLowerCase() === "z"){
    e.preventDefault();
    undo().catch(console.error);
  }
});

// ===== filters =====
function applyFilters(){
  const q = ($("q")?.value || "").trim().toLowerCase();
  const st = $("statusFilter")?.value || "";

  table.clearFilter(true);

  table.setFilter((rowData) => {
    if(st && rowData.status !== st) return false;
    if(!q) return true;

    const hay = [
      rowData.scene, rowData.demo, rowData.status, rowData.len,
      rowData.director, rowData.memo, rowData.reference, rowData.in, rowData.out
    ].join(" ").toLowerCase();

    return hay.includes(q);
  });
}

$("q")?.addEventListener("input", applyFilters);
$("statusFilter")?.addEventListener("change", applyFilters);

$("fpsDefault")?.addEventListener("change", async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  if (!canEditAll()) { msg("管理者のみ変更できます"); return; }
  const ref = doc(db, "projects", currentProjectId, "settings", "ui");
  const fps = $("fpsDefault").value;
  window.__FPS_DEFAULT__ = fps;
  await setDoc(ref, { fpsDefault: fps, updatedAt: serverTimestamp(), updatedBy: who() }, { merge:true });
  msg("FPSを保存しました");
  setTimeout(()=>msg(""), 900);
});

// ===== settings modal wiring =====
$("btnSettings")?.addEventListener("click", openStatusModal);
$("btnCloseStatus")?.addEventListener("click", closeStatusModal);
$("overlay")?.addEventListener("click", closeStatusModal);

$("btnAddStatus")?.addEventListener("click", () => {
  if (!canEditAll()) return;
  statuses.push({ value: "new", label: "new", color: "#a78bfa" });
  renderStatusList();
});

$("btnSaveStatuses")?.addEventListener("click", async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  if (!canEditAll()) { msg("管理者のみ変更できます"); return; }
  await saveStatuses();
});

$("f_status")?.addEventListener("change", updateStatusPreview);
document.getElementById("f_reference")?.addEventListener("input", (e) => {
  const v = e.target?.value || "";
  setReferenceValue(v, "f_reference");
});
document.getElementById("f_reference_shared")?.addEventListener("input", (e) => {
  const v = e.target?.value || "";
  setReferenceValue(v, "f_reference_shared");
});


