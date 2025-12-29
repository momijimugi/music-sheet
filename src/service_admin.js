import "./style.css";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  limit,
} from "firebase/firestore";
import { db } from "./firebase";
import { mountTopbar } from "./ui_common";
import { mountNav } from "./nav";

const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const JP = {
  loginRequired: "\u30ED\u30B0\u30A4\u30F3\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  notAdmin: "\u7BA1\u7406\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093\u3002",
  loading: "\u8AAD\u307F\u8FBC\u307F\u4E2D...",
  loadFail: "\u30E6\u30FC\u30B6\u30FC\u306E\u8AAD\u307F\u8FBC\u307F\u306B\u5931\u6557\u3057\u307E\u3057\u305F: ",
  updated: "\u66F4\u65B0\u3057\u307E\u3057\u305F",
  banned: "\u5229\u7528\u505C\u6B62",
  active: "\u6709\u52B9",
};

const $ = (id) => document.getElementById(id);
const el = {
  msg: $("adminMsg"),
  userFilter: $("userFilter"),
  userList: $("userList"),
  activeStats: $("activeStats"),
  activeList: $("activeList"),
  btnReloadUsers: $("btnReloadUsers"),
};

const PLAN_OPTIONS = ["free", "pro", "studio"];
const SUB_OPTIONS = ["inactive", "active", "past_due", "canceled"];

let currentUser = null;
let allUsers = [];

const setMsg = (text) => {
  if (el.msg) el.msg.textContent = text || "";
};

const isAdminUser = (user) =>
  !!user?.email && ADMIN_EMAILS.includes(user.email);

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const fmtTs = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const normalize = (value) => String(value || "").trim().toLowerCase();

function buildSelect(options, value, dataAct) {
  const safeValue = String(value || "");
  const items = options
    .map((opt) => {
      const selected = opt === safeValue ? " selected" : "";
      return `<option value="${escapeHtml(opt)}"${selected}>${escapeHtml(opt)}</option>`;
    })
    .join("");
  return `<select data-act="${dataAct}" class="select small">${items}</select>`;
}

