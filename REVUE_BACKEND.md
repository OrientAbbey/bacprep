# Revue du backend FastAPI — BacPrep

Date : 2026-09-18 — Périmètre : `backend/app` (routers, core, db) — Méthode : revue multi-axes (correction, sécurité, performance, robustesse, conception) + vérifications manuelles ciblées.

Sévérités : **CRITIQUE** (perte de données / paywall bypass) · **REQUIS** (comportement erroné, doit être corrigé) · **OPTIONNEL** (amélioration) · **NIT** (détail).

---

## 1. Paywall assistanat — bypass via conversation persistée (**REQUIS**)

- **Fichier :** `backend/app/routers/assistant.py:35-47` (`_load_conversation_and_epreuve`)
- **Problème :** la voie « conversation persistée » charge l'épreuve via `get_epreuve_or_404` (aucun contrôle), alors que la voie sans conversation (`assistant.py` éphémère) passe par `get_public_epreuve_or_404` (`backend/app/routers/deps.py:29-42`) qui vérifie `statut == "publie"` **et** `db_layer.has_access`. Conséquence : un utilisateur dont l'abonnement a expiré (ou pour une épreuve dépubliée) continue d'interroger le LLM sur le contenu tant qu'il fournit un `cid` existant.
- **Correction :** remplacer `get_epreuve_or_404` par `get_public_epreuve_or_404` dans `_load_conversation_and_epreuve`.

## 2. Suppression d'une épreuve → abonnement PROMU en pass tout-classe (**REQUIS**)

- **Fichier :** `backend/app/routers/admin_epreuves.py:464-466` (suppression épreuve) + `backend/app/routers/subscriptions.py:229-234` (`_resolve_epreuve_fields`)
- **Problème :** la suppression met `SubscriptionORM.epreuve_id = NULL`. Comme `_resolve_epreuve_fields` enregistre déjà `matiere="ALL"`, `annee="ALL"` (et `classe`, `serie/filiere`, `evaluation`), l'abonnement devient un pass « toutes les épreuves publiées de cette classe + évaluation » : un client dont l'abonnement visait UNE épreuve donnée obtient soudain accès à toute la série. Paywall bypass.
- **Correction :** au lieu de `NULL`, poser `statut = "annulee"` (l'abonnement ciblé doit mourir avec l'épreuve).

## 3. Stockage muté hors transaction → perte de contenu à mi-séquence (**CRITIQUE**)

