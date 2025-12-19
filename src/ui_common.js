import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, provider } from "./firebase";

const THEME_KEY = "theme";

export function mountTopbar(){
  mountThemeToggle();
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

export function getPreferredTheme(){
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function applyTheme(theme){
  const mode = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  return mode;
}

export function setTheme(theme){
  const mode = theme === "dark" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
  return mode;
}

export function toggleTheme(){
  const next = getPreferredTheme() === "dark" ? "light" : "dark";
  return setTheme(next);
}

export function mountThemeToggle(buttonId = "btnThemeToggle"){
  const btn = document.getElementById(buttonId);
  const render = () => {
    const mode = document.documentElement.dataset.theme || getPreferredTheme();
    if (btn) btn.textContent = `テーマ: ${mode === "dark" ? "ダーク" : "ライト"}`;
  };

  applyTheme(getPreferredTheme());
  render();

  if (!btn) return;
  btn.addEventListener("click", () => {
    const mode = toggleTheme();
    render();
    window.dispatchEvent(new CustomEvent("themechange", { detail: mode }));
  });
}
