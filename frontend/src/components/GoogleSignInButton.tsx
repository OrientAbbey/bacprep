import { useEffect, useRef } from "react";
import { useTheme } from "../theme/ThemeProvider";

declare global {
  interface Window {
    google?: any;
  }
}

export function GoogleSignInButton({
  clientId,
  onCredential,
}: {
  clientId: string;
  onCredential: (credential: string) => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    let cancelled = false;

    function render() {
      if (cancelled || !window.google || !divRef.current) return;
      // Le widget Google est un <iframe> peint une fois par le SDK ; pour
      // qu'il suive notre thème (et reste lisible en mode sombre), on vide
      // le conteneur et on le redessine avec le thème Google adapté
      // ("filled_black" en sombre, "outline" en clair) à chaque bascule.
      divRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(divRef.current, {
        theme: theme === "dark" ? "filled_black" : "outline",
        size: "large",
        width: 280,
      });
    }

    function init() {
      if (cancelled || !window.google || !divRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => onCredential(response.credential),
      });
      render();
    }

    if (window.google) {
      init();
    } else {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = init;
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, theme]);

  return <div ref={divRef} />;
}
