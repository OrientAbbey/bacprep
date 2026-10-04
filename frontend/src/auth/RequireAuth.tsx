import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { t } from "../i18n";

export function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-paper text-ink-soft font-mono-tag text-sm">
      {t("Chargement…")}
    </div>
  );
}

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
