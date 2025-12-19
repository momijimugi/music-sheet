import "./style.css";
import { TabulatorFull as Tabulator } from "tabulator-tables";

// Firebase（npm版）
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import {
  getFirestore, collection, doc, addDoc, updateDoc,
  serverTimestamp, onSnapshot, query, orderBy
} from "firebase/firestore";

// ★ env（後述）から読む
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const $ = (id) => document.getElementById(id);
const msg = (t) => ($("msg").textContent = t || "");

let currentUser = null;
let currentProjectId = $("projectId").value.trim();
let unsub = null;

const table = new Tabulator("#grid", {
  height: "100%",
  layout: "fitColumns",
  selectable: 1,
  index: "id",
  columns: [
    { title: "#M", field: "m", width: 70, editor: "input" },
    { title: "V", field: "v", width: 55, editor: "input" },
    { title: "demo", field: "demo", width: 80, editor: "input" },
    { title: "scene", field: "scene", minWidth: 180, editor: "input" },
    { title: "進捗", field: "status", width: 90, editor: "input" },
    { title: "監督FB(省略)", field: "director", minWidth: 220,
      formatter: (cell) => (cell.getValue() || "").replace(/\s+/g," ").slice(0,40) + ((cell.getValue()||"").length>40?"…":"")
    },
    { title: "memo(省略)", field: "memo", minWidth: 180,
      formatter: (cell) => (cell.getValue() || "").replace(/\s+/g," ").slice(0,30) + ((cell.getValue()||"").length>30?"…":"")
    },
    { title: "updatedBy", field: "updatedBy", width: 160 },
  ],
});

let selected = null;

function setInspector(row){
  if(!row){ selected = null; $("selMeta").textContent="行を選択すると表示されます"; return; }
  const d = row.getData();
  selected = { id: d.id };
  $("selMeta").textContent = `選択中: #M ${d.m ?? ""} / demo ${d.demo ?? ""}`;
  $("f_m").value = d.m ?? "";
  $("f_v").value = d.v ?? "";
  $("f_demo").value = d.demo ?? "";
  $("f_scene").value = d.scene ?? "";
  $("f_status").value = d.status ?? "";
  $("f_len").value = d.len ?? "";
  $("f_director").value = d.director ?? "";
  $("f_memo").value = d.memo ?? "";
  $("f_in").value = d.in ?? "";
  $("f_out").value = d.out ?? "";
}

table.on("rowClick", (e, row) => setInspector(row));

function listen(projectId){
  if(unsub) unsub();
  currentProjectId = projectId;

  const q = query(collection(db, "projects", projectId, "cues"), orderBy("m"));
  unsub = onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    table.replaceData(rows);
    msg("");
  }, (err) => {
    console.error(err);
    msg(`同期エラー: ${err.code || err.message}`);
  });
}

// ログイン
$("btnLogin").onclick = async () => {
  try { await signInWithPopup(auth, provider); }
  catch(e){ console.error(e); msg(`ログイン失敗: ${e.code||e.message}`); }
};
$("btnLogout").onclick = async () => { await signOut(auth); };

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if(user){
    $("userPill").textContent = user.email || user.uid;
    $("btnLogin").style.display = "none";
    $("btnLogout").style.display = "inline-block";
    listen($("projectId").value.trim());
  }else{
    $("userPill").textContent = "未ログイン";
    $("btnLogin").style.display = "inline-block";
    $("btnLogout").style.display = "none";
    if(unsub) unsub();
    table.replaceData([]);
    setInspector(null);
  }
});

// 行追加（★エラーを表示する）
$("btnAddRow").onclick = async () => {
  if(!currentUser){ msg("ログインしてね"); return; }
  try{
    await addDoc(collection(db,"projects",currentProjectId,"cues"),{
      m: 999, v: null, demo:"", scene:"", status:"wip", len:"",
      director:"", memo:"", in:"", out:"",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.email || currentUser.uid,
    });
    msg("行を追加しました");
  }catch(e){
    console.error(e);
    msg(`追加失敗: ${e.code || e.message}`);
  }
};

// 詳細保存（未選択なら新規行を作る）
$("btnSaveDetail").onclick = async () => {
  if(!currentUser){ msg("ログインしてね"); return; }

  const patch = {
    m: $("f_m").value.trim() || null,
    v: $("f_v").value.trim() || null,
    demo: $("f_demo").value.trim() || "",
    scene: $("f_scene").value.trim() || "",
    status: $("f_status").value.trim() || "",
    len: $("f_len").value.trim() || "",
    director: $("f_director").value || "",
    memo: $("f_memo").value || "",
    in: $("f_in").value.trim() || "",
    out: $("f_out").value.trim() || "",
    updatedAt: serverTimestamp(),
    updatedBy: currentUser.email || currentUser.uid,
  };

  try{
    if(!selected){
      await addDoc(collection(db,"projects",currentProjectId,"cues"),{
        ...patch, createdAt: serverTimestamp()
      });
      msg("新規行を作って保存しました");
    }else{
      await updateDoc(doc(db,"projects",currentProjectId,"cues",selected.id), patch);
      msg("保存しました");
    }
  }catch(e){
    console.error(e);
    msg(`保存失敗: ${e.code || e.message}`);
  }
};
