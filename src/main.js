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

function who() {
  return currentUser?.displayName || currentUser?.email || currentUser?.uid || "";
}
function fmtUpdated(d){
  const at = d?.updatedAt?.toDate ? d.updatedAt.toDate() : null;
  const t = at ? at.toLocaleString() : "";
  const by = d?.updatedBy || "";
  return `${t} ${by}`.trim();
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
  const text = pickTextColor(s.color);
  // ほんのり色つけ（背景薄め + 枠濃いめ）
  const bg = s.color + "22";
  const bd = s.color + "55";
  return `<span class="tagPill" style="background:${bg};border-color:${bd};color:${text}">${s.label}</span>`;
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

  select.style.width = "100%";
  select.style.height = "28px";
  select.style.borderRadius = "8px";
  select.style.border = "1px solid rgba(15,23,42,.15)";
  select.style.background = "#fff";

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
  return `<span class="tagPill" style="background:${s.color}22;border-color:${s.color}55;color:${pickTextColor(s.color)}">${s.label}</span>`;
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
        cell.edit(true);
      },
    });
  }catch(_){ }
}

function openStatusModal(){
  $("overlay").classList.remove("hidden");
  $("statusModal").classList.remove("hidden");
  renderStatusList();
}
function closeStatusModal(){
  $("overlay").classList.add("hidden");
  $("statusModal").classList.add("hidden");
}

function renderStatusList(){
  const host = $("statusList");
  host.innerHTML = "";

  statuses.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "statusRow";
    row.innerHTML = `
      <input type="text" value="${s.label}" data-k="label" data-i="${idx}" placeholder="表示名" />
      <input type="text" value="${s.value}" data-k="value" data-i="${idx}" placeholder="保存値（英数推奨）" />
      <input type="color" value="${s.color}" data-k="color" data-i="${idx}" />
      <button class="smallBtn" data-act="del" data-i="${idx}">削除</button>
    `;
    host.appendChild(row);
  });

  host.oninput = (e) => {
    const t = e.target;
    const i = Number(t?.dataset?.i);
    const k = t?.dataset?.k;
    if(Number.isNaN(i) || !k) return;
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
  // value重複を軽くケア（空は消す）
  statuses = statuses
    .map(s => ({...s, value:(s.value||"").trim(), label:(s.label||"").trim()}))
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

function updateStatusPreview(){
  const v = $("f_status")?.value || "";
  $("statusTagPreview").outerHTML = `<span id="statusTagPreview" class="tagPill">${(statusMap.get(v)?.label || v || "—")}</span>`;
  // 上で差し替わったので再参照不要（次回はapplyStatusUIが再生成）
}

let currentUser = null;
// ===== project from URL =====
const sp = new URLSearchParams(location.search);
const urlProject = (sp.get("project") || "").trim();
if (urlProject) {
  $("projectId").value = urlProject;
  $("projectId").disabled = true;
  localStorage.setItem("lastProject", urlProject);
}
let currentProjectId = $("projectId").value.trim();
let unsub = null;
let pendingSelectId = null;
let projectNameLoaded = false;

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
      width: 34,
      hozAlign: "center",
      headerSort: false,
      rowHandle: true,
    },
    { title: "#M", field: "m", width: 70, headerSort: true },
    { title: "V", field: "v", width: 55, editor: "input" },
    { title: "demo", field: "demo", width: 80, editor: "input" },
    { title: "scene", field: "scene", minWidth: 180, editor: "input" },
    { title:"長さ", field:"len", width:120,
      formatter:(cell)=>renderSelectCell(renderLenTag(cell.getValue())),
      editor: selectEditor,
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
        cell.edit(true);
      },
    },
    {
      title: "進捗",
      field: "status",
      width: 130,
      formatter: (cell) => renderSelectCell(renderStatusTag(cell.getValue())),
      editor: selectEditor,
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
        cell.edit(true);
      },
    },
    { title: "memo(省略)", field: "memo", minWidth: 180,
      formatter: (cell) => (cell.getValue() || "").replace(/\s+/g," ").slice(0,30) + ((cell.getValue()||"").length>30?"…":"")
    },
    { title: "監督FB(省略)", field: "director", minWidth: 220,
      formatter: (cell) => (cell.getValue() || "").replace(/\s+/g," ").slice(0,40) + ((cell.getValue()||"").length>40?"…":"")
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
    { title: "IN TC", field: "in", width: 110, editor: "input" },
    { title: "OUT TC", field: "out", width: 110, editor: "input" },
    { title: "INT TC", field: "interval", width: 110, headerSort: false },
  ],
});

