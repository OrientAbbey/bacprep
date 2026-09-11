import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  showToast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const AUTO_DISMISS_MS = 4000;

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-valide/30 bg-valide-soft text-valide",
  error: "border-correction/30 bg-correction-soft text-correction",
  info: "border-highlight/30 bg-highlight-soft text-highlight-ink",
};

const KIND_ICON: Record<ToastKind, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

/**
 * Notifications éphémères en haut à droite de l'écran (connexion,
 * déconnexion, sauvegarde d'épreuve, upload d'image, etc.) — remplace les
 * messages de confirmation auparavant affichés en haut d'un formulaire
 * (peu visibles une fois la page longue, ou carrément hors de vue après
 * une action en bas de page).
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Nettoyage des minuteries au démontage du provider (évite un setState
  // sur un composant démonté si l'app se ferme avant les 4 s).
  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const showToast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
    timersRef.current.push(timer);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => {
          const Icon = KIND_ICON[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg ${KIND_STYLES[t.kind]}`}
            >
              <Icon size={16} strokeWidth={2} />
              <p className="flex-1">{t.message}</p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Fermer la notification"
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast doit être utilisé dans un ToastProvider");
  return ctx;
}
