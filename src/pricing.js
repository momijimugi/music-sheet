import { mountTopbar } from "./ui_common";
import { mountNav } from "./nav";

const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminUser(user) {
  return !!user?.email && ADMIN_EMAILS.includes(user.email);
}

(async function boot() {
  const user = await mountTopbar();
  mountNav({ current: "pricing", hideAdmin: !isAdminUser(user) });
})();
