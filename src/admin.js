// src/admin.js
import "./style.css";
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";

import { db, createProject } from "./firebase";
import { mountTopbar, getPreferredTheme } from "./ui_common";
import { mountNav } from "./nav";

const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const base = import.meta.env.BASE_URL || "/";

function isAdminUser(user) {
  return !!user?.email && ADMIN_EMAILS.includes(user.email);
}

/**
 * ✅ New data model
 * projects/{projectId}: { name, ownerUid, ... }
 * projects/{projectId}/members/{uid}: { uid, role, email, displayName, ... }
 * projects/{projectId}/invites/{inviteId}: { emailLower, role, usedBy, usedAt, ... }
 */

const $ = (id) => document.getElementById(id);

const el = {
  msg: $("msg"),
  projectSelect: $("memberProjectPicker"),
  btnCreate: $("btnCreate"),
  btnInitProjectDoc: $("btnInitProjectDoc"),
  ownerEmailView: $("ownerEmailView"),
  memberEmailInput: $("memberEmailInput"),
  btnAddMember: $("btnAddMember"),
  btnCopyInvite: $("btnCopyInvite"),
  memberList: $("memberList"),

  // schedule embed + selection UI
  scheduleFrame: $("adminScheduleFrame"),
  openSchedule: $("openSchedule"),
  selTitle: $("scheduleSelectionTitle"),
  selMeta: $("scheduleSelectionMeta"),
  toSheet: $("scheduleToSheet"),
  directorLogBox: $("scheduleDirectorLog"),
  writerLogBox: $("scheduleWriterLog"),
  meetingTitle: $("scheduleMeetingTitle"),
  meetingMeta: $("scheduleMeetingMeta"),
  meetingLogBox: $("scheduleMeetingLog"),
};

let currentUser = null;
let currentProjectId = null;
let lastInviteText = "";

let unsubProject = null;
let unsubMembers = null;

/* ---------------- UI helpers ---------------- */
function msg(text = "") {
  if (el.msg) el.msg.textContent = text;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTs(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (!d) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    msg("コピーしました");
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    msg("コピーしました");
  }
}

function normEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

