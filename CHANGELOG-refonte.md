# Refonte d'octobre 2026 — journal des changements

Base : `main` @ `7694149`. Branche : `refonte` (une série de commits par lot).

| Lot | Commit | Contenu |
|---|---|---|
| 0 | `ops:` | CI GitHub Actions, Dependabot, requirements-dev, test de contrat frontend↔API, page 404 |
| 1 | `sec:` | Quotas IA journaliers, IP cliente configurable, Origin WebSocket, CSP en rapport seul, jeton `token_urlsafe`, `/api/health` (SELECT 1) |
| 2 | `plans:` | Table `plans`, onglet admin « Formules », page Abonnement dynamique, `plan_id` au checkout |
| 3 | `perf:` | Lecteur/profil en lazy, polices hébergées, assets immuables, bandeau « serveur lent », recherche sans accents (PostgreSQL `unaccent`), keep-alive Supabase |
| 4 | `ui:` | Catalogue par matière puis par année, colonne admin Épreuves collante, barre d'onglets mobile, taille du texte, doré accessible |
| 4b | `test:` | Suite sur PostgreSQL, contrat `.env.example`, contexte de l'assistant vérifié côté serveur, E2E Chromium |
| 5 | `feat:` | Calendrier (public + admin), compte à rebours, examen blanc, « à revoir », révisions du jour, export PDF |
| 6 | `i18n:` | Interface élève FR/EN, formules bilingues, assistant dans la langue de l'élève |
| 7 | `pwa:` | Manifeste, service worker, lecture hors-ligne, bandeau réseau |
| 8 | `admin-ai:` | Assistant du back-office sur tous les onglets, actions confirmées, liste blanche, journal |
| 9 | `ops:` | Logs JSON, sauvegarde hebdomadaire par jeton, `render.yaml`, ruff, `PAIEMENT.md` (en pause) |

## À faire après application du bundle
1. `git fetch bacprep-refonte.bundle refonte:refonte` puis relecture / `git push` (je n'ai pas d'accès GitHub).
2. Render : ajouter le secret `CRON_TOKEN` ; secrets GitHub : `CRON_TOKEN` ; voir `DEPLOIEMENT.md` § « Mise en service ».
3. Contrôle IP : `GET /api/health/ip` avec un faux `True-Client-IP` (voir `DEPLOIEMENT.md`).
4. Laisser `DEMO_MODE=false` : le paiement est en pause, personne ne peut acheter tant qu'il n'est pas repris.

## Non réalisé (volontairement ou faute de preuve)
- Paiement réel (en pause, documenté dans `PAIEMENT.md`).
- Découpage de `AssistantPanel` / `EpreuvesPanel` (≈ 1 100 lignes chacun) : refactor sans gain fonctionnel, contraire à la règle « minimum de code ».
- Messages d'erreur du serveur : restent en français dans l'interface anglaise.
- Mesures Lighthouse et tests sur téléphone réel / site Render déployé : non faits.
