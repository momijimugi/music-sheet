import { getParams } from "./ui_common";

export function mountNav({ current = "", projectId = "" } = {}) {
  const nav = document.getElementById("nav");
  if (!nav) return;

  const base = import.meta.env.BASE_URL || "/";
  const params = getParams();
  const isEmbed = window.self !== window.top;

  // project は (引数) → (URL) → (localStorage) の順で拾う
  const remembered = localStorage.getItem("lastProject") || "";
  const p0 = projectId || params.project || remembered;

  const btn = (key, label) =>
    `<button type="button" class="navBtn${current === key ? " active" : ""}" data-go="${key}">${label}</button>`;

  nav.innerHTML =
    btn("admin", "管理") + btn("portal", "ポータル") + btn("sheet", "Music Sheet");

  nav.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest("button[data-go]");
      if (!b) return;

      e.preventDefault();
      e.stopPropagation();

      const go = b.dataset.go;
      let url =
        base +
        (go === "admin"
          ? "admin.html"
          : go === "portal"
            ? "portal.html"
            : "sheet.html");

      let pid = p0;
      if (go !== "admin") {
        if (!pid) {
          pid = prompt("プロジェクトIDを入力して開くよ（例：invisible-half）")?.trim();
          if (!pid) return;
        }
        localStorage.setItem("lastProject", pid);
        url += `?project=${encodeURIComponent(pid)}`;
      }

      // iframe内なら親画面で遷移
      (isEmbed ? window.top : window).location.href = url;
    },
    true
  );
}
