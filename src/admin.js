import "./style.css";
import "tabulator-tables/dist/css/tabulator.min.css";
import { mountNav } from "./nav";
import { getPreferredTheme, mountThemeToggle } from "./ui_common";
import { auth, db, provider } from "./firebase";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  collectionGroup,
  deleteField,
  deleteDoc,
  doc,
  FieldPath,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { upsertUserProfile } from "./firebase";

const base = import.meta.env.BASE_URL || "/";
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_MEMBER_ROLE = "member";

function isAdmin(user) {
  return !!user && !!user.email && ADMIN_EMAILS.includes(user.email);
}

const $ = (id) => document.getElementById(id);
const msg = (t) => ($("msg").textContent = t || "");
const whoName = () => currentUser?.displayName || currentUser?.email || currentUser?.uid || "";
const lastUpdatedEl = $("lastUpdated");
let projectUpdatedAt = null;
let projectUpdatedBy = "";
let scheduleUpdatedAt = null;
let scheduleUpdatedBy = "";

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
  const projVal = tsValue(projectUpdatedAt);
  const schedVal = tsValue(scheduleUpdatedAt);
  if (schedVal >= projVal) {
    setLastUpdated(scheduleUpdatedAt, scheduleUpdatedBy);
  } else {
    setLastUpdated(projectUpdatedAt, projectUpdatedBy);
  }
}

const $m = (id) => document.getElementById(id);
const memberMsg = (t) => {
  const el = $m("memberMsg");
  if (el) el.textContent = t || "";
};

const scheduleTitle = $("scheduleSelectionTitle");
const scheduleMeta = $("scheduleSelectionMeta");
const scheduleToSheet = $("scheduleToSheet");
const scheduleDirectorLog = $("scheduleDirectorLog");
const scheduleCommentLog = $("scheduleCommentLog");
const scheduleReferencePreview = $("scheduleReferencePreview");
const scheduleMeetingTitle = $("scheduleMeetingTitle");
const scheduleMeetingMeta = $("scheduleMeetingMeta");
const scheduleMeetingLog = $("scheduleMeetingLog");

let meetingMemoUnsub = null;

function renderMeetingMemoEmpty(message) {
  if (scheduleMeetingTitle) scheduleMeetingTitle.textContent = "";
  if (scheduleMeetingMeta) scheduleMeetingMeta.textContent = "";
  if (scheduleMeetingLog) {
    scheduleMeetingLog.innerHTML = `<div class="muted">${message || "まだメモがありません"}</div>`;
  }
}

function updateScheduleSheetLink(projectId, cueId) {
  if (!scheduleToSheet) return;
  if (!projectId) {
    scheduleToSheet.style.display = "none";
    scheduleToSheet.removeAttribute("href");
    return;
  }
  const href = cueId
    ? `${base}sheet.html?project=${encodeURIComponent(projectId)}&cue=${encodeURIComponent(cueId)}`
    : `${base}sheet.html?project=${encodeURIComponent(projectId)}`;
  scheduleToSheet.href = href;
  scheduleToSheet.style.display = "inline-flex";
}

function renderMeetingMemo(docData) {
  const title = docData?.title || "打ち合わせメモ";
  const html = docData?.meetingHtml || "";
  const at = docData?.createdAt?.toDate ? docData.createdAt.toDate() : null;
  const t = at ? at.toLocaleString() : "";
  const by = formatByName(docData?.createdBy || "");
  if (scheduleMeetingTitle) scheduleMeetingTitle.textContent = title;
  if (scheduleMeetingMeta) scheduleMeetingMeta.textContent = [t, by].filter(Boolean).join(" ");
  if (scheduleMeetingLog) {
    scheduleMeetingLog.innerHTML = html
      ? `<div class="logText">${html}</div>`
      : `<div class="muted">本文がありません</div>`;
  }
}

