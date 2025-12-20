import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  collectionGroup,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { mountThemeToggle } from "./ui_common";
import { auth, provider, db } from "./firebase";

const base = import.meta.env.BASE_URL || "/";
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const userPill = document.getElementById("userPill");
const btnLogin = document.getElementById("btnLogin");
const btnLogout = document.getElementById("btnLogout");
const adminLink = document.getElementById("adminLink");
const inviteMsg = document.getElementById("inviteMsg");
const inviteList = document.getElementById("inviteList");

const setMsg = (t) => {
  if (inviteMsg) inviteMsg.textContent = t || "";
};

mountThemeToggle();

const isAdminUser = (user) => !!user?.email && ADMIN_EMAILS.includes(user.email);

btnLogin?.addEventListener("click", async () => {
  await signInWithPopup(auth, provider);
});
btnLogout?.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (userPill) userPill.textContent = user?.email || "未ログイン";
  if (btnLogin) btnLogin.style.display = user ? "none" : "inline-flex";
  if (btnLogout) btnLogout.style.display = user ? "inline-flex" : "none";
  if (adminLink) adminLink.style.display = isAdminUser(user) ? "inline-flex" : "none";

  if (!user) {
    setMsg("ログインすると招待プロジェクトが表示されます。");
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  await loadInvites(user);
});

async function loadInvites(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) {
    setMsg("メールアドレスが取得できませんでした。");
    return;
  }
  setMsg("読み込み中...");

  let projectIds = [];
  let projectNames = {};
  let denied = false;
  try {
    const snap = await getDoc(doc(db, "inviteIndex", email));
    const data = snap?.data() || {};
    projectIds = Array.isArray(data.projects) ? data.projects : [];
    projectNames = data.projectNames && typeof data.projectNames === "object"
      ? data.projectNames
      : {};
  } catch (err) {
    if (err?.code === "permission-denied") denied = true;
    console.warn("inviteIndex read failed", err);
  }

  projectIds = [...new Set(projectIds.filter(Boolean))];
  if (!projectIds.length) {
    try {
      const q = query(
        collectionGroup(db, "invites"),
        where(documentId(), "==", email)
      );
      const snap = await getDocs(q);
      projectIds = snap.docs
        .map((docSnap) => docSnap.ref.parent.parent?.id)
        .filter(Boolean);
    } catch (err) {
      if (err?.code === "permission-denied") denied = true;
      console.warn("invite collectionGroup read failed", err);
    }
  }

  projectIds = [...new Set(projectIds.filter(Boolean))];
  if (!projectIds.length) {
    setMsg(
      denied
        ? "招待一覧の読み込み権限がありません。ログイン状態とルールを確認してください。"
        : "招待されているプロジェクトがありません。"
    );
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  const docs = await Promise.all(
    projectIds.map(async (pid) => {
      try {
        const snap = await getDoc(doc(db, "projects", pid));
        if (!snap.exists()) return null;
        const data = snap.data() || {};
        if (data.deleted) return null;
        const name = String(
          data.name ||
          data.projectName ||
          data.title ||
          projectNames[pid] ||
          pid
        ).trim();
        return { id: pid, name: name || pid };
      } catch (err) {
        if (err?.code === "permission-denied") denied = true;
        console.warn("project doc read failed", err);
        const fallbackName = String(projectNames[pid] || "").trim();
        if (denied && !fallbackName) return null;
        return { id: pid, name: fallbackName || pid };
      }
    })
  );
  const cards = docs
    .filter(Boolean)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

  if (!cards.length) {
    setMsg(
      denied
        ? "招待一覧の読み込み権限がありません。ログイン状態とルールを確認してください。"
        : "表示できるプロジェクトがありません。"
    );
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  if (inviteList) {
    inviteList.innerHTML = cards
      .map(
        (item) => `
        <div class="inviteItem">
          <div class="inviteTitle">${item.name}</div>
          <div class="inviteActions">
            <a class="btn ghost" data-project="${item.id}" href="${base}portal.html?project=${encodeURIComponent(item.id)}">Portal</a>
            <a class="btn ghost" data-project="${item.id}" href="${base}sheet.html?project=${encodeURIComponent(item.id)}">Music Sheet</a>
          </div>
          <div class="inviteHint">project: ${item.id}</div>
        </div>
      `
      )
      .join("");
    inviteList.querySelectorAll("[data-project]").forEach((link) => {
      link.addEventListener("click", () => {
        const pid = link.getAttribute("data-project");
        if (pid) localStorage.setItem("lastProject", pid);
      });
    });
  }
  setMsg("");
}