function inviteIdFromEmail(emailLower) {
  // base64url(emailLower) で docId を安定化（"/"を避ける）
  const b64 = btoa(unescape(encodeURIComponent(emailLower)));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function resetScheduleSelection() {
  if (el.selTitle) el.selTitle.textContent = "（スケジュールでトラックを選択すると表示されます）";
  if (el.selMeta) el.selMeta.textContent = "";
  if (el.toSheet) el.toSheet.href = "sheet.html";
  if (el.directorLogBox) el.directorLogBox.innerHTML = "<div class='muted'>—</div>";
  if (el.writerLogBox) el.writerLogBox.innerHTML = "<div class='muted'>—</div>";

  if (el.meetingTitle) el.meetingTitle.textContent = "最新の打合せメモ";
  if (el.meetingMeta) el.meetingMeta.textContent = "";
  if (el.meetingLogBox) el.meetingLogBox.innerHTML = "<div class='muted'>—</div>";
}

function getScheduleTheme() {
  return document.documentElement.dataset.theme || getPreferredTheme();
}

function postScheduleTheme(theme) {
  if (el.scheduleFrame?.contentWindow) {
    el.scheduleFrame.contentWindow.postMessage({ type: "SET_THEME", theme }, "*");
  }
}

function buildScheduleUrl(embed) {
  const theme = getScheduleTheme();
  const url = new URL(`${base}schedule-admin.html`, location.href);
  if (embed) url.searchParams.set("embed", "1");
  url.searchParams.set("theme", theme);
  return url.pathname + url.search;
}

function syncScheduleLinks({ reloadFrame = false } = {}) {
  if (el.scheduleFrame) {
    if (reloadFrame) {
      el.scheduleFrame.src = buildScheduleUrl(true);
    } else {
      postScheduleTheme(getScheduleTheme());
    }
  }
  if (el.openSchedule) {
    el.openSchedule.href = buildScheduleUrl(false);
  }
}

/* ---------------- Project list ---------------- */
async function fetchAccessibleProjectIds(uid) {
  if (!uid) return [];
  const q = query(collectionGroup(db, "members"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const ids = [];
  snap.forEach((d) => {
    const pid = d.ref.parent.parent?.id;
    if (pid) ids.push(pid);
  });
  return [...new Set(ids)];
}

async function loadProjectsAndMountPicker() {
  if (!currentUser) return;

  msg("プロジェクト読み込み中…");

  const ids = await fetchAccessibleProjectIds(currentUser.uid);

  // project doc を個別に読む（rulesで list を許可してなくてもOK）
  const projects = [];
  for (const pid of ids) {
    try {
      const ps = await getDoc(doc(db, "projects", pid));
      if (ps.exists()) {
        const data = ps.data();
        projects.push({
          id: pid,
          name: data?.name || "(no name)",
          ownerUid: data?.ownerUid || "",
          updatedAt: data?.updatedAt || data?.createdAt || null,
        });
      }
    } catch (e) {
      console.warn("project read failed:", pid, e);
    }
  }

  // 新しい順
  projects.sort((a, b) => {
    const ta = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
    const tb = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
    return tb - ta;
  });

  if (el.projectSelect) {
    el.projectSelect.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "（プロジェクトを選択）";
    el.projectSelect.appendChild(opt0);

    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      el.projectSelect.appendChild(opt);
    }
  }

  // lastProject を復元
  const last = localStorage.getItem("lastProject") || "";
  const preferred = (last && projects.find((p) => p.id === last)) ? last : (projects[0]?.id || "");
  if (preferred) {
    if (el.projectSelect) el.projectSelect.value = preferred;
    await setProject(preferred, { from: "picker" });
  } else {
    msg("プロジェクトがまだありません。右上から新規作成してください。");
  }
}

/* ---------------- Project selection ---------------- */
async function setProject(projectId, { from = "code" } = {}) {
  if (!projectId) return;

  if (currentProjectId === projectId && from !== "iframe") return;

  currentProjectId = projectId;
  localStorage.setItem("lastProject", projectId);

  if (el.projectSelect && el.projectSelect.value !== projectId) {
    el.projectSelect.value = projectId;
  }

  try { unsubProject?.(); } catch { }
  try { unsubMembers?.(); } catch { }
  unsubProject = null;
  unsubMembers = null;

  resetScheduleSelection();

  // プロジェクト情報
  const pref = doc(db, "projects", projectId);
  unsubProject = onSnapshot(
    pref,
    async (snap) => {
      if (!snap.exists()) {
        msg("このプロジェクトは存在しないか、権限がありません。");
        return;
      }
      const p = snap.data() || {};
      msg("");

      // owner 表示（ownerUid + 可能なら email/displayName）
      if (el.ownerEmailView) {
        let ownerText = p.ownerUid ? `ownerUid: ${p.ownerUid}` : "";
        if (p.ownerUid) {
          try {
            const ms = await getDoc(doc(db, "projects", projectId, "members", p.ownerUid));
            if (ms.exists()) {
              const md = ms.data();
              const label = [md?.displayName, md?.email].filter(Boolean).join(" / ");
              if (label) ownerText += ` (${label})`;
            }
          } catch { }
        }
        el.ownerEmailView.value = ownerText || "(unknown)";
      }
    },
    (err) => {
      console.error(err);
      msg(`プロジェクト読込失敗: ${err.code || err.message}`);
    }
  );

  // メンバー一覧
  const membersCol = collection(db, "projects", projectId, "members");
  unsubMembers = onSnapshot(
    membersCol,
    (snap) => {
      const items = [];
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));

      // owner を先頭に
      items.sort((a, b) => {
        const ra = a.role === "owner" ? 0 : 1;
        const rb = b.role === "owner" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return String(a.email || "").localeCompare(String(b.email || ""));
      });

      if (el.memberList) {
        if (!items.length) {
          el.memberList.innerHTML = "<div class='muted'>メンバーがいません</div>";
        } else {
          el.memberList.innerHTML = items
            .map((m) => {
              const title = escapeHtml(m.displayName || "");
              const email = escapeHtml(m.email || "");
              const role = escapeHtml(m.role || "member");
              const uid = escapeHtml(m.uid || m.id || "");
              const canRemove =
                currentUser &&
                m.id !== currentUser.uid &&
                role !== "owner";

              return `
                <div class="card" style="padding:10px; margin:8px 0;">
                  <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                    <div style="min-width:0;">
                      <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${title || email || uid}
                      </div>
                      <div class="muted" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                        ${email ? email + " · " : ""}${uid} · ${role}
                      </div>
                    </div>
                    ${canRemove
                  ? `<button class="btn small" data-act="rm-member" data-uid="${escapeHtml(m.id)}">削除</button>`
                  : ""
                }
                  </div>
                </div>
              `;
            })
            .join("");

          el.memberList.querySelectorAll('[data-act="rm-member"]').forEach((btn) => {
            btn.onclick = async () => {
              const uid = btn.getAttribute("data-uid");
              if (!uid || !currentProjectId) return;
              const ok = confirm("このメンバーを削除しますか？");
              if (!ok) return;
              try {
                await deleteDoc(doc(db, "projects", currentProjectId, "members", uid));
                msg("メンバーを削除しました");
              } catch (e) {
                console.error(e);
                msg(`削除失敗: ${e.code || e.message}`);
              }
            };
          });
        }
      }
    },
    (err) => {
      console.error(err);
      msg(`メンバー読込失敗: ${err.code || err.message}`);
    }
  );

  // 最新打合せメモ
  listenLatestMeetingMemo(projectId);

  // schedule iframe 同期（schedule-admin.html は lastProject を見てる）
  if (from === "picker" && el.scheduleFrame) {
    const url = new URL(el.scheduleFrame.src, location.href);
    url.searchParams.set("_ts", String(Date.now()));
    el.scheduleFrame.src = url.pathname + url.search;
  }
}