function listenLatestMeetingMemo(projectId) {
  if (meetingMemoUnsub) {
    meetingMemoUnsub();
    meetingMemoUnsub = null;
  }
  if (!projectId) {
    renderMeetingMemoEmpty("案件を選択してください");
    return;
  }
  renderMeetingMemoEmpty("読み込み中...");
  const q = query(
    collection(db, "projects", projectId, "portalLogs"),
    orderBy("createdAt", "desc"),
    limit(1)
  );
  meetingMemoUnsub = onSnapshot(q, (snap) => {
    if (snap.empty) {
      renderMeetingMemoEmpty("まだメモがありません");
      return;
    }
    renderMeetingMemo(snap.docs[0]?.data?.() || {});
  }, (err) => {
    console.error(err);
    renderMeetingMemoEmpty("読み込みに失敗しました");
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeLabel(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function splitScopedTrackId(trackId) {
  const raw = String(trackId || "");
  const idx = raw.indexOf("__");
  if (idx <= 0) return null;
  const projectId = raw.slice(0, idx).trim();
  const cueId = raw.slice(idx + 2).trim();
  if (!projectId || !cueId) return null;
  return { projectId, cueId };
}

function buildCueLabel(cue) {
  const m = (cue?.m ?? "").toString().trim();
  const scene = (cue?.scene ?? "").toString().trim();
  const demo = (cue?.demo ?? "").toString().trim();
  const v = (cue?.v ?? "").toString().trim();
  const parts = [];
  if (m) parts.push(`#${m}`);
  if (scene) parts.push(scene);
  else if (demo) parts.push(demo);
  else if (v) parts.push(`v:${v}`);
  return parts.join(" ").trim();
}

function extractUrls(text) {
  const s = String(text || "");
  const m = s.match(/https?:\/\/[^\s<>"']+/g);
  return m ? [...new Set(m)] : [];
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const s = u.pathname.match(/\/shorts\/([^\/]+)/);
      if (s) return s[1];
      const e = u.pathname.match(/\/embed\/([^\/]+)/);
      if (e) return e[1];
    }
  } catch {}
  return null;
}

function buildReferenceBody(value) {
  const raw = String(value || "").trim();
  if (!raw) return `<div class="muted">参考曲はありません</div>`;

  const urls = extractUrls(raw);
  const ytUrl = urls.find((u) => youtubeId(u));
  let embed = "";
  if (ytUrl) {
    const id = youtubeId(ytUrl);
    embed = `
      <div class="referenceEmbed" data-provider="youtube">
        <iframe src="https://www.youtube.com/embed/${id}" title="YouTube preview" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
      </div>
    `;
  }

  const showText = raw && !(urls.length === 1 && raw === urls[0]);
  const textHtml = showText ? `<div class="muted">${escapeHtml(raw)}</div>` : "";
  const linksHtml = urls.length
    ? `<div class="referenceList">${urls
        .map((u) => {
          const safe = escapeHtml(u);
          return `<a class="referenceLink" href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
        })
        .join("")}</div>`
    : "";
  return `${textHtml}${embed}${linksHtml}`;
}

function renderScheduleReference(items, emptyText = "参考曲はまだありません") {
  if (!scheduleReferencePreview) return;
  if (!items || items.length === 0) {
    scheduleReferencePreview.innerHTML = `<div class="muted">${emptyText}</div>`;
    return;
  }
  scheduleReferencePreview.innerHTML = items
    .map((item) => {
      const label = item.label ? `<div class="muted">${escapeHtml(item.label)}</div>` : "";
      return `<div class="referenceCard">${label}${buildReferenceBody(item.value)}</div>`;
    })
    .join("");
}

function renderScheduleLog(host, items, emptyText) {
  if (!host) return;
  if (!items.length) {
    host.innerHTML = `<div class="muted">${emptyText}</div>`;
    return;
  }
  host.innerHTML = items.map((item) => {
    const cue = item.cue || {};
    const at = item.at?.toDate ? item.at.toDate() : null;
    const t = at ? at.toLocaleString() : "";
    const by = item.by || "";
    const metaParts = [];
    if (cue.m != null && cue.m !== "") metaParts.push(`#M ${cue.m}`);
    if (cue.scene) metaParts.push(cue.scene);
    if (t) metaParts.push(t);
    if (by) metaParts.push(by);
    return `
      <div class="logItem">
        <div class="logMeta">${escapeHtml(metaParts.join(" / "))}</div>
        <div class="logText">${escapeHtml(item.text || "")}</div>
      </div>
    `;
  }).join("");
}

function flattenLogs(cues, key) {
  const items = [];
  cues.forEach((cue) => {
    const list = Array.isArray(cue[key]) ? cue[key] : [];
    list.forEach((entry) => {
      if (entry && !entry.archived) {
        items.push({ ...entry, cue });
      }
    });
  });
  items.sort((a, b) => (b?.at?.seconds || 0) - (a?.at?.seconds || 0));
  return items.slice(0, 12);
}

