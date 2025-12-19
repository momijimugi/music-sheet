import "./style.css";
import { mountTopbar, getParams } from "./ui_common";
import { mountNav } from "./nav";
import { db } from "./firebase";
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp, collection, addDoc, query, orderBy, updateDoc, deleteDoc } from "firebase/firestore";

const $ = (id)=>document.getElementById(id);
const msg = (t)=>($("msg").textContent=t||"");

const me = await mountTopbar();
const { project } = getParams();
if(!project){ msg("project が指定されてないよ"); throw new Error("missing project"); }
localStorage.setItem("lastProject", project);

mountNav({ current: "portal", projectId: project });
const base = import.meta.env.BASE_URL || "/";

const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

function isAdminUser(u){
  return !!u?.email && ADMIN_EMAILS.includes(u.email);
}
const enc = encodeURIComponent(project);

$("toSheet").href = `${base}sheet.html?project=${encodeURIComponent(project)}`;
document.querySelector('a[href="/admin.html"]')?.setAttribute("href", `${base}admin.html`);

const f = document.getElementById("scheduleFrame");
const open = document.getElementById("openSchedule");

if (f) {
  f.src = `${base}schedule.html?embed=1&theme=light&project=${enc}`;
}
if (open) {
  open.href = `${base}schedule.html?theme=light&project=${enc}`;
}

const projectRef = doc(db,"projects",project);
const portalRef  = doc(db,"projects",project,"portal","main");
const logsCol = collection(db, "projects", project, "portalLogs");
let latestId = null;
let latestDocCache = null;
let lastLogs = [];

const isAdmin = isAdminUser(me);
const dropboxAdmin = document.getElementById("dropboxAdmin");
if (dropboxAdmin) dropboxAdmin.style.display = isAdmin ? "flex" : "none";

const pSnap = await getDoc(projectRef);
if (pSnap.exists()) {
  const pdata = pSnap.data() || {};
  if (pdata.deleted) {
    alert("このプロジェクトは消去されています（管理者に連絡してください）");
    location.replace(`${base}admin.html`);
    throw new Error("deleted project");
  }
  $("pTitle").textContent = pdata.name || project;
} else {
  $("pTitle").textContent = project;
}

const editor = $("meetingEditor");

onSnapshot(portalRef, (snap)=>{
  const d = snap.exists() ? snap.data() : {};
  const link = (d?.dropboxLink || "").trim();

  const openLink = document.getElementById("dropboxOpen");
  const unset = document.getElementById("dropboxUnset");
  const input = document.getElementById("dropboxUrl");

  if(link){
    if (openLink) {
      openLink.style.display = "inline-flex";
      openLink.href = link;
    }
    if (unset) unset.style.display = "none";
    if(isAdmin && input) input.value = link;
  }else{
    if (openLink) openLink.style.display = "none";
    if (unset) unset.style.display = "block";
    if(isAdmin && input) input.value = "";
  }
});

