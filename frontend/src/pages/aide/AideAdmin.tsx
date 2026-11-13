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
      "Il lit le brouillon tel qu'il est à l'écran, même non enregistré, avec tous ses sujets numérotés, et sait quel sujet est affiché.",
      "Il propose des modifications ciblées : remplacer un passage d'un sujet ou d'un corrigé, changer des métadonnées. Avec la case « Appliquer automatiquement » (cochée par défaut, mémorisée), elles sont appliquées au formulaire à la fin de la réponse ; décochée, un bouton « Appliquer » apparaît.",
      "Les champs modifiés sont entourés de vert, y compris l'onglet d'un sujet qui n'est pas affiché. « Annuler la dernière application » restaure l'état d'avant, tant que tu n'as pas tapé dans le formulaire depuis.",
      "Un extrait introuvable ou présent plusieurs fois n'applique rien : le message indique lequel.",
      "La discussion est mémorisée par épreuve (ou par brouillon, puis rattachée à l'épreuve à l'enregistrement) ; « Nouvelle conversation » l'efface.",
    ],
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
      "Les épreuves importées arrivent en brouillon : relis-les, vérifie les figures, puis publie. Les « Imports précédents » gardent un journal d'exécution.",
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
      "Chaque ligne affiche la matière, le chapitre, les classes, la difficulté, le total de points et le résultat du contrôle automatique (nombre de variantes tirées, d'énoncés distincts, défauts éventuels).",
      "« Voir une variante » affiche un énoncé complet avec sa correction et sa méthode ; « Autre variante » en tire une nouvelle. C'est le geste à faire avant de valider.",
      "« Valider » rend l'exercice visible sur la page Entraînement ; « Retirer » l'en retire. Un gabarit modifié depuis sa validation repasse en « À valider » et demande une revalidation.",
      "Un contrôle automatique en échec bloque la validation. « Peu de variété » signale un gabarit qui produit trop peu d'énoncés différents.",
      "La section « Signalements d'exercices » liste les variantes signalées par les élèves, avec leur numéro de graine ; « Voir la variante signalée » la retrouve exactement, puis « Marquer comme résolu ».",
    ],
    astuce: "Un fichier de gabarit illisible est ignoré et listé en haut du panneau : corrige-le sur le serveur plutôt que de valider à l'aveugle.",
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
    id: "calendrier",
    onglet: "calendrier",
    titre: "Calendrier",
    points: ["Saisis les dates officielles des examens : elles alimentent la page Calendrier et le compte à rebours de l'accueil."],
  },
  {
    id: "utilisateurs",
    onglet: "utilisateurs",
    titre: "Utilisateurs",
    points: [
      "Le tableau montre, pour chaque compte, le profil, les consentements, le nombre de notes, de discussions IA et de consultations, les abonnements actifs, le montant dépensé (FCFA) et la dernière connexion.",
      "« Supprimer » efface le compte et toutes ses données, après confirmation.",
      "La promotion en administrateur et la révocation sont réservées au compte racine ; le compte racine lui-même n'est pas modifiable.",
    ],
  },
  {
    id: "signalements",
    onglet: "signalements",
    titre: "Signalements",
    points: [
      "Liste des problèmes signalés par les élèves (énoncé, corrigé, image, lisibilité), avec un lien « ouvrir l'épreuve ».",
      "Corrige l'épreuve, puis « Marquer résolu » : le signalement passe de Ouvert à Résolu.",
    ],
  },
  {
    id: "notifications",
    onglet: "notifications",
    titre: "Notifications",
    points: [
      "Crée une notification avec un titre (obligatoire), un détail facultatif et un type.",
      "« Active (visible par tous) » la publie dans la cloche des élèves ; « Inactive (masquée) » la garde de côté.",
    ],
  },
  {
    id: "parametres",
    onglet: "parametres",
    titre: "Paramètres : référentiels",
    points: [
      "Les listes de valeurs (niveaux, classes, évaluations, matières, séries) alimentent les formulaires et les filtres.",
      "Les matières s'enrichissent à l'usage ; une série saisie hors référentiel dans une épreuve y est mémorisée.",
    ],
  },
  {
    id: "sauvegardes",
    onglet: "sauvegardes",
    titre: "Sauvegardes",
    points: [
      "Une sauvegarde contient le catalogue entier : épreuves, sujets, corrigés, images et identifiants.",
      "L'export se déclenche à la main depuis l'onglet ; la restauration affiche d'abord l'inventaire de l'archive et te fait choisir un mode de restauration.",
    ],
    astuce: "Fais une sauvegarde avant toute opération lourde (import massif, suppression en série).",
  },
  {
    id: "journal",
    onglet: "journal",
    titre: "Journal d'audit",
    points: ["Historique des actions de la console (créations, modifications, suppressions…) avec leur détail : qui, quoi, sur quelle épreuve."],
  },
  {
    id: "assistant-global",
    titre: "L'assistant des autres onglets",
    points: [
      "Le bouton « Assistant » (en bas à droite) lit un résumé de l'onglet courant, répond à tes questions et propose des actions.",
      "Rien ne s'exécute sans ton clic sur « Confirmer » : les actions passent par une liste blanche et sont validées côté serveur.",
      "Sa discussion est mémorisée par onglet ; « Nouvelle conversation » l'efface. Les actions proposées lors d'une visite précédente ne sont pas rejouables : le texte revient, pas les boutons.",
    ],
  },
];