async function loadScheduleLogs(payload = {}) {
  let { projectId, projectName, trackId, trackName, cueId } = payload;
  const scoped = splitScopedTrackId(trackId);
  if (scoped?.projectId) projectId = scoped.projectId;
  if (scoped?.cueId) cueId = scoped.cueId;
  if (!projectId) return;
  listenLatestMeetingMemo(projectId);
  updateScheduleSheetLink(projectId, cueId);
  const requestId = ++scheduleSelectionToken;
  const displayName = trackName || "選択中の曲";
  if (scheduleTitle) {
    scheduleTitle.textContent = displayName;
  }
  renderScheduleLog(scheduleDirectorLog, [], "読み込み中...");
  renderScheduleLog(scheduleCommentLog, [], "読み込み中...");
  renderScheduleReference([], "読み込み中...");

  let resolvedCueId = cueId || trackId || "";
  if (resolvedCueId && projectId && resolvedCueId.startsWith(`${projectId}__`)) {
    resolvedCueId = resolvedCueId.slice(projectId.length + 2);
  }

  if (resolvedCueId) {
    const cueSnap = await getDoc(doc(db, "projects", projectId, "cues", resolvedCueId));
    if (requestId !== scheduleSelectionToken) return;
    if (cueSnap.exists()) {
      const cue = { id: resolvedCueId, ...(cueSnap.data() || {}) };
      const titleParts = [];
      if (cue.m != null && cue.m !== "") titleParts.push(`#M ${cue.m}`);
      if (cue.scene) titleParts.push(cue.scene);
      if (cue.demo) titleParts.push(cue.demo);
      const titleText = titleParts.join(" / ") || displayName;

      if (scheduleTitle) scheduleTitle.textContent = titleText;
      if (scheduleMeta) {
        const parts = [];
        if (projectName) parts.push(projectName);
        if (projectId) parts.push(`#${projectId}`);
        scheduleMeta.textContent = parts.join(" / ");
      }

      const directorItems = (cue.directorLog || [])
        .filter((x) => x && !x.archived)
        .map((x) => ({ ...x, cue }))
        .sort((a, b) => (b?.at?.seconds || 0) - (a?.at?.seconds || 0));
      const commentItems = (cue.commentLog || [])
        .filter((x) => x && !x.archived)
        .map((x) => ({ ...x, cue }))
        .sort((a, b) => (b?.at?.seconds || 0) - (a?.at?.seconds || 0));

      renderScheduleLog(scheduleDirectorLog, directorItems, "監督FBはまだありません");
      renderScheduleLog(scheduleCommentLog, commentItems, "コメントはまだありません");
      const refValue = (cue.reference || "").trim();
      if (refValue) {
        renderScheduleReference([{ value: refValue }]);
      } else {
        renderScheduleReference([], "参考曲はまだありません");
      }
      return;
    }
  }

  const q = query(collection(db, "projects", projectId, "cues"), orderBy("m"));
  const snap = await getDocs(q);
  if (requestId !== scheduleSelectionToken) return;
  const cues = [];
  snap.forEach((d) => cues.push({ id: d.id, ...(d.data() || {}) }));

  let filtered = cues;
  const keywordRaw = String(trackName || "").trim();
  const keyword = normalizeLabel(keywordRaw);
  const mMatch = keywordRaw.match(/#\s*(\d+)/);
  const mFromName = mMatch ? mMatch[1] : null;
  if (keyword || mFromName) {
    const matches = cues.filter((cue) => {
      const label = normalizeLabel(buildCueLabel(cue));
      if (label && label === keyword) return true;
      const hay = [
        cue.scene,
        cue.demo,
        cue.memo,
        cue.note,
        cue.v != null ? `v:${cue.v}` : "",
        cue.m != null ? `#${cue.m}` : "",
      ]
        .filter(Boolean)
        .map((v) => normalizeLabel(v))
        .join(" ");
      if (hay.includes(keyword)) return true;
      if (mFromName && String(cue.m ?? "") === mFromName) return true;
      return false;
    });
    filtered = matches;
  }

  if (scheduleMeta) {
    const parts = [];
    if (projectName) parts.push(projectName);
    if (projectId) parts.push(`#${projectId}`);
    if (trackName) parts.push(`曲: ${trackName}`);
    scheduleMeta.textContent = parts.join(" / ");
  }

  const directorItems = flattenLogs(filtered, "directorLog");
  const commentItems = flattenLogs(filtered, "commentLog");
  renderScheduleLog(scheduleDirectorLog, directorItems, "監督FBはまだありません");
  renderScheduleLog(scheduleCommentLog, commentItems, "コメントはまだありません");

  const referenceItems = filtered
    .map((cue) => ({
      label: buildCueLabel(cue) || cue.id,
      value: cue.reference || "",
    }))
    .filter((item) => String(item.value || "").trim());
  if (referenceItems.length) {
    renderScheduleReference(referenceItems);
  } else {
    renderScheduleReference([], "参考曲はまだありません");
  }
}

function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}
function isEmailLike(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function baseUrl() {
  return import.meta.env.BASE_URL || "/";
}

function collectMemberEmails(map) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    Object.entries(node).forEach(([key, value]) => {
      if (value === true) {
        out.push([...prefix, key].join("."));
      } else if (value && typeof value === "object") {
        walk(value, [...prefix, key]);
      }
    });
  };
  walk(map, []);
  return [...new Set(out)];
}

