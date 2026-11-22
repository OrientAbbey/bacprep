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

Approche : [Capacitor](https://capacitorjs.com/) enveloppe le build React existant (`frontend/dist`) dans une WebView native. Aucune réécriture de l'UI.

Points bloquants à traiter **avant** de distribuer :

1. **Authentification** — Google Identity Services refuse le login dans un WebView embarqué. Passer par le navigateur système (`@capacitor/browser` → Chrome Custom Tabs / `ASWebAuthenticationSession`) avec un deep link de retour (`appliquer://auth/callback`). Ajouter les origines natives (`capacitor://localhost`, `http://localhost`) à `CORS_ORIGINS` **et** à la vérification d'origine du WebSocket (`backend/app/routers/ws.py`).
2. **Cookie de session** — `SameSite=Lax` posé sur le domaine web ; depuis l'origine native, prévoir soit un token Bearer pour le mobile, soit `SameSite=None; Secure` + CORS `credentials`.
3. **Base de l'API** — `VITE_API_URL` doit être renseigné à la compilation (sinon `BASE_URL=""` = same-origin, faux dans une WebView).
4. **Liens partagés** — vérifier `PUBLIC_BASE_URL` en prod, sinon les liens WhatsApp/Facebook pointent vers `capacitor://localhost`.
5. **Hors-ligne** — `shared/lib/horsLigne.ts` utilise le Cache API + service worker ; le support dans WKWebView est à valider, prévoir un adaptateur `@capacitor/filesystem`.
6. **Distribution** — APK en direct d'abord (contourne les règles IAP du Play Store) ; test interne Play ensuite.

Charge estimée : 1 à 2 semaines. À lancer dès que l'étape 1 est validée par les utilisateurs.

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
