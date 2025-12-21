import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  writeBatch,
  where,
} from "firebase/firestore";
import { mountThemeToggle } from "./ui_common";
import { auth, provider, db } from "./firebase";

const base = import.meta.env.BASE_URL || "/";
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const DEFAULT_MEMBER_ROLE = "member";
const userPill = document.getElementById("userPill");
const btnLogin = document.getElementById("btnLogin");
const btnLogout = document.getElementById("btnLogout");
const adminLink = document.getElementById("adminLink");
const inviteMsg = document.getElementById("inviteMsg");
const inviteList = document.getElementById("inviteList");

const JP = {
  metaDescription: "\u97f3\u697d\u5236\u4f5c\u30c1\u30fc\u30e0\u5411\u3051\u306e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u5171\u6709\u30cf\u30d6",
  lead: "\u3088\u3046\u3053\u305d\u3002\u97f3\u697d\u5236\u4f5c\u3084\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u3092\u5171\u6709\u3057\u3066\u3001\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u4e00\u7dd2\u306b\u9032\u3081\u308b\u305f\u3081\u306e\u30dd\u30fc\u30bf\u30eb\u3067\u3059\u3002",
  notLoggedIn: "\u672a\u30ed\u30b0\u30a4\u30f3",
  login: "Google\u3067\u30ed\u30b0\u30a4\u30f3",
  logout: "\u30ed\u30b0\u30a2\u30a6\u30c8",
  admin: "\u7ba1\u7406\u753b\u9762\u3078",
  inviteTitle: "\u62db\u5f85\u3055\u308c\u3066\u3044\u308b\u30d7\u30ed\u30b8\u30a7\u30af\u30c8",
  loginHint: "\u30ed\u30b0\u30a4\u30f3\u3059\u308b\u3068\u62db\u5f85\u3055\u308c\u305f\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u304c\u8868\u793a\u3055\u308c\u307e\u3059\u3002",
  emailMissing: "\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u304c\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002",
  loading: "\u8aad\u307f\u8fbc\u307f\u4e2d...",
  inviteLoadFail: "\u62db\u5f85\u4e00\u89a7\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u30ed\u30b0\u30a4\u30f3\u72b6\u614b\u3084\u6a29\u9650\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
  noInvites: "\u62db\u5f85\u4e2d\u306e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306f\u3042\u308a\u307e\u305b\u3093\u3002",
  inviteLoadFailShort: "\u62db\u5f85\u4e00\u89a7\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002",
  noProjects: "\u53c2\u7167\u3067\u304d\u308b\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u304c\u3042\u308a\u307e\u305b\u3093\u3002",
  statusJoined: "\u53c2\u52a0\u6e08\u307f",
  statusInvite: "\u62db\u5f85\u4e2d",
  noteJoin: "\u53c2\u52a0\u3059\u308b\u3092\u62bc\u3059\u3068\u5165\u5ba4\u3067\u304d\u307e\u3059",
  join: "\u53c2\u52a0\u3059\u308b",
  joining: "\u53c2\u52a0\u4e2d...",
  joinFail: "\u53c2\u52a0\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ",
};

const setMsg = (t) => {
  if (inviteMsg) inviteMsg.textContent = t || "";
};
const normEmail = (value) => String(value || "").trim().toLowerCase();

function mountStaticText() {
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", JP.metaDescription);
  const lead = document.querySelector(".lead");
  if (lead) lead.textContent = JP.lead;
  if (btnLogin) btnLogin.textContent = JP.login;
  if (btnLogout) btnLogout.textContent = JP.logout;
  if (adminLink) adminLink.textContent = JP.admin;
  const inviteTitle = document.getElementById("inviteTitle");
  if (inviteTitle) inviteTitle.textContent = JP.inviteTitle;
  if (userPill) userPill.textContent = JP.notLoggedIn;
}

mountStaticText();