applyLenUI();

let bulkMode = false;
let applying = false;
const undoStack = [];
const UNDO_MAX = 50;
const BULK_FIELDS = new Set(["status", "len", "scene", "demo", "memo", "in", "out"]);

$("btnBulk")?.addEventListener("click", () => {
  bulkMode = !bulkMode;
  $("btnBulk").textContent = `一括編集: ${bulkMode ? "ON" : "OFF"}`;
});

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
    $("selMeta").textContent="行を選択すると表示されます";
    renderDirectorLog([]);
    renderCommentLog([]);
    $("f_director_new").value = "";
    $("f_comment_new").value = "";
    $("f_in").value = "";
    $("f_out").value = "";
    $("f_interval").value = "";
    return;
  }
  const d = row.getData();
  selectedId = d.id;
  $("selMeta").textContent = `選択中: #M ${d.m ?? ""} / demo ${d.demo ?? ""}`;
  $("f_m").value = d.m ?? "";
  $("f_v").value = d.v ?? "";
  $("f_demo").value = d.demo ?? "";
  $("f_scene").value = d.scene ?? "";
  $("f_status").value = d.status ?? "";
  $("f_len").value = d.len ?? "";
  $("f_memo").value = d.memo ?? "";
  $("f_in").value = d.in ?? "";
  $("f_out").value = d.out ?? "";
  const fps = (window.__FPS_DEFAULT__ || "24");
  $("f_interval").value = d.interval ?? calcInterval(d.in || "", d.out || "", fps);
  renderDirectorLog(d.directorLog || []);
  renderCommentLog(d.commentLog || []);
  $("f_director_new").value = "";
  $("f_comment_new").value = "";
}


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

function renderDirectorLog(list){
  const host = document.getElementById("directorLog");
  const showArchived = document.getElementById("showDirectorArchived")?.checked;

  if(!host) return;
  const arr = Array.isArray(list) ? list.slice() : [];
  const view = showArchived ? arr : arr.filter(x=>!x?.archived);

  if(view.length === 0){
    host.innerHTML = `<div class="muted">まだFBはありません</div>`;
    host.onclick = null;
    return;
  }

  host.innerHTML = view
    .sort((a,b)=> (a?.at?.seconds||0) - (b?.at?.seconds||0))
    .map((item, idx) => {
      const by = item.by || "";
      const at = item.at?.toDate ? item.at.toDate() : null;
      const t  = at ? at.toLocaleString() : "";
      const text = item.text || "";
      return `
        <div class="logItem">
          <div class="logMeta">${t}　${escapeHtml(by)}</div>
          <div class="logText">${escapeHtml(text)}</div>
          ${buildLinkPreviews(text)}
          <div style="margin-top:8px; display:flex; gap:8px;">
            <button class="smallBtn" type="button" data-act="archiveDirector" data-idx="${idx}">アーカイブ</button>
          </div>
        </div>
      `;
    }).join("");

  host.onclick = async (e)=>{
    const btn = e.target?.closest("button[data-act='archiveDirector']");
    if(!btn) return;
    if(!currentUser || !selectedId) return;

    const idx = Number(btn.dataset.idx);
    const row = table.getRow(selectedId);
    const cur = row?.getData?.() || {};
    const list0 = Array.isArray(cur.directorLog) ? cur.directorLog.slice() : [];

    const view2 = showArchived ? list0 : list0.filter(x=>!x?.archived);
    const target = view2[idx];
    if(!target) return;

    const i = list0.findIndex(x =>
      (x?.text||"") === (target.text||"") &&
      (x?.by||"") === (target.by||"") &&
      (x?.at?.seconds||0) === (target.at?.seconds||0)
    );
    if(i < 0) return;

    list0[i] = { ...list0[i], archived: true, archivedAt: Timestamp.now(), archivedBy: who() };

    try{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selectedId), {
        directorLog: list0,
        updatedAt: serverTimestamp(),
        updatedBy: who(),
      });
    }catch(e){
      console.error(e);
      msg(`アーカイブ失敗: ${e.code || e.message}`);
    }
  };
}

