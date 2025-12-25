import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, addDoc, collection } from "firebase/firestore";

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
      status: "active",
      roleGlobal: "user",
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    });
  }else{
    await updateDoc(uref, {
      lastSeenAt: serverTimestamp(),
      email,
      emailNorm,
      displayName: user.displayName || null,
    });
  }
}

export async function isUserBanned(uid){
  if(!uid) return false;
  const snap = await getDoc(doc(db, "users", uid));
  const data = snap.exists() ? snap.data() : null;
  return (data?.status === "banned");
}

export async function createProject({ name, user }) {
  // user: { uid, email, displayName } を渡す想定（auth.currentUserでもOK）
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
