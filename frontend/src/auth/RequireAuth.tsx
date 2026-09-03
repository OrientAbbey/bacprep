import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper text-ink-soft font-mono-tag text-sm">
        Chargement…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/connexion" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
