import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";

export async function registerCurrentUser(user) {
  if (!user?.uid) return;
  const payload = {
    uid: user.uid,
    email: user.email ? user.email.toLowerCase() : null,
    name: user.displayName || null,
    photoURL: user.photoURL || null,
    lastSeenAt: serverTimestamp(),
  };
  await setDoc(doc(db, "users", user.uid), payload, { merge: true });
}