document.getElementById("btnSaveDropbox")?.addEventListener("click", async ()=>{
  if(!isAdmin){ msg("管理者のみ設定できます"); return; }
  const url = (document.getElementById("dropboxUrl")?.value || "").trim();
  await setDoc(portalRef, { dropboxLink: url, updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  msg("Dropboxリンクを保存しました");
  setTimeout(()=>msg(""), 1000);
});

document.getElementById("btnClearDropbox")?.addEventListener("click", async ()=>{
  if(!isAdmin){ msg("管理者のみ設定できます"); return; }
  await setDoc(portalRef, { dropboxLink: "" , updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  msg("Dropboxリンクをクリアしました");
  setTimeout(()=>msg(""), 1000);
});

// Notion風：ツールバー（太字など）
document.querySelectorAll(".tb[data-cmd]").forEach(btn=>{
  btn.addEventListener("click", (e)=>{
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    // execCommandは古いけど、軽量で今でも十分動く
    document.execCommand(cmd, false, null);
    editor.focus();
  });
});

$("btnMeetingClear").addEventListener("click", (e)=>{
  e.preventDefault();
  if(confirm("メモを全消去する？")) editor.innerHTML = "";
});

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function extractUrlsFromHtml(html){
  const urls = new Set();

  const hrefRe = /href=["']([^"']+)["']/gi;
  let m;
  while((m = hrefRe.exec(html || ""))) urls.add(m[1]);

  const plain = (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  while((m = urlRe.exec(plain))) urls.add(m[1]);

  return [...urls].filter(u => u.startsWith("http"));
}

function youtubeId(url){
  try{
    const u = new URL(url);
    if(u.hostname === "youtu.be"){
      return u.pathname.slice(1) || null;
    }
    if(u.hostname.includes("youtube.com")){
      const v = u.searchParams.get("v");
      if(v) return v;
      const s = u.pathname.match(/\/shorts\/([^\/]+)/);
      if(s) return s[1];
      const e = u.pathname.match(/\/embed\/([^\/]+)/);
      if(e) return e[1];
    }
  }catch{}
  return null;
}

function buildPreviews(html){
  const urls = extractUrlsFromHtml(html);
  if(urls.length === 0) return "";

  const cards = urls.slice(0, 6).map(u=>{
    const yid = youtubeId(u);
    if(yid){
      const thumb = `https://img.youtube.com/vi/${yid}/hqdefault.jpg`;
      return `
        <a class="linkCard" href="${u}" target="_blank" rel="noopener">
          <img class="linkThumb" loading="lazy" src="${thumb}" alt="YouTube thumbnail">
          <div class="linkMeta">
            <div class="linkTitle">YouTube</div>
            <div class="linkUrl">${u}</div>
          </div>
        </a>
      `;
    }
    return `
      <a class="linkCard" href="${u}" target="_blank" rel="noopener">
        <div class="linkMeta">
          <div class="linkTitle">リンク</div>
          <div class="linkUrl">${u}</div>
        </div>
      </a>
    `;
  }).join("");

  return `<div class="linkPreviewGrid">${cards}</div>`;
}

function canManageLog(user, d){
  const isAdmin = isAdminUser(user);
  const isOwner = d.createdBy && user?.email && d.createdBy === user.email;
  return isAdmin || isOwner;
}

function renderLogItem(d){
  const by = d.createdBy || "";
  const at = d.createdAt?.toDate ? d.createdAt.toDate() : null;
  const t  = at ? at.toLocaleString() : "";
  const title = d.title || "打ち合わせメモ";
  const html = d.meetingHtml || "";
  const archived = !!d.archived;
  return { t, by, title, html, archived };
}

function renderLogs(all){
  const showArchived = !!document.getElementById("showArchived")?.checked;
  const visible = showArchived ? all : all.filter(x => !x.archived);

  const latestHost = document.getElementById("latestMeeting");
  const latestMeta = document.getElementById("latestMeta");
  const histHost   = document.getElementById("meetingHistory");

  if(!latestHost || !latestMeta || !histHost) return;

  if(visible.length === 0){
    latestId = null;
    latestDocCache = null;
    latestHost.innerHTML = `<div class="muted">まだログがありません</div>`;
    latestMeta.textContent = "";
    histHost.innerHTML = `<div class="muted">—</div>`;
    document.getElementById("btnArchiveLatest")?.setAttribute("disabled","true");
    document.getElementById("btnDeleteLatest")?.setAttribute("disabled","true");
    return;
  }

  latestId = visible[0].id;
  latestDocCache = visible[0];

  const latest = renderLogItem(visible[0]);
  latestMeta.textContent = `${latest.t}　${latest.by}`;
  latestHost.innerHTML = `
    <div class="logMeta"><b>${escapeHtml(latest.title)}</b>${latest.archived ? ` <span class="muted">（アーカイブ）</span>` : ""}</div>
    <div class="logText">${latest.html}</div>
    ${typeof buildPreviews === "function" ? buildPreviews(latest.html) : ""}
  `;

  const rest = visible.slice(1);
  if(rest.length === 0){
    histHost.innerHTML = `<div class="muted">過去ログはまだありません</div>`;
  }else{
    histHost.innerHTML = rest.map((x)=>{
      const it = renderLogItem(x);
      return `
        <details class="logToggle">
          <summary>
            <span>${escapeHtml(it.title)}　<span class="muted">${escapeHtml(it.t || "")}</span></span>
            <span class="muted">${escapeHtml(it.by || "")}${it.archived ? "（A）" : ""}</span>
          </summary>
          <div class="logItem" style="margin-top:8px;">
            <div class="logText">${it.html}</div>
            ${typeof buildPreviews === "function" ? buildPreviews(it.html) : ""}
          </div>
        </details>
      `;
    }).join("");
  }

  const can = canManageLog(me, visible[0]);
  const ba = document.getElementById("btnArchiveLatest");
  const bd = document.getElementById("btnDeleteLatest");
  if(ba) ba.disabled = !can;
  if(bd) bd.disabled = !can;
}

const qLogs = query(logsCol, orderBy("createdAt","desc"));
onSnapshot(qLogs, (snap)=>{
  const all = [];
  snap.forEach(docu => all.push({ id: docu.id, ...docu.data() }));
  lastLogs = all;
  renderLogs(all);

}, (err)=>{
  console.error(err);
  msg(`ログ同期エラー: ${err.code || err.message}`);
});

document.getElementById("showArchived")?.addEventListener("change", () => {
  renderLogs(lastLogs);
});

// 保存
$("btnSave").addEventListener("click", async ()=>{
  if(!me){ msg("ログインしてね"); return; }
  const titleEl = document.getElementById("meetingTitle");
  const title = (titleEl?.value || "").trim() || "打ち合わせメモ";
  const html = editor.innerHTML || "";
  if(!html.trim()){ msg("空のメモは保存できないよ"); return; }

  await addDoc(logsCol, {
    title,
    meetingHtml: html,
    createdAt: serverTimestamp(),
    createdBy: me.email || me.uid,
  });

  if (titleEl) titleEl.value = "";
  editor.innerHTML = "";
  msg("ログとして保存しました");
  setTimeout(()=>msg(""), 1200);
});

document.getElementById("btnArchiveLatest")?.addEventListener("click", async ()=>{
  if(!me){ msg("ログインしてね"); return; }
  if(!latestId || !latestDocCache){ msg("対象ログがありません"); return; }
  if(!confirm("最新ログをアーカイブする？（通常表示から外れます）")) return;

  try{
    const ref = doc(db, "projects", project, "portalLogs", latestId);
    await updateDoc(ref, {
      archived: true,
      archivedAt: serverTimestamp(),
      archivedBy: me.email || me.uid,
    });
    msg("アーカイブしました");
    setTimeout(()=>msg(""), 900);
  }catch(e){
    console.error(e);
    msg(`アーカイブ失敗: ${e.code || e.message}`);
  }
});

document.getElementById("btnDeleteLatest")?.addEventListener("click", async ()=>{
  if(!me){ msg("ログインしてね"); return; }
  if(!latestId || !latestDocCache){ msg("対象ログがありません"); return; }

  const ok1 = confirm("最新ログを消去します。よろしいですか？（元に戻せません）");
  if(!ok1) return;
  const ok2 = prompt("最終確認：DELETE と入力してください");
  if(ok2 !== "DELETE") return;

  try{
    const ref = doc(db, "projects", project, "portalLogs", latestId);
    await deleteDoc(ref);
    msg("消去しました");
    setTimeout(()=>msg(""), 900);
  }catch(e){
    console.error(e);
    msg(`消去失敗: ${e.code || e.message}`);
  }
});

// Ctrl+S で保存
window.addEventListener("keydown", (e)=>{
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if(mod && e.key.toLowerCase()==="s"){
    e.preventDefault();
    $("btnSave").click();
  }
});