function statusTag(status) {
  const label = status === "banned" ? JP.banned : JP.active;
  const cls = status === "banned" ? "svcTag danger" : "svcTag ok";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function renderUsers(list) {
  if (!el.userList) return;
  if (!list.length) {
    el.userList.innerHTML = `<div class="muted">No users</div>`;
    return;
  }

  el.userList.innerHTML = list
    .map((user) => {
      const uid = user.uid || "";
      const email = user.email || user.emailNorm || "";
      const name = user.displayName || user.name || "";
      const label = [name, email].filter(Boolean).join(" / ") || uid;
      const status = user.status || "active";
      const plan = user.plan || "free";
      const sub = user.subscriptionStatus || "inactive";
      const lastSeen = fmtTs(user.lastSeenAt);
      const banLabel = status === "banned" ? "Unban" : "Ban";

      return `
        <div class="svcAdminRow" data-uid="${escapeHtml(uid)}">
          <div class="svcAdminRowHeader">
            <div>
              <div class="svcAdminName">${escapeHtml(label)}</div>
              <div class="svcAdminMeta">uid: ${escapeHtml(uid)}${lastSeen ? ` / lastSeen: ${escapeHtml(lastSeen)}` : ""}</div>
            </div>
            <div class="svcAdminTags">
              ${statusTag(status)}
              <span class="svcTag">${escapeHtml(plan)}</span>
              <span class="svcTag">${escapeHtml(sub)}</span>
            </div>
          </div>
          <div class="svcAdminControls">
            <label class="svcLabel">Plan ${buildSelect(PLAN_OPTIONS, plan, "plan")}</label>
            <label class="svcLabel">Subscription ${buildSelect(SUB_OPTIONS, sub, "sub")}</label>
            <button class="ghost" type="button" data-act="toggle-ban">${banLabel}</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderActive(list) {
  if (!el.activeStats || !el.activeList) return;
  const activeUsers = list.filter((u) => (u.status || "active") !== "banned");
  const bannedUsers = list.filter((u) => (u.status || "active") === "banned");
  el.activeStats.textContent = `total: ${list.length} / active: ${activeUsers.length} / banned: ${bannedUsers.length}`;

  if (!activeUsers.length) {
    el.activeList.innerHTML = `<div class="muted">No active users</div>`;
    return;
  }

  el.activeList.innerHTML = activeUsers
    .map((u) => {
      const email = u.email || u.emailNorm || "";
      const name = u.displayName || u.name || "";
      const label = [name, email].filter(Boolean).join(" / ");
      const lastSeen = fmtTs(u.lastSeenAt);
      return `<div class="svcAdminActiveItem">${escapeHtml(label || u.uid)}${lastSeen ? ` <span class="muted">(${escapeHtml(lastSeen)})</span>` : ""}</div>`;
    })
    .join("");
}

function applyFilter() {
  const q = normalize(el.userFilter?.value || "");
  if (!q) {
    renderUsers(allUsers);
    renderActive(allUsers);
    return;
  }

  const filtered = allUsers.filter((u) => {
    const hay = [
      u.email,
      u.emailNorm,
      u.displayName,
      u.name,
      u.uid,
      u.plan,
      u.subscriptionStatus,
      u.status,
    ]
      .map((v) => normalize(v))
      .join(" ");
    return hay.includes(q);
  });

  renderUsers(filtered);
  renderActive(filtered);
}

async function loadUsers() {
  if (!currentUser) return;
  setMsg(JP.loading);
  try {
    const q = query(collection(db, "users"), orderBy("lastSeenAt", "desc"), limit(300));
    const snap = await getDocs(q);
    const list = snap.docs.map((docSnap) => ({ uid: docSnap.id, ...docSnap.data() }));
    allUsers = list;
    setMsg("");
    applyFilter();
  } catch (err) {
    console.error(err);
    setMsg(JP.loadFail + (err?.code || err?.message || "unknown"));
  }
}

async function updateUser(uid, patch) {
  if (!uid) return;
  await updateDoc(doc(db, "users", uid), {
    ...patch,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.uid || "",
  });
}

if (el.userList) {
  el.userList.addEventListener("change", async (e) => {
    const target = e.target;
    const row = target?.closest?.(".svcAdminRow");
    const uid = row?.dataset?.uid || "";
    if (!uid) return;

    if (target.matches("select[data-act='plan']")) {
      await updateUser(uid, { plan: target.value });
      const idx = allUsers.findIndex((u) => u.uid === uid);
      if (idx >= 0) allUsers[idx] = { ...allUsers[idx], plan: target.value };
      applyFilter();
    }

    if (target.matches("select[data-act='sub']")) {
      await updateUser(uid, { subscriptionStatus: target.value });
      const idx = allUsers.findIndex((u) => u.uid === uid);
      if (idx >= 0) allUsers[idx] = { ...allUsers[idx], subscriptionStatus: target.value };
      applyFilter();
    }
  });

  el.userList.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-act='toggle-ban']");
    if (!btn) return;
    const row = btn.closest(".svcAdminRow");
    const uid = row?.dataset?.uid || "";
    if (!uid) return;

    const idx = allUsers.findIndex((u) => u.uid === uid);
    const current = idx >= 0 ? allUsers[idx] : {};
    const isBanned = (current.status || "active") === "banned";
    const nextStatus = isBanned ? "active" : "banned";

    btn.disabled = true;
    try {
      await updateUser(uid, {
        status: nextStatus,
        bannedAt: nextStatus === "banned" ? serverTimestamp() : null,
        bannedBy: nextStatus === "banned" ? currentUser?.uid || "" : null,
      });
      if (idx >= 0) {
        allUsers[idx] = { ...allUsers[idx], status: nextStatus };
      }
      applyFilter();
      setMsg(JP.updated);
      setTimeout(() => setMsg(""), 1200);
    } catch (err) {
      console.error(err);
      setMsg(JP.loadFail + (err?.code || err?.message || "unknown"));
    } finally {
      btn.disabled = false;
    }
  });
}

if (el.userFilter) {
  el.userFilter.addEventListener("input", applyFilter);
}

el.btnReloadUsers?.addEventListener("click", () => loadUsers());

(async function boot() {
  currentUser = await mountTopbar();
  mountNav({ current: "admin", hideAdmin: !isAdminUser(currentUser) });
  if (!currentUser) {
    setMsg(JP.loginRequired);
    return;
  }

  if (!isAdminUser(currentUser)) {
    setMsg(JP.notAdmin);
    return;
  }
  await loadUsers();
})();
