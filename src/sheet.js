import { doc, getDoc, getDocs, collection, collectionGroup, query, where } from "firebase/firestore";
import { db } from "./firebase";
import { mountTopbar, getParams } from "./ui_common";
import { mountNav } from "./nav";

const me = await mountTopbar();

const base = import.meta.env.BASE_URL || "/";
const guestUrl = `${base}index.html`;
async function loadMemberProjectIds(user) {
  if (!user?.uid) return new Set();
  try {
    const q = query(
      collectionGroup(db, "members"),
      where("memberUid", "==", user.uid)
    );
    const snap = await getDocs(q);
    const ids = snap.docs
      .map((docSnap) => docSnap.ref.parent.parent?.id)
      .filter(Boolean);
    return new Set(ids);
  } catch (err) {
    console.warn("member project list failed", err);
    return new Set();
  }
}
const memberProjectIds = await loadMemberProjectIds(me);
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
function normEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function canAccessProject(user, data, projectId) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  const email = normEmail(user?.email);
  if (email && normEmail(data?.ownerEmail) === email) return true;
  const uid = user?.uid;
  if (uid && Array.isArray(data?.members) && data.members.includes(uid)) return true;
  if (uid && data?.roleByUid && data.roleByUid[uid]) return true;
  if (projectId && memberProjectIds.has(projectId)) return true;
  return false;
}

async function initProjectSwitcher() {
  if (!projectSwitcher) return false;
  if (!me) {
    projectSwitcher.style.display = "none";
    return false;
  }
  try {
    let items = [];
    if (isAdminUser(me)) {
      const snap = await getDocs(collection(db, "projects"));
      snap.forEach((d) => items.push({ id: d.id, ...(d.data() || {}) }));
    } else {
      const projectIds = [...memberProjectIds];
      if (projectIds.length) {
        const docs = await Promise.all(
          projectIds.map(async (pid) => {
            try {
              const snap = await getDoc(doc(db, "projects", pid));
              if (!snap.exists()) return null;
              const data = snap.data() || {};
              if (data.deleted) return null;
              if (!canAccessProject(me, data, pid)) return null;
              return { id: pid, ...data };
            } catch (err) {
              if (err?.code !== "permission-denied") {
                console.warn("project doc read failed", err);
              }
              return null;
            }
          })
        );
        items = docs.filter(Boolean);
      }
    }
    const allowed = items.filter((item) => !item.deleted && canAccessProject(me, item, item.id));
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
let pSnap = null;
try {
  pSnap = await getDoc(projectRef);
} catch (err) {
  console.warn("project doc read failed", err);
  location.replace(guestUrl);
  throw err;
}
const pdata = pSnap?.exists() ? (pSnap.data() || {}) : null;
if (!pdata) {
  location.replace(guestUrl);
  throw new Error("project not found");
}
if (pdata?.deleted) {
  alert("???????????????????????????????");
  location.replace(`${base}admin.html`);
  throw new Error("deleted project");
}
if (!canAccessProject(me, pdata, project)) {
  location.replace(guestUrl);
  throw new Error("not member");
}
const pName = pdata?.name || project;

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
