import React from "react";
import { t } from "../i18n";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // React ne journalise l'erreur QUE dans les builds de développement : sans
  // ce hook, une erreur de rendu en production n'apparaît nulle part dans la
  // console du navigateur, et le message générique affiché à l'utilisateur
  // la rend introuvable. Le détail part dans la console, jamais à l'écran.
  componentDidCatch(error: Error, infos: React.ErrorInfo) {
    console.error("Erreur de rendu interceptée par ErrorBoundary :", error, infos.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-4 text-center">
          <h1 className="font-serif-brand text-xl">{t("Une erreur est survenue")}</h1>
          {/* Message GÉNÉRIQUE : `error.message` était affiché tel quel. Il
              peut contenir des noms de champs SQL, des chemins de fichiers,
              des fragments d'URL ou le texte brut d'une erreur serveur — rien
              de tout cela ne doit être montré à l'utilisateur. Le détail
              reste dans la console (voir componentDidCatch). */}
          <p className="mt-2 max-w-md text-sm text-ink-soft">
            {t("L'application a rencontré un problème inattendu. Actualisez la page pour reprendre.")}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 min-h-[44px] rounded-full bg-ink px-6 text-sm font-medium text-paper hover:opacity-90"
          >
            {t("Recharger la page")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
