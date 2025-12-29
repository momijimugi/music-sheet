import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { mountThemeToggle } from "./ui_common";
import { auth, provider, db, upsertUserProfile, createProject } from "./firebase";
import { mountNav } from "./nav";

const base = import.meta.env.BASE_URL || "/";
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);
const DEFAULT_MEMBER_ROLE = "member";
const userPill = document.getElementById("userPill");
const btnLogin = document.getElementById("btnLogin");
const btnLogout = document.getElementById("btnLogout");
const btnNewProject = document.getElementById("btnNewProject");
const accountLink = document.getElementById("accountLink");
const adminLink = document.getElementById("adminLink");
const inviteMsg = document.getElementById("inviteMsg");
const inviteList = document.getElementById("inviteList");

const JP = {
  metaDescription: "アカウント作成とログインのページです。",
  lead: "ログインしてアカウントを作成します。招待されたプロジェクトは下に表示されます。",
  notLoggedIn: "未ログイン",
  login: "Googleでログイン",
  logout: "ログアウト",
  account: "アカウント管理へ",
  admin: "サービス管理へ",
  inviteTitle: "参加中のプロジェクト",
  loginHint: "ログインすると招待されたプロジェクトが表示されます。",
  emailMissing: "メールアドレスが取得できませんでした。",
  loading: "読み込み中...",
  inviteLoadFail: "招待一覧の読み込みに失敗しました。ログイン状態や権限を確認してください。",
  noInvites: "招待中のプロジェクトはありません。",
  inviteLoadFailShort: "招待一覧の読み込みに失敗しました。",
  noProjects: "参照できるプロジェクトがありません。",
  statusJoined: "参加済み",
  statusInvite: "招待中",
  noteJoin: "参加するを押すと入室できます",
  join: "参加する",
  joining: "参加中...",
  joinFail: "参加に失敗しました: ",
  newProject: "新しいプロジェクト名を入力してください",
  creatingProject: "プロジェクトを作成中...",
  projectCreated: "プロジェクトを作成しました",
  createProjectFail: "プロジェクトの作成に失敗しました: ",
};

let currentUser = null;

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
  if (accountLink) accountLink.textContent = JP.account;
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
    where("uid", "==", uid)
  );
  const snap = await getDocs(q);
  const ids = [];
  snap.forEach((d) => {
    // d.ref: .../projects/{projectId}/members/{uid}
    const projectId = d.ref.parent.parent.id;
    ids.push(projectId);
  });
  return [...new Set(ids)];
}

