import { doc, getDoc } from "firebase/firestore";
import { db } from "./firebase";
import { mountTopbar, getParams } from "./ui_common";
import { mountNav } from "./nav";

await mountTopbar();

const { project } = getParams();
if (!project) {
  alert("project が指定されてないよ（例：sheet.html?project=invisible-half）");
  throw new Error("missing project");
}

const base = import.meta.env.BASE_URL || "/";
const projectRef = doc(db, "projects", project);
const pSnap = await getDoc(projectRef);
const pdata = pSnap.exists() ? (pSnap.data() || {}) : null;
if (pdata?.deleted) {
  alert("このプロジェクトは消去されています（管理者に連絡してください）");
  location.replace(`${base}admin.html`);
  throw new Error("deleted project");
}
const pName = pdata?.name || project;

document.getElementById("projectNamePill").textContent = pName;
document.getElementById("sheetTitle").textContent = pName;
document.title = `Music Sheet | ${pName}`;

// ナビ
mountNav({ current: "sheet", projectId: project });

// projectId を固定（ユーザーが触れないように）
const pid = document.getElementById("projectId");
if (pid) {
  pid.value = project;
  pid.disabled = true;
}

localStorage.setItem("lastProject", project);

// ✅ Music Sheet 本体を起動（あなたの既存コードが入ってるファイル）
await import("./main.js");