- **Fichiers :** `backend/app/core/epreuve_files.py:110-138` (`write_document`), `:188-195` (`delete_file`) ; `backend/app/routers/admin_epreuves.py:361-367` (`_replace_sujets`) et `:390-402` (`_relocate_files`) ; `backend/app/routers/import_service.py:160-175`
- **Problème :** les fichiers/documents sont effacés (ou réécrits après suppression) **avant** le `commit` de la transaction. Un échec au milieu (`_relocate_files`, `_replace_sujets`, un SAError) laisse la base pointer vers des clés de stockage supprimées — contenu définitivement perdu.
- **Correction :** pattern en deux phases —
  1. écriture des nouveaux documents (upsert, ids préservés) + commit ;
  2. suppression **best-effort après commit** des fichiers absents du nouveau payload.
  (Corrigé via les points B2/B6 du plan ; l'import fait l'objet d'un traitement similaire.)

## 4. Course double login → IntegrityError/500 (**REQUIS**)

- **Fichier :** `backend/app/core/store.py:50-67` (`get_or_create_user`), `:76-93` (`create_session`)
- **Problème :** `SessionORM.user_id` est clé primaire (`backend/app/db_models.py:73`). Deux `POST /auth/login` simultanés sur un nouvel utilisateur : deux `get_or_create` ajoutent la même ligne → `IntegrityError` sur la dernière transaction → HTTP 500 (au lieu d'une session valide). Constaté aussi par le frontend comme erreur de login aléatoire.
- **Correction :** intercepter `IntegrityError` autour de `db.add`/`db.flush` de l'utilisateur et relire l'utilisateur existant (SELECT après rollback partiel), puis créer normalement la session.

## 5. Renommage d'une option de référentiel : épreuves orphelinisées (**REQUIS**)

- **Fichier :** `backend/app/routers/admin_referentiel.py:123-151` (`admin_update_referentiel_option`)
- **Problème :** le PATCH réécrit `code` sur la seule ligne `referentiel_options`, sans toucher aux colonnes des `EpreuveORM` (et `EpreuveFiliereORM`) déjà saisies avec l'ancienne valeur. Résultat : le formulaire d'épreuve affiche désormais l'épreuve sous une valeur « hors liste », le compteur `en_usage` ne correspond plus à la liste, et le frontend propose des « valeurs hors liste » fantômes. (Le DELETE conserve explicitement les épreuves, cf. docstring :159-162 — cohérent ; le RENAME, lui, est silencieusement destructeur de cohérence.)
- **Correction :** si `en_usage > 0` pour l'ancien code, refuser le changement de `code` (HTTP 409 avec message guide : « modifier le libellé, ou supprimer puis recréer ») ; ne permettre que le changement de `label`/`position`. Laisser le `label` seul être modifiable librement pour ne pas casser les formulaires en cours.

## 6. Incohérences mineures d'endpoints admin (**OPTIONNEL**)

- `admin_epreuves.py` : création/mise à jour sans « idempotence » explicite quand deux saves simultanées arrivent — acceptable au back-office, mais un verrou admin ligne (`admin_lock`) n'empêche pas ce cas. Non bloquant.
- `admin_epreuves.py:175-176` : le markdown renvoyé par `admin_get_epreuve` contient les **anciens** jetons signés (ceux de l'upload), alors que `assets[].url` est re-signé à chaque GET (:206). Divergence balise/URL → voir la contrepartie frontend (REVUE_FRONTEND.md, F1) ; corrigé côté backend en re-signant les URLs du markdown.

## 7. Performance / requêtes (**OPTIONNEL**)

- `store.py::covered_epreuves_condition` / `has_access` : logique correcte ; peut devenir N+1 sur les listes si beaucoup d'abonnements. Déjà regroupée via une seule condition SQL — RAS en l'état.
- `admin_referentiel.py::_usage_counts` : 2 requêtes groupées (épreuves + filières) — bon pattern, à conserver si on ajoute des scopes.
- `import_service` : chargement des fichiers en mémoire (multipart) ; pour de très gros PDF, prévoir streaming. Non bloquant.

## 8. Sécurité générale — vérifiée et OK

- **Signatures d'URLs** (`core/signing.py`) : HMAC signe `file_id + epreuve_id + statut`, TTL 1 h + grâce 300 s. Solide. NB : chaque GET re-signé → un même markdown peut contenir des jetons périmés (cf. point 6/F1).
- **Admin** : cookie HttpOnly + verrou singleton persistant en base (`admin_session.py`), création atomique via UPDATE conditionnel puis INSERT (:129-135) — pas de course sur la PK. `require_admin` (`deps.py`) rafraîchit `last_activity`. OK.
- **WebSocket assistant** : active-connection-checked via `ACTIVE_WEBSOCKETS` (store.py) ; fermeture du socket = déconnexion. À vérifier lors du fix F3 frontend (socket dupliqué).
- **Entrées utilisateur** : Pydantic strict partout (min/max length), Taille des images plafonnée (`MAX_IMAGE_BYTES`), normalisation des filières. Pas de requête brute interpolée (SQLAlchemy ORM uniquement). OK.
- **Sensibilité** : aucun secret en dur ; `ADMIN_ROOT`, `ADMIN_SESSION_TIMEOUT_MINUTES` passés par env. OK.

## 9. Tests backend

- Suite : 138 tests, tous verts avant corrections (chevauchement : `pytest tests -q`, ~180 s).
- Couverture : endpoints publics (listes/accès), subscriptions, auth admin, assistant, import, storage S3 local. Bonne base.

## 10. Liste des corrections prévues (rappel du plan)

| Id | Point | Fichier |
|----|-------|---------|
| B1 | Re-signer les URLs des balises images dans `admin_get_epreuve` | `admin_epreuves.py` |
| B2 | `_replace_sujets` : ne supprimer que les fichiers absents du payload, suppression après commit (préserve les ids de documents) | `admin_epreuves.py` |
| B3 | `_load_conversation_and_epreuve` → `get_public_epreuve_or_404` | `assistant.py` |
| B4 | Suppression épreuve → `statut="annulee"` au lieu de `epreuve_id=NULL` | `admin_epreuves.py` |
| B5 | `IntegrityError` login → relecture utilisateur | `core/store.py` |
| B6 | Rename référentiel bloqué si `en_usage > 0` | `admin_referentiel.py` |