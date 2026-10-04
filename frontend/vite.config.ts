import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Copies & Corrigés — BacPrep Cameroun",
        short_name: "Corrigés",
        description: "Épreuves et corrigés du secondaire camerounais, disponibles hors-ligne.",
        lang: "fr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f6f2e7",
        theme_color: "#1b2a4a",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // Coque de l'application (JS/CSS/polices/icônes) précachée : l'app démarre sans réseau.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Le back-office (478 Ko) ne sert pas aux élèves : chargé à la demande, jamais précaché.
        globIgnores: ["**/AdminPage-*.js"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        runtimeCaching: [
          // Épreuve ouverte ou « téléchargée » : réseau d'abord (3 s max — utile sur
          // connexion lente), repli sur la copie locale. Ne met en cache que les 200.
          {
            urlPattern: ({ url }) => /^\/api\/epreuves\/[^/]+$/.test(url.pathname),
            handler: "NetworkFirst",
            options: {
              cacheName: "epreuves",
              networkTimeoutSeconds: 3,
              matchOptions: { ignoreVary: true },
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
          // Images d'épreuve : les jetons d'URL expirent en 15 min, donc le jeton
          // (?token=…) est ignoré à la lecture du cache.
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/files/"),
            handler: "CacheFirst",
            options: {
              cacheName: "epreuves-images",
              matchOptions: { ignoreSearch: true, ignoreVary: true },
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
          // Profil connecté : l'élève reste « connecté » à l'ouverture hors-ligne.
          {
            urlPattern: ({ url }) => url.pathname === "/api/auth/me",
            handler: "NetworkFirst",
            options: { cacheName: "session", networkTimeoutSeconds: 3, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // Découpage manuel des dépendances lourdes, limité aux
        // dépendances RÉELLEMENT présentes dans le graphe statique de
        // l'entrée.
        //
        // Contrainte mesurée, pas théorique : Vite émet un
        // <link rel="modulepreload"> pour chaque chunk manuel qu'il rattache
        // à l'entrée, donc le navigateur le télécharge immédiatement. Les
        // groupes qui ne servent qu'à une route lazy doivent donc rester
        // DANS le chunk lazy. Concrètement, `recharts` n'est atteint que par
        // StatsPanel → ImportPanel → AdminPage, lui-même en React.lazy : le
        // mettre dans un groupe `charts` faisait passer le premier rendu de
        // 787 kB à 1136 kB, soit 359 kB de graphiques téléchargés par chaque
        // élève alors qu'aucun ne les verra. D'où l'absence de groupe ici.
        //
        // Bénéfice conservé : le chunk applicatif tombe de 787 kB à ~165 kB,
        // et les vendors deviennent des fichiers cacheables séparément — une
        // modification du code applicatif n'invalide plus 900 kB de cache.
        //
        // L'ordre des tests est significatif : `katex` passe AVANT
        // `markdown`, car `rehype-katex` correspondrait aux deux motifs.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](katex)[\\/]/.test(id)) return "katex";
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-[\\w-]+|rehype-[\\w-]+|micromark[\\w-]*|mdast-util-[\\w-]+|hast-util-[\\w-]+|unist-util-[\\w-]+|unified|bail|trough|vfile[\w-]*|devlop|longest-streak|markdown-table|character-entities[\w-]*|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|zwitch|trim-lines|web-namespaces|is-plain-obj|extend)/.test(id)
          ) {
            return "markdown";
          }
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "icons";
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]|use-sync-external-store)[\\/]/.test(id)
          ) {
            return "react-vendor";
          }
          return;
        },
      },
    },
  },
});
