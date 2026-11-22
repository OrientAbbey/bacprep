# Plan — application native (APK / exe / Apple)

Objectif : proposer Copies & Corrigés au-delà du navigateur, **sans réécrire l'interface**. Le socle est une PWA (manifeste, icônes, service worker, lecture hors-ligne) déjà en place : le passage au natif est du conditionnement, pas un nouveau produit.

Règle d'or : chaque étape est livrée séparément, avec tests verts et sans régression sur le web. Le plan est ordonné par rentabilité, pas par fantaisie.

---

## Étape 1 — PWA « Ajouter à l'écran d'accueil » + guide ✅

Livrée dans la PR #26.

- Bouton d'installation native quand le navigateur émet `beforeinstallprompt` (Chrome / Android / ordinateur), affiché dans la rubrique dédiée de l'aide.
- Refus mémorisé 30 jours (`bacprep_install_refus`) pour ne pas harceler l'élève.
- Guide court dans l'aide : Android/Chrome, iPhone/iPad (Safari → Partager → « Sur l'écran d'accueil »), ordinateur (icône dans la barre d'adresse), désinstallation.
- Lien de découverte dans le pied de page.
- Helpers purs et testés dans `shared/lib/installation.ts`.

---

## Étape 2 — Capacitor → Android APK (à faire en priorité)

