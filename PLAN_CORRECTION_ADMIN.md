# Plan de correction — Console Admin

> Document de suivi de l’implémentation des corrections concernant les
> sauvegardes, les imports, la banque d’exercices et les exercices types.
>
> Les fichiers temporaires et documents non suivis du point 3 restent exclus
> de ce plan et ne doivent pas être modifiés automatiquement.

## État global

- [x] Tous les lots sont implémentés *(lots 1 à 10)*
- [x] La suite backend complète passe (842 tests réussis, 2 ignorés en local,
      Ruff vert ; les deux échecs historiques sont levés :
      `test_acces_type_gratuit` rendu indépendant de l'ordre d'exécution et
      `test_export_et_suppression_compte` corrigé en amont)
- [x] Les tests frontend passent
- [x] Les tests E2E passent
- [ ] Une vérification manuelle en production a été effectuée

> **Dernière validation locale ciblée :** suite backend complète 842 passés /
> 2 ignorés et Ruff vert, 104 tests backend ciblés sauvegardes/imports/jobs/banque,
> 298 tests frontend et `npm run build` réussis. Un import .zip a aussi été
> parcouru dans l’interface locale jusqu’au rapport terminé ; l’inventaire local
> a répondu HTTP 200 avec une liste lisible. Un processus worker distinct a
> repris un job `running` périmé, ré-extrait son archive et terminé l’import.
>
> **Dernière exécution E2E :** 128/128 scénarios réussis (dont bandeau global,
> reprise après navigation, import suivi après rechargement et aides intégrées).
>
> **Reste à faire en priorité :** vérification en production avec Render/S3 et
> contrôle de l'inventaire avec le stockage S3 réel. La CI `refonte` est verte
> sur les quatre jobs (backend SQLite, backend PostgreSQL, frontend, E2E).

## 1. Diagnostic et mesure des performances

### 1.1 Instrumentation backend

- [x] Ajouter `started_at` aux jobs.
- [x] Ajouter `heartbeat_at` aux jobs.
- [x] Ajouter `duration_ms` ou une durée calculée côté serveur.
- [x] Ajouter la phase courante du job.
- [x] Mesurer séparément les phases suivantes :
  - [x] Préparation du manifeste.
  - [x] Lecture du stockage.
  - [x] Compression.
  - [x] Upload des parties.
  - [x] Écriture de l’index.
  - [x] Finalisation.
- [x] Journaliser le `job_id`, la phase, la durée et l’erreur éventuelle.
- [x] Mesurer le temps de génération de l’inventaire.
- [x] Mesurer le nombre d’objets et de lectures S3 effectuées par inventaire.

### 1.2 Critères de mesure

- [x] Le POST de lancement retourne rapidement, indépendamment de la taille de
      la sauvegarde.
- [x] La progression est mise à jour régulièrement.
- [x] La durée finale est identique côté serveur et côté interface.
- [x] Les opérations lentes sont identifiées par phase et non uniquement par
      leur durée totale.

## 2. Durée et progression des sauvegardes

### 2.1 Modèle et API

- [x] Ajouter les nouveaux champs au modèle de job.
- [x] Prévoir une migration compatible avec les bases existantes.
- [x] Exposer la durée et la phase dans les endpoints de jobs.
- [x] Exposer l’historique récent des sauvegardes terminées.
- [x] Conserver la durée même en cas d’échec.

### 2.2 Interface Admin

- [x] Afficher la phase en cours.
- [x] Afficher les fichiers traités et les octets traités.
- [x] Afficher la partie courante et le nombre total de parties.
- [x] Afficher la durée écoulée pendant l’exécution.
- [x] Afficher la durée finale après réussite ou échec.
- [x] Ajouter un historique des sauvegardes avec :
  - [x] Date de lancement.
  - [x] Date de fin.
  - [x] Durée.
  - [x] Taille.
  - [x] Nombre de fichiers.
  - [x] Statut.
- [x] Afficher clairement la dernière activité connue.

## 3. Correction de l’inventaire « Inventaire illisible »

### 3.1 Reproduction et diagnostic

