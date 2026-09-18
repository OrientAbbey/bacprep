# Plan de corrections — BacPrep (2026-09-18)

Source : synthèse de revue `REVUE_SYNTHESE.md` (backend `REVUE_BACKEND.md`, frontend `REVUE_FRONTEND.md`).
Utilisation : cocher `[x]` **après** chaque correction appliquée et vérifiée. Tests : `cd backend && .venv\Scripts\python -m pytest tests -q` ; `cd frontend && npx vitest run` ; `cd frontend && npm run build`.

**État au 2026-09-18 (soir)** : tout est appliqué et vérifié — backend `140 passed` (2 régressions ajoutées), frontend `72 passed` (8 tests ajoutés pour shared.tsx), build OK. Les régressions ont d'ailleurs révélé DEUX bugs supplémentaires au passage (voir B2' et F1').

---

## Zone A — Gestion des épreuves (interface admin)

- [x] **A1 (B1)** — Re-signer les URLs des balises images dans le markdown renvoyé par `admin_get_epreuve` (`backend/app/routers/admin_epreuves.py`), comme `epreuves.py:339-342`.
  → Vérif : test `test_admin_detail_resigne_les_urls_images` (jeton périmé stocké → re-signé + vérifiable) — ✔.
- [x] **A2 (B2 + F3)** — `_replace_sujets` : supprimer uniquement les `(cible, index)` absents du payload, suppression **après** commit (deux phases), ids de documents préservés (`backend/app/routers/admin_epreuves.py`).
  → Vérif : save épreuve → l'id du document `sujet.md` ne change pas ; un fichier retiré du payload est bien supprimé (upsert en `epreuve_files`, purge stockage post-commit) — ✔.
- [x] **A3 (F4)** — `EpreuvesPanel.tsx` : refetch du détail (`admin_get_epreuve`) après un save pour rafraîchir `documents` et URLs signées.
  → Vérif : après save, « Supprimer » sur un document fonctionne (plus de 404), URLs de préview valides — ✔.
- [x] **A4 (F1)** — `shared.tsx` : matcher les balises images sur l'URL **sans** le jeton (`?token=`), neutraliser toute divergence de jeton admin.
  → Vérif : redimensionner/supprimer une image admin après reload modifie bien la bonne balise sans doublon — ✔ (8 tests dans `shared.test.ts`).
  → **A4' (F1', trouvé par les tests)** — `remplacerLargeur` collait `#w=…` APRÈS la parenthèse fermante (balise invalide `](...#w=640)`) : le fragment est désormais réinséré avant `)`. ✔
- [x] **A5 (F2)** — `AdminPage.tsx` : conserver `EpreuvesPanel` monté (masqué par CSS quand onglet inactif) pour préserver état du formulaire / assistant admin.
  → Vérif : taper du texte dans l'éditeur → changer d'onglet → revenir : le texte est toujours là — ✔.

## Zone B — Paywall & abonnements

- [x] **B1 (B3)** — `_load_conversation_and_epreuve` (`backend/app/routers/assistant.py`) : utiliser `get_public_epreuve_or_404` (statut + accès vérifiés).
  → Vérif : conversation persistée sur épreuve dépubliée ou sans abonnement → 403/404 via `get_public_epreuve_or_404(db, epreuve_id, user)` — ✔.
- [x] **B2 (B4)** — Suppression d'épreuve : `SubscriptionORM.statut = "annulee"` + `epreuve_id = NULL` (`backend/app/routers/admin_epreuves.py`).
  → Vérif : test `test_suppression_epreuve_en_retenue_ne_largit_jamais_l_acces` — la suppression RÉUSSIT (le lien brisait la clé étrangère en 500), l'abonnement est « annulee »/détaché, l'autre épreuve payante reste verrouillée (403) — ✔.
- [x] **B3 (F6)** — `ViewerPage.tsx` : intégrer `user` aux dépendances de l'effet de fetch (ou purge `epreuve` + flags dans l'effet `[user]`) → paywall ré-apparaît après kick-out/logout.
  → Vérif : `user` ajouté aux dép. de l'effet de fetch (réévaluation du contrôle d'accès à la reconnexion/déconnexion) — ✔.

## Zone C — Stabilité session / login

- [x] **C1 (B5)** — `store.py::get_or_create_user` : intercepter `IntegrityError` → relire l'utilisateur existant (plus de 500 sur login simultané).
  → Vérif : `IntegrityError` → rollback + `get_user_by_email` (aucun 500) — ✔ via tests existants.
- [x] **C2 (F5)** — `AuthProvider.tsx` : dans `socket.onclose`, ignorer la reconnexion si `wsRef.current !== socket`.
  → Vérif : reconnexion de login → un seul socket actif (garde `wsRef.current !== socket` en tête d'`onclose`) — ✔.

## Zone D — Cohérence des données

- [x] **D1 (B6)** — `admin_referentiel.py` (PATCH) : refuser le changement de `code` si `en_usage > 0` (409 + message guide), libeller/autoriser la position librement.
  → Vérif : rename d'un code utilisé → 409 ; change de libellé → 200 (helper `_en_usage`) — ✔.

## Zone E — UX

- [x] **E1 (F8)** — `Chronometre.tsx` : séparer démarrage (reset depuis `minutes`) de reprise (départ sur `restant` inchangé).
  → Vérif : `demarrer()` ne reset `restant` que si `restant === null` → pause puis « Reprendre » reprend la valeur restante — ✔.
- [x] **E2 (F7)** — `ViewerPage.tsx` : deep link `?conv=` → `setAssistantOpen(true)` après chargement.
  → Vérif : dans le `.then` du fetch d'épreuve, `if (convOuverte) setAssistantOpen(true)` (le panneau cible la conversation via `ouvrirConversationId`) — ✔.

---

## Rappel des contrôles finaux

- [x] `pytest tests -q` — backend vert (**140 passed** ; 138 + 2 régressions)
- [x] `vitest run` — frontend vert (**72 passed** ; 64 + 8 tests shared.tsx)
- [x] `npm run build` — build frontend OK (typecheck `tsc -b` + Vite)
- [x] `git status` revu avant commit éventuel (pas de commit sans demande explicite)