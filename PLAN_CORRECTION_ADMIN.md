# Plan de correction — Console Admin

> Document de suivi de l’implémentation des corrections concernant les
> sauvegardes, les imports, la banque d’exercices et les exercices types.
>
> Les fichiers temporaires et documents non suivis du point 3 restent exclus
> de ce plan et ne doivent pas être modifiés automatiquement.

## État global

- [ ] Tous les lots sont implémentés
- [x] Les tests backend passent
- [x] Les tests frontend passent
- [ ] Les tests E2E passent
- [ ] Une vérification manuelle en production a été effectuée

> **Dernière exécution :** 39 tests backend des sauvegardes, 290 tests
> frontend, `npm run build` sans erreur.
>
> **Reste à faire en priorité :** worker durable (lot 4), scénarios E2E,
> vérification en production, ouverture d’un ancien rapport depuis
> l’historique, bandeau global « Opérations en cours ».

## 1. Diagnostic et mesure des performances

### 1.1 Instrumentation backend

- [x] Ajouter `started_at` aux jobs.
- [x] Ajouter `heartbeat_at` aux jobs.
- [x] Ajouter `duration_ms` ou une durée calculée côté serveur.
- [x] Ajouter la phase courante du job.
- [x] Mesurer séparément les phases suivantes :
  - [x] Préparation du manifeste.
  - [x] Lecture du stockage.
  - [ ] Compression.
  - [x] Upload des parties.
  - [x] Écriture de l’index.
  - [x] Finalisation.
- [x] Journaliser le `job_id`, la phase, la durée et l’erreur éventuelle.
- [ ] Mesurer le temps de génération de l’inventaire.
- [ ] Mesurer le nombre d’objets et de lectures S3 effectuées par inventaire.

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

- [ ] Reproduire un retour sur l’onglet pendant un export.
- [ ] Reproduire le problème avec le backend de stockage local.
- [ ] Reproduire le problème avec le backend S3.
- [x] Tester une sauvegarde dont le manifeste est présent mais dont l’index
      est encore absent.
- [x] Tester une indisponibilité temporaire du stockage.
- [ ] Tester une session admin expirée pendant le chargement.
- [x] Remplacer le message générique par une erreur technique journalisée et
      un message utilisateur adapté.

### 3.2 Sauvegarde partielle et visibilité

- [x] Écrire un marqueur final `_READY` uniquement après l’écriture complète
      de l’index.
- [ ] Ne pas afficher une sauvegarde qui n’a pas de marqueur final.
      *(Exception assumée : les sauvegardes antérieures au marqueur restent
      listées si aucun job actif ne les concerne.)*
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

- [ ] Remplacer la dépendance exclusive à `FastAPI BackgroundTasks`.
- [ ] Mettre en place une file de jobs persistée en base.
- [x] Ajouter une réclamation atomique des jobs.
- [ ] Ajouter un worker durable séparé du processus HTTP.
- [ ] Prévoir un mode de lancement local du worker.
- [ ] Ajouter un identifiant de worker et un heartbeat.
- [x] Empêcher l’exécution simultanée du même job.

### 4.2 Reprise après redémarrage

- [ ] Reprendre les jobs `pending` après un redémarrage.
- [ ] Détecter les jobs `running` dont le heartbeat est expiré.
- [ ] Définir une politique de retry par type de job.
- [ ] Nettoyer les fichiers temporaires orphelins.
- [ ] Rendre les exports idempotents.
- [ ] Rendre les imports idempotents.
- [ ] Rendre les restaurations reprenables ou les placer en état
      « intervention requise » si une reprise automatique est dangereuse.

### 4.3 Données nécessaires à la reprise

- [ ] Conserver l’archive source d’un import dans un stockage persistant.
- [ ] Ne pas dépendre uniquement du disque temporaire du processus.
- [ ] Conserver le snapshot JSON nécessaire aux imports de banque.
- [ ] Conserver les paramètres et la source de chaque opération.
- [ ] Ne supprimer les fichiers sources qu’après un état terminal confirmé.

## 5. Suivi frontend persistant

### 5.1 Suivi commun

- [ ] Créer un hook ou contexte commun de suivi des jobs Admin.
- [x] Charger les jobs actifs au montage de la console.
- [x] Charger l’historique récent.
- [x] Reprendre automatiquement les jobs `pending` et `running`.
- [ ] Utiliser un polling avec délai contrôlé et sans requêtes concurrentes.
- [ ] Gérer les erreurs réseau avec retry et backoff.
- [x] Distinguer une session expirée d’une erreur d’inventaire.