/* ---------------- Invites (by email) ---------------- */
async function createInviteForEmail(projectId, emailLower) {
  const inviteId = inviteIdFromEmail(emailLower);
  const ref = doc(db, "projects", projectId, "invites", inviteId);

  await setDoc(
    ref,
    {
      emailLower,
      role: "member",
      projectName: "",
      usedBy: null,
      usedAt: null,
      createdAt: serverTimestamp(),
      createdBy: currentUser?.uid || null,
    },
    { merge: true }
  );

  const baseUrl = `${location.origin}${location.pathname.replace(/\/[^/]*$/, "/")}index.html`;
  lastInviteText = `MusicSheet に招待しました！\n1) このURLを開く: ${baseUrl}\n2) 招待されたGoogleアカウントでログイン\n3) 「招待されているプロジェクト」に表示されたら参加\n\n招待先: ${emailLower}`;
  return inviteId;
}

/* ---------------- Schedule selection (from iframe) ---------------- */
function renderLogBox(boxEl, logs) {
  if (!boxEl) return;
  if (!Array.isArray(logs) || logs.length === 0) {
    boxEl.innerHTML = "<div class='muted'>—</div>";
    return;
  }
  boxEl.innerHTML = logs
    .slice(-20)
    .reverse()
    .map((x) => {
      const at = fmtTs(x?.at);
      const by = escapeHtml(x?.by || "");
      const text = escapeHtml(x?.text || "");
      return `
        <div style="padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08);">
          <div class="muted" style="font-size:12px;">${at}${by ? " · " + by : ""}</div>
          <div style="white-space:pre-wrap;">${text || "（空）"}</div>
        </div>
      `;
    })
    .join("");
}

async function loadScheduleLogs(projectId, cueId) {
  if (!projectId || !cueId) return;
  try {
    const cueSnap = await getDoc(doc(db, "projects", projectId, "cues", cueId));
    const cue = cueSnap.exists() ? cueSnap.data() : null;
    const directorLogs = cue?.directorLog || cue?.commentLog || [];
    const writerLogs = cue?.writerLog || [];

    renderLogBox(el.directorLogBox, directorLogs);
    renderLogBox(el.writerLogBox, writerLogs);
  } catch (e) {
    console.error(e);
    if (el.directorLogBox) el.directorLogBox.innerHTML = "<div class='muted'>読み込み失敗</div>";
    if (el.writerLogBox) el.writerLogBox.innerHTML = "<div class='muted'>読み込み失敗</div>";
  }
}

let unsubMeeting = null;
function listenLatestMeetingMemo(projectId) {
  try { unsubMeeting?.(); } catch { }
  unsubMeeting = null;

  if (!projectId) return;
  const col = collection(db, "projects", projectId, "portalLogs");
  const q = query(col, orderBy("createdAt", "desc"), limit(1));
  unsubMeeting = onSnapshot(
    q,
    (snap) => {
      if (!el.meetingLogBox || !el.meetingMeta || !el.meetingTitle) return;

      if (snap.empty) {
        el.meetingTitle.textContent = "最新の打合せメモ";
        el.meetingMeta.textContent = "";
        el.meetingLogBox.innerHTML = "<div class='muted'>—</div>";
        return;
      }

      const d = snap.docs[0].data() || {};
      const title = d.title || "最新の打合せメモ";
      const at = fmtTs(d.createdAt);
      const by = d.createdByName || d.createdBy || "";
      const memo = d.memo || "";

      el.meetingTitle.textContent = title;
      el.meetingMeta.textContent = `${at}${by ? " · " + by : ""}`;
      el.meetingLogBox.innerHTML = `<div style="white-space:pre-wrap; padding:10px;">${escapeHtml(memo)}</div>`;
    },
    (err) => {
      console.error(err);
    }
  );
}

