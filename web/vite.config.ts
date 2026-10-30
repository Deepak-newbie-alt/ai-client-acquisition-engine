import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard calls the API through this proxy, so the session cookie stays
// same-origin and the browser's Origin header matches APP_ORIGIN.
export default defineConfig({
  plugins: [react()],
  server: {
    // Must match APP_ORIGIN (http://localhost:5173) for the API's CSRF origin check.
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: true } },
  },
});
