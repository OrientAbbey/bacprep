import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

/**
 * Garde de la route /admin : réserve la page aux utilisateurs CONNECTÉS dont l'email est dans la
 * liste blanche admin (`is_admin`, calculé serveur). Simple commodité d'affichage : le back-office
 * reste protégé par le jeton admin et la liste blanche, vérifiés à CHAQUE appel API.
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <ReserveAdmin>{children}</ReserveAdmin>
    </RequireAuth>
  );
}

function ReserveAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.is_admin) return <>{children}</>;
  return (
    <div className="mx-auto mt-10 max-w-md rounded-lg border border-correction/30 bg-correction-soft p-6 text-center text-correction">
      <p className="text-sm">La console d'administration est réservée aux comptes autorisés.</p>
      <Link to="/" className="mt-3 inline-block text-sm underline hover:opacity-80">
        Retour à l'accueil
      </Link>
    </div>
  );
}