- [x] Reproduire un retour sur l’onglet pendant un export
      *(scénario E2E : bandeau global, changement d'onglet, retour et rapport).*
- [x] Reproduire le problème avec le backend de stockage local
      *(inventaire local HTTP 200 lisible et tests backend de stockage).*
- [x] Reproduire le problème avec le backend S3
      *(reproduction locale via `S3CompatibleStorage` et client boto3 factice :
      pagination `list_objects_v2`, `ClientError` → 503, `_READY` absent via
      `head_object` ; validation sur un vrai bucket reste à faire en production).*
- [x] Tester une sauvegarde dont le manifeste est présent mais dont l’index
      est encore absent.
- [x] Tester une indisponibilité temporaire du stockage.
- [x] Tester une session admin expirée pendant le chargement
      *(backend : `test_session_admin_expiree_pendant_inventaire_401_pas_503` —
      la session est vérifiée avant l'accès au stockage : 401 distincte du 503
      d'inventaire).*
- [x] Remplacer le message générique par une erreur technique journalisée et
      un message utilisateur adapté.

### 3.2 Sauvegarde partielle et visibilité

- [x] Écrire un marqueur final `_READY` uniquement après l’écriture complète
      de l’index.
- [x] Ne pas afficher une sauvegarde qui n’a pas de marqueur final.
      *(À partir du 16/11/2026, une archive sans `_READY` est signalée dans les
      ignorées ; les sauvegardes antérieures restent listées pour compatibilité.)*
- [x] Ignorer les destinations liées à un job `pending` ou `running`.
- [x] Conserver les sauvegardes anciennes compatibles sans marqueur, ou
      prévoir une stratégie de migration explicite.

### 3.3 Robustesse de l’API d’inventaire

- [x] Isoler les erreurs sauvegarde par sauvegarde.
- [x] Ne pas faire échouer tout l’inventaire à cause d’un index corrompu.
- [x] Valider la structure de `manifest.json` et `index.json`.
- [x] Capturer les erreurs de stockage et de connexion S3.
- [x] Retourner un statut distinct lorsque le stockage est indisponible.
- [x] Fournir une liste des sauvegardes ignorées et la raison, sans exposer de
      secrets.
- [x] Ajouter un bouton de nouvelle tentative côté frontend.

## 4. Tâches de fond persistantes

### 4.1 Architecture de worker

- [x] Remplacer la dépendance exclusive à `FastAPI BackgroundTasks`.
- [x] Mettre en place une file de jobs persistée en base.
- [x] Ajouter une réclamation atomique des jobs.
- [x] Ajouter un worker durable séparé du processus HTTP.
- [x] Prévoir un mode de lancement local du worker (`python -m app.worker`).
- [x] Ajouter un identifiant de worker et un heartbeat.
- [x] Empêcher l’exécution simultanée du même job.

### 4.2 Reprise après redémarrage

- [x] Reprendre les jobs `pending` après un redémarrage.
- [x] Détecter les jobs `running` dont le heartbeat est expiré.
- [x] Définir une politique de retry par type de job.
- [x] Nettoyer les fichiers temporaires orphelins.
- [x] Rendre les exports idempotents.
- [x] Rendre les imports idempotents.
- [x] Rendre les restaurations reprenables ou les placer en état
      « intervention requise » si une reprise automatique est dangereuse.

### 4.3 Données nécessaires à la reprise

- [x] Conserver l’archive source d’un import dans un stockage persistant.
- [x] Ne pas dépendre uniquement du disque temporaire du processus.
- [x] Conserver le snapshot JSON nécessaire aux imports de banque.
      *(Archivage best-effort du JSON brut dans `banque-snapshots/` et clé
      conservée dans l'évènement d'audit ; l'import reste synchrone.)*
- [x] Conserver les paramètres et la source de chaque opération.
- [x] Ne supprimer les fichiers sources qu’après un état terminal confirmé.

## 5. Suivi frontend persistant

### 5.1 Suivi commun

- [x] Créer un hook ou contexte commun de suivi des jobs Admin.
      *(Le bandeau global interroge les deux listes serveur ; les panneaux
      gardent leur suivi détaillé.)*
- [x] Charger les jobs actifs au montage de la console.
- [x] Charger l’historique récent.
- [x] Reprendre automatiquement les jobs `pending` et `running`.
- [x] Utiliser un polling avec délai contrôlé et sans requêtes concurrentes.
- [x] Gérer les erreurs réseau avec retry et backoff.
      *(Le bandeau garde la cadence de 4 s au premier échec, puis double
      jusqu'à 30 s et revient à 4 s au premier succès ; logique testée dans
      `jobs.test.ts`.)*
- [x] Distinguer une session expirée d’une erreur d’inventaire.

### 5.2 Sauvegardes et restaurations

- [x] Modifier `SauvegardesPanel` pour charger `/api/admin/sauvegardes/jobs`
      au montage.
- [x] Rattacher automatiquement le dernier ou les jobs actifs.
- [x] Afficher les jobs terminés pendant l’absence de l’utilisateur.
- [x] Rafraîchir l’inventaire après la fin d’un export ou d’une restauration.
- [x] Conserver les rapports après retour sur l’onglet.

### 5.3 Imports

- [x] Modifier `ImportPanel` pour rattacher un job actif après son montage.
- [x] Afficher les imports actifs et terminés, pas uniquement le dernier état
      local.
- [x] Reprendre l’affichage du journal après navigation.
- [x] Afficher la durée et la dernière activité de l’import.

### 5.4 Bandeau global

- [x] Ajouter un indicateur commun « Opérations en cours » dans la console.
- [x] Permettre d’ouvrir le détail d’un job depuis ce bandeau.
- [x] Indiquer clairement lorsqu’un job continue côté serveur mais n’est plus
      surveillé dans la page courante.

## 6. Documentation de la banque d’exercices

### 6.1 Aide directement dans `BanquePanel`

- [x] Expliquer **Matière** : matière de rattachement de la partie.
- [x] Expliquer **Nom** : nom lisible et unique dans une matière.
- [x] Expliquer **Ordre** : ordre d’affichage, du plus petit au plus grand.
- [x] Expliquer **Partie** : groupe logique utilisé par le générateur.
- [x] Expliquer que l’ordre n’est pas une priorité de tirage.
- [x] Expliquer **Actif** : exercice éligible au tirage.
- [x] Expliquer **Difficulté**.
- [x] Expliquer **Classes** et **Spécialités**.
- [x] Expliquer **Session**.
- [x] Expliquer le **tag examen**.
- [x] Expliquer « Aucune spécialité ».
- [x] Ajouter un exemple complet de création d’une partie et d’un exercice.

### 6.2 Import et export de banque

- [x] Expliquer la différence entre fusionner et remplacer.
- [x] Décrire précisément les données exportées.
- [x] Afficher une confirmation renforcée avant le remplacement.
- [x] Afficher la progression si l’import ou l’export devient long
      *(indicateur `role="status"` avec libellé et roue de chargement dans le
      panneau de transfert ; boutons désactivés pendant l'opération).*
- [ ] Transformer l’opération en job persistant si les mesures montrent qu’elle
      dépasse le seuil acceptable.

## 7. Guide des exercices types

### 7.1 Interface `GabaritsPanel`

- [x] Ajouter un parcours « de la relecture à la publication ».
- [x] Expliquer le rapport automatique.
- [x] Expliquer les variantes et la graine.
- [x] Expliquer la différence entre énoncé, réponse et méthode.
- [x] Ajouter une checklist « Avant de valider ».
- [x] Expliquer les statuts :
  - [x] À valider.
  - [x] Validé.
  - [x] Modifié depuis la validation.
- [x] Expliquer pourquoi un contrôle automatique peut bloquer la validation.
- [x] Expliquer le traitement des signalements élèves.

### 7.2 `AideAdmin.tsx`

- [x] Détailler la création et la validation d’un exercice type.
- [x] Ajouter un exemple de traitement d’un signalement.
- [x] Expliquer le lien entre validation Admin et visibilité élève.
- [x] Expliquer quand utiliser « Retirer » et « Revalider ».
- [x] Documenter les fichiers de gabarit illisibles.
- [x] Vérifier que chaque onglet possède une aide cohérente.

## 8. Tests backend

- [x] Tester la durée en cas de réussite.
- [x] Tester la durée en cas d’échec.
- [x] Tester la mise à jour du heartbeat.
- [x] Tester l’inventaire pendant un export actif.
- [x] Tester un manifeste incomplet.
- [x] Tester un index corrompu.
- [x] Tester une panne de stockage.
- [x] Tester la reprise après redémarrage.
- [x] Tester l’absence de double exécution.
- [x] Tester la reprise d’un import.
- [x] Tester la sécurité d’une restauration partielle.
- [x] Tester les migrations sur SQLite et PostgreSQL.
      *(SQLite : `test_migration_colonnes_jobs_idempotente` et suite locale ;
      PostgreSQL : job `backend (postgres)` de la CI `refonte` au vert.)*

## 9. Tests frontend

- [x] Tester le lancement d’un job.
- [x] Tester le changement d’onglet pendant un job.
- [x] Tester le retour sur l’onglet concerné.
- [x] Tester le retour après fermeture complète de la page Admin
      *(scénario E2E : rechargement complet de `/admin` pendant un import actif,
      bandeau et journal repris depuis la liste serveur).*
- [x] Tester l’affichage de la durée.
- [x] Tester la reprise du polling.
- [x] Tester l’affichage d’un job terminé pendant l’absence.
- [x] Tester la distinction entre inventaire vide et inventaire inaccessible
      *(backend : `test_panne_de_stockage_renvoie_503`, plus les cas manifeste
      et index absents).*
- [x] Tester les aides et descriptions de la banque
      *(E2E : aide intégrée `Comprendre la banque d'exercices` et rubrique
      `Banque d'exercices` de l'aide Admin).*
- [x] Tester le guide des exercices types
      *(E2E : aide intégrée `Guide : de la relecture à la publication` et
      rubrique `Exercices types (gabarits)` de l'aide Admin).*

## 10. Tests E2E obligatoires

- [x] Lancer une sauvegarde (job simulé, panneaux réels).
- [x] Naviguer vers plusieurs onglets Admin.
- [x] Ouvrir l’aide Admin *(lien « Aide » de la console et `/aide/admin`)*.
- [x] Revenir sur l’onglet Sauvegardes.
- [x] Vérifier que le même job est retrouvé depuis la liste serveur.
- [x] Vérifier que la phase et le suivi reprennent.
- [x] Vérifier que l’inventaire reste lisible (validation navigateur locale,
      stockage local ; l’inventaire réel Render/S3 reste à contrôler).
- [x] Vérifier la durée finale et rouvrir le rapport.
- [x] Répéter le scénario avec un import encore actif pendant la navigation
      *(E2E : upload .zip simulé, changement d'onglet, rechargement complet,
      retour via le bandeau, journal repris et rapport final ; un vrai import
      .zip a par ailleurs été mené jusqu'au rapport en local).*
- [x] Reprise d’un job `running` périmé après lancement d’un nouveau processus
      worker validée localement ; le parcours navigateur après reprise est
      couvert par le rechargement de la console dans le scénario d'import.

## 11. Ordre recommandé d’implémentation

- [x] Lot 1 — Instrumentation et mesure.
- [x] Lot 2 — Durées et progression des sauvegardes.
- [x] Lot 3 — Correction de l’inventaire.
- [x] Lot 4 — Worker durable et reprise après redémarrage.
- [x] Lot 5 — Suivi frontend persistant.
- [x] Lot 6 — Documentation de la banque.
- [x] Lot 7 — Guide des exercices types.
- [x] Lots 8 à 10 — Tests backend, frontend et E2E
      *(842 tests backend, 298 tests frontend, 128/128 scénarios E2E ; CI
      `refonte` verte sur SQLite, PostgreSQL, frontend et E2E).*

## 12. État de référence avant implémentation

- Les tests backend des sauvegardes existants passent : **30 tests**.
- Les tests frontend de la logique des sauvegardes passent : **16 tests**.
- La suite frontend complète précédemment vérifiée passe : **273 tests**.
- Aucune modification fonctionnelle n’est incluse dans ce document.
- Les fichiers temporaires du point 3 restent volontairement hors périmètre.

## 13. État après implémentation (lots 1, 2, 3, 5, 6, 7)

- Tests backend des sauvegardes : **39 tests** (dont durée, phase, échec,
  inventaire actif, manifeste/index absents, panne de stockage).
- Tests frontend complets : **290 tests** (dont `lib/jobs.test.ts`).
- `npm run build` : réussi.
- Suite backend complète : **842 passés, 2 ignorés** en local (SQLite) et Ruff
  vert. Les deux échecs historiques sont levés : `test_acces_type_gratuit` a été
  rendu indépendant de l'ordre d'exécution (matière unique + filtre explicite)
  et `test_export_et_suppression_compte` a été corrigé en amont.
- Le suivi des jobs survit à la navigation : la liste serveur est rechargée au
  montage, le job actif est rattaché une seule fois, l’historique affiche durée,
  taille, fichiers et dernière activité.
- L’inventaire distingue désormais une liste vide d’un stockage injoignable
  (HTTP 503) et expose les sauvegardes ignorées avec leur raison.
- Le marqueur `_READY` rend une sauvegarde visible seulement une fois complète ;
  les archives antérieures restent compatibles.
- La banque et les exercices types disposent d’une aide détaillée dans le
  panneau et dans l’aide Admin.

## 14. État après worker et suivi global

- Worker durable : file persistée, réclamation atomique, heartbeat, reprise
  contrôlée et lancement autonome (`python -m app.worker`) implémentés.
- Bandeau global, reprise après navigation et réouverture du rapport implémentés.
- Le bandeau applique un backoff plafonné en cas d'erreur réseau, avec retour à
  la cadence nominale au premier succès (logique extraite et testée dans
  `frontend/src/lib/jobs.ts` / `jobs.test.ts`).
- Suite E2E complète : **128/128 scénarios réussis** ; les scénarios de
  sauvegarde et d'import couvrent le bandeau, la navigation, le rechargement
  complet de la console, la reprise du journal, la durée et le rapport.
- Validation locale complémentaire : import .zip depuis l’interface jusqu’au
  rapport terminé (1 épreuve créée), puis inventaire HTTP 200 lisible avec le
  stockage local ; job `running` périmé repris par un processus worker distinct,
  archive source ré-extraite et import terminé.
- Restent à effectuer : contrôle de l'inventaire avec le stockage réel S3 et
  validation production (Render + S3). Les scénarios navigateur d'import actif
  et de reprise, comme les migrations PostgreSQL en CI, sont désormais couverts.
