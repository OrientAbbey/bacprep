import { t } from "../../i18n";
import type { SectionAide } from "./SectionsAide";

/** Aide des élèves : une section par thème (français ci-dessous, anglais dans `locales/en.json`). */
export const sectionsAideUtilisateur = (): SectionAide[] => [
  {
    id: "demarrer",
    titre: t("Pour commencer"),
    intro: t("Copies & Corrigés réunit les épreuves et leurs corrigés du secondaire camerounais, de la 6e à la Terminale."),
    points: [
      t("Depuis l'accueil, choisis ta classe, puis une matière : les épreuves sont regroupées par année."),
      t("La barre de recherche de l'en-tête retrouve une épreuve par sa matière, son année ou sa série, même sans accents."),
      t("Sans compte, tu peux consulter les épreuves gratuites. Connecte-toi pour utiliser le Tuteur IA, prendre des notes et suivre ton activité."),
      t("Certaines épreuves demandent un abonnement : les formules sont présentées sur la page Abonnement."),
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
      t("Le drapeau à côté du titre permet de signaler une erreur dans l'épreuve : énoncé, corrigé, image…"),
    ],
  },
  {
    id: "tuteur",
    titre: t("Le Tuteur IA"),
    intro: t("Le Tuteur IA t'aide à comprendre une épreuve : ouvre-le avec le bouton « Tuteur IA Prep » en bas à droite du lecteur."),
    points: [
      t("Pose ta question sur l'épreuve entière, ou sélectionne un passage pour interroger le Tuteur sur ce passage précis."),
      t("Tes discussions sont regroupées en onglets ; tu peux modifier une question, relancer une réponse ou copier un texte."),
      t("Si tu as accepté l'enregistrement des conversations, tu retrouves tes discussions d'une visite à l'autre ; sinon elles disparaissent à la fermeture."),
      t("Le nombre de questions est limité chaque jour pour que tout le monde puisse en profiter."),
    ],
    astuce: t("Le Tuteur peut se tromper. Compare toujours avec le corrigé officiel et demande à ton professeur en cas de doute."),
  },
  {
    id: "notes",
    titre: t("Prendre des notes"),
    intro: t("Garde tes remarques directement sur l'épreuve."),
    points: [
      t("Sélectionne un passage du texte puis choisis « Prendre une note » : ta note reste liée à l'épreuve."),
      t("Retrouve toutes tes notes dans ton profil, onglet « Mes notes »."),
      t("L'éditeur te propose un aperçu de la mise en forme avant d'enregistrer."),
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
      t("« À revoir » ajoute l'épreuve à ta liste de révision espacée : elle te revient selon un calendrier de révision."),
      t("Ton profil, onglet « Activité », retrace tes connexions, consultations, notes et discussions."),
      t("La page Calendrier affiche les dates officielles des examens ; l'accueil affiche un compte à rebours."),
    ],
  },
  {
    id: "abonnements",
    titre: t("Abonnements"),
    intro: t("Les formules d'abonnement donnent accès aux épreuves payantes."),
    points: [
      t("La page Abonnement présente les formules : une épreuve précise, une matière, une année ou une série complète, avec leur prix en FCFA et leur durée."),
      t("Un abonnement actif et les épreuves qu'il couvre apparaissent dans ton profil, onglet « Abonnements »."),
    ],
  },
  {
    id: "profil",
    titre: t("Profil et confidentialité"),
    intro: t("Tu gardes la main sur tes informations."),
    points: [
      t("Dans ton profil, ajoute une photo (PNG, JPEG, WebP ou GIF, 2 Mo au maximum) : elle apparaît dans l'en-tête."),
      t("L'onglet « Confidentialité » te permet d'accepter ou de refuser, à tout moment, l'enregistrement de tes conversations avec le Tuteur IA et de tes notes."),
      t("Pour supprimer ton compte et tes données, écris à l'équipe depuis l'adresse e-mail de ton compte."),
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
      t("Le Tuteur ne répond plus : tu as peut-être atteint la limite du jour, réessaie plus tard."),
    ],
  },
];
