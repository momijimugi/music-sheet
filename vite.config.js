import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ command }) => ({
  // dev (npm run dev) uses "/", build uses "/music-sheet/"
  base: command === "serve" ? "/" : "/music-sheet/",

  server: {
    port: 5173,
    strictPort: true,
    open: "/admin.html",
  },

  build: {
    rollupOptions: {
      input: {
        admin: resolve(__dirname, "admin.html"),
        portal: resolve(__dirname, "portal.html"),
        sheet: resolve(__dirname, "sheet.html"),
        "schedule-admin": resolve(__dirname, "schedule-admin.html"),
        "schedule-portal": resolve(__dirname, "schedule-portal.html"),
      },
    },
  },
}));