async function fetchMemberProjectIds(uid) {
  if (!uid) return [];
  const q = query(
    collectionGroup(db, "members"),
    where("memberUid", "==", uid)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((docSnap) => docSnap.ref.parent.parent?.id)
    .filter(Boolean);
}

async function fetchPendingInvites(emailLower) {
  if (!emailLower) return [];
  const results = new Map();
  const addDoc = (docSnap) => {
    const data = docSnap.data() || {};
    if (data.usedBy != null) return;
    const projectId = docSnap.ref.parent.parent?.id;
    if (!projectId) return;
    const key = `${projectId}:${docSnap.id}`;
    results.set(key, {
      inviteId: docSnap.id,
      projectId,
      projectName: data.projectName || "",
      role: data.role || DEFAULT_MEMBER_ROLE,
    });
  };

  const q = query(
    collectionGroup(db, "invites"),
    where("emailLower", "==", emailLower)
  );
  const snap = await getDocs(q);
  snap.docs.forEach(addDoc);

  return [...results.values()];
}

mountThemeToggle();

const isAdminUser = (user) => !!user?.email && ADMIN_EMAILS.includes(user.email);

btnLogin?.addEventListener("click", async () => {
  await signInWithPopup(auth, provider);
});
btnLogout?.addEventListener("click", async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (userPill) userPill.textContent = user?.email || JP.notLoggedIn;
  if (btnLogin) btnLogin.style.display = user ? "none" : "inline-flex";
  if (btnLogout) btnLogout.style.display = user ? "inline-flex" : "none";
  if (adminLink) adminLink.style.display = isAdminUser(user) ? "inline-flex" : "none";

  if (!user) {
    setMsg(JP.loginHint);
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  await loadInvites(user);
});

async function fetchProjectCards(projectIds, user) {
  if (!projectIds.length) return [];
  const cards = await Promise.all(
    projectIds.map(async (pid) => {
      if (isAdminUser(user)) {
        try {
          const snap = await getDoc(doc(db, "projects", pid));
          if (!snap.exists()) return null;
          const data = snap.data() || {};
          if (data.deleted) return null;
          const name = String(
            data.name ||
            data.projectName ||
            data.title ||
            pid
          ).trim();
          return { id: pid, name: name || pid, registered: true };
        } catch (err) {
          console.warn("project doc read failed", err);
          return { id: pid, name: pid, registered: true };
        }
      }

      try {
        const snap = await getDoc(doc(db, "projects", pid));
        if (!snap.exists()) return null;
        const data = snap.data() || {};
        if (data.deleted) return null;
        const name = String(
          data.name ||
          data.projectName ||
          data.title ||
          pid
        ).trim();
        return { id: pid, name: name || pid, registered: true };
      } catch (err) {
        if (err?.code !== "permission-denied") {
          console.warn("project doc read failed", err);
        }
        return { id: pid, name: pid, registered: false };
      }
    })
  );
  return cards.filter(Boolean);
}

async function loadInvites(user) {
  const email = normEmail(user?.email || "");
  const uid = user?.uid || "";
  if (!email || !uid) {
    setMsg(JP.emailMissing);
    return;
  }
  setMsg(JP.loading);

  let memberProjectIds = [];
  let invites = [];
  let denied = false;
  try {
    memberProjectIds = await fetchMemberProjectIds(uid);
  } catch (err) {
    if (err?.code === "permission-denied") denied = true;
    console.warn("member project list failed", err);
  }
  try {
    invites = await fetchPendingInvites(email);
  } catch (err) {
    if (err?.code === "permission-denied") denied = true;
    console.warn("invite collectionGroup read failed", err);
  }

  const memberSet = new Set(memberProjectIds);
  invites = invites.filter((invite) => !memberSet.has(invite.projectId));

  if (!memberProjectIds.length && !invites.length) {
    setMsg(
      denied
        ? JP.inviteLoadFail
        : JP.noInvites
    );
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  const memberCards = await fetchProjectCards(memberProjectIds, user);
  const inviteCards = invites.map((invite) => ({
    id: invite.projectId,
    name: invite.projectName || invite.projectId,
    registered: false,
    type: "invite",
    inviteId: invite.inviteId,
  }));
  const cards = [
    ...memberCards.map((card) => ({ ...card, type: "member" })),
    ...inviteCards,
  ];
  cards.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));

  if (!cards.length) {
    setMsg(
      denied
        ? JP.inviteLoadFailShort
        : JP.noProjects
    );
    if (inviteList) inviteList.innerHTML = "";
    return;
  }

  if (inviteList) {
    inviteList.innerHTML = cards
      .map((item) => {
        const canAccess = isAdminUser(user) || item.type === "member";
        const statusLabel = canAccess ? JP.statusJoined : JP.statusInvite;
        const statusClass = canAccess ? "ok" : "ng";
        const note = canAccess
          ? ""
          : `<span class="inviteNote">${JP.noteJoin}</span>`;
        const joinButton = canAccess
          ? ""
          : `<button class="btn primary small" data-act="join" data-project="${item.id}" data-invite="${item.inviteId}">${JP.join}</button>`;
        const portalLink = canAccess
          ? `<a class="btn ghost" data-project="${item.id}" href="${base}portal.html?project=${encodeURIComponent(item.id)}">Portal</a>`
          : `<span class="btn ghost disabled" aria-disabled="true">Portal</span>`;
        const sheetLink = canAccess
          ? `<a class="btn ghost" data-project="${item.id}" href="${base}sheet.html?project=${encodeURIComponent(item.id)}">Music Sheet</a>`
          : `<span class="btn ghost disabled" aria-disabled="true">Music Sheet</span>`;
        return `
        <div class="inviteItem">
          <div class="inviteTitle">${item.name}</div>
          <div class="inviteMeta">
            <span class="inviteStatus ${statusClass}">${statusLabel}</span>
            ${note}
          </div>
          <div class="inviteActions">
            ${joinButton}
            ${portalLink}
            ${sheetLink}
          </div>
          <div class="inviteHint">project: ${item.id}</div>
        </div>
      `;
      })
      .join("");
    inviteList.onclick = async (event) => {
      const target = event.target;
      const joinBtn = target?.closest?.("button[data-act='join']");
      if (joinBtn) {
        const projectId = joinBtn.getAttribute("data-project") || "";
        const inviteId = joinBtn.getAttribute("data-invite") || "";
        if (!projectId || !inviteId) return;
        joinBtn.disabled = true;
        const prev = joinBtn.textContent;
        joinBtn.textContent = JP.joining;
        try {
          const batch = writeBatch(db);
          const memberRef = doc(db, "projects", projectId, "members", uid);
          const inviteRef = doc(db, "projects", projectId, "invites", inviteId);
          batch.set(memberRef, {
            role: DEFAULT_MEMBER_ROLE,
            emailLower: email,
            joinedAt: serverTimestamp(),
            memberUid: uid,
            inviteId,
          });
          batch.update(inviteRef, {
            usedBy: uid,
            usedAt: serverTimestamp(),
          });
          await batch.commit();
          await loadInvites(user);
        } catch (err) {
          console.error(err);
          setMsg(JP.joinFail + (err.code || err.message));
          joinBtn.disabled = false;
          joinBtn.textContent = prev || JP.join;
        }
        return;
      }
      const link = target?.closest?.("a[data-project]");
      if (!link) return;
      const pid = link.getAttribute("data-project");
      if (pid) localStorage.setItem("lastProject", pid);
    };
  }
  setMsg("");
}