function renderCommentLog(list){
  const host = document.getElementById("commentLog");
  const showArchived = document.getElementById("showCommentArchived")?.checked;

  if(!host) return;
  const arr = Array.isArray(list) ? list.slice() : [];
  const view = showArchived ? arr : arr.filter(x=>!x?.archived);

  if(view.length === 0){
    host.innerHTML = `<div class="muted">まだコメントはありません</div>`;
    host.onclick = null;
    return;
  }

  host.innerHTML = view
    .sort((a,b)=> (a?.at?.seconds||0) - (b?.at?.seconds||0))
    .map((item, idx) => {
      const by = item.by || "";
      const at = item.at?.toDate ? item.at.toDate() : null;
      const t  = at ? at.toLocaleString() : "";
      const text = item.text || "";
      return `
        <div class="logItem">
          <div class="logMeta">${t}　${escapeHtml(by)}</div>
          <div class="logText">${escapeHtml(text)}</div>
          ${buildLinkPreviews(text)}
          <div style="margin-top:8px; display:flex; gap:8px;">
            <button class="smallBtn" type="button" data-act="archiveComment" data-idx="${idx}">アーカイブ</button>
          </div>
        </div>
      `;
    }).join("");

  host.onclick = async (e)=>{
    const btn = e.target?.closest("button[data-act='archiveComment']");
    if(!btn) return;
    if(!currentUser || !selectedId) return;

    const idx = Number(btn.dataset.idx);
    const row = table.getRow(selectedId);
    const cur = row?.getData?.() || {};
    const list0 = Array.isArray(cur.commentLog) ? cur.commentLog.slice() : [];

    const view2 = showArchived ? list0 : list0.filter(x=>!x?.archived);
    const target = view2[idx];
    if(!target) return;

    const i = list0.findIndex(x =>
      (x?.text||"") === (target.text||"") &&
      (x?.by||"") === (target.by||"") &&
      (x?.at?.seconds||0) === (target.at?.seconds||0)
    );
    if(i < 0) return;

    list0[i] = { ...list0[i], archived: true, archivedAt: Timestamp.now(), archivedBy: who() };

    try{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selectedId), {
        commentLog: list0,
        updatedAt: serverTimestamp(),
        updatedBy: who(),
      });
    }catch(e){
      console.error(e);
      msg(`アーカイブ失敗: ${e.code || e.message}`);
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
  if (!insideGrid && !insideInspector) table.deselectRow();
});

let moving = false;
table.on("rowMoved", async () => {
  if(!currentUser) return;
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

  const q = query(collection(db, "projects", projectId, "cues"), orderBy("m"));
  unsub = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    table.replaceData(rows);
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
});