function hasMemberEmail(map, email) {
  const target = normEmail(email);
  if (!target) return false;
  if (map && map[target] === true) return true;
  const list = collectMemberEmails(map);
  return list.some((value) => normEmail(value) === target);
}

function memberEmailField(email) {
  return new FieldPath("memberEmails", email);
}

function inviteDoc(projectId, email) {
  const key = normEmail(email);
  if (!key) return null;
  return doc(db, "projects", projectId, "invites", key);
}

async function ensureInvite(projectId, email, by, projectName) {
  const ref = inviteDoc(projectId, email);
  if (!ref) return;
  const byName = by || whoName();
  let exists = false;
  try {
    const snap = await getDoc(ref);
    exists = snap.exists();
  } catch (err) {
    console.warn("invite doc check failed", err);
  }
  let resolvedName = String(
    projectName || projectNameCache.get(projectId) || ""
  ).trim();
  if (!resolvedName) {
    try {
      const snap = await getDoc(doc(db, "projects", projectId));
      if (snap.exists()) {
        const data = snap.data() || {};
        resolvedName = String(data.name || data.projectName || data.title || "").trim();
      }
    } catch (err) {
      console.warn("project name fetch failed", err);
    }
  }
  try {
    const payload = {
      emailLower: normEmail(email),
      role: DEFAULT_MEMBER_ROLE,
      createdAt: serverTimestamp(),
      createdBy: byName,
      ...(exists ? {} : { usedBy: null, usedAt: null }),
    };
    if (resolvedName) payload.projectName = resolvedName;
    await setDoc(ref, payload, { merge: true });
  } catch (err) {
    console.warn("invite create failed", err);
  }
}

async function syncInviteIndexProjectName(projectId, name) {
  const resolvedName = String(name || "").trim();
  if (!resolvedName) return;
  try {
    const snap = await getDoc(doc(db, "projects", projectId));
    if (!snap.exists()) return;
    const data = snap.data() || {};
    const list = Array.isArray(data.memberEmailList) ? data.memberEmailList : [];
    const emails = mergeMemberEmails(data.memberEmails || {}, list);
    const byName = whoName();

    await Promise.all(
      emails.map((email) => {
        const ref = inviteDoc(projectId, email);
        if (!ref) return null;
        return updateDoc(ref, {
          projectName: resolvedName,
          updatedAt: serverTimestamp(),
          updatedBy: byName,
        }).catch(() => null);
      })
    );
  } catch (err) {
    console.warn("invite name sync failed", err);
  }
}

async function removeProjectFromInviteIndex(projectId, projectData) {
  try {
    const list = Array.isArray(projectData?.memberEmailList) ? projectData.memberEmailList : [];
    const emails = mergeMemberEmails(projectData?.memberEmails || {}, list);
    await Promise.all(
      emails.map((email) => {
        const ref = inviteDoc(projectId, email);
        if (!ref) return null;
        return deleteDoc(ref).catch(() => null);
      })
    );
  } catch (err) {
    console.warn("invite cleanup failed", err);
  }
}

function mergeMemberEmails(map, list) {
  const set = new Set(collectMemberEmails(map));
  if (Array.isArray(list)) {
    list.forEach((email) => {
      const norm = normEmail(email);
      if (norm) set.add(norm);
    });
  }
  return [...set];
}

async function syncInviteIndexMembers(projectId, emails, projectName) {
  if (!projectId || !Array.isArray(emails) || !emails.length) return;
  const cache = inviteSyncCache.get(projectId) || new Set();
  const next = new Set(cache);
  const byName = whoName();

  await Promise.all(
    emails.map((email) => {
      const norm = normEmail(email);
      if (!norm || next.has(norm)) return null;
      next.add(norm);
      return ensureInvite(projectId, norm, byName, projectName).catch((err) => {
        console.warn("invite sync failed", err);
      });
    })
  );

  inviteSyncCache.set(projectId, next);
}

