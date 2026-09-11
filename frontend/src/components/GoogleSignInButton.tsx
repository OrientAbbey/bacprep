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
  const callbackRef = useRef(onCredential);
  const { theme } = useTheme();

  // Met à jour le ref sans re-lancer l'effet → le callback pointe
  // toujours vers la dernière version (anti stale closure).
  callbackRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;

    function render() {
      if (cancelled || !window.google || !divRef.current) return;
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
        callback: (response: { credential: string }) => callbackRef.current(response.credential),
      });
      render();
    }

    if (window.google) {
      init();
    } else {
      scriptEl = document.createElement("script");
      scriptEl.src = "https://accounts.google.com/gsi/client";
      scriptEl.async = true;
      scriptEl.defer = true;
      scriptEl.onload = init;
      document.body.appendChild(scriptEl);
    }

    return () => {
      cancelled = true;
      scriptEl?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, theme]);

  return <div ref={divRef} />;
}
