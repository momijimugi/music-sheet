import "./style.css";
import "tabulator-tables/dist/css/tabulator.min.css";
import { mountNav } from "./nav";
import { auth, db, provider } from "./firebase";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const base = import.meta.env.BASE_URL || "/";
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(user) {
  return !!user && !!user.email && ADMIN_EMAILS.includes(user.email);
}

const $ = (id) => document.getElementById(id);
const msg = (t) => ($("msg").textContent = t || "");

const $m = (id) => document.getElementById(id);
const memberMsg = (t) => {
  const el = $m("memberMsg");
  if (el) el.textContent = t || "";
};

function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}
function isEmailLike(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function baseUrl() {
  return import.meta.env.BASE_URL || "/";
}

let currentUser = null;
let initDone = false;
let memberUnsub = null;
let currentMemberProjectId = "";

mountNav({ current: "admin" });

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

function setScheduleFrameAll() {
  const f = document.getElementById("adminScheduleFrame");
  const open = document.getElementById("openSchedule");
  if (!f || !open) return;

  const url = `${base}schedule.html?theme=light&scope=all`;
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
    const emails = Object.keys(mem).filter((k) => mem[k] === true).sort();

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
      await updateDoc(ref, {
        [`memberEmails.${email}`]: deleteField(),
        updatedAt: serverTimestamp(),
        updatedBy: currentUser?.email || currentUser?.uid || "",
      });
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
    if (!myEmail) {
      memberMsg("管理者メールが取れません");
      return;
    }

    if (!snap.exists()) {
      await setDoc(ref, {
        name: projectId,
        ownerEmail: myEmail,
        memberEmails: { [myEmail]: true },
        createdAt: serverTimestamp(),
        createdBy: myEmail,
        updatedAt: serverTimestamp(),
        updatedBy: myEmail,
      }, { merge: true });
      memberMsg("プロジェクトdocを作成しました");
      setTimeout(() => memberMsg(""), 1200);
      return;
    }

    const d = snap.data() || {};
    const patch = {};
    if (!d.ownerEmail) patch.ownerEmail = myEmail;
    if (!d.memberEmails || d.memberEmails[myEmail] !== true) {
      patch[`memberEmails.${myEmail}`] = true;
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = serverTimestamp();
      patch.updatedBy = myEmail;
      await updateDoc(ref, patch);
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
    await updateDoc(ref, {
      [`memberEmails.${email}`]: true,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser?.email || currentUser?.uid || "",
    });
    $m("memberEmailInput").value = "";
    memberMsg("追加しました");
    setTimeout(() => memberMsg(""), 1000);
  } catch (err) {
    console.error(err);
    memberMsg(`追加失敗: ${err.code || err.message}`);
  }
}

async function copyInvite(projectId) {
  const url = `${location.origin}${baseUrl()}portal.html?project=${encodeURIComponent(projectId)}`;
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
            <button class="smallBtn" data-act="archive" data-id="${id}" data-on="${archiveOn}">${archiveLabel}</button>
            <button class="smallBtn danger" data-act="delete" data-id="${id}">消去</button>
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
  const by = currentUser?.email || currentUser?.uid || "";

  try {
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

    renderProjectList(items);
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
  currentUser = user;

  if (!isAdmin(user)) {
    alert("このページは管理者専用です。");
    if (user) await signOut(auth);
    location.replace(base + "portal.html");
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
  const name = $("newName").value.trim();
  if (!name) {
    msg("プロジェクト名を入れてね");
    return;
  }

  const docRef = await addDoc(collection(db, "projects"), {
    name,
    createdAt: serverTimestamp(),
    members: [currentUser.uid],
    roleByUid: { [currentUser.uid]: "owner" },
  });

  msg(`作成しました: ${docRef.id}`);
});