async function joinProjectFromInvite(projectId, uid, emailLower, inviteId) {
  if (!projectId || !uid || !emailLower || !inviteId) return;
  const memberRef = doc(db, "projects", projectId, "members", uid);
  const inviteRef = doc(db, "projects", projectId, "invites", inviteId);
  try {
    const snap = await getDoc(memberRef);
    if (snap.exists()) return;
    const batch = writeBatch(db);
    batch.set(memberRef, {
      role: DEFAULT_MEMBER_ROLE,
      emailLower,
      joinedAt: serverTimestamp(),
      memberUid: uid,
      inviteId,
    });
    batch.update(inviteRef, {
      usedBy: uid,
      usedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) {
    console.warn("member join failed", err);
  }
}

let currentUser = null;
let initDone = false;
let memberUnsub = null;
let currentMemberProjectId = "";
const projectNameCache = new Map();
const inviteSyncCache = new Map();
let scheduleSelectionToken = 0;

mountNav({ current: "admin" });
mountThemeToggle();
window.addEventListener("themechange", () => setScheduleFrameAll());
renderScheduleLog(scheduleDirectorLog, [], "曲名をクリックすると表示されます");
renderScheduleLog(scheduleCommentLog, [], "曲名をクリックすると表示されます");
renderScheduleReference([], "曲名をクリックすると表示されます");
renderMeetingMemoEmpty("案件名をクリックすると表示されます");
updateScheduleSheetLink(null);

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SCHEDULE_TRACK_SELECT") {
    loadScheduleLogs(data).catch((err) => {
      console.error(err);
      renderScheduleLog(scheduleDirectorLog, [], "読み込みに失敗しました");
      renderScheduleLog(scheduleCommentLog, [], "読み込みに失敗しました");
      renderScheduleReference([], "読み込みに失敗しました");
    });
    return;
  }
  if (data.type === "SCHEDULE_PROJECT_SELECT") {
    const pid = data.projectId || "";
    listenLatestMeetingMemo(pid);
    updateScheduleSheetLink(pid, null);
  }
});

$("btnLogin")?.addEventListener("click", async () => {
  await signInWithPopup(auth, provider);
});
$("btnLogout")?.addEventListener("click", async () => {
  await signOut(auth);
});

function projectIdFromPath(path) {
  const parts = String(path).split("/");
  return parts[0] === "projects" ? parts[1] : "";
}

function setScheduleFrameAll(reloadToken) {
  const f = document.getElementById("adminScheduleFrame");
  const open = document.getElementById("openSchedule");
  if (!f || !open) return;

  const theme = getPreferredTheme();
  const stamp = reloadToken ? `&t=${encodeURIComponent(String(reloadToken))}` : "";
  const url = `${base}schedule-admin.html?theme=${theme}${stamp}`;
  f.src = url + "&embed=1";
  open.href = url;
}

function mountMemberManager(projectId) {
  if (memberUnsub) memberUnsub();
  currentMemberProjectId = projectId;

  const projectRef = doc(db, "projects", projectId);

  memberUnsub = onSnapshot(projectRef, (snap) => {
    if (!snap.exists()) {
      $m("ownerEmailView").textContent = "（未作成）";
      $m("memberList").innerHTML =
        `<div class="muted">プロジェクトドキュメントがありません。「初期化」を押して作ってね。</div>`;
      return;
    }

    const d = snap.data() || {};
    $m("ownerEmailView").textContent = d.ownerEmail || "—";

    const mem = d.memberEmails || {};
    const list = Array.isArray(d.memberEmailList) ? d.memberEmailList : [];
    const emails = mergeMemberEmails(mem, list).sort();
    syncInviteIndexMembers(projectId, emails, d.name || projectId).catch((err) => {
      console.warn("invite sync error", err);
    });
    const missing = emails.filter((email) => mem[email] !== true);
    const listMissing = emails.filter((email) => !list.includes(email));
    if ((missing.length || listMissing.length) && currentUser) {
      const updates = [];
      missing.forEach((email) => updates.push(memberEmailField(email), true));
      if (listMissing.length) updates.push("memberEmailList", emails);
      updates.push("updatedAt", serverTimestamp(), "updatedBy", whoName());
      updateDoc(projectRef, ...updates).catch((err) => {
        console.warn("memberEmails normalize failed", err);
      });
    }

    if (emails.length === 0) {
      $m("memberList").innerHTML = `<div class="muted">メンバーがまだいません</div>`;
      return;
    }

    $m("memberList").innerHTML = emails.map((email) => {
      const safe = email.replaceAll('"', "&quot;");
      return `
        <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid rgba(15,23,42,.10);border-radius:14px;padding:10px;">
          <div style="display:flex;gap:10px;align-items:center;min-width:0;">
            <span class="pill">${safe}</span>
          </div>
          <button class="smallBtn" data-act="removeMember" data-email="${safe}">削除</button>
        </div>
      `;
    }).join("");
  }, (err) => {
    console.error(err);
    memberMsg(`メンバー同期エラー: ${err.code || err.message}`);
  });

  $m("memberList").onclick = async (e) => {
    const btn = e.target?.closest("button[data-act='removeMember']");
    if (!btn) return;
    const email = normEmail(btn.dataset.email);
    if (!email) return;

    if (!confirm(`${email} をメンバーから削除する？`)) return;

    try {
      const ref = doc(db, "projects", projectId);
      await updateDoc(
        ref,
        memberEmailField(email),
        deleteField(),
        "memberEmailList",
        arrayRemove(email),
        "updatedAt",
        serverTimestamp(),
        "updatedBy",
        whoName()
      );
      try {
        await updateDoc(ref, { [`memberEmails.${email}`]: deleteField() });
      } catch (err) {
        console.warn("legacy memberEmails cleanup failed", err);
      }
      try {
        const inviteRef = inviteDoc(projectId, email);
        if (inviteRef) await deleteDoc(inviteRef);
      } catch (err) {
        console.warn("invite delete failed", err);
      }
      memberMsg("削除しました");
      setTimeout(() => memberMsg(""), 1000);
    } catch (err) {
      console.error(err);
      memberMsg(`削除失敗: ${err.code || err.message}`);
    }
  };
}

