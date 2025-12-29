import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";

const authEmail = document.getElementById("authEmail");
const projectLink = document.getElementById("projectLink");
const loginLink = document.getElementById("loginLink");

const setVisible = (el, isVisible) => {
  if (!el) return;
  el.classList.toggle("hidden", !isVisible);
  if (isVisible) {
    el.classList.add("inline-flex");
  } else {
    el.classList.remove("inline-flex");
  }
};

onAuthStateChanged(auth, (user) => {
  if (!user) {
    setVisible(authEmail, false);
    setVisible(projectLink, false);
    setVisible(loginLink, true);
    return;
  }

  if (authEmail) {
    authEmail.textContent = user.email || user.uid || "";
  }
  setVisible(authEmail, true);
  setVisible(projectLink, true);
  setVisible(loginLink, false);
});
