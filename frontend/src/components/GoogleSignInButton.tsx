import { useEffect, useRef } from "react";
import { useTheme } from "../theme/ThemeProvider";

declare global {
  interface Window {
    google?: any;
  }
}

// GSI n'honore QUE le premier `initialize()` d'une page : ré-initialiser à
// chaque montage (ou changement de thème) liait un callback périmé, d'où des
// comportements de compte incohérents (un e-mail au lieu d'un autre). On
// initialise donc une seule fois par chargement de page.
let gsiInitialise = false;
let promesseScript: Promise<void> | null = null;

// `initialize` n'étant appelé qu'une fois, la fonction enregistrée auprès de
// GSI doit déléguer au composant actuellement monté — sinon le callback
// capturé au premier montage resterait figé après une navigation.
let callbackPartage: (credential: string) => void = () => {};

/** Charge le script GSI une seule fois par page (partagé entre les
 * montages) ; un échec est oublié pour autoriser une nouvelle tentative. */
function chargerScriptGsi(): Promise<void> {
  if (window.google) return Promise.resolve();
  if (!promesseScript) {
    promesseScript = new Promise<void>((resolve, reject) => {
      const scriptEl = document.createElement("script");
      scriptEl.src = "https://accounts.google.com/gsi/client";
      scriptEl.async = true;
      scriptEl.defer = true;
      scriptEl.onload = () => resolve();
      scriptEl.onerror = () => {
        scriptEl.remove();
        promesseScript = null;
        reject(new Error("Chargement du script Google impossible"));
      };
      document.body.appendChild(scriptEl);
    });
  }
  return promesseScript;
}

export function GoogleSignInButton({
  clientId,
  onCredential,
  disabled = false,
}: {
  clientId: string;
  onCredential: (credential: string) => void;
  /** Désactive le bouton pendant une connexion en cours (le rendu GSI est
   * une iframe : on bloque clics et focus sur son conteneur). */
  disabled?: boolean;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const { theme } = useTheme();

  // Met à jour le ref sans re-lancer l'effet → le callback pointe
  // toujours vers la dernière version (anti stale closure).
  callbackRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;

    // Route le callback unique de GSI vers le composant monté courant.
    callbackPartage = (credential) => callbackRef.current(credential);

    function rendre() {
      if (cancelled || !window.google || !divRef.current) return;
      if (!gsiInitialise) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential: string }) => callbackPartage(response.credential),
        });
        gsiInitialise = true;
      }
      // Seul le rendu du bouton suit le thème ; l'initialisation, elle,
      // reste unique pour toute la page.
      divRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(divRef.current, {
        theme: theme === "dark" ? "filled_black" : "outline",
        size: "large",
        width: 280,
      });
    }

    if (window.google) {
      rendre();
    } else {
      chargerScriptGsi()
        .then(() => {
          if (!cancelled) rendre();
        })
        .catch(() => {
          // Silence volontaire : LoginPage signale déjà l'échec de config.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [clientId, theme]);

  return (
    <div
      ref={divRef}
      className={disabled ? "pointer-events-none opacity-60" : undefined}
      aria-disabled={disabled || undefined}
      inert={disabled || undefined}
    />
  );
}
