import React, { Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./shared/auth/AuthProvider";
import { RequireAdmin } from "./shared/auth/RequireAdmin";
import { RequireAuth } from "./shared/auth/RequireAuth";
import { ConsentModal } from "./shared/ui/ConsentModal";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { Layout } from "./shared/ui/Layout";
import { ToastProvider } from "./shared/ui/Toast";
import { ThemeProvider } from "./shared/theme/ThemeProvider";
import { Skeleton, ViewerSkeleton } from "./shared/ui/Skeleton";
import { t } from "./i18n";

// Découpage de code : le back-office (utilisé par une poignée de personnes)
// est chargé dynamiquement plutôt que d'alourdir le paquet initial.
const ViewerPage = React.lazy(() => import("./pages/ViewerPage").then((m) => ({ default: m.ViewerPage })));
const ProfilePage = React.lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const AdminPage = React.lazy(() => import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const AidePage = React.lazy(() => import("./pages/AidePage").then((m) => ({ default: m.AidePage })));
const AdminHelpPage = React.lazy(() => import("./pages/aide/AdminHelpPage").then((m) => ({ default: m.AdminHelpPage })));
const AProposPage = React.lazy(() => import("./pages/AProposPage").then((m) => ({ default: m.AProposPage })));
const LegalPage = React.lazy(() => import("./pages/LegalPage").then((m) => ({ default: m.LegalPage })));
const EntrainementPage = React.lazy(() => import("./pages/EntrainementPage").then((m) => ({ default: m.EntrainementPage })));
const HomePage = React.lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const CataloguePage = React.lazy(() => import("./pages/CataloguePage").then((m) => ({ default: m.CataloguePage })));
const CalendrierPage = React.lazy(() => import("./pages/CalendrierPage").then((m) => ({ default: m.CalendrierPage })));
const SubscribePage = React.lazy(() => import("./pages/SubscribePage").then((m) => ({ default: m.SubscribePage })));
const LoginPage = React.lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const NotFoundPage = React.lazy(() => import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })));

function KickoutBanner() {
  const { kickoutMessage, clearKickoutMessage } = useAuth();
  if (!kickoutMessage) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between bg-correction px-4 py-2 text-sm text-paper">
      <span>{kickoutMessage}</span>
      <button onClick={clearKickoutMessage} className="underline">
        {t("Fermer")}
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
 *   - `/profil` : connexion requise ;
 *   - `/admin` : réservé aux comptes de la liste blanche admin (RequireAdmin).
 */
/** Composant racine : routeurs, fournisseurs de contexte et mise en page globale. */
export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          <AuthProvider>
            <KickoutBanner />
            <ConsentModal />
            <Routes>
              {/* Routes avec Layout commun (Outlet) */}
              <Route element={<Layout />}>
                <Route
                  path="/"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <HomePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/secondaire/:classe"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <CataloguePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/catalogue"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <CataloguePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/epreuve/:id"
                  element={
                    <Suspense fallback={<ViewerSkeleton />}>
                      <ViewerPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/abonnement"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <SubscribePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/calendrier"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <CalendrierPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/aide"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <AidePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/a-propos"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <AProposPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/confidentialite"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <LegalPage kind="privacy" />
                    </Suspense>
                  }
                />
                <Route
                  path="/conditions"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <LegalPage kind="terms" />
                    </Suspense>
                  }
                />
                <Route
                  path="*"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <NotFoundPage />
                    </Suspense>
                  }
                />
              </Route>

              {/* Routes sans Layout */}
              <Route
                path="/connexion"
                element={
                  <Suspense fallback={<Skeleton className="h-64" />}>
                    <LoginPage />
                  </Suspense>
                }
              />

              {/* Routes protégées auth avec Layout : l'entraînement est
                  réservé aux comptes connectés (les exercices ne sont ni
                  publics ni indexables). */}
              <Route element={<RequireAuth><Layout /></RequireAuth>}>
                <Route
                  path="/entrainement"
                  element={
                    <Suspense fallback={<Skeleton className="h-64" />}>
                      <EntrainementPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/profil"
                  element={
                    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
                      <ProfilePage />
                    </Suspense>
                  }
                />
              </Route>

              {/* Admin : RequireAdmin + Layout + Suspense */}
              <Route
                path="/admin"
                element={
                  <RequireAdmin>
                    <Layout>
                      <Suspense fallback={<p className="text-sm text-slate">{t("Chargement…")}</p>}>
                        <AdminPage />
                      </Suspense>
                    </Layout>
                  </RequireAdmin>
                }
              />

              {/* Aide de la console : même garde que /admin, chargée à la demande
                  (un élève ne télécharge pas ce guide). */}
              <Route
                path="/aide/admin"
                element={
                  <RequireAdmin>
                    <Layout>
                      <Suspense fallback={<Skeleton className="h-64" />}>
                        <AdminHelpPage />
                      </Suspense>
                    </Layout>
                  </RequireAdmin>
                }
              />

            </Routes>
          </AuthProvider>
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  );
}
