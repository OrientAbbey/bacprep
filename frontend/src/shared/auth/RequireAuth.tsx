import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { t } from "../../i18n";

/** Écran d'attente affiché pendant la résolution de la session. */
export function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-paper text-ink-soft font-mono-tag text-sm">
      {t("Chargement…")}
    </div>
  );
}

/** Garde de route : affiche les enfants si l'utilisateur est connecté, sinon redirige vers la connexion. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/connexion" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