async function initProjectDocIfNeeded(projectId) {
  try {
    const ref = doc(db, "projects", projectId);
    const snap = await getDoc(ref);

    const myEmail = normEmail(currentUser?.email || "");
    const myUid = currentUser?.uid || "";
    if (!myEmail) {
      memberMsg("管理者メールが取れません");
      return;
    }

    if (!snap.exists()) {
      const byName = whoName();
      await setDoc(ref, {
        name: projectId,
        ownerEmail: myEmail,
        memberEmailList: [myEmail],
        createdAt: serverTimestamp(),
        createdBy: byName,
        updatedAt: serverTimestamp(),
        updatedBy: byName,
      }, { merge: true });
      await updateDoc(
        ref,
        memberEmailField(myEmail),
        true,
        "updatedAt",
        serverTimestamp(),
        "updatedBy",
        byName
      );
      await ensureInvite(projectId, myEmail, byName, projectId);
      await joinProjectFromInvite(projectId, myUid, myEmail, myEmail);
      memberMsg("プロジェクトdocを作成しました");
      setTimeout(() => memberMsg(""), 1200);
      return;
    }

    const d = snap.data() || {};
    const updates = [];
    if (!d.ownerEmail) updates.push("ownerEmail", myEmail);
    if (!d.memberEmails || !hasMemberEmail(d.memberEmails, myEmail)) {
      updates.push(memberEmailField(myEmail), true);
    }
    if (updates.length) {
      updates.push("updatedAt", serverTimestamp(), "updatedBy", whoName());
      if (!Array.isArray(d.memberEmailList) || !d.memberEmailList.includes(myEmail)) {
        updates.push("memberEmailList", arrayUnion(myEmail));
      }
      await updateDoc(ref, ...updates);
      await ensureInvite(projectId, myEmail, whoName(), d.name || projectId);
      await joinProjectFromInvite(projectId, myUid, myEmail, myEmail);
      memberMsg("初期化しました");
      setTimeout(() => memberMsg(""), 1200);
    } else {
      memberMsg("初期化は不要でした");
      setTimeout(() => memberMsg(""), 1200);
    }
  } catch (err) {
    console.error(err);
    memberMsg(`初期化失敗: ${err.code || err.message}`);
  }
}

async function addMember(projectId, emailRaw) {
  const email = normEmail(emailRaw);
  if (!isEmailLike(email)) {
    memberMsg("メール形式が不正です");
    return;
  }
  try {
    const ref = doc(db, "projects", projectId);
    await updateDoc(
      ref,
      memberEmailField(email),
      true,
      "memberEmailList",
      arrayUnion(email),
      "updatedAt",
      serverTimestamp(),
      "updatedBy",
      whoName()
    );
    await ensureInvite(projectId, email, undefined, projectNameCache.get(projectId));
    $m("memberEmailInput").value = "";
    memberMsg("追加しました");
    setTimeout(() => memberMsg(""), 1000);
  } catch (err) {
    console.error(err);
    memberMsg(`追加失敗: ${err.code || err.message}`);
  }
}

