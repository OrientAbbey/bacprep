import { useEffect, useState } from "react";
import { getInitials } from "../lib/initials";
import { urlAvatar } from "../lib/avatar";

/** Photo de profil de l'utilisateur connecté (à placer dans un conteneur rond), ou ses initiales tant qu'il n'en a pas
 * ou si elle ne charge pas. */
export function PhotoProfil({ nom, version }: { nom: string; version?: string | null }) {
  const [echec, setEchec] = useState(false);
  useEffect(() => {
    setEchec(false);
  }, [version]);
  if (!version || echec) return <>{getInitials(nom)}</>;
  return <img src={urlAvatar(version)} alt="" onError={() => setEchec(true)} className="h-full w-full rounded-full object-cover" />;
}
