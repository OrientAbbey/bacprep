import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError, BASE_URL } from "../api/client";
import { useToast } from "../components/Toast";
import { t } from "../i18n";

export interface User {
  id: string;
  email: string;
  nom: string;
  created_at: string;
  /** Vrai si l'email est dans la liste blanche admin (calculé serveur) —
   * conditionne l'affichage du lien et l'accès à la page /admin. */
  is_admin: boolean;
  /** Consentements (null = modale pas encore répondue). */
  consent_ia: boolean | null;
  consent_notes: boolean | null;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  kickoutMessage: string | null;
  clearKickoutMessage: () => void;
  loginMock: (email: string, nom: string) => Promise<void>;
  loginGoogle: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Recharge /api/auth/me pour refléter un changement de consentement
   * (modale de première connexion, réglages du profil) — renvoie l'utilisateur
   * relu, ou null si la session est invalide : l'appelant (modale de
   * consentement) s'en sert pour CONFIRMER côté serveur avant de se fermer. */
  refreshConsentement: () => Promise<User | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

/** Plateforme de l'appareil : "mobile" sur smartphone/tablette (UA mobile
 * OU écran tactile étroit), "web" sinon. Envoyée à la connexion et affichée
 * dans le fil d'activité du profil (« Connexion à ton compte (mobile) /
 * (ordinateur) »). */
export function detectPlatform(): "mobile" | "web" {
  if (typeof navigator === "undefined") return "web";
  const mobileUa =
    typeof navigator.userAgent === "string" &&
    /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent);
  return mobileUa || (navigator.maxTouchPoints > 0 && window.innerWidth < 1024) ? "mobile" : "web";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [kickoutMessage, setKickoutMessage] = useState<string | null>(null);
  const { showToast } = useToast();

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);

  const openSocket = useCallback(() => {
    const wsUrl = (BASE_URL || window.location.origin).replace(/^http/, "ws") + "/ws/session";
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      reconnectAttempt.current = 0;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "kicked_out") {
          setKickoutMessage(data.message || t("Votre session a été fermée."));
          intentionalClose.current = true; // plus de session à surveiller
          setUser(null);
        }
      } catch {
        // message non JSON, ignoré
      }
    };

    socket.onclose = () => {
      if (intentionalClose.current) return;
      // Ce socket n'est plus le socket ACTIF (un plus récent a été ouvert,
      // ex. reconnexion au login via completeLogin → closeSocket(false) puis
      // openSocket()) : ignorer sa fermeture. Sans ce garde-fou, la
      // reconnexion planifiée par l'ancien onclose ouvrait un socket
      // PARASITE en plus (revue 2026-09, REVUE_FRONTEND.md F5).
      if (wsRef.current !== socket) return;
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS.length - 1)];
      reconnectAttempt.current += 1;
      reconnectTimer.current = setTimeout(openSocket, delay);
    };
  }, []);

  const closeSocket = useCallback((intentional: boolean) => {
    intentionalClose.current = intentional;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.get<User>("/api/auth/me");
      setUser(me);
      intentionalClose.current = false;
      reconnectAttempt.current = 0;
      openSocket();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [openSocket]);

  useEffect(() => {
    refreshMe();
    return () => closeSocket(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Post-traitement commun aux modes de connexion (mock, Google) : état
  // utilisateur, reconnexion du websocket de session, notification.
  const completeLogin = useCallback(
    (me: User) => {
      setUser(me);
      closeSocket(false);
      intentionalClose.current = false;
      reconnectAttempt.current = 0;
      openSocket();
      showToast(`Bienvenue, ${me.nom} !`, "success");
    },
    [closeSocket, openSocket, showToast],
  );

  const loginMock = async (email: string, nom: string) => {
    completeLogin(await api.post<User>("/api/auth/mock-login", { email, nom, platform: detectPlatform() }));
  };

  const loginGoogle = async (idToken: string) => {
    completeLogin(
      await api.post<User>("/api/auth/google-login", { id_token: idToken, platform: detectPlatform() }),
    );
  };

  const logout = async () => {
    closeSocket(true);
    await api.post("/api/auth/logout");
    setUser(null);
    showToast(t("Déconnexion réussie."), "info");
  };

  const refreshConsentement = useCallback(async (): Promise<User | null> => {
    try {
      const me = await api.get<User>("/api/auth/me");
      setUser(me);
      return me;
    } catch {
      return null;
    }
  }, []);

  const clearKickoutMessage = () => setKickoutMessage(null);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        kickoutMessage,
        clearKickoutMessage,
        loginMock,
        loginGoogle,
        logout,
        refreshConsentement,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé dans un AuthProvider");
  return ctx;
}
