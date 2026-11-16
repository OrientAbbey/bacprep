# Vérification manuelle — console Admin (Render + S3)

Ce document clôt la dernière case ouverte du plan : **« Une vérification manuelle en production a été effectuée »**. Il s'exécute **de ton côté**, sans partager de secrets avec l'agent.

Le script `backend/scripts_dev/verifier_prod_admin.py` vérifie les endpoints via l'API ; la checklist navigateur vérifie l'interface réelle (bandeau, navigation, inventaire, rapport).

## 1. Prérequis

- Une URL de service **Render / staging** configurée comme la prod, idéalement avec `STORAGE_BACKEND=s3`.
- Un compte admin autorisé : e-mail dans la liste blanche + `ADMIN_TOKEN` (ou la possibilité d'ouvrir une session admin temporaire).
- Une fenêtre de test où l'on peut, si besoin, créer **une** sauvegarde puis la supprimer.
- La confirmation que les variables d'environnement du service sont posées (valeurs non nécessaires ici) :
  `ENV`, `ADMIN_TOKEN`, `ADMIN_ROOT`, `STORAGE_BACKEND`, `STORAGE_ENDPOINT_URL`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `FILE_URL_SECRET`.
- Python 3.10+ sur la machine qui exécute le script (stdlib uniquement, aucune dépendance à installer).

## 2. Script de vérification API

### Lecture seule (par défaut)

```bash
VERIFY_URL=https://MON-SERVICE.onrender.com \
VERIFY_ADMIN_EMAIL=admin@example.com \
VERIFY_ADMIN_TOKEN=... \
python backend/scripts_dev/verifier_prod_admin.py
```

PowerShell :

```powershell
$env:VERIFY_URL="https://MON-SERVICE.onrender.com"
$env:VERIFY_ADMIN_EMAIL="admin@example.com"
$env:VERIFY_ADMIN_TOKEN="..."
python backend\scripts_dev\verifier_prod_admin.py
```

Il contrôle : connexion admin, `/api/admin/stats`, inventaire des sauvegardes, liste des jobs de sauvegarde, liste des imports, export de la banque (`schemaVersion 1.0`).

### Avec export de test et nettoyage

```bash
... python backend/scripts_dev/verifier_prod_admin.py --write --cleanup
```

Il lance une sauvegarde, suit le job jusqu'à `done`, vérifie `duration_ms`, le rapport, la présence de la sauvegarde dans l'inventaire, puis supprime la sauvegarde créée. Sans `--cleanup`, la clé à supprimer manuellement est affichée.

Variables optionnelles : `VERIFY_FORCE=true` si un autre admin détient le verrou (409), `VERIFY_TIMEOUT` pour allonger le polling (défaut **600 s**).

Si le job est encore `running` au bout du délai, **ne relance pas `--write`** (cela créerait une sauvegarde de plus). Reprends son suivi avec l’identifiant affiché :

```bash
python scripts_dev/verifier_prod_admin.py --job-id <id_du_job> --cleanup --timeout 900
```

Le script affiche toutes les 15 s le statut, la phase, la durée et le heartbeat, puis vérifie le rapport et nettoie la sauvegarde créée par ce job.

> Le script ne stocke aucun secret : il lit uniquement les variables d'environnement de la machine qui l'exécute.

## 3. Checklist navigateur

À réaliser avec le même compte admin, dans le service déployé.

| # | Action | Résultat attendu |
|---|--------|------------------|
| 1 | Ouvrir `/admin` et se connecter | Connexion réussie ; aucun message « jeton d'exemple » ni « session expirée » |
| 2 | Onglet **Sauvegardes** → « Créer une sauvegarde maintenant » | Le bandeau « Opérations en cours » apparaît avec la phase et la durée écoulée |
| 3 | Aller sur **Import massif**, puis **Formules** pendant l'export | Le bandeau reste visible et indique toujours la sauvegarde en cours |
| 4 | Cliquer « Voir » dans le bandeau | Retour sur **Sauvegardes** ; la carte du job réaffiche phase et durée depuis la liste serveur |
| 5 | Attendre la fin | Statut « Terminé », durée finale mesurée par le serveur, rapport rouvrable |
| 6 | Ouvrir « Dernières opérations » → « Voir le rapport » | Fichiers, octets, parties et durée cohérents |
| 7 | Recharger la page `/admin` puis revenir sur **Sauvegardes** | L'historique et le rapport restent consultables ; l'inventaire répond et n'affiche pas « Inventaire illisible » |
| 8 | Vérifier la liste des sauvegardes | Seules des sauvegardes complètes (`_READY`) sont proposées ; les autres sont dans « ignorées » avec une raison lisible |
| 9 | Ouvrir l'aide via le bouton « Aide » | `/aide/admin` s'ouvre ; rubriques Import massif, Banque, Exercices types, Sauvegardes présentes |
| 10 | Onglet **Banque** → « Comprendre la banque d'exercices » | Aide lisible ; export JSON téléchargeable ; import en fusion avec aperçu et confirmation |
| 11 | Onglet **Exercices types** → « Guide : de la relecture à la publication » | Guide lisible, checklist « Avant de valider », statuts expliqués |
| 12 | Déconnecter admin, puis tenter un appel admin | 401 « Session admin invalide ou expirée », pas un 503 ni un message de stockage |

## 4. Éléments à transmettre

- La sortie complète du script (les lignes `OK` / `FAIL` et le récapitulatif).
- Pour la checklist : un court compte rendu par étape (✅ / ❌) et, en cas d'échec, une capture d'écran ou le texte exact du message.
- Les codes HTTP renvoyés lors d'un échec (401 / 503 / 429 sont particulièrement informatifs).

## 5. Dépannage rapide

| Symptôme | Cause probable | Action |
|----------|----------------|--------|
| `409` à la connexion | Un autre admin détient le verrou | Relancer avec `VERIFY_FORCE=true` |
| `401` immédiat | Jeton invalide, e-mail hors liste blanche ou `ENV=prod` avec jeton d'exemple | Vérifier `ADMIN_TOKEN` / `ADMIN_ROOT` |
| `503` sur l'inventaire | Stockage S3 injoignable ou identifiants expirés | Vérifier `STORAGE_*` et les logs Render ; ne pas conclure à une perte de données |
| `429` sur `mock-login` | Limiteur de connexion | Attendre une minute ou désactiver en staging uniquement (`LOGIN_RATE_LIMIT=0`) |
| Export reste `pending` | Aucun worker actif | Vérifier que le service web démarre bien le worker intégré (`JOB_WORKER_ENABLED`) |

## 6. Nettoyage

- Si le script a été lancé avec `--write` sans `--cleanup`, supprimer la sauvegarde dont la clé a été affichée.
- Aucune modification de configuration n'est à faire : la validation est uniquement observatoire (hors export de test).
- Une fois les éléments transmis, la case « vérification manuelle en production » du `PLAN_CORRECTION_ADMIN.md` sera cochée.
