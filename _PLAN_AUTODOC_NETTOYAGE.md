# Plan — rendre le projet autodocumenté et le nettoyer

## Objectif

Rendre le code **self-documenting** sans changer le comportement : noms explicites pour les variables, paramètres, fonctions, classes et types ; docstrings/JSDoc systématiques sur l'API publique ; puis nettoyage du code mort, des types flous et des redondances.

## Principes et garde-fous

- **Aucun changement de comportement ni de contrat API** : uniquement noms locaux, documentation, types et organisation.
- Les renommages de **paramètres publics** Python sont sans risque pour les appels nommés *sauf* si un appel les utilise explicitement : chaque renommage est vérifié par `ruff` + tests.
- Les **noms mathématiques consacrés** (`x`, `n`, `a`, `b` dans les formules polynômes/fractions) sont conservés si le contexte les rend évidents, mais **documentés** dans la docstring (quand renommer nuirait à la lisibilité de la formule).
- Les **tests** ont des noms déjà explicites (`test_..._refuse_...`) : pas de docstring obligatoire, sauf helper non trivial.
- Les modèles **Pydantic** dont les champs portent `Field(description=...)` sont considérés documentés si la classe a une docstring courte.
- Les documents `.md` non suivis préexistants à la racine ne sont **pas touchés**.
- Un commit atomique par phase, sur une branche dédiée, PR verte puis fusion dans `refonte`.

## Inventaire initial (baseline mesurée)

| Métrique | Valeur |
|---|---|
| Définitions publiques `backend/app` sans docstring | **178** (86 fonctions, 40 routes, 39 modèles Pydantic, 13 classes) |
| Exports `frontend/src` sans JSDoc | **167** (83 fonctions, 51 interfaces, 18 const, 13 types, 2 classes) |
| Paramètres Python ≤ 2 lettres | **85** (`p`, `v`, `n`, `x`, `e`, `k`, `bg`, …) |
| `any` TypeScript | **8** (4 dans `lib/markdownSource.ts`, 1 dans `api/client.ts`, 1 dans `components/GoogleSignInButton.tsx`, 2 dans des tests) |
| TODO / FIXME / HACK | **0** |
| Modules backend non importés | **0** |
| `ruff check app tests` | propre |

Répartition backend (docstrings) : `core/storage.py` 25, `routers/admin_banque.py` 21, `models.py` 18, `core/admin_tools.py` 15, `core/job_runner.py` 10, `routers/admin_assistant.py` 9, `core/generation_exercices.py` 7, `routers/calendrier.py` 7, `routers/admin_plans.py` 6, `routers/banque.py` 6, `core/banque_generation.py` 5, `routers/admin_gabarits.py` 5, puis 4 et moins dans les autres.

Répartition frontend (JSDoc) : `api/types.ts` 32, `lib/adminContexte.ts` 7, `lib/entrainement.ts` 7, `pages/admin/shared.tsx` 6, `lib/atelier.ts` 5, `lib/jobs.ts` 5, `api/client.ts` 4, `i18n.ts` 4, `lib/adminAssistant.ts` 4, `lib/ak.ts` 4, `lib/streaming.ts` 4, puis 3 et moins.

## Phase 0 — Garde-fous

- [x] Mesurer l'inventaire initial et le consigner ci-dessus.
- [x] Créer la branche `docs/autodoc-nettoyage` depuis `refonte`.
- [x] Vérifier la baseline verte : `ruff`, pytest, `npm test`, `npm run build` (résultats acquis lors de la livraison précédente, tous verts).

## Phase 1 — Backend : docstrings des modules `core` (≈ 70)

- [x] `core/storage.py` : documenter le protocole `Storage`, ses méthodes (`put_bytes`, `get_bytes`, `put_stream`, `delete`, `presigned_url_or_none`) et les classes concrètes (25).
- [x] `core/admin_tools.py` : docstring de `resume_onglet` et des modèles d'arguments (`IdArgs`, `BannirArgs`, `PlanModifierArgs`, `EvenementArgs`, `OptionArgs`, `VideArgs`, `PartieModifierArgs`, …) — 15.
- [x] `core/job_runner.py` : `dossier_temporaire`, `dossier_job_import`, `cle_source_import`, `noter`, `progresser`, `changer_phase` — 10.
- [x] `core/generation_exercices.py` : `a_des_erreurs`, `prompt_plan`, `prompt_exercice`, `prompt_situation`, `prompt_corrige`, `assembler_sujet`, `etape` — 7.
- [x] `core/banque_generation.py` : `Parametres`, `n`, `ajouter`, `disponible`, `tirer` — 5.
- [x] `core/gabarits.py` : `vue_correction`, `tous`, `resume` — 4 (et documenter le sens de `x`/`n` dans les helpers de calcul).
- [x] `core/export_service.py`, `core/logging_config.py`, `core/plans.py`, `core/import_parsing.py`, `core/import_service.py`, `core/restore_service.py`, `core/seo.py`, `core/textsearch.py`, `core/epreuve_files.py`, `core/admin_approbation.py` — ~15.
- [x] `main.py` : `security_headers`, `robots_txt`, `sitemap_xml` — 3.
- [x] `worker.py`, `scripts/importer.py` : `main` — 2.

## Phase 2 — Backend : docstrings des routeurs et modèles (≈ 108)

- [x] `routers/admin_banque.py` : `PartieIn`, `ExerciceIn`, `ClasseMetaIn`, `ImportIn`, `lister`, `creer_partie`, `modifier_partie`, `supprimer_partie`, `creer_exercice`, `modifier_exercice`, `supprimer_exercice`, `upload_image_banque` — 21.
- [x] `models.py` : 18 modèles de requête/réponse (`MockLoginIn`, `UserOut`, `EpreuveIn`, …) — 18.
- [x] `routers/admin_assistant.py` : `DeplacerIn`, `ExecuterIn`, `ActionPlan`, `CommitIn`, `question_non_blanche`, `historique_borne`, `epreuve_bornee`, `contexte_borne` — 9.
- [x] `routers/calendrier.py` : `EvenementIn`, `EvenementUpdate`, `lister_public`, `lister_admin`, `creer`, `modifier`, `supprimer` — 7.
- [x] `routers/admin_plans.py` (6), `routers/banque.py` (6), `routers/admin_gabarits.py` (5), `routers/admin_sauvegardes.py` (4), `routers/admin_generation.py` (4), `routers/admin_referentiel.py` (2), `routers/avatar.py` (3), `routers/entrainement.py` (3), `routers/essais.py` (3) — ~36.
- [x] Vérifier `ruff check app tests` et les tests backend après chaque lot de fichiers.

## Phase 3 — Backend : noms significatifs

- [x] `core/banque_generation.py` : `p` → `parametres`, `e` → `exercice`, `k` → `cle`, `n` → `nombre`/`quotas` selon le contexte, `Tirage` etc.
- [x] `core/admin_tools.py` : `bg` → `background_tasks`.
- [x] `core/gabarits.py` : renommer les paramètres génériques non mathématiques ; documenter explicitement les symboles mathématiques conservés.
- [x] `core/export_service.py`, `core/job_runner.py` : remplacer `v`, `nb`, `_i`, `_d`, `_o` par des noms explicites.
- [x] Routeurs : `q` → `requete`/` recherche`, `g` → `gabarit`, `zf`/`bg` → noms complets.
- [x] Vérifier qu'aucun appel nommé (`f(cle=...)`) n'est cassé : `ruff` + suite backend complète.

## Phase 4 — Frontend : JSDoc des exports (≈ 167)

- [x] `api/types.ts` : JSDoc de courte (32 interfaces/types) — doc de l'objet, pas repetition des champs déjà explicites.
- [x] `api/client.ts` (4), `i18n.ts` (4), `lib/streaming.ts` (4), `lib/adminAssistant.ts` (4), `lib/ak.ts` (4), `lib/adminContexte.ts` (7), `lib/entrainement.ts` (7), `lib/atelier.ts` (5), `lib/jobs.ts` (5), `lib/referentiel.ts` (3), `lib/renduMath.ts` (3), `auth/AuthProvider.tsx` (3), `components/MetaBadge.tsx` (3), `pages/admin/shared.tsx` (6), puis 1–2 dans les autres — ~135.
- [x] Composants React : JSDoc sur les composants exportés et sur les interfaces de `props` non triviales (quand le nom ne suffit pas).
- [x] Ne pas ajouter de JSDoc redondant du type « /\*\* La fonction machin \*/ » : documenter **l'intention**, les effets de bord et les invariants.

## Phase 5 — Frontend : noms et types explicites

- [x] Remplacer les 8 `any` par des types précis (`lib/markdownSource.ts` 4, `api/client.ts` 1, `components/GoogleSignInButton.tsx` 1, tests 2) — vérifier `tsc -b`.
- [x] Renommer les variables locales cryptiques dans `lib/*` (`e`, `r`, `s`, `t` quand le sens n'est pas immédiat).
- [x] Harmoniser les noms de callbacks/props (`onChanger`, `onClose`, `onAction` déjà cohérents) et corriger les incohérences repérées.

## Phase 6 — Nettoyage

- [x] Supprimer le code mort et les helpers dupliqués repérés pendant la relecture (aucun module mort détecté au départ ; vérifier les fonctions non appelées dans `lib/`).
- [x] Nettoyer les commentaires obsolètes ou qui répètent le code (ex. commentaires « historique » qui ne décrivent plus l'état actuel).
- [x] Vérifier l'absence de `console.log` de debug, de code commenté et de fichiers temporaires dans le dépôt.
- [x] Vérifier la cohérence des traductions (`frontend/src/locales/en.json`) après renommages éventuels de libellés — le test `test_messages_serveur_eleve_traduits` doit rester vert.
- [x] Mettre à jour la documentation racine concernée (`README.md`) si un nom public change, sans toucher aux documents non suivis.

## Phase 7 — Vérifications

- [x] `ruff check app tests` + `ruff format --check` (si configuré).
- [x] Suite backend complète (SQLite) : **992 passed, 1 skipped** attendus.
- [x] Frontend : **313 tests** + `npm run build`.
- [x] E2E : `e2e.mjs` **129/129** + `banque-e2e.mjs` **10/10** sur le build final.
- [x] `git diff --check` propre.
- [x] Test navigateur intégré rapide (pages admin et entraînement) : aucun débordement, aucun message d'erreur console.

## Phase 8 — Livraison

- [ ] Commit atomique par phase (ou lot cohérent), messages explicites.
- [ ] Push de la branche, ouverture d'une PR vers `refonte`.
- [ ] Vérification de **toutes** les PR ouvertes au vert (CI backend SQLite/PostgreSQL + frontend + E2E).
- [ ] Fusion (squash), vérification qu'aucune PR n'est ouverte, synchronisation de `refonte`.
- [x] Cocher la dernière case et clore le plan.

## Critères d'acceptation

1. Toute fonction/classe/méthode **publique** de `backend/app` a une docstring utile (objectif : 178 → 0).
2. Tout export public de `frontend/src` a un JSDoc utile (objectif : 167 → 0).
3. Aucun paramètre cryptique subsiste hors symboles mathématiques documentés (objectif : 85 → ~0 justifié).
4. Aucun `any` TypeScript dans le code de production (objectif : 8 → 0 en prod, 2 en tests tolérés ou typés).
5. Aucun changement fonctionnel : toutes les suites de tests restent au vert.
6. Propreté : `git diff --check` et `ruff` propres, dépôt sans fichier temporaire.

## Suivi de progression

Les cases `- [ ]` sont cochées au fur et à mesure. En cas d'arbitrage (ex. symbole mathématique conservé), la décision est notée inline dans le plan.
