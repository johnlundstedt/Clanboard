import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["clan_board_logo.png", "clan_board_logo_192x192.png", "clan_board_logo_512x512.png"],
      manifest: {
        name: "Clan Board",
        short_name: "Clan Board",
        description: "Clan life, organized — weather, chores, meals, lists, and more for the whole household.",
        theme_color: "#2563eb",
        background_color: "#f4f6f8",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/clan_board_logo_192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/clan_board_logo_512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/clan_board_logo_512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [
          {
            // The app is live data behind a poll/change contract; never serve
            // stale API responses, even offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/api"),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/uploads": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});