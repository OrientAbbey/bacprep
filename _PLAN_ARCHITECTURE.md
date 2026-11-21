# Plan de travail — réorganisation architecturale

Plan d'exécution de la proposition détaillée dans `_PROPOSITION_ARCHITECTURE.md`.
Règle d'or : **une phase = une PR verte**, aucune URL ni paramètre de requête public modifié, toutes les suites de tests au vert à chaque étape.

## Principes

- Modular monolith à tranches verticales + noyau partagé mince ; pas de microservices, pas de repositories génériques.
- Dépendances vers l'intérieur : `api → use_cases → queries/infrastructure` ; `core` n'importe jamais `routers`/`domains`.
- Migration progressive (strangler fig) : on construit à côté, on vérifie, puis on retire l'ancien.

## Phase 0 — Garde-fous

- [x] Créer un test de contrainte d'architecture backend (`backend/tests/test_architecture_boundaries.py`) : `core` n'importe pas `routers`, pas de cycle `job_runner ↔ job_queue`, `shared` n'importe pas de domaine (une fois créés).
- [x] Ajouter une contrainte frontend équivalente **sans nouvelle dépendance** : script de vérification des imports (`frontend/scripts/check-boundaries.mjs`, lancé via `npm run check:boundaries`) interdisant `features/* → features/*` et `shared/ui → features/*` ; l'étendre au fur et à mesure de la création des features.
- [x] Vérifier la baseline : `ruff`, pytest, `npm test`, `npm run build`, E2E.

## Phase 1 — Fondations backend (faible risque)

- [x] `core/settings.py` : vue typée et validée de la configuration (Pydantic `BaseModel` + `os.environ`, sans nouvelle dépendance), conservative et utilisable par le nouveau code ; les lectures existantes restent valides.
- [x] `core/errors.py` : erreurs applicatives typées avec `code` + statut HTTP par défaut ; handler global dans `main.py` ; migration progressive de `UploadImageError` en premier.
- [x] Casser le cycle `job_runner ↔ job_queue` : extraire `WORKER_ID` (et les constantes partagées) dans `core/job_definitions.py`, supprimer les imports différés de `job_runner.py`.
- [ ] `shared/deps.py` : faire matter les dépendances partagées depuis `routers/deps.py` sans casser les imports existants (alias de compatibilité), étape préparatoire aux domaines. **Reporté sine die** : 17 routeurs importent `.deps` ; les domaines extraits depuis utilisent `routers.deps` comme contrat stable (aucune duplication). Un alias créerait deux chemins pour la même fonction sans bénéfice.
- [x] Tester : ruff + suite backend complète + E2E.

## Phase 2 — Premier domaine pilote : `entrainement`

- [x] Créer `backend/app/domains/entrainement/` avec `api.py`, `schemas.py`, `moteur.py`, `use_cases.py`.
- [x] Déplacer `core/gabarits.py` → `moteur.py`, `routers/entrainement.py` + `routers/admin_gabarits.py` → `api.py` (deux routeurs inclus).
- [ ] Déplacer `app/gabarits/*.json` sous le domaine, en conservant le chargeur et le cache. **Reporté** : les 19 JSON restent sous `app/gabarits` (le chargeur les résout via `parents[2]`) ; le déplacement n'apporte pas de bénéfice fonctionnel et toucherait les scripts de relecture.
- [x] Conserver **toutes** les URLs (`/api/entrainement/*`, `/api/admin/gabarits/*`) et les codes d'erreur.
- [x] Tester : tests entraînement + E2E entraînement + compatibilité des signalements.

## Phase 3 — Domaines élèves

