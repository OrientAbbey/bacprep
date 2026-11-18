import type { Onglet } from "../admin/onglets";
import type { SectionAide } from "./SectionsAide";

/** Rubrique de l'aide de la console. `onglet` désigne l'onglet documenté :
 * le test `aide.test.ts` vérifie que chacun des onglets en a une. */
export interface SectionAideAdmin extends SectionAide {
  onglet?: Onglet;
}

/** Aide de la console d'administration : en français comme la console elle-même.
 * Aucun appel à `t()` ici, volontairement : la console n'est pas traduite. */
export const sectionsAideAdmin: SectionAideAdmin[] = [
  {
    id: "acces",
    titre: "Accéder à la console",
    intro: "La console est réservée aux comptes administrateurs.",
    points: [
      "Le lien « Admin » apparaît dans l'en-tête pour les comptes administrateurs ; la console demande le jeton d'administration à l'ouverture.",
      "La page d'accueil de la console présente des statistiques générales ; les indicateurs détaillés restent dans l'onglet correspondant.",
      "« Déconnexion admin » ferme la session d'administration sans fermer ton compte.",
      "Pour gagner de la place, le menu des sections se replie (« Masquer le menu ») et les statistiques aussi (« Masquer les statistiques ») ; les deux choix sont mémorisés. Replié, le menu laisse une liste déroulante pour changer de section. Sur téléphone, une liste déroulante remplace toujours le menu.",
    ],
  },
  {
    id: "epreuves",
    onglet: "epreuves",
    titre: "Épreuves : créer et modifier",
    intro: "L'onglet Épreuves est le cœur de la console.",
    points: [
      "La liste de gauche se filtre par statut (Tous, Publiées, À réviser, Brouillons) et se recherche par texte.",
      "« + Nouvelle épreuve » ouvre un formulaire vierge : niveau, classe, évaluation, année, matière, durée, coefficient, séries et accès gratuit. Les listes de valeurs viennent des Paramètres.",
      "Une épreuve peut avoir plusieurs sujets (« + Sujet »), chacun avec son corrigé facultatif. Le contenu est du Markdown : modes Texte, Rendu ou Côte à côte (le rendu se met à jour en direct), import d'un fichier .md, ajout d'images sous la zone de texte.",
      "Les statuts sont Brouillon, À réviser et Publiée : seules les épreuves publiées sont visibles des élèves. Chaque création, modification ou suppression est inscrite au journal d'audit.",
      "Supprimer une épreuve demande une confirmation.",
    ],
    astuce: "Rien n'est enregistré tant que tu n'as pas cliqué sur « Enregistrer », y compris quand l'assistant modifie le formulaire.",
  },
  {
    id: "assistant-epreuve",
    onglet: "epreuves",
    titre: "L'assistant d'édition",
    intro: "Le bouton « Assistant » (en bas à droite de l'onglet Épreuves) ouvre un tiroir de discussion.",
    points: [
      "Il est réservé à l'onglet Épreuves. Les autres onglets utilisent l'agent transverse décrit plus bas.",
      "Il lit le brouillon tel qu'il est à l'écran, même non enregistré : toutes les métadonnées, tous les sujets numérotés avec leur corrigé, et le sujet actuellement affiché. Tu peux donc dire « corrige le sujet 2 » sans le réexpliquer.",
      "Il sait rédiger un énoncé ou un corrigé, reformuler une question, corriger une faute, améliorer une démarche et convertir du texte en Markdown, dans le style des épreuves camerounaises (barème, GPC, théorème…).",
      "Trois sorts de modifications sont appliquées au formulaire : un remplacement ciblé (un extrait exact à changer), une réécriture complète d'un sujet ou d'un corrigé, et un bloc de métadonnées (niveau, classe, évaluation, année, durée, coefficient, séries, statut, gratuité).",
      "Le remplacement ciblé exige un extrait présent MOT POUR MOT et unique dans le contenu ; s'il est introuvable ou ambigu, rien n'est appliqué et le message te le dit. Un extrait vide ajoute à la fin ; une nouvelle version vide supprime.",
      "Avec « Appliquer automatiquement » (coché par défaut et mémorisé), les changements sont appliqués dès la fin de la réponse. Décoché, un bouton « Appliquer » apparaît pour chaque modification, et tu choisis lesquelles garder.",
      "Les champs modifiés sont entourés de vert, y compris dans un onglet de sujet qui n'est pas affiché. « Annuler la dernière application » restaure l'état précédent, tant que tu n'as pas tapé dans le formulaire depuis.",
      "Le Markdown produit respecte les règles du lecteur : $…$ dans une phrase, $$…$$ seul sur sa ligne pour une formule isolée, jamais \\( \\) ni \\[ \\]. Les images se référencent avec ![Légende](/api/files/{id}#w=300). Pas de HTML brut.",
      "Il ne remplace pas ton travail : rien n'est envoyé au serveur. L'enregistrement reste le bouton « Enregistrer », et la publication le bouton « Publier », après ta relecture. Il ne supprime ni épreuve ni fichier et ne change aucun rôle.",
      "La discussion est mémorisée par épreuve, ou par brouillon avant le premier enregistrement puis rattachée à l'épreuve ; elle est effacée après 30 jours si elle reste orpheline. « Nouvelle conversation » la supprime immédiatement.",
      "Réponds en français, de façon précise : plus tu donnes de contexte (matière, classe, difficulté, point bloquant), plus la proposition est exploitable. Vérifie toujours le résultat dans le formulaire avant d'enregistrer.",
    ],
    astuce: "Demande une modification ciblée plutôt que « réécris tout » sur un long sujet : l'extrait exact est plus sûr, et tu peux annuler uniquement cette modification.",
  },
  {
    id: "import",
    onglet: "import",
    titre: "Import massif",
    intro: "Pour créer beaucoup d'épreuves d'un coup à partir d'un dossier compressé.",
    points: [
      "Organise le dossier par année, classe puis matière, avec des fichiers Markdown (.md) et des images, compresse-le en archive et dépose-la. Pas de PDF.",
      "Un nom de fichier contenant « corrige » est un corrigé, sinon un sujet ; la série est extraite du nom (« série D », « bac-D »…).",
      "Les doublons (contenu identique) sont détectés par empreinte SHA-256 et ignorés ; les fichiers aux métadonnées insuffisantes (année, classe, matière) sont signalés.",
      "Les épreuves importées arrivent en brouillon : relis-les, vérifie les figures, puis publie. Les « Imports précédents » gardent un journal d'exécution et la durée de chaque import.",
      "L'import continue côté serveur même si tu changes d'onglet ou fermes la page : en revenant, l'import actif est retrouvé automatiquement et son journal reprend. La durée affichée est celle mesurée par le serveur, de la prise en charge à la fin.",
    ],
  },
  {
    id: "formules",
    onglet: "formules",
    titre: "Formules d'abonnement",
    points: [
      "Les formules actives sont proposées sur la page Abonnement.",
      "Une nouvelle formule est créée désactivée : complète-la (prix, durée, libellés français et anglais, portée) puis active-la.",
    ],
  },
  {
    id: "gabarits",
    onglet: "gabarits",
    titre: "Exercices types (gabarits)",
    intro: "Un gabarit fabrique des exercices dont les valeurs changent à chaque tirage.",
    points: [
      "Parcours de relecture : « Voir une variante » tire un exemple au hasard avec sa correction ; « Autre variante » en tire un nouveau. Relis au moins trois variantes, dont une avec des valeurs limites, avant de valider.",
      "Chaque ligne affiche la matière, le chapitre, les classes, la difficulté, le total de points et le résultat du contrôle automatique (nombre de variantes tirées, d'énoncés distincts, défauts éventuels).",
      "Une variante est une version concrète du gabarit ; sa graine est le nombre qui l'a produite. La même graine redonne exactement la même variante, ce qui permet de retrouver une version signalée par un élève.",
      "L'énoncé est ce que lit l'élève, la réponse le résultat attendu, la méthode la démarche détaillée. Les trois sont relus : une réponse juste avec une méthode fausse apprend une erreur.",
      "Le contrôle automatique tire plusieurs variantes et vérifie qu'elles se génèrent et se corrigent ; il compte aussi les énoncés distincts. Un échec ou une variante incomplète désactive « Valider » : publier un exercice qui ne se génère pas exposerait les élèves à une page vide.",
      "Les statuts sont « À valider » (invisible des élèves), « Validé » (publié sur la page Entraînement) et « Modifié depuis la validation » (le fichier a changé après publication : revalide après vérification).",
      "« Retirer » dépublie immédiatement un exercice validé dès qu'un défaut est confirmé. « Revalider » republie un gabarit modifié après une nouvelle relecture.",
      "La section « Signalements d'exercices » liste les variantes signalées par les élèves, avec leur numéro de graine ; « Voir la variante signalée » la retrouve exactement, puis « Marquer comme résolu ».",
      "Un fichier de gabarit illisible est ignoré et listé en haut du panneau avec son motif : il ne peut ni être relu ni être validé. Corrige le fichier source puis recharge la page ; les autres gabarits gardent leur validation.",
    ],
    astuce:
      "Exemple de signalement : un élève signale « variante n° 4821 » avec le message « l'unité est fausse ». Ouvre la variante signalée, vérifie le calcul, corrige le fichier du gabarit, recharge la page, revalide, puis marque le signalement comme résolu. Si le défaut est confirmé, « Retirer » d'abord pour cesser de servir la version fautive.",
  },
  {
    id: "entrainement",
    onglet: "gabarits",
    titre: "Ce que voient les élèves : Entraînement",
    intro: "La page Entraînement ne montre que les gabarits validés, regroupés par matière.",
    points: [
      "L'élève choisit un exercice, le refait autant de fois qu'il veut (« Autre exercice » change les valeurs) puis affiche la correction détaillée (réponse et méthode).",
      "« Copier le lien » garde la variante exacte (numéro de graine) : c'est ce lien qu'un élève peut signaler, et que tu retrouves dans le panneau Exercices types.",
      "Sans validation de ta part, un gabarit n'apparaît jamais ici : c'est le seul verrou entre l'atelier et les élèves.",
    ],
  },
  {
    id: "banque",
    onglet: "banque",
    titre: "Banque d'exercices",
    intro:
      "L'onglet Banque compose des épreuves personnalisées à partir d'exercices réutilisables, rangés en parties.",
    points: [
      "Une partie porte une matière et un nom lisible, unique dans cette matière. L'ordre range les parties à l'écran, du plus petit au plus grand : ce n'est pas une priorité de tirage, un exercice d'ordre 1 n'est pas plus souvent choisi qu'un autre.",
      "Un exercice appartient à une partie et porte un sujet, un corrigé et une difficulté (Facile, Moyen, Difficile). La difficulté sert au générateur à équilibrer le sujet, pas à noter l'élève.",
      "Les classes indiquent les niveaux pour lesquels l'exercice est valable : sans classe cochée, il n'est proposé à personne. Les spécialités restreignent le tirage aux séries choisies ; « Aucune spécialité (toutes les séries) » l'ouvre à toutes, y compris aux classes sans spécialité.",
      "La session rattache l'exercice à une progression pédagogique ; laisse-la vide pour une révision ou une annale. Le tag « Épreuve d'examen » marque un exercice déjà tombé à un examen et n'est disponible que si une session est choisie.",
      "Un exercice doit être actif pour être tiré. Inactif, il reste dans la banque et garde son historique, mais le générateur ne le choisit plus.",
      "Les métadonnées de classe indiquent les classes d'examen et celles où une spécialité est obligatoire ; vérifie-les avant de proposer la composition aux élèves.",
      "Le journal conserve les générations récentes. L'export télécharge un JSON contenant les parties, les exercices, le référentiel et les métadonnées de classe.",
      "À l'import, « Fusionner » ajoute et met à jour les éléments du fichier sans supprimer ce qui n'y figure pas ; « Remplacer » efface la banque actuelle puis écrit le fichier, après une confirmation explicite.",
    ],
    astuce:
      "Exemple : pour les suites en Terminale D, crée une partie « Suites » (Mathématiques, ordre 3), puis un exercice (Moyen, classe Terminale, spécialité D, session « Suites et récurrence », actif). Il devient tirable dès qu'il est enregistré avec au moins une classe.",
  },
  {
    id: "calendrier",
    onglet: "calendrier",
    titre: "Calendrier",
    points: [
      "Ajoute les dates d'examens, de résultats ou d'inscriptions, avec une évaluation et un lien https:// facultatifs.",
      "La case Visible détermine si l'événement apparaît sur la page Calendrier ; les événements publiés alimentent aussi le compte à rebours de l'accueil.",
      "La suppression retire l'événement du calendrier public après confirmation.",
    ],
  },
  {
    id: "utilisateurs",
    onglet: "utilisateurs",
    titre: "Utilisateurs",
    points: [
      "Le tableau montre, pour chaque compte, le profil, les consentements, le nombre de notes, de discussions IA et de consultations, les abonnements actifs, le montant dépensé (FCFA) et la dernière connexion.",
      "« Supprimer » efface le compte et toutes ses données, après confirmation.",
      "Tu peux bannir un compte ou lever son bannissement ; le bannissement ferme sa session et la réautorisation lui permet de se reconnecter.",
      "La promotion en administrateur et la révocation sont réservées au compte racine ; le compte racine lui-même n'est pas modifiable.",
    ],
  },
  {
    id: "signalements",
    onglet: "signalements",
    titre: "Signalements",
    points: [
      "La liste regroupe les problèmes signalés par les élèves (énoncé, corrigé, image, lisibilité) ; recherche dans les messages et filtre par statut.",
      "Le lien « ouvrir l'épreuve » mène au contenu concerné. Corrige l'épreuve, puis « Marquer résolu » pour mettre à jour le statut du signalement.",
    ],
  },
  {
    id: "notifications",
    onglet: "notifications",
    titre: "Notifications",
    points: [
      "Crée une notification avec un titre obligatoire, un message facultatif et un type.",
      "« Active (visible par tous) » la publie dans la cloche des élèves ; « Inactive (masquée) » la garde de côté. Tu peux modifier ou supprimer une notification.",
    ],
  },
  {
    id: "parametres",
    onglet: "parametres",
    titre: "Paramètres : référentiels",
    points: [
      "Les listes de valeurs (niveaux, classes, évaluations, matières, séries) alimentent les formulaires d'épreuve et les filtres du catalogue.",
      "Tu peux ajouter, renommer ou supprimer une option. Si elle est utilisée, la suppression change la liste mais ne réécrit pas les épreuves déjà enregistrées.",
      "Les matières s'enrichissent à l'usage ; une série saisie hors référentiel dans une épreuve y est mémorisée.",
    ],
  },
  {
    id: "sauvegardes",
    onglet: "sauvegardes",
    titre: "Sauvegardes",
    points: [
      "Une sauvegarde contient le catalogue entier : épreuves, sujets, corrigés, images et identifiants.",
      "L'export se déclenche à la main depuis l'onglet. Pendant l'exécution, l'écran affiche la phase en cours (préparation, lecture, envoi, index, finalisation), les compteurs de fichiers et la durée écoulée ; à la fin, la durée mesurée par le serveur reste dans « Dernières opérations ».",
      "L'export continue côté serveur même si tu changes d'onglet ou fermes la page. En revenant, le job actif est retrouvé automatiquement et le suivi reprend ; l'inventaire n'est jamais celui d'une sauvegarde encore en écriture.",
      "Une sauvegarde n'apparaît dans l'inventaire qu'une fois complète. Un dossier encore en cours, interrompu ou illisible est signalé séparément avec sa raison, sans faire échouer tout l'inventaire.",
      "Avant la restauration, l'inventaire affiche le contenu détecté et te laisse choisir un mode.",
      "Commence toujours par l'essai à blanc : il n'écrit rien. L'écriture n'est proposée qu'après un essai terminé sans anomalie et une confirmation explicite.",
      "« Recharge du stockage » ne modifie pas les lignes de la base ; « Restauration complète » recrée aussi les métadonnées et n'est acceptée que si la base ne contient aucune épreuve.",
      "Si l'essai signale une anomalie, ne lance pas l'écriture : examine le rapport et choisis une autre sauvegarde ou demande une vérification technique.",
      "La suppression d'une sauvegarde est distincte de la restauration et demande une confirmation.",
    ],
    astuce:
      "Fais une sauvegarde avant toute opération lourde (import massif, suppression en série). Si l'inventaire affiche un message d'erreur, lis-le en entier : « stockage injoignable » et « index illisible » n'appellent pas la même réaction.",
  },
  {
    id: "journal",
    onglet: "journal",
    titre: "Journal d'audit",
    points: [
      "L'historique liste les actions de la console (créations, modifications, suppressions…) avec leur détail : qui, quoi, sur quelle épreuve.",
      "Utilise la recherche et les filtres pour retrouver une action ; ce journal sert à suivre les opérations de la console.",
    ],
  },
  {
    id: "assistant-global",
    titre: "L'agent des onglets de la console",
    intro: "Le bouton « Assistant » (en bas à droite) est disponible dans tous les onglets sauf Épreuves, qui garde son assistant d'édition. C'est un agent : il lit, prépare, puis te demande la permission avant d'écrire.",
    points: [
      "Ce qu'il voit : un résumé de l'onglet courant (lecture seule) et, dans les panneaux à formulaire — Banque, Formules, Calendrier, Notifications, Paramètres — les champs exactement tels que tu les as remplis. Ces champs sont traités comme des données, jamais comme des consignes.",
      "Il peut consulter un autre onglet pour préparer sa réponse : c'est une lecture, sans permission et sans effet. Il travaille en plusieurs étapes (au plus 6) et te montre le résultat de chaque étape importante.",
      "Trois niveaux d'action : lire (immédiat), remplir le formulaire (brouillon, sans écriture serveur) et proposer un plan d'écritures (soumis à ton approbation).",
      "Remplissage : les champs modifiés apparaissent tout de suite dans le panneau avec la liste des champs concernés et un bouton « Annuler ces modifications ». Rien n'est enregistré avant que tu cliques sur « Enregistrer » toi-même.",
      "Plan : chaque action est présentée avec son libellé et ses arguments en JSON. « Tout approuver » exécute le lot en une seule fois ; « Rejeter » ne fait aucune écriture. Un plan contient au plus 10 actions.",
      "« Ignorer » retire une action du lot ; l'agent demande alors un nouveau jeton pour les actions restantes. Le crayon « Éditer » te laisse corriger les arguments avant approbation : le jeton d'origine devient invalide et un nouveau est demandé.",
      "Le jeton est signé côté serveur et lié à ton compte, aux actions exactes, à une expiration de 5 minutes et à un numéro unique : ni modification des arguments après coup, ni réutilisation d'une approbation. Si tu tardes trop, relance la demande.",
      "Chaque action est vérifiée séparément à l'exécution : le résultat indique les succès et les échecs. Une action refusée n'annule pas les actions déjà réussies ; vérifie la base après un échec partiel.",
      "Liste blanche : l'agent peut créer et modifier des épreuves, formules, notifications, événements, options du référentiel, parties et exercices de la Banque, publier ou retirer une épreuve, bannir ou débannir un élève, valider un gabarit, résoudre un signalement et lancer une sauvegarde. Il ne peut jamais supprimer un élément, lancer une restauration ni promouvoir ou révoquer un administrateur.",
      "Toute exécution est inscrite au journal d'audit : un événement pour le plan et un par action. Un plan rejeté ou expiré n'écrit rien.",
      "La conversation est mémorisée par onglet ; « Nouvelle conversation » l'efface. Les plans d'une visite précédente reviennent en texte mais sans boutons exécutables : tu dois formuler une nouvelle demande.",
      "Réponds en français et en Markdown, avec les mêmes règles mathématiques que le lecteur. Les appels sont limités (30 demandes par 5 minutes) ; en cas de saturation, attends un peu puis réessaie.",
    ],
    astuce: "Formule une demande en deux temps : « prépare la formule et dis-moi ce que tu vas faire », puis « approuve » après avoir lu le plan. C'est le moyen le plus sûr de garder la main sur les écritures.",
  },
];