/* ---------------- Boot ---------------- */
(async function boot() {
  // 旧仕様の残骸なので隠す
  if (el.btnInitProjectDoc) el.btnInitProjectDoc.style.display = "none";

  currentUser = await mountTopbar();
  if (!currentUser) {
    msg("ログインしてください");
    return;
  }
  mountNav({ current: "account", hideAdmin: !isAdminUser(currentUser) });
  syncScheduleLinks({ reloadFrame: true });
  el.scheduleFrame?.addEventListener("load", () => postScheduleTheme(getScheduleTheme()));
  window.addEventListener("themechange", () => syncScheduleLinks());

  // 新規プロジェクト
  if (el.btnCreate) {
    el.btnCreate.onclick = async () => {
      const name = prompt("新規プロジェクト名を入力してください");
      if (!name || !name.trim()) return;

      el.btnCreate.disabled = true;
      msg("作成中…");
      try {
        const pid = await createProject({ name, user: currentUser });
        msg("プロジェクトを作成しました");
        await loadProjectsAndMountPicker();
        if (el.projectSelect) el.projectSelect.value = pid;
        await setProject(pid, { from: "picker" });
      } catch (e) {
        console.error(e);
        if (e?.code === "plan-limit") {
          msg("無料プランではプロジェクトは2件までです。");
        } else {
          msg(`作成失敗: ${e.code || e.message}`);
        }
      } finally {
        el.btnCreate.disabled = false;
      }
    };
  }

  // プロジェクト切替
  if (el.projectSelect) {
    el.projectSelect.onchange = async () => {
      const pid = el.projectSelect.value;
      if (!pid) return;
      await setProject(pid, { from: "picker" });
    };
  }

  // メンバー招待（invite作成）
  if (el.btnAddMember) {
    el.btnAddMember.onclick = async () => {
      if (!currentProjectId) {
        msg("先にプロジェクトを選択してください");
        return;
      }
      const emailLower = normEmail(el.memberEmailInput?.value || "");
      if (!emailLower) {
        msg("招待したいメールアドレスを入力してください");
        return;
      }

      el.btnAddMember.disabled = true;
      msg("招待を作成中…");
      try {
        await createInviteForEmail(currentProjectId, emailLower);
        msg("招待を作成しました（右のボタンで案内文をコピーできます）");
        if (el.memberEmailInput) el.memberEmailInput.value = "";
      } catch (e) {
        console.error(e);
        msg(`招待作成失敗: ${e.code || e.message}`);
      } finally {
        el.btnAddMember.disabled = false;
      }
    };
  }

  // 案内文コピー
  if (el.btnCopyInvite) {
    el.btnCopyInvite.onclick = async () => {
      if (!lastInviteText) {
        msg("先に招待を作成してください");
        return;
      }
      await copyToClipboard(lastInviteText);
    };
  }

  // iframe → 親 への通知
  window.addEventListener("message", async (ev) => {
    const d = ev?.data;
    if (!d || typeof d !== "object") return;

    if (d.type === "SCHEDULE_PROJECT_SELECT") {
      const pid = d.projectId;
      if (pid) await setProject(pid, { from: "iframe" });
      return;
    }

    if (d.type === "SCHEDULE_TRACK_SELECT") {
      const projectId = d.projectId || currentProjectId;
      const cueId = d.cueId || "";
      const trackName = d.trackName || "(no title)";

      if (el.selTitle) el.selTitle.textContent = trackName;
      if (el.selMeta) el.selMeta.textContent = `cueId: ${cueId}${d.trackId ? ` · trackId: ${d.trackId}` : ""}`;
      if (el.toSheet) el.toSheet.href = projectId ? `sheet.html?project=${encodeURIComponent(projectId)}` : "sheet.html";

      if (projectId && cueId) {
        await loadScheduleLogs(projectId, cueId);
      } else {
        renderLogBox(el.directorLogBox, []);
        renderLogBox(el.writerLogBox, []);
      }
    }
  });

  await loadProjectsAndMountPicker();
})();