### 5.2 Sauvegardes et restaurations

- [x] Modifier `SauvegardesPanel` pour charger `/api/admin/sauvegardes/jobs`
      au montage.
- [x] Rattacher automatiquement le dernier ou les jobs actifs.
- [x] Afficher les jobs terminés pendant l’absence de l’utilisateur.
- [x] Rafraîchir l’inventaire après la fin d’un export ou d’une restauration.
- [ ] Conserver les rapports après retour sur l’onglet.
      *(L’historique affiche le résumé ; le rapport détaillé n’est pas encore
      réouvrable depuis un job terminé.)*

### 5.3 Imports

- [x] Modifier `ImportPanel` pour rattacher un job actif après son montage.
- [x] Afficher les imports actifs et terminés, pas uniquement le dernier état
      local.
- [x] Reprendre l’affichage du journal après navigation.
- [x] Afficher la durée et la dernière activité de l’import.

### 5.4 Bandeau global

- [ ] Ajouter un indicateur commun « Opérations en cours » dans la console.
- [ ] Permettre d’ouvrir le détail d’un job depuis ce bandeau.
- [ ] Indiquer clairement lorsqu’un job continue côté serveur mais n’est plus
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
- [ ] Afficher la progression si l’import ou l’export devient long.
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
- [ ] Tester la reprise après redémarrage.
- [ ] Tester l’absence de double exécution.
- [ ] Tester la reprise d’un import.
- [x] Tester la sécurité d’une restauration partielle.
- [ ] Tester les migrations sur SQLite et PostgreSQL.

## 9. Tests frontend

- [ ] Tester le lancement d’un job.
- [ ] Tester le changement d’onglet pendant un job.
- [ ] Tester le retour sur l’onglet concerné.
- [ ] Tester le retour après fermeture complète de la page Admin.
- [x] Tester l’affichage de la durée.
- [x] Tester la reprise du polling.
- [ ] Tester l’affichage d’un job terminé pendant l’absence.
- [ ] Tester la distinction entre inventaire vide et inventaire inaccessible.
- [ ] Tester les aides et descriptions de la banque.
- [ ] Tester le guide des exercices types.

## 10. Tests E2E obligatoires

- [ ] Lancer une sauvegarde.
- [ ] Naviguer vers plusieurs onglets Admin.
- [ ] Ouvrir l’aide Admin.
- [ ] Revenir sur l’onglet Sauvegardes.
- [ ] Vérifier que le même job est retrouvé.
- [ ] Vérifier que la progression reprend.
- [ ] Vérifier que l’inventaire reste lisible.
- [ ] Vérifier la durée finale.
- [ ] Répéter le scénario avec un import.
- [ ] Répéter le scénario après redémarrage du worker.

## 11. Ordre recommandé d’implémentation

- [x] Lot 1 — Instrumentation et mesure.
- [x] Lot 2 — Durées et progression des sauvegardes.
- [x] Lot 3 — Correction de l’inventaire.
- [ ] Lot 4 — Worker durable et reprise après redémarrage.
- [x] Lot 5 — Suivi frontend persistant.
- [x] Lot 6 — Documentation de la banque.
- [x] Lot 7 — Guide des exercices types.
- [ ] Lots 8 à 10 — Tests backend, frontend et E2E.

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
- Suite backend complète : **821 passés, 2 échecs préexistants hors périmètre**
  (`test_acces_type_gratuit` dépend de l’ordre d’exécution ;
  `test_export_et_suppression_compte` attend une liste d’export qui ne contient
  pas encore `epreuves_generees`).
- Le suivi des jobs survit à la navigation : la liste serveur est rechargée au
  montage, le job actif est rattaché une seule fois, l’historique affiche durée,
  taille, fichiers et dernière activité.
- L’inventaire distingue désormais une liste vide d’un stockage injoignable
  (HTTP 503) et expose les sauvegardes ignorées avec leur raison.
- Le marqueur `_READY` rend une sauvegarde visible seulement une fois complète ;
  les archives antérieures restent compatibles.
- La banque et les exercices types disposent d’une aide détaillée dans le
  panneau et dans l’aide Admin.

## 14. Prochaines étapes

1. Concevoir le worker durable : file en base, réclamation atomique déjà en
   place, heartbeat et reprise après redémarrage.
2. Ajouter les tests E2E de navigation pendant une sauvegarde et un import.
3. Rendre un rapport terminé réouvrable depuis « Dernières opérations ».
4. Ajouter le bandeau global « Opérations en cours ».
5. Vérifier le rendu et les durées en production (Render + stockage S3).