- [x] `domains/catalogue/` : `routers/epreuves.py`, `core/seo.py`, vues catalogue et consultation.
- [x] `domains/abonnements/` : `routers/subscriptions.py`, `admin_plans.py`, `core/subscriptions.py`, `core/plans.py`, `core/ak.py`.
- [x] `domains/comptes/` : `routers/auth.py`, `me.py`, `avatar.py`, `core/avatar.py`. **Reporté** : `core/store.py` reste dans le noyau (sessions, TTL, stockage) — il n'a pas de frontière comptes autonome et ses imports sont partagés avec les autres domaines.
- [x] Vérifier : E2E catalogue, abonnement, profil, avatar, confidentialité (129/129 et 10/10 scénarios).

## Phase 4 — Domaines admin

- [x] `domains/epreuves_admin/` : `routers/admin_epreuves.py`, `admin_generation.py`, `core/epreuve_files.py`, `core/images.py`, `core/generation_exercices.py`.
- [x] `domains/banque/` : `routers/banque.py`, `admin_banque.py`, `core/banque_generation.py`, journal technique + journal admin.
- [x] `domains/sauvegardes/` : `routers/admin_sauvegardes.py`, `admin_import.py`, `core/export_service.py`, `import_service.py`, `import_parsing.py`, `restore_service.py`, `jobs/`.
- [x] `domains/communication/` : notifications, calendrier, signalements, journal d'audit, stats.
- [x] `domains/assistant/` : `routers/assistant.py`, `admin_assistant.py`, `core/assistant*.py`, `admin_agent*.py`, `admin_approbation.py`, `admin_tools.py`, prompts. **Reporté** : les prompts restent définis inline (`_build_prompt`, `build_admin_prompt`, `prompt_agent`, `prompt_onglet`, génération) ; un `prompts.py` unique n'apporte pas de bénéfice fonctionnel.
- [x] Corriger l'inversion `core/admin_tools.py → routers` : le module vit dans `domains/assistant` et appelle directement les cas d'usage des domaines. **Reporté** : les modèles d'arguments restent dans `admin_tools.py` (ils sont déjà hors de `core`) plutôt que dans un `schemas.py` dédié, sans gain fonctionnel.
- [ ] Vérifier : E2E admin complète (129 scénarios).

## Phase 5 — Frontend par tranches

- [ ] Créer `src/shared/` en déplaçant les composants et helpers réellement transversaux ; conserver `api/client.ts` et `api/types.ts` comme contrat unique.
- [ ] Créer `src/features/entrainement/` (première feature, miroir du domaine backend) avec `index.ts` public.
- [ ] Brancher `npm run check:boundaries` dans la CI et faire respecter les règles.
- [ ] Déplacer progressivement une feature à la fois : `catalogue`, `abonnements`, `compte`, `epreuves`, `admin-epreuves`, `banque`, `assistant`, `sauvegardes`, `communication`.
- [ ] Alléger `pages/` (composition uniquement) et découper `EpreuvesPanel.tsx` (1 302 lignes), `AdminPage.tsx` (593).
- [ ] Introduire TanStack Query pour le server-state (catalogue, options, jobs, journal) sans toucher aux providers.
- [ ] Lazy-loading des routes ; vérifier la baisse du bundle initial.
- [ ] Tester : 313 tests, build, E2E 129 + 10, audit de bundle.

## Phase 6 — Optionnel

- [ ] Alembic si les évolutions de schéma deviennent fréquentes.
- [ ] Supprimer les alias de compatibilité une fois tous les appels migrés.

## Critères d'acceptation finaux

1. Aucune règle d'import violée (backend AST + frontend check:boundaries).
2. Aucun cycle d'import.
3. URLs et paramètres de requête publics inchangés.
4. 992 tests backend, 313 frontend, 129 + 10 E2E au vert.
5. Performance conservée : routes Pillow synchrones, SSE inchangé, bundle initial en baisse.
6. Sécurité conservée : auth par routeur, Pydantic, URL signées, rate limits, headers, CSP.
7. Chaque phase livrée par PR verte fusionnée dans `refonte`.

## Suivi

Cocher au fur et à mesure ; noter inline tout arbitrage écartant la proposition initiale.