async function fetchPendingInvites(email) {
  const emailLower = normEmail(email);
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

  let snap = null;
  try {
    const q = query(
      collectionGroup(db, "invites"),
      where("emailLower", "==", emailLower),
      where("usedBy", "==", null)
    );
    snap = await getDocs(q);
  } catch (err) {
    if (err?.code !== "failed-precondition") throw err;
    const q = query(
      collectionGroup(db, "invites"),
      where("emailLower", "==", emailLower)
    );
    snap = await getDocs(q);
  }
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
btnNewProject?.addEventListener("click", async () => {
  if (!currentUser) {
    setMsg("ログインしてください");
    return;
  }
  const name = prompt(JP.newProject);
  if (!name || !name.trim()) return;

  btnNewProject.disabled = true;
  const prevMsg = inviteMsg.textContent;
  setMsg(JP.creatingProject);

  try {
    await createProject({ name, user: currentUser });
    setMsg(JP.projectCreated);
    await loadInvites(currentUser);
  } catch (err) {
    console.error(err);
    if (err?.code === "plan-limit") {
      setMsg("無料プランではプロジェクトは2件までです。");
    } else {
      setMsg(JP.createProjectFail + (err.code || err.message));
    }
  } finally {
    btnNewProject.disabled = false;
    // メッセージを少し待ってから元に戻す
    setTimeout(() => {
      if(inviteMsg.textContent === JP.creatingProject || inviteMsg.textContent === JP.projectCreated){
        setMsg(prevMsg);
      }
    }, 2000);
  }
});


onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  await upsertUserProfile(user);
  mountNav({ current: "signup", hideAdmin: !isAdminUser(user) });
  if (userPill) userPill.textContent = user?.email || JP.notLoggedIn;
  if (btnLogin) btnLogin.style.display = user ? "none" : "inline-flex";
  if (btnLogout) btnLogout.style.display = user ? "inline-flex" : "none";
  if (btnNewProject) btnNewProject.style.display = user ? "inline-flex" : "none";
  if (accountLink) accountLink.style.display = user ? "inline-flex" : "none";
  if (adminLink) adminLink.style.display = isAdminUser(user) ? "inline-flex" : "none";

  if (!user) {
    setMsg(JP.loginHint);
    if (inviteList) inviteList.innerHTML = "";
    if (btnNewProject) btnNewProject.style.display = "none";
    if (accountLink) accountLink.style.display = "none";
    if (adminLink) adminLink.style.display = "none";
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
  const pendingInvites = invites.filter((invite) => !memberSet.has(invite.projectId));

  const projectIds = [...new Set([...memberProjectIds, ...pendingInvites.map(p => p.projectId)])];

  if (!projectIds.length) {
    if (inviteList) inviteList.innerHTML = "";
    setMsg(denied ? JP.inviteLoadFail : JP.noProjects);
    return;
  }

  const projectCards = await fetchProjectCards(projectIds, user);
  const projectMap = new Map(projectCards.map(p => [p.id, p]));

  const memberCards = memberProjectIds.map(id => projectMap.get(id)).filter(Boolean);
  const inviteCards = pendingInvites.map(invite => {
    const card = projectMap.get(invite.projectId);
    return {
      ...invite,
      name: card?.name || invite.projectName || invite.projectId,
      registered: !!card,
    }
  });

  const cards = [
    ...memberCards.map((card) => ({ ...card, type: "member" })),
    ...inviteCards.map((card) => ({ ...card, type: "invite" })),
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
        const canAccess = item.type === "member";
        const statusLabel = canAccess ? JP.statusJoined : JP.statusInvite;
        const statusClass = canAccess
          ? "border-brand-200 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-slate-50 text-slate-600";
        const note = canAccess
          ? ""
          : `<p class="mt-2 text-xs text-slate-500">${JP.noteJoin}</p>`;
        const joinButton = canAccess
          ? ""
          : `<button type="button" class="inline-flex items-center justify-center rounded-full bg-brand-700 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-brand-600/30 hover:bg-brand-800" data-act="join" data-project="${item.id}" data-invite="${item.inviteId}">${JP.join}</button>`;
        const portalLink = canAccess
          ? `<a class="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300" data-project="${item.id}" href="${base}portal.html?project=${encodeURIComponent(item.id)}">Portal</a>`
          : `<span class="inline-flex items-center justify-center rounded-full border border-slate-200 bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-400 cursor-not-allowed" aria-disabled="true">Portal</span>`;
        const sheetLink = canAccess
          ? `<a class="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300" data-project="${item.id}" href="${base}sheet.html?project=${encodeURIComponent(item.id)}">Music Sheet</a>`
          : `<span class="inline-flex items-center justify-center rounded-full border border-slate-200 bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-400 cursor-not-allowed" aria-disabled="true">Music Sheet</span>`;
        return `
        <div class="rounded-3xl border border-slate-200 bg-white p-5 shadow-md shadow-slate-200/50">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-lg font-semibold text-slate-900">${item.name}</div>
              <div class="mt-2 inline-flex items-center gap-2 text-xs">
                <span class="inline-flex items-center rounded-full border ${statusClass} px-3 py-1 text-xs font-semibold">${statusLabel}</span>
              </div>
              ${note}
            </div>
            <div class="text-xs text-slate-400">ID: ${item.id}</div>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            ${joinButton}
            ${portalLink}
            ${sheetLink}
          </div>
          <div class="mt-3 text-xs text-slate-400">project: ${item.id}</div>
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
          await runTransaction(db, async (tx) => {
            const memberRef = doc(db, "projects", projectId, "members", uid);
            const inviteRef = doc(db, "projects", projectId, "invites", inviteId);
            const inviteSnap = await tx.get(inviteRef);
            if (!inviteSnap.exists()) {
              const err = new Error("invite-missing");
              err.code = "invite-missing";
              throw err;
            }
            const inviteData = inviteSnap.data() || {};
            const inviteEmail = normEmail(inviteData.emailLower);
            if (!inviteEmail || inviteEmail !== email) {
              const err = new Error("invite-email-mismatch");
              err.code = "invite-email-mismatch";
              throw err;
            }
            if (inviteData.usedBy != null) {
              const err = new Error("invite-used");
              err.code = "invite-used";
              throw err;
            }
            const memberSnap = await tx.get(memberRef);
            if (memberSnap.exists()) {
              const err = new Error("already-member");
              err.code = "already-member";
              throw err;
            }

            tx.set(memberRef, {
              uid,
              role: inviteData.role || DEFAULT_MEMBER_ROLE,
              email: user?.email || null,
              displayName: user?.displayName || null,
              joinedAt: serverTimestamp(),
              inviteId,
            });
            tx.update(inviteRef, {
              usedBy: uid,
              usedAt: serverTimestamp(),
            });
          });
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

