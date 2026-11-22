import { t } from "../../i18n";
import type { SectionAide } from "./SectionsAide";

/** Aide des élèves : une section par thème (français ci-dessous, anglais dans `locales/en.json`). */
export const sectionsAideUtilisateur = (): SectionAide[] => [
  {
    id: "demarrer",
    titre: t("Pour commencer"),
    intro: t("Copies & Corrigés réunit les épreuves et leurs corrigés du secondaire camerounais, de la 6e à la Terminale."),
    points: [
      t("Depuis l'accueil, choisis un niveau puis une classe pour afficher les matières et les épreuves disponibles."),
      t("Dans le catalogue, utilise la recherche et les filtres pour affiner par classe, série, matière, année, évaluation, présence d'un corrigé ou type d'accès ; « Voir plus » charge les résultats suivants."),
      t("La recherche de l'en-tête retrouve une épreuve par sa matière, son année ou sa série, même sans accents."),
      t("Sans compte, tu peux consulter les épreuves gratuites. Connecte-toi pour faire les exercices d'entraînement, utiliser le Tuteur IA, prendre des notes et suivre ton activité."),
      t("Une épreuve marquée Payant mène à la page Abonnement ; si elle est déjà couverte, tu peux l'ouvrir directement."),
      t("La page Calendrier donne les dates saisies par l'équipe et les liens officiels disponibles pour les examens."),
    ],
  },
  {
    id: "lecteur",
    titre: t("Lire une épreuve"),
    intro: t("Le lecteur présente le texte sur une feuille de largeur A4, pour une lecture confortable."),
    points: [
      t("Passe du sujet au corrigé avec les onglets, ou avec les touches S et C du clavier."),
      t("Quand une épreuve compte plusieurs sujets, choisis l'affichage « Page par page » ou « Toutes les pages »."),
      t("A− et A+ règlent la taille du texte de 40 % à 200 %. Sur téléphone, pince la feuille avec deux doigts : seule l'épreuve est zoomée, pas la page du site."),
      t("Le bouton Immersion masque l'en-tête et le pied de page du site et replie les outils derrière « Outils » : toute la place est pour l'épreuve. Le bouton Retour te ramène en arrière."),
      t("« Hors-ligne » télécharge l'épreuve pour la lire sans connexion ; « PDF » ouvre l'impression de la feuille."),
      t("Le drapeau à côté du titre permet de signaler une erreur dans l'épreuve : énoncé, corrigé, image… Le message envoyé est associé à cette épreuve."),
      t("Le filigrane affiché sur la lecture identifie le compte et l'heure de consultation ; évite de diffuser une capture avec ces informations."),
    ],
  },
  {
    id: "tuteur",
    titre: t("Le Tuteur IA"),
    intro: t("Le Tuteur IA t'aide à comprendre une épreuve : ouvre-le avec le bouton « Tuteur IA Prep » en bas à droite du lecteur. Sur ordinateur, le panneau s'ouvre à côté de l'épreuve ; sur téléphone, il occupe tout l'écran."),
    points: [
      t("Il faut être connecté pour l'utiliser, et il est masqué pendant un examen blanc, en même temps que le corrigé. Sans compte, seules des puces verrouillées rappellent sa présence."),
      t("Pose ta question sur l'épreuve entière, ou sélectionne un passage puis « Demander » : le texte et sa mise en forme (formules, tableaux, images) sont transmis. Panneau fermé, cela ouvre une nouvelle discussion sur ce passage ; panneau ouvert, le passage est collé dans le champ sans changer le contexte de la discussion en cours."),
      t("La réponse s'affiche au fur et à mesure. Elle est en Markdown avec titres, listes, tableaux et formules LaTeX : $…$ dans une phrase, $$…$$ sur sa propre ligne pour une formule isolée. Aucun HTML brut."),
      t("Le Tuteur répond dans la langue de ta dernière question, français ou anglais, même si l'épreuve est dans une autre langue."),
      t("Tu peux avoir jusqu'à 5 discussions par épreuve, regroupées en onglets. Le bouton « + » en crée une nouvelle ; dans un onglet, tu peux modifier une question, la relancer avec « Réessayer », copier la réponse en Markdown et passer d'un onglet à l'autre avec les flèches ← et →."),
      t("Entrée envoie la question, Maj+Entrée fait un saut de ligne et Échap ferme le panneau. Si tu envoies une question pendant qu'une réponse est en cours, elle attend son tour."),
      t("Sous une réponse, « Sauvegarder en note » l'ajoute à tes notes personnelles, si tu as accepté les notes. Il n'existe pas de bouton pour signaler une réponse : le drapeau du lecteur signale une erreur dans l'épreuve, pas dans la réponse du Tuteur."),
      t("Tu peux rouvrir une discussion depuis ton profil, onglet « Activité » : le lien mène directement à la conversation sur l'épreuve."),
      t("Si tu as accepté l'enregistrement des conversations, tu les retrouves d'une visite à l'autre ; sinon elles restent dans la session en cours. Retirer ton consentement efface aussitôt les conversations déjà enregistrées."),
      t("Le Tuteur lit l'épreuve et le passage sélectionné, avec au plus 3 images. Un texte qui ne vient pas de l'épreuve est écarté : il reste cantonné au sujet. Ton nom et ton adresse e-mail ne sont pas transmis."),
      t("Les questions sont limitées : 20 questions par 5 minutes et 60 questions par jour pour ton compte, plus un quota global pour le site. Selon le cas, le message indique « Trop de questions à l'assistant — réessaie dans quelques minutes », « Quota quotidien de l'assistant atteint — reviens demain » ou « L'assistant est très sollicité aujourd'hui — réessaie plus tard »."),
      t("Si les fournisseurs d'IA sont indisponibles, tu vois « Les fournisseurs d'IA sont temporairement indisponibles — réessaie dans quelques minutes ». En cas de coupure réseau, le panneau essaie de se reconnecter jusqu'à 3 fois avant d'afficher l'erreur."),
      t("Pour une réponse utile, précise ta question et l'étape qui te bloque. N'écris ni mot de passe ni donnée personnelle sensible : ta question, l'extrait sélectionné et les derniers échanges sont transmis au fournisseur d'IA et peuvent être traités hors du Cameroun."),
    ],
    astuce: t("Le Tuteur peut se tromper, surtout sur les calculs. Compare toujours avec le corrigé officiel et demande à ton professeur en cas de doute."),
  },
  {
    id: "notes",
    titre: t("Prendre des notes"),
    intro: t("Garde tes remarques directement sur l'épreuve."),
    points: [
      t("Sélectionne un passage du texte puis choisis « Prendre une note » : ta note reste liée à l'épreuve."),
      t("Tu peux aussi utiliser « Sauvegarder en note » sous une réponse du Tuteur IA : elle devient une note liée à l'épreuve, si tu as accepté l'enregistrement des notes."),
      t("Retrouve toutes tes notes dans ton profil, onglet « Mes notes »."),
      t("L'éditeur te propose un aperçu de la mise en forme avant d'enregistrer ; ferme-le sans enregistrer si tu veux abandonner."),
      t("Tes notes ne sont conservées que si tu l'as accepté ; tu peux changer ce choix à tout moment dans ton profil, onglet « Confidentialité »."),
    ],
  },
  {
    id: "chrono",
    titre: t("Chronomètre et examen blanc"),
    intro: t("Entraîne-toi dans les conditions de l'examen."),
    points: [
      t("Chrono : choisis une durée en minutes et lance le compte à rebours. À zéro, une alarme sonne en continu jusqu'à ce que tu appuies sur « Arrêter l'alarme » ; elle s'arrête seule au bout d'une minute."),
      t("Le bouton avec le haut-parleur coupe ou rétablit le son de l'alarme ; le signal visuel reste."),
      t("Examen blanc : le temps officiel de l'épreuve démarre, le corrigé et le Tuteur sont masqués. À la fin, tu peux saisir ta note sur 20 pour suivre ta progression."),
    ],
  },
  {
    id: "revision",
    titre: t("Réviser et suivre ta progression"),
    intro: t("Reviens sur ce qui compte, au bon moment."),
    points: [
      t("Sur la page Entraînement, filtre les exercices par matière ou difficulté, puis génère une nouvelle variante ou affiche la correction détaillée."),
      t("Le compositeur d'épreuve permet de choisir classe, matière, série, format et difficulté ; certaines matières requièrent un abonnement actif."),
      t("« À revoir » ajoute l'épreuve à ta liste de révision espacée : elle te revient selon un calendrier de révision."),
      t("Ton profil, onglet « Activité », retrace tes connexions, consultations, notes et discussions."),
      t("La page Calendrier affiche les dates publiées par l'équipe ; l'accueil met en avant les prochaines échéances."),
    ],
  },
  {
    id: "abonnements",
    titre: t("Abonnements"),
    intro: t("Les formules d'abonnement donnent accès aux épreuves payantes."),
    points: [
      t("La page Abonnement présente les formules : une épreuve précise, une matière, une année ou une série complète, avec leur prix en FCFA et leur durée."),
      t("Un abonnement actif et les épreuves qu'il couvre apparaissent dans ton profil, onglet « Abonnements »."),
      t("Les AK sont des crédits internes : une connexion chaque jour en crédite selon ta série — 3 AK les jours 1 à 3, 7 AK les jours 4 à 6, puis 10 AK à partir du jour 7. Si tu sautes une journée, la série repart au jour 1. Certaines formules peuvent être payées avec ton solde AK, visible dans ton profil avec les derniers mouvements."),
    ],
  },
  {
    id: "profil",
    titre: t("Profil et confidentialité"),
    intro: t("Tu gardes la main sur tes informations."),
    points: [
      t("Dans ton profil, ajoute une photo (PNG, JPEG, WebP ou GIF, 2 Mo au maximum) : elle apparaît dans l'en-tête."),
      t("L'onglet « Confidentialité » te permet d'accepter ou de refuser, à tout moment, l'enregistrement de tes conversations avec le Tuteur IA et de tes notes."),
      t("Dans l'onglet « Confidentialité » de ton profil, « Exporter mes données » télécharge une copie de tout ce qui est conservé sur toi, et « Supprimer mon compte » efface définitivement ton compte et tes données."),
      t("Un seul appareil peut être connecté à la fois : si tu te connectes ailleurs, la première session est fermée."),
    ],
  },
  {
    id: "confort",
    titre: t("Langue, thème et hors-ligne"),
    intro: t("L'application s'adapte à ton téléphone et à ta connexion."),
    points: [
      t("Le sélecteur FR / EN change la langue de l'interface ; le contenu des épreuves garde sa langue d'origine."),
      t("Le bouton lune / soleil bascule entre le thème clair et le thème sombre."),
      t("Sans connexion, les épreuves téléchargées restent lisibles ; l'icône de nuage de l'en-tête indique l'état de la connexion."),
      t("Tu peux installer l'application sur l'écran d'accueil de ton téléphone depuis le menu de ton navigateur."),
      t("La cloche affiche les notifications de l'équipe : nouvelles épreuves, annonces."),
    ],
  },
  {
    id: "inviter",
    titre: t("Inviter des amis"),
    intro: t("Partage Copies & Corrigés avec tes camarades."),
    points: [
      t("Le bouton de partage de l'en-tête (ou le lien « Inviter des amis » du pied de page) propose WhatsApp, Facebook, Telegram, l'e-mail ou la copie du lien."),
      t("Sur téléphone, « Autres applications… » ouvre la feuille de partage de ton appareil."),
    ],
  },
  {
    id: "depannage",
    titre: t("Un problème ?"),
    intro: t("Quelques réflexes avant de nous écrire."),
    points: [
      t("Le texte est trop petit ou trop grand : utilise A− / A+ ou pince la feuille."),
      t("Tu es déconnecté sans l'avoir demandé : ton compte s'est ouvert sur un autre appareil."),
      t("Une épreuve contient une erreur : signale-la avec le drapeau du lecteur."),
      t("Le Tuteur ne répond plus : regarde le message affiché. « Quota quotidien… reviens demain » signifie que ta limite du jour est atteinte ; « Trop de questions… réessaie dans quelques minutes » concerne les 20 questions par 5 minutes ; « Fournisseurs indisponibles » est une panne du service, et une coupure réseau déclenche 3 reconnexions automatiques."),
    ],
  },
];