async function copyInvite(projectId) {
  const url = `${location.origin}${baseUrl()}index.html`;
  try {
    await navigator.clipboard.writeText(url);
    memberMsg("招待リンクをコピーしました");
    setTimeout(() => memberMsg(""), 1200);
  } catch {
    prompt("コピーできなかったので、これをコピーしてね", url);
  }
}

function renderProjectList(items) {
  const host = $("list");
  if (!host) return;
  const active = items.filter((p) => !p.deleted && !p.archived);
  const archived = items.filter((p) => !p.deleted && p.archived);
  const deleted = items.filter((p) => p.deleted);

  const renderSection = (title, list, showActions) => {
    if (!list.length) return "";
    const rows = list.map((p) => {
      const id = p.id;
      const name = p.name || id;
      const archiveLabel = p.archived ? "Unarchive" : "Archive";
      const archiveOn = p.archived ? "1" : "0";
      const actions = showActions
        ? `
          <div class="btns">
            <a class="btnLink" href="${base}portal.html?project=${id}">ポータル</a>
            <a class="btnLink" href="${base}sheet.html?project=${id}">Music Sheet</a>
            <details class="actionMenu">
              <summary class="smallBtn">設定</summary>
              <div class="actionMenuList">
                <button class="smallBtn" data-act="rename" data-id="${id}" data-name="${encodeURIComponent(name)}">名前変更</button>
                <button class="smallBtn" data-act="archive" data-id="${id}" data-on="${archiveOn}">${archiveLabel}</button>
                <button class="smallBtn danger" data-act="delete" data-id="${id}">消去</button>
              </div>
            </details>
          </div>
        `
        : "";
      return `
        <div class="listItem">
          <div>
            <div class="title">${name}</div>
            <div class="muted">id: ${id}</div>
          </div>
          ${actions}
        </div>
      `;
    }).join("");
    return `
      <div style="margin-top:10px;">
        <div class="muted" style="margin-bottom:6px;">${title}</div>
        <div class="list">${rows}</div>
      </div>
    `;
  };

  host.innerHTML =
    renderSection("プロジェクト", active, true) +
    renderSection("アーカイブ", archived, true) +
    renderSection("削除済み", deleted, false);
}

const list = $("list");
list?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;

  const act = b.dataset.act;
  const id = b.dataset.id;
  if (!id) return;

  if (!currentUser) {
    alert("ログインしてね");
    return;
  }

  const ref = doc(db, "projects", id);
  const by = whoName();

  try {
    if (act === "rename") {
      const raw = b.dataset.name || "";
      const currentName = raw ? decodeURIComponent(raw) : id;
      const next = prompt("新しいプロジェクト名を入力してください", currentName);
      if (next === null) return;
      const name = next.trim();
      if (!name) {
        alert("プロジェクト名を入力してください");
        return;
      }
      if (name === currentName) return;
      await updateDoc(ref, {
        name,
        updatedAt: serverTimestamp(),
        updatedBy: by,
      });
      await syncInviteIndexProjectName(id, name);
      return;
    }
    if (act === "archive") {
      const on = b.dataset.on === "1";
      await updateDoc(ref, {
        archived: !on,
        archivedAt: serverTimestamp(),
        archivedBy: by,
        updatedAt: serverTimestamp(),
        updatedBy: by,
      });
      return;
    }

    if (act === "delete") {
      let projectData = null;
      try {
        const snap = await getDoc(ref);
        projectData = snap.exists() ? snap.data() : null;
      } catch (err) {
        console.warn("project doc read failed", err);
      }

      const ok1 = confirm(
        "このプロジェクトを「消去（論理削除）」します。よろしいですか？\n※データは復元可能です"
      );
      if (!ok1) return;

      const phrase = prompt("最終確認：DELETE と入力してください");
      if (phrase !== "DELETE") return;

      await updateDoc(ref, {
        deleted: true,
        deletedAt: serverTimestamp(),
        deletedBy: by,
        updatedAt: serverTimestamp(),
        updatedBy: by,
      });
      if (projectData) {
        await removeProjectFromInviteIndex(id, projectData);
      }
      alert("消去（論理削除）しました。");
      return;
    }
  } catch (err) {
    console.error(err);
    alert(`操作失敗: ${err.code || err.message}`);
  }
});