// 行追加（失敗時はエラーを表示）
$("btnAddRow").onclick = async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  try{
    const m = nextMNumber();
    const ref = await addDoc(collection(db,"projects",currentProjectId,"cues"),{
      m,
      v: "",
      demo: "",
      status: "",
      scene: "",
      len: "",
      in: "",
      out: "",
      interval: "",
      memo: "",
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

  let id = selectedId;
  if(!id){
    const r = table.getSelectedRows?.()[0];
    id = r?.getData?.()?.id || null;
  }
  if(!id){ msg("削除する行を選択してね"); return; }

  const r = table.getRow(id);
  const d = r?.getData?.() || {};
  if(!confirm(`#M ${d.m || ""} を削除する？`)) return;

  try{
    await deleteDoc(doc(db,"projects",currentProjectId,"cues", id));
    selectedId = null;
    setInspector(null);
    msg("削除しました");
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

  const patch = {
    m: $("f_m").value.trim() || null,
    v: $("f_v").value.trim() || null,
    demo: $("f_demo").value.trim() || "",
    scene: $("f_scene").value.trim() || "",
    status: $("f_status").value.trim() || "",
    len: $("f_len").value.trim() || "",
    memo: $("f_memo").value || "",
    in: inTc,
    out: outTc,
    interval,
    updatedAt: serverTimestamp(),
    updatedBy: who(),
  };

  try{
    if(!selectedId){
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
  if(!selectedId){ msg("行を選択してね"); return; }

  const text = ($("f_director_new")?.value || "").trim();
  if(!text){ msg("追加するFBを入力してね"); return; }

  const whoName = who();
  const ref = doc(db, "projects", currentProjectId, "cues", selectedId);

  const row = table.getRow(selectedId);
  const cur = row?.getData?.() || {};
  const list = Array.isArray(cur.directorLog) ? cur.directorLog.slice() : [];

  list.push({
    text,
    at: Timestamp.now(),
    by: whoName,
    archived: false,
  });

  await updateDoc(ref, {
    directorLog: list,
    updatedAt: serverTimestamp(),
    updatedBy: whoName,
  });

  $("f_director_new").value = "";
  msg("FBを追加しました");
  setTimeout(()=>msg(""), 900);
});

$("btnAddComment")?.addEventListener("click", async ()=>{
  if(!currentUser){ msg("ログインしてね"); return; }
  if(!selectedId){ msg("行を選択してね"); return; }

  const text = ($("f_comment_new")?.value || "").trim();
  if(!text){ msg("追加するコメントを入力してね"); return; }

  const ref = doc(db, "projects", currentProjectId, "cues", selectedId);
  const row = table.getRow(selectedId);
  const cur = row?.getData?.() || {};
  const list = Array.isArray(cur.commentLog) ? cur.commentLog.slice() : [];

  list.push({ text, at: Timestamp.now(), by: who(), archived: false });

  await updateDoc(ref, {
    commentLog: list,
    updatedAt: serverTimestamp(),
    updatedBy: who(),
  });

  $("f_comment_new").value = "";
  msg("コメントを追加しました");
  setTimeout(()=>msg(""), 900);
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
      rowData.director, rowData.memo, rowData.in, rowData.out
    ].join(" ").toLowerCase();

    return hay.includes(q);
  });
}

$("q")?.addEventListener("input", applyFilters);
$("statusFilter")?.addEventListener("change", applyFilters);

$("fpsDefault")?.addEventListener("change", async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  const ref = doc(db, "projects", currentProjectId, "settings", "ui");
  const fps = $("fpsDefault").value;
  window.__FPS_DEFAULT__ = fps;
  await setDoc(ref, { fpsDefault: fps, updatedAt: serverTimestamp(), updatedBy: who() }, { merge:true });
  msg("FPSを保存しました");
  setTimeout(()=>msg(""), 900);
});

// ===== status modal wiring =====
$("btnStatusConfig")?.addEventListener("click", openStatusModal);
$("btnCloseStatus")?.addEventListener("click", closeStatusModal);
$("overlay")?.addEventListener("click", closeStatusModal);

$("btnAddStatus")?.addEventListener("click", () => {
  statuses.push({ value: "new", label: "new", color: "#a78bfa" });
  renderStatusList();
});

$("btnSaveStatuses")?.addEventListener("click", async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  await saveStatuses();
});

$("f_status")?.addEventListener("change", updateStatusPreview);

