import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
