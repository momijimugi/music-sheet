import "./style.css";
import { mountTopbar, getParams, getPreferredTheme } from "./ui_common";
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
const editor = $("meetingEditor");

$("toSheet").href = `${base}sheet.html?project=${encodeURIComponent(project)}`;
document.querySelector('a[href="/admin.html"]')?.setAttribute("href", `${base}admin.html`);

const f = document.getElementById("scheduleFrame");
const open = document.getElementById("openSchedule");

function setScheduleTheme() {
  const scheduleTheme = getPreferredTheme();
  if (f) {
    f.src = `${base}schedule.html?embed=1&theme=${scheduleTheme}&project=${enc}`;
  }
  if (open) {
    open.href = `${base}schedule.html?theme=${scheduleTheme}&project=${enc}`;
  }
}

setScheduleTheme();
window.addEventListener("themechange", () => setScheduleTheme());

const projectRef = doc(db,"projects",project);
const portalRef  = doc(db,"projects",project,"portal","main");
const logsCol = collection(db, "projects", project, "portalLogs");
let latestId = null;
let latestDocCache = null;
let lastLogs = [];

const isAdmin = isAdminUser(me);
const dropboxAdmin = document.getElementById("dropboxAdmin");
if (dropboxAdmin) dropboxAdmin.style.display = isAdmin ? "flex" : "none";
const referenceAdmin = document.getElementById("referenceAdmin");
if (referenceAdmin) referenceAdmin.style.display = isAdmin ? "flex" : "none";
const pdfAdmin = document.getElementById("pdfAdmin");
if (pdfAdmin) pdfAdmin.style.display = isAdmin ? "flex" : "none";
const referenceMsg = (t) => {
  const el = document.getElementById("referenceMsg");
  if (el) el.textContent = t || "";
};
let referenceLinks = [];
const pdfMsg = (t) => {
  const el = document.getElementById("pdfMsg");
  if (el) el.textContent = t || "";
};

const editorWrap = document.querySelector(".portalEditor");
const editorControls = document.querySelectorAll(".toolbar button");
const meetingTitle = document.getElementById("meetingTitle");
if (!isAdmin) {
  editor?.setAttribute("contenteditable", "false");
  editorControls.forEach((btn) => (btn.disabled = true));
  meetingTitle && (meetingTitle.disabled = true);
  document.getElementById("btnSave")?.setAttribute("disabled", "true");
  document.getElementById("btnMeetingClear")?.setAttribute("disabled", "true");
  editorWrap?.classList.add("readOnly");
}

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


