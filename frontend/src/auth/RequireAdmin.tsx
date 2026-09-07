import React from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

/**
 * Garde de la route /admin : réserve la page aux utilisateurs CONNECTÉS dont
 * l'email est dans la liste blanche admin (is_admin calculé serveur). C'est
 * une commodité d'affichage — le back-office reste réellement protégé par le
 * jeton admin + liste blanche vérifiés à CHAQUE appel API (défense en
 * profondeur : cacher le bouton n'est pas une sécurité).
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
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

  if (!user.is_admin) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-lg border border-correction/30 bg-correction-soft p-6 text-center text-correction">
        <p className="text-sm">
          La console d'administration est réservée aux comptes autorisés.
        </p>
        <Link to="/" className="mt-3 inline-block text-sm underline hover:opacity-80">
          Retour à l'accueil
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
