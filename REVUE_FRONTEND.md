# Revue du frontend React/Vite — BacPrep

Date : 2026-09-18 — Périmètre : `frontend/src` (66 fichiers) — Méthode : revue multi-axes + vérifications manuelles ciblées (panneaux admin, viewer, auth).

Sévérités : **CRITIQUE** / **REQUIS** / **OPTIONNEL** / **NIT**.

---

## F1. Admin : retour du markdown avec d'anciens jetons → images cassées au reload (**REQUIS**)

- **Fichiers :** `frontend/src/pages/admin/shared.tsx:16-31` (`extraireBaliseImage`, `remplacerLargeur`) ; `frontend/src/pages/admin/EpreuvesPanel.tsx` (rendu des assets) ; côté API : `backend/app/routers/admin_epreuves.py:175-176` + `:206`.
- **Problème :** après un rechargement de la page, `admin_get_epreuve` renvoie le markdown brut avec l'**ancien** jeton signé ; or tout est réaffiché à partir de `assets[].url` (fraîchement re-signés). `extraireBaliseImage`/`remplacerLargeur` matchent l'URL complète (`...?token=...`), donc :
  - « Insérer image » depuis l'éditeur peut ré-insérer une balise alors qu'un asset existe déjà ;
  - le redimensionnement ne modifie pas la balise trouvée (elle échoue au match) ;
  - « Supprimer » retire le fichier du stockage mais **pas** la balise du markdown → lien mort dans l'épreuve publiée (403/404).
- **Correction :**
  - Backend (B1) : re-signer les URLs des balises images du markdown renvoyé par `admin_get_epreuve`, comme le fait `epreuves.py:339-342`;
  - Frontend : matcher les balises sur l'URL **sans** le `?token=...` (comparer `fileName`), pour neutraliser toute divergence de jeton.

## F2. Admin : l'état du formulaire d'épreuve est perdu au changement d'onglet (**REQUIS**)

- **Fichier :** `frontend/src/pages/AdminPage.tsx` — les panneaux sont montés conditionnellement selon l'onglet actif → `EpreuvesPanel` (formulaire, brouillon, assistant admin ouvert) est démonté à chaque navigation, **perdant toutes les modifications non sauvegardées**.
- **Correction :** conserver les panneaux montés et masquer les inactifs via CSS (à minima garder `EpreuvesPanel` monté en permanence). Le chargement initial paresseux n'est pas nécessaire pour un back-office ; les données restent rafraîchissables manuellement.

## F3. Admin : recréation des documents à chaque save → ids obsolètes (**REQUIS**)

- **Fichier :** `backend/app/routers/admin_epreuves.py:361-367` (`_replace_sujets`) + consommateur `EpreuvesPanel.tsx` (`form.documents`, `onSave`).
- **Problème :** à chaque enregistrement, tous les `sujet*.md`/`corrige*.md` sont supprimés puis réécrits avec de **nouveaux** ids (la suppression se fait avant commit). Côté UI, `form.documents` conserve les anciens ids → liste de documents obsolète et « Supprimer » renvoie 404 après un save.
- **Correction :** côté backend, `_replace_sujets` ne doit supprimer que les `(cible, index)` absents du nouveau payload (l'upsert de `write_document` préserve l'id), et ce **après** commit (cf. plan B2). Côté UI (F4), refetch du détail après chaque save pour rafraîchir `documents` et URLs signées.

## F4. Admin : refetch du détail d'épreuve après un save (**REQUIS**)

- **Fichier :** `frontend/src/pages/admin/EpreuvesPanel.tsx` (handler de sauvegarde).
- **Problème :** après save, la liste des documents et les URLs signées (jetons) restent ceux rendus avant le save ; les assets images pointent sur des jetons déjà consommés/périmés et la liste documents est fausse (voir F3).
- **Correction :** après `POST/PUT` réussi → `admin_get_epreuve` (refetch) pour rebasculer `form.documents` et les URLs sur l'état serveur frais.

## F5. Auth : socket WebSocket dupliqué lors d'une reconnexion de login (**REQUIS**)

