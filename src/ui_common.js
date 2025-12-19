import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, provider } from "./firebase";

export function mountTopbar(){
  const userPill = document.getElementById("userPill");
  const btnLogin = document.getElementById("btnLogin");
  const btnLogout = document.getElementById("btnLogout");

  btnLogin?.addEventListener("click", async () => {
    await signInWithPopup(auth, provider);
  });
  btnLogout?.addEventListener("click", async () => {
    await signOut(auth);
  });

  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if(user){
        userPill.textContent = user.email || user.uid;
        btnLogin.style.display = "none";
        btnLogout.style.display = "inline-block";
      }else{
        userPill.textContent = "未ログイン";
        btnLogin.style.display = "inline-block";
        btnLogout.style.display = "none";
      }
      resolve(user);
    });
  });
}

export function getParams(){
  const u = new URL(location.href);
  return Object.fromEntries(u.searchParams.entries());
}
