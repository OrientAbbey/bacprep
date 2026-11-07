import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { rechargerPourNouvelleVersion } from "./lib/nouvelleVersion";

// Un déploiement remplace les fichiers hachés : un onglet resté ouvert peut
// demander un chunk supprimé (404). Vite émet `vite:preloadError` dans ce cas ;
// un rechargement récupère l'index courant (garde-fou anti-boucle dans le module).
window.addEventListener("vite:preloadError", () => {
  rechargerPourNouvelleVersion();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
