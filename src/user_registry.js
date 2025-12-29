import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";

export async function registerCurrentUser(user) {
  if (!user?.uid) return;
  const emailNorm = user.email ? user.email.toLowerCase() : null;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || null,
      emailNorm,
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      status: "active",
      roleGlobal: "user",
      plan: "free",
      subscriptionStatus: "inactive",
      lastSeenAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });
    return;
  }

  await updateDoc(ref, {
    email: user.email || null,
    emailNorm,
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
    lastSeenAt: serverTimestamp(),
  });
}
