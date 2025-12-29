import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, serverTimestamp, addDoc, collection, collectionGroup, query, where } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();

const FREE_PROJECT_LIMIT = 2;

export async function upsertUserProfile(user){
  if(!user?.uid) return;

  const uref = doc(db, "users", user.uid);
  const snap = await getDoc(uref);

  const email = user.email || "";
  const emailNorm = email.trim().toLowerCase();

  if(!snap.exists()){
    await setDoc(uref, {
      email,
      emailNorm,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      status: "active",
      roleGlobal: "user",
      plan: "free",
      subscriptionStatus: "inactive",
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    });
  }else{
    await updateDoc(uref, {
      lastSeenAt: serverTimestamp(),
      email,
      emailNorm,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
    });
  }
}

export async function isUserBanned(uid){
  if(!uid) return false;
  const snap = await getDoc(doc(db, "users", uid));
  const data = snap.exists() ? snap.data() : null;
  return (data?.status === "banned");
}

async function getUserPlan(uid){
  if(!uid) return "free";
  const snap = await getDoc(doc(db, "users", uid));
  if(!snap.exists()) return "free";
  const data = snap.data() || {};
  return String(data.plan || "free").trim() || "free";
}

async function countOwnedProjects(user){
  const uid = user?.uid;
  if(!uid) return 0;
  const q = query(
    collectionGroup(db, "members"),
    where("uid", "==", uid)
  );
  const snap = await getDocs(q);
  const map = new Map();
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data?.role !== "owner") return;
    const projectId = docSnap.ref.parent.parent?.id;
    if (projectId) map.set(projectId, true);
  });
  return map.size;
}

async function assertCanCreateProject(user){
  if(!user?.uid) return;
  const plan = await getUserPlan(user.uid);
  if(plan && plan !== "free") return;
  const count = await countOwnedProjects(user);
  if(count >= FREE_PROJECT_LIMIT){
    const err = new Error("無料プランではプロジェクトは2件までです。");
    err.code = "plan-limit";
    err.limit = FREE_PROJECT_LIMIT;
    err.count = count;
    throw err;
  }
}

export async function createProject({ name, user }) {
  // user: { uid, email, displayName } を渡す想定（auth.currentUserでもOK）
  await assertCanCreateProject(user);
  const ref = await addDoc(collection(db, "projects"), {
    name: name.trim(),
    ownerUid: user.uid,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  });

  await setDoc(doc(db, "projects", ref.id, "members", user.uid), {
    role: "owner",
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || null,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  });

  return ref.id;
}
