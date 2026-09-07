import React, { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { RequireAdmin } from "./auth/RequireAdmin";
import { RequireAuth } from "./auth/RequireAuth";
import { ConsentModal } from "./components/ConsentModal";
import { Layout } from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { ThemeProvider } from "./theme/ThemeProvider";
import { CataloguePage } from "./pages/CataloguePage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SubscribePage } from "./pages/SubscribePage";
import { ViewerPage } from "./pages/ViewerPage";

// Découpage de code : le back-office (utilisé par une poignée de personnes)
// est chargé dynamiquement plutôt que d'alourdir le paquet initial.
const AdminPage = React.lazy(() => import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })));

function KickoutBanner() {
  const { kickoutMessage, clearKickoutMessage } = useAuth();
  if (!kickoutMessage) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between bg-correction px-4 py-2 text-sm text-white">
      <span>{kickoutMessage}</span>
      <button onClick={clearKickoutMessage} className="underline">
        Fermer
      </button>
    </div>
  );
}

/**
 * Navigation publique depuis la refonte multi-classes :
 * - `/` : accueil (niveau → classe) et recherche globale — SANS connexion ;
 * - `/secondaire/:classe` : catalogue filtrable d'une classe — public ;
 * - `/catalogue?q=` : résultats de recherche globale — public ;
 * - `/epreuve/:id` : lecteur — PUBLIC pour les épreuves gratuites (mode
 *   visiteur ; les épreuves payantes renvoient vers la connexion) ;
 * - `/abonnement` : grille des forfaits — publique, la souscription exige
 *   elle un compte ;
 * - `/connexion` : page de connexion ;
 * - `/profil` : connexion requise ;
 * - `/admin` : réservé aux comptes de la liste blanche admin (RequireAdmin).
 */
export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <KickoutBanner />
          <ConsentModal />
          <Routes>
            <Route
              path="/"
              element={
                <Layout>
                  <HomePage />
                </Layout>
              }
            />
            <Route path="/connexion" element={<LoginPage />} />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <Layout>
                    <Suspense fallback={<p className="text-sm text-slate">Chargement…</p>}>
                      <AdminPage />
                    </Suspense>
                  </Layout>
                </RequireAdmin>
              }
            />
            <Route
              path="/secondaire/:classe"
              element={
                <Layout>
                  <CataloguePage />
                </Layout>
              }
            />
            <Route
              path="/catalogue"
              element={
                <Layout>
                  <CataloguePage />
                </Layout>
              }
            />
            <Route
              path="/epreuve/:id"
              element={
                <Layout>
                  <ViewerPage />
                </Layout>
              }
            />
            <Route
              path="/abonnement"
              element={
                <Layout>
                  <SubscribePage />
                </Layout>
              }
            />
            <Route
              path="/profil"
              element={
                <RequireAuth>
                  <Layout>
                    <ProfilePage />
                  </Layout>
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
