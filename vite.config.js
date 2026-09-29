import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/socket": { target: "ws://127.0.0.1:4318", ws: true },
    },
  },
});
