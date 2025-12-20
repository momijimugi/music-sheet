import { doc, getDoc, getDocs, collection, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";
import { mountTopbar, getParams } from "./ui_common";
import { mountNav } from "./nav";

const me = await mountTopbar();

const base = import.meta.env.BASE_URL || "/";
const guestUrl = `${base}index.html`;
const { project } = getParams();
if (!project) {
  location.replace(guestUrl);
  throw new Error("missing project");
}

const projectPill = document.getElementById("projectNamePill");
const projectSwitcher = document.getElementById("projectSwitcher");
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminUser(user) {
  return !!user?.email && ADMIN_EMAILS.includes(user.email);
}
let inviteIndexCache = null;
async function loadInviteIndex(){
  if (inviteIndexCache) return inviteIndexCache;
  const empty = { ids: new Set(), names: {} };
  if (isAdminUser(me)) {
    inviteIndexCache = empty;
    return empty;
  }
  const email = String(me?.email || "").trim().toLowerCase();
  if (!email) {
    inviteIndexCache = empty;
    return empty;
  }
  try {
    const snap = await getDoc(doc(db, "inviteIndex", email));
    const data = snap?.data() || {};
    const list = Array.isArray(data.projects) ? data.projects : [];
    const names = data.projectNames && typeof data.projectNames === "object"
      ? data.projectNames
      : {};
    inviteIndexCache = { ids: new Set(list.filter(Boolean)), names };
    return inviteIndexCache;
  } catch (err) {
    console.warn("invite index load failed", err);
    inviteIndexCache = empty;
    return empty;
  }
}
function normEmail(value) {
  return String(value || "").trim().toLowerCase();
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
  return out;
}
function hasMemberEmail(map, email) {
  const target = normEmail(email);
  if (!target) return false;
  if (map && map[target] === true) return true;
  const list = collectMemberEmails(map);
  return list.some((value) => normEmail(value) === target);
}
function hasMemberEmailList(list, email) {
  const target = normEmail(email);
  if (!target || !Array.isArray(list)) return false;
  return list.some((value) => normEmail(value) === target);
}
function canAccessProject(user, data) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  const email = normEmail(user?.email);
  if (email && normEmail(data?.ownerEmail) === email) return true;
  if (email && hasMemberEmail(data?.memberEmails, email)) return true;
  if (email && hasMemberEmailList(data?.memberEmailList, email)) return true;
  const uid = user?.uid;
  if (uid && Array.isArray(data?.members) && data.members.includes(uid)) return true;
  if (uid && data?.roleByUid && data.roleByUid[uid]) return true;
  return false;
}

async function initProjectSwitcher() {
  if (!projectSwitcher) return false;
  if (!me) {
    projectSwitcher.style.display = "none";
    return false;
  }
  try {
    const invitedIds = new Set();
    let items = [];
    if (isAdminUser(me)) {
      const snap = await getDocs(collection(db, "projects"));
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));
    } else {
      const map = new Map();
      const inviteInfo = await loadInviteIndex();
      const projectIds = [...inviteInfo.ids];
      if (projectIds.length) {
        const docs = await Promise.all(
          projectIds.map((pid) => getDoc(doc(db, "projects", pid)).catch(() => null))
        );
        docs.forEach((snap, idx) => {
          const pid = projectIds[idx];
          invitedIds.add(pid);
          if (snap?.exists()) {
            map.set(pid, { id: pid, ...(snap.data() || {}) });
          } else {
            const fallback = String(inviteInfo.names?.[pid] || "").trim();
            map.set(pid, { id: pid, name: fallback || pid });
          }
        });
      }
      items = [...map.values()];
    }
    const allowed = items.filter((item) =>
      !item.deleted && (canAccessProject(me, item) || invitedIds.has(item.id))
    );
    allowed.sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id))
    );
    if (!allowed.length) {
      projectSwitcher.style.display = "none";
      return false;
    }
    projectSwitcher.innerHTML = "";
    allowed.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name || item.id;
      projectSwitcher.appendChild(opt);
    });

    const current = allowed.find((item) => item.id === project);
    const active = current || allowed[0];
    if (active?.id) {
      projectSwitcher.value = active.id;
      if (projectPill) projectPill.textContent = active.name || active.id;
      if (!current) {
        location.replace(`${base}sheet.html?project=${encodeURIComponent(active.id)}`);
        return true;
      }
    }
    projectSwitcher.style.display = allowed.length > 1 ? "inline-flex" : "none";
  } catch (err) {
    console.error(err);
    projectSwitcher.style.display = "none";
  }
  return false;
}

projectSwitcher?.addEventListener("change", () => {
  const next = projectSwitcher.value;
  if (!next || next === project) return;
  localStorage.setItem("lastProject", next);
  location.href = `${base}sheet.html?project=${encodeURIComponent(next)}`;
});
const projectRef = doc(db, "projects", project);
async function ensureMemberDoc() {
  if (isAdminUser(me)) return true;
  if (!me?.uid) return false;
  const memberRef = doc(db, "projects", project, "members", me.uid);
  try {
    const snap = await getDoc(memberRef);
    if (!snap.exists()) {
      await setDoc(memberRef, {
        email: me?.email || "",
        joinedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (err) {
    console.warn("member doc ensure failed", err);
    return false;
  }
}
let pSnap = null;
let inviteInfo = null;
let fallbackName = "";
const memberReady = await ensureMemberDoc();
if (!memberReady) {
  console.warn("member doc not ready");
}
try {
  pSnap = await getDoc(projectRef);
} catch (err) {
  if (err?.code === "permission-denied") {
    inviteInfo = await loadInviteIndex();
    if (inviteInfo?.ids?.has(project)) {
      fallbackName = String(inviteInfo.names?.[project] || project).trim();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        pSnap = await getDoc(projectRef);
      } catch (retryErr) {
        console.warn("project doc retry failed", retryErr);
        location.replace(guestUrl);
        throw retryErr;
      }
    }
  } else {
    console.warn("project doc read failed", err);
    location.replace(guestUrl);
    throw err;
  }
}
const pdata = pSnap?.exists() ? (pSnap.data() || {}) : null;
if (!pdata && !fallbackName) {
  location.replace(guestUrl);
  throw new Error("project not found");
}
if (pdata?.deleted) {
  alert("???????????????????????????????");
  location.replace(`${base}admin.html`);
  throw new Error("deleted project");
}
const pName = pdata?.name || fallbackName || project;

if (projectPill) projectPill.textContent = pName;
const sheetTitle = document.getElementById("sheetTitle");
if (sheetTitle) sheetTitle.textContent = "Music Sheet";
document.title = `Music Sheet | ${pName}`;

if (await initProjectSwitcher()) {
  throw new Error("project switcher redirected");
}

// ナビ
mountNav({ current: "sheet", projectId: project, hideAdmin: !isAdminUser(me) });

// projectId を固定（ユーザーが触れないように）
const pid = document.getElementById("projectId");
if (pid) {
  pid.value = project;
  pid.disabled = true;
}

localStorage.setItem("lastProject", project);

// ✅ Music Sheet 本体を起動（あなたの既存コードが入ってるファイル）
await import("./main.js");