- **Fichier :** `frontend/src/auth/AuthProvider.tsx` (`completeLogin` → `closeSocket(false)` ; gestionnaires `socket.onclose`).
- **Problème :** `completeLogin` ferme l'ancien socket avec `intentionalClose=false`. Son handler `onclose` planifie alors une reconnexion (car `intentionalClose=false`) **alors qu'un nouveau socket est déjà ouvert** → ~2 s plus tard, un socket parasite en plus → sauvegarde/annulation d'états croisés, déconnexions fantômes.
- **Correction :** dans `socket.onclose`, ignorer la reconnexion si `wsRef.current !== socket` (le socket fermé n'est plus l'actif).

## F6. Viewer : le contenu payant reste affiché après kick-out / logout (**REQUIS**)

- **Fichier :** `frontend/src/pages/ViewerPage.tsx:130-165` (effets `useEffect`).
- **Problème :** l'effet de chargement de l'épreuve ne dépend que de `[id]`. Quand `user` est purgé (kick-out pour abonnement expiré, logout), ni la protection d'accès ni l'affichage ne sont re-évalués : le sujet/corrigé (prix) reste lisible à l'écran et le paywall n'apparaît pas. Le commentaire lignes 158-160 documente le comportement voulu mais non implémenté.
- **Correction :** intégrer `user` dans les dépendances de l'effet de fetch (ou déclencher une purge de `epreuve` + reset des flags d'accès dans l'effet `[user]`), de sorte que tout changement de session re-déclenche le contrôle d'accès et affiche le paywall.

## F7. Viewer : le deep link `?conv=` n'ouvre jamais l'assistant (**OPTIONNEL**)

- **Fichiers :** `frontend/src/pages/ViewerPage.tsx:73, 354, 617, 627` (`convOuverte`) ; `frontend/src/pages/ProfilePage.tsx:715-717` (construction du lien).
- **Problème :** `convOuverte` est lu mais ne déclenche jamais `setAssistantOpen(true)` ou `setNoteOuverte`. Le lien « reprendre la conversation » depuis le profil ne fait qu'ouvrir l'épreuve, sans rouvrir le panneau.
- **Correction :** effet `[id]` : si `convOuverte` → `setAssistantOpen(true)` (après chargement), comme prévu par l'UI.

## F8. Chronomètre : « Reprendre » relance le compte à rebours depuis le début (**REQUIS**)

- **Fichier :** `frontend/src/components/Chronometre.tsx`.
- **Problème :** `demarrer()` réinitialise toujours `setRestant(Math.round(m * 60))` à partir du champ `minutes` d'origine. Après « Pause », « Reprendre » réappelle `demarrer()` → le chrono repart du temps initial au lieu de reprendre à `restant`.
- **Correction :** séparer le démarrage (reset depuis `minutes` + départ) du reprendre (départ sans toucher `restant`).

## F9. Divers / Nits

- `shared.tsx` : `EMPTY_FORM` et helpers bathrooms corrects mais à réutiliser systématiquement pour éviter la duplication des champs (cf. `ReferentielPanel`, `UtilisateursPanel`).
- `api/client.ts` : `authHeaders` n'envoie que `credentials` (cookie admin) — OK en prod (same-origin) ; pensez aux tests dev/API si `VITE_API_URL` est renseigné (cookie cross-origin non envoyé en dev avec des origines différentes).
- `AdminAssistantPanel` : l'application des « modifications » cible l'onglet actif plutôt que le sujet 0 — vérifier l'intention produit avant réécriture ; non bloquant.

## Tests frontend

- Suite : 64 tests, 7 fichiers (`vitest run`), tous verts avant corrections.
- Couverture : composants viewer/paywall/chrono, hook auth, helpers markdown. Bonne base pour couvrir les fixes F1/F6.

## Liste des corrections prévues (rappel du plan)

| Id | Point | Fichier(s) |
|----|-------|------------|
| B1 (partielle) | Re-signature des URLs du markdown en admin | `admin_epreuves.py` |
| F1 | Match des balises images sans jeton | `shared.tsx` |
| F2 | États preservés entre onglets admin | `AdminPage.tsx` |
| F3/F4 | Documents frais après save | `admin_epreuves.py` + `EpreuvesPanel.tsx` |
| F5 | Socket obsolète ignoré au onclose | `AuthProvider.tsx` |
| F6 | Paywall re-évalué au changement de `user` | `ViewerPage.tsx` |
| F7 | Deep link `?conv=` ouvre l'assistant | `ViewerPage.tsx` |
| F8 | Chrono « Reprendre » sans reset | `Chronometre.tsx` |