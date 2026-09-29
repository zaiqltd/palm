import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
export default defineConfig({
  plugins: [react()],
  define: { __PALM_VERSION__: JSON.stringify(version) },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/socket": { target: "ws://127.0.0.1:4318", ws: true },
    },
  },
});