async function initAdmin() {
  onSnapshot(collection(db, "projects"), (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));

    items.sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );

    projectNameCache.clear();
    items.forEach((item) => {
      if (item?.id) projectNameCache.set(item.id, item.name || "");
    });

    let latestAt = null;
    let latestBy = "";
    items.forEach((item) => {
      const at = item.updatedAt || item.createdAt || null;
      if (tsValue(at) > tsValue(latestAt)) {
        latestAt = at;
        latestBy = item.updatedBy || item.createdBy || "";
      }
    });
    projectUpdatedAt = latestAt;
    projectUpdatedBy = latestBy;
    updateHeaderUpdated();

    renderProjectList(items);
  });

  onSnapshot(collectionGroup(db, "scheduleBoard"), (snap) => {
    let latestAt = null;
    let latestBy = "";
    snap.forEach((d) => {
      const data = d.data() || {};
      const at = data.updatedAt || null;
      if (tsValue(at) > tsValue(latestAt)) {
        latestAt = at;
        latestBy = data.updatedBy || "";
      }
    });
    const prevAt = scheduleUpdatedAt;
    scheduleUpdatedAt = latestAt;
    scheduleUpdatedBy = latestBy;
    updateHeaderUpdated();
  });

  setScheduleFrameAll();

  // ===== メンバー管理UI wiring =====
  const memberPicker = $m("memberProjectPicker");

  onSnapshot(collection(db, "projects"), (snap) => {
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));
    items.sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );

    if (memberPicker) {
      memberPicker.innerHTML = items
        .map((p) => `<option value="${p.id}">${p.name || p.id}</option>`)
        .join("");

      const saved = localStorage.getItem("lastProject");
      const pick = items.find((x) => x.id === saved) ? saved : (items[0]?.id || "");
      if (pick) {
        memberPicker.value = pick;
        localStorage.setItem("lastProject", pick);
        mountMemberManager(pick);
      }
    }
  });

  memberPicker?.addEventListener("change", () => {
    const pid = memberPicker.value;
    localStorage.setItem("lastProject", pid);
    mountMemberManager(pid);
  });

  $m("btnInitProjectDoc")?.addEventListener("click", () => {
    const pid = $m("memberProjectPicker").value;
    initProjectDocIfNeeded(pid);
  });

  $m("btnAddMember")?.addEventListener("click", () => {
    const pid = $m("memberProjectPicker").value;
    addMember(pid, $m("memberEmailInput").value);
  });

  $m("memberEmailInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $m("btnAddMember")?.click();
    }
  });

  $m("btnCopyInvite")?.addEventListener("click", () => {
    const pid = $m("memberProjectPicker").value;
    copyInvite(pid);
  });
}

onAuthStateChanged(auth, async (user) => {
  await upsertUserProfile(user);
  currentUser = user;

  if (!isAdmin(user)) {
    alert("このページは管理者専用です。");
    if (user) await signOut(auth);
    location.replace(base + "index.html");
    return;
  }

  $("userPill").textContent = user.displayName || user.email || user.uid;
  $("btnLogin").style.display = "none";
  $("btnLogout").style.display = "inline-block";

  if (!initDone) {
    initDone = true;
    initAdmin();
  }
});

$("btnCreate")?.addEventListener("click", async () => {
  if (!currentUser) {
    msg("ログインしてね");
    return;
  }
  const ownerEmail = normEmail(currentUser?.email || "");
  if (!ownerEmail) {
    msg("Owner email is required.");
    return;
  }
  const name = $("newName").value.trim();
  const byName = whoName();
  if (!name) {
    msg("プロジェクト名を入れてね");
    return;
  }

  try {
    const docRef = await addDoc(collection(db, "projects"), {
      name,
      ownerEmail,
      memberEmailList: [ownerEmail],
      createdAt: serverTimestamp(),
      createdBy: byName,
      updatedAt: serverTimestamp(),
      updatedBy: byName,
      members: currentUser?.uid ? [currentUser.uid] : [],
      roleByUid: currentUser?.uid ? { [currentUser.uid]: "owner" } : {},
    });

    try {
      await updateDoc(docRef, memberEmailField(ownerEmail), true);
    } catch (err) {
      console.warn("memberEmails owner set failed", err);
    }
    await ensureInvite(docRef.id, ownerEmail, byName, name);
    await joinProjectFromInvite(docRef.id, currentUser?.uid || "", ownerEmail, ownerEmail);
    msg(`作成しました: ${docRef.id}`);
  } catch (err) {
    console.error(err);
    msg(`作成失敗: ${err?.code || err?.message || err}`);
  }
});