onSnapshot(portalRef, (snap)=>{
  const d = snap.exists() ? snap.data() : {};
  const link = (d?.dropboxLink || "").trim();
  const pdfLink = (d?.schedulePdfLink || "").trim();
  referenceLinks = Array.isArray(d?.referenceLinks)
    ? d.referenceLinks.filter((v) => typeof v === "string" && v.trim())
    : [];

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

  renderReferences(referenceLinks);
  setPdfView(pdfLink);
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

document.getElementById("btnSavePdf")?.addEventListener("click", async ()=>{
  if(!isAdmin){ pdfMsg("管理者のみ設定できます"); return; }
  const raw = (document.getElementById("pdfUrl")?.value || "").trim();
  const url = normalizeReferenceUrl(raw);
  if (!url) {
    pdfMsg("リンクの形式を確認してください");
    return;
  }
  await setDoc(portalRef, { schedulePdfLink: url, updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  pdfMsg("PDFリンクを保存しました");
  setTimeout(()=>pdfMsg(""), 1200);
});

document.getElementById("btnClearPdf")?.addEventListener("click", async ()=>{
  if(!isAdmin){ pdfMsg("管理者のみ設定できます"); return; }
  await setDoc(portalRef, { schedulePdfLink: "" , updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  pdfMsg("PDFリンクをクリアしました");
  setTimeout(()=>pdfMsg(""), 1200);
});

document.getElementById("pdfUrl")?.addEventListener("keydown", (e)=>{
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btnSavePdf")?.click();
  }
});

document.getElementById("btnAddReference")?.addEventListener("click", async ()=>{
  if(!isAdmin){ referenceMsg("管理者のみ設定できます"); return; }
  const raw = (document.getElementById("referenceInput")?.value || "").trim();
  const url = normalizeReferenceUrl(raw);
  if (!url) {
    referenceMsg("リンクの形式を確認してください");
    return;
  }
  const next = [...new Set([...referenceLinks, url])];
  await setDoc(portalRef, { referenceLinks: next, updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  const input = document.getElementById("referenceInput");
  if (input) input.value = "";
  referenceMsg("参考曲を追加しました");
  setTimeout(()=>referenceMsg(""), 1200);
});

document.getElementById("referenceInput")?.addEventListener("keydown", (e)=>{
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("btnAddReference")?.click();
  }
});

// Notion風：ツールバー（太字など）
document.querySelectorAll(".tb[data-cmd]").forEach(btn=>{
  btn.addEventListener("click", (e)=>{
    e.preventDefault();
    if (!isAdmin) {
      msg("ゲストは閲覧のみです");
      return;
    }
    const cmd = btn.dataset.cmd;
    // execCommandは古いけど、軽量で今でも十分動く
    document.execCommand(cmd, false, null);
    editor.focus();
  });
});

$("btnMeetingClear").addEventListener("click", (e)=>{
  e.preventDefault();
  if (!isAdmin) {
    msg("ゲストは閲覧のみです");
    return;
  }
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

function normalizeReferenceUrl(raw){
  const s = String(raw || "").trim();
  if (!s) return "";
  try{
    return new URL(s).toString();
  }catch{
    try{
      return new URL(`https://${s}`).toString();
    }catch{
      return "";
    }
  }
}

function getPdfEmbedUrl(url){
  try{
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("drive.google.com")) {
      let id = "";
      const match = u.pathname.match(/\/file\/d\/([^\/]+)/);
      if (match) id = match[1];
      if (!id) id = u.searchParams.get("id") || "";
      if (id) return `https://drive.google.com/file/d/${id}/preview`;
    }
    if (host.includes("dropbox.com")) {
      u.searchParams.delete("dl");
      u.searchParams.set("raw", "1");
      return u.toString();
    }
  }catch{
    return "";
  }
  return url;
}

function setPdfView(link){
  const openLink = document.getElementById("pdfOpen");
  const unset = document.getElementById("pdfUnset");
  const viewer = document.getElementById("pdfViewer");
  const input = document.getElementById("pdfUrl");

  if (!link) {
    if (openLink) openLink.style.display = "none";
    if (unset) unset.style.display = "block";
    if (viewer) viewer.style.display = "none";
    if (isAdmin && input) input.value = "";
    return;
  }

  if (openLink) {
    openLink.style.display = "inline-flex";
    openLink.href = link;
  }
  if (unset) unset.style.display = "none";
  if (viewer) {
    const embed = getPdfEmbedUrl(link) || link;
    viewer.style.display = "block";
    viewer.innerHTML = `<iframe class="pdfFrame" src="${embed}" loading="lazy" title="Schedule PDF"></iframe>`;
  }
  if (isAdmin && input) input.value = link;
}

function getReferenceEmbed(url){
  const id = youtubeId(url);
  if (id) {
    return { provider: "youtube", label: "YouTube", embedUrl: `https://www.youtube.com/embed/${id}` };
  }
  try{
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host.includes("spotify.com")) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const type = parts[0];
        const key = parts[1];
        return { provider: "spotify", label: "Spotify", embedUrl: `https://open.spotify.com/embed/${type}/${key}` };
      }
    }
    if (host.includes("music.apple.com")) {
      const embed = new URL(u.toString());
      embed.hostname = "embed.music.apple.com";
      return { provider: "apple", label: "Apple Music", embedUrl: embed.toString() };
    }
  }catch{}
  return null;
}

function renderReferences(list){
  const host = document.getElementById("referenceList");
  const unset = document.getElementById("referenceUnset");
  const count = document.getElementById("referenceCount");
  if (!host) return;

  if (!list.length) {
    host.innerHTML = "";
    if (unset) unset.style.display = "block";
    if (count) count.textContent = "";
    return;
  }

  if (unset) unset.style.display = "none";
  if (count) count.textContent = `${list.length}件`;

  host.innerHTML = list.map((url, idx) => {
    const embed = getReferenceEmbed(url);
    const label = embed?.label || "リンク";
    const safeUrl = escapeHtml(url);
    const actions = isAdmin
      ? `<button class="smallBtn ghost" type="button" data-act="removeReference" data-idx="${idx}">削除</button>`
      : "";
    const embedHtml = embed
      ? `
        <div class="referenceEmbed" data-provider="${embed.provider}">
          <iframe data-src="${embed.embedUrl}" loading="lazy" allow="autoplay *; encrypted-media *; clipboard-write" allowfullscreen></iframe>
        </div>
      `
      : "";
    return `
      <details class="referenceItem">
        <summary>
          <span class="referenceTitle"><span class="tagPill">${label}</span>${safeUrl}</span>
          <span class="referenceActions">${actions}</span>
        </summary>
        <div class="referenceBody">
          ${embedHtml}
          <a class="referenceLink" href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>
        </div>
      </details>
    `;
  }).join("");

  host.querySelectorAll("details.referenceItem").forEach((details) => {
    const iframe = details.querySelector("iframe[data-src]");
    if (!iframe) return;
    const onToggle = () => {
      if (details.open && !iframe.src) {
        iframe.src = iframe.dataset.src || "";
      }
    };
    details.addEventListener("toggle", onToggle);
  });

  host.onclick = async (e) => {
    const btn = e.target?.closest("button[data-act='removeReference']");
    if (!btn) return;
    if (!isAdmin) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(btn.dataset.idx);
    if (Number.isNaN(idx)) return;
    const next = referenceLinks.filter((_, i) => i !== idx);
    await setDoc(portalRef, { referenceLinks: next, updatedAt: serverTimestamp(), updatedBy: me.email || me.uid }, { merge:true });
  };
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
  return isAdminUser(user);
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
  if(!isAdmin){ msg("ゲストは閲覧のみです"); return; }
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
  if(!isAdmin){ msg("管理者のみ操作できます"); return; }
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
  if(!isAdmin){ msg("管理者のみ操作できます"); return; }
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