Approche : [Capacitor](https://capacitorjs.com/) enveloppe le build React existant (`frontend/dist`) dans une WebView native. **Aucune réécriture de l'UI.** Charge estimée : 1 à 2 semaines, dont ~60 % sur l'authentification.

### Les 5 points bloquants et leurs solutions

**1. Origine de l'API et build natif**
- `frontend/src/api/client.ts:3` : `BASE_URL = import.meta.env.VITE_API_URL || ""`. Vide = same-origin. Dans Capacitor, l'origine est `capacitor://localhost` (iOS) / `http://localhost` (Android) → tous les appels partent dans la WebView et meurent en 404.
- *Solution* : un build dédié `npm run build:native` avec `VITE_API_URL=https://<domaine>` et un drapeau `VITE_NATIVE=1`. Le build web garde ses variables vides et ses tests verts.

**2. Session cross-origin — le point le plus dur**
- `api_auth.py:65-72` pose `bacprep_session` en `HttpOnly; SameSite=Lax; Secure`. Depuis `capacitor://localhost` vers `https://domaine`, c'est cross-site : le cookie `Lax` n'est pas envoyé sur les `fetch` (`credentials: "include"` ne suffit pas). Le WebSocket (`routers/ws.py:30-32`) parse le cookie manuellement → même problème.
- *Solutions écartées* : `SameSite=None; Secure` affaiblirait le CSRF de tout le site web ; servir la WebView depuis `https://domaine` (`server.url`) marche mais perd le hors-ligne et ressemble à un simple wrapper.
- *Solution retenue* : **token Bearer pour le natif**. Le session store existe déjà : faire accepter `Authorization: Bearer <token>` par `store.resolve_session` en plus du cookie. `require_user`/`optional_user` gardent la même logique, zéro nouveau secret, le cookie web reste inchangé. Stocker le token via `@capacitor/preferences` (pas `localStorage`, exposé au XSS dans la WebView).

**3. Google sign-in dans une WebView**
- Google Identity Services refuse le login dans un WebView embarqué → le bouton GIS actuel ne fonctionnera pas dans l'app.
- *Solution* : en mode natif, ouvrir le **navigateur système** via `@capacitor/browser` (Chrome Custom Tabs / `ASWebAuthenticationSession`) :
  1. `GET /api/auth/native/start` → redirection Google avec `redirect_uri=https://domaine/api/auth/native/callback` ;
  2. le callback backend vérifie le code avec le `google-auth` déjà utilisé (`verify_oauth2_token`), crée la session, redirige vers `bacprep://auth/callback#token=...` ;
  3. `@capacitor/app` (`appUrlOpen`) récupère le token et le stocke.
- À déclarer dans Google Console : l'URI de redirect callback. Alternative plus rapide : plugin Google natif renvoyant un ID token à `/api/auth/google-login` (déjà existant), mais il faut quand même la variante « répondre un token » pour le point 2.

**4. CORS, WebSocket et liens partagés**
- `main.py:515` (`CORS_ORIGINS`) et `ws.py:37-43` (`_origine_autorisee`) sont des listes fermées → ajouter explicitement `capacitor://localhost` et `http://localhost`. Pas de `*` : avec `credentials`, les navigateurs refusent. Un oubli sur le WS = kick-out non notifié.
- `Invitation.tsx:22` fait `urlSite(window.location.origin)` → dans l'app, les messages WhatsApp/Facebook contiendraient `capacitor://localhost/`. `seo._url_publique` utilise déjà `PUBLIC_BASE_URL`. *Solution* : exposer `PUBLIC_BASE_URL` dans `/api/auth/config` (déjà appelé au démarrage) et l'utiliser pour `urlSite` en mode natif.

**5. Hors-ligne, distribution et disponibilité**
- `horsLigne.ts:40` teste `caches` + `serviceWorker`. Android WebView (Chromium) devrait fonctionner ; WKWebView (iOS, étape 4) est irrégulier. *Solution* : garder Cache API pour l'APK, prévoir un adaptateur `@capacitor/filesystem` derrière l'interface existante (`telecharger`, `retirer`, `estTelechargee`) — ne pas réécrire les écrans.
- **APK en direct d'abord** (pas de Play Store → pas de règle IAP) ; test interne Play ensuite. Réutiliser `icon-512.png` / `icon-maskable-512.png`.
- Render Free se réveille en ~1 min : le client a déjà `TIMEOUT_DEFAUT_MS = 60_000` et le bandeau `ServeurLent`, mais le plan Starter (~7 $/mois) est recommandé avant diffusion.

### Ordre proposé pour le spike

1. Installer Capacitor + `cap add android`, `npm run build:native`, ouvrir Android Studio, générer un APK debug **avec un écran vide** → valider la chaîne d'outils (½ jour).
2. Ajouter les origines natives à CORS + WS, brancher `VITE_API_URL` → valider que les routes publiques répondent (½ jour).
3. Implémenter le Bearer + l'adapter client (`api/client.ts`) → valider `/api/auth/me` connecté (2–3 jours). **60 % du travail.**
4. Brancher le navigateur système + deep link Google (2–3 jours).
5. Corriger `urlSite` et tester le hors-ligne (1 jour).
6. APK signé + diffusion interne (1 jour).

**Définition de done** : un APK installé sur un téléphone physique, connexion Google réussie, `/api/auth/me` OK, une épreuve lue hors-ligne, un lien de partage pointant sur le domaine HTTPS, et le build web inchangé (tests verts).

Décision prise : **on ne lance pas maintenant** ; ce spike sera repris une autre fois.

---

## Étape 3 — Tauri (desktop Windows / Linux / macOS)

- Tauri plutôt qu'Electron : ~10 Mo au lieu de ~150 Mo, meilleure surface d'attaque.
- Intérêt réel uniquement si les administrateurs réclament un client dédié ; sinon un raccourci PWA suffit.
- Réutilise le même build web ; pas de changement backend prévu.

---

## Étape 4 — iOS / App Store (conditionnelle)

- Compte Apple Developer ~99 $/an, Mac + Xcode ou CI cloud (Codemagic), signature, privacy manifest, revue.
- **Règle IAP** : les abonnements numériques payés via Orange/MTN doivent passer par l'in-app purchase (commission 15–30 %), ou être retirés de la version iOS. À trancher avant de commencer.
- Risque de rejet « simple wrapper web » (guideline 4.2) ; les fonctions hors-ligne aident.
- À ne lancer que si la demande iOS est validée **et** le modèle économique arbitré.

---

## Contraintes transverses

- **Backend en veille** : le plan Render Free se réveille au premier accès. UptimeRobot (ping `/api/health/live` toutes les 5 min) limite le problème ; le plan Starter (~7 $/mois) reste la seule solution déterministe pour une expérience mobile fluide.
- **Mises à jour** : le web se met à jour instantanément, une app native repasse par revue. Garder le plus de logique côté serveur/PWA possible.
- **Aucun changement d'URL publique, de paramètre de requête ni de règle de sécurité** lors du passage au natif.
