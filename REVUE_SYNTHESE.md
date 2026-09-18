# Synthèse de la revue — BacPrep (2026-09-18)

Baseline avant correction : **138 tests backend** OK, **64 tests frontend** OK.

## Vue d'ensemble

Le projet est globalement sain : architecture claire (FastAPI + SQLAlchemy, React/Vite/TS), contrôle d'accès sérieux (URLs signées HMAC, verrou admin singleton, paywall), Pydantic strict, bonne couverture de tests. Les défauts relevés sont **concentrés** sur deux zones :

1. **Gestion des épreuves côté admin** (suppression/écriture des fichiers, signature des URLs dans le markdown, état du formulaire entre onglets) ;
2. **Cohérence du paywall / suivi d'abonnement** (voie assistant persistée, suppression d'épreuve qui « élargit » un abonnement, contenu payant resté à l'écran après kick-out).

## Risques prioritaires (ordre de traitement)

| # | Risque | Sévérité | Impact |
|---|--------|----------|--------|
| 1 | Abonnement élargi à toute la série quand l'épreuve ciblée est supprimée (B4) | **CRITIQUE** | Revenus / paywall |
| 2 | Contenu accessible sans abonnement via conversation persistée de l'assistant (B3) | **CRITIQUE** | Revenus / paywall |
| 3 | Fichiers supprimés hors transaction → contenu perdu à mi-écriture (B2) | **CRITIQUE** | Perte de données /
contenu |
| 4 | Images admin cassées au reload (URls/jetons divergents) (B1+F1) | **REQUIS** | UX admin, liens morts |
| 5 | Documents re-créés à chaque save (ids obsolètes, 404) (F3/F4) | **REQUIS** | UX admin |
| 6 | Kick-out/logout → contenu payant toujours affiché (F6) | **REQUIS** | Paywall / confidentialité |
| 7 | Course double login → IntegrityError/500 (B5) | **REQUIS** | Stabilité login |
| 8 | Socket WebSocket dupliqué après reconnexion (F5) | **REQUIS** | Stabilité session |
| 9 | Renommage référentiel orphelinise les épreuves (B6) | **REQUIS** | Cohérence données |
| 10 | État du formulaire épreuve perdu entre onglets admin (F2) | **REQUIS** | UX admin |
| 11 | Chronomètre : « Reprendre » repart du début (F8) | **REQUIS** | UX élève |
| 12 | Deep link `?conv=` mort (F7) | OPTIONNEL | UX profil |

## Ce qui est solide (à ne pas casser)

- Signature HMAC des URLs média avec TTL (core/signing.py) + re-signature à chaque GET public.
- Session admin : verrou singleton persistant, création atomique (UPDATE conditionnel → INSERT), fenêtre d'inactivité, prise de contrôle forcée journalisée.
- `admin_session.py` a été relu : le mécanisme de course sur la PK est déjà maîtrisé (pas de fix fantôme à y faire).
- `admin_referentiel.py::_usage_counts` : comptage agrégé efficace (2 requêtes), DELETE préservant les épreuves (cohérent).
- Requêtes ORM uniquement, pas d'interpolation SQL brute ; envs de secrets via variables d'environnement.

## Corrections au programme

Voir `PLAN_CORRECTIONS_2026-09-18.md` : 12 corrections, groupées par zone
(épreuves admin B1/B2/F3/F4/F2, paywall B3/B4/F6, stabilité B5/F5, cohérence B6, UX F7/F8), chacune avec son critère de vérification.