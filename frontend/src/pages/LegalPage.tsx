import { Link } from "react-router-dom";
import { locale, t } from "../i18n";

/**
 * Pages légales (confidentialité, conditions d'utilisation).
 *
 * Le texte décrit le fonctionnement RÉEL du service tel qu'il est codé :
 * données effectivement stockées (`db_models.py`), consentement granulaire
 * révocable (`routers/me.py`), export et effacement en libre-service, durée
 * des sessions (`core/store.py`) et lecture hors-ligne (`lib/horsLigne.ts`),
 * fournisseurs d'IA (`core/assistant.py`), hébergement (`DEPLOIEMENT.md`).
 *
 * Il porte encore une ligne « version de travail » : elle ne doit être
 * retirée qu'après relecture juridique (cf. lot D de la revue de portage).
 */

/** Date de dernière révision du texte (les deux pages avancent ensemble). */
const DATE_REVISION = new Date(2026, 10, 13);

interface Section {
  id: string;
  titre: string;
  intro?: string;
  points?: string[];
}

const SECTIONS_CONFIDENTIALITE: Section[] = [
  {
    id: "responsable",
    titre: t("Qui traite tes données"),
    intro: t("Copies & Corrigés est un service de révision pour les élèves du secondaire camerounais, de la 6e à la Terminale."),
    points: [
      t("Le responsable du traitement est l'équipe qui édite Copies & Corrigés. Pour toute question sur tes données, écris à l'adresse e-mail affichée dans ton profil, onglet « Confidentialité »."),
      t("Nous appliquons les principes de la loi camerounaise n° 2010/012 du 21 décembre 2010 relative à la cybersécurité et à la cybercriminalité, dont l'ANTIC assure la promotion : finalité déterminée, proportionnalité, durée limitée, droits d'accès et d'effacement."),
    ],
  },
  {
    id: "donnees",
    titre: t("Les données que nous traitons"),
    points: [
      t("Compte : ton nom, ton adresse e-mail et, si tu les renseignes, ton niveau, ta classe, ton établissement et une photo de profil. En connexion Google, nous ne recevons ni mot de passe ni carnet d'adresses."),
      t("Activité : les épreuves consultées, les essais d'examen blanc et leurs notes, tes notes personnelles, tes discussions avec le Tuteur IA, tes signalements et tes abonnements."),
      t("Paiements : le moyen choisi, le montant en FCFA, la référence de la transaction et son statut. Aucune donnée bancaire n'est saisie ni conservée sur nos serveurs."),
      t("Préférences : la langue, le thème, le zoom et la liste des épreuves téléchargées restent dans ton navigateur, sur ton appareil ; elles ne sont pas envoyées au serveur."),
    ],
  },
  {
    id: "finalites",
    titre: t("Pourquoi nous les traitons"),
    points: [
      t("Faire fonctionner le service : ouvrir ton compte, retrouver tes épreuves et tes abonnements, afficher ton filigrane."),
      t("Améliorer ton apprentissage : corriger tes essais, reprendre tes notes et tes discussions, te proposer ta révision espacée."),
      t("Sécurité et modération : une seule session active par compte, journal des actions d'administration, traitement des signalements."),
      t("Nous ne vendons aucune donnée, nous n'affichons aucune publicité et nous n'utilisons ni traceur publicitaire ni outil de mesure d'audience tiers."),
    ],
  },
  {
    id: "consentement",
    titre: t("Ton consentement, finalité par finalité"),
    points: [
      t("À ta première connexion, deux cases indépendantes te sont proposées : conserver tes conversations avec le Tuteur IA, et conserver tes notes personnelles."),
      t("Un refus est effectif immédiatement : sans ton accord, le Tuteur fonctionne en mode éphémère et la prise de note est masquée, rien n'est écrit sur le serveur."),
      t("Tu changes d'avis à tout moment dans ton profil, onglet « Confidentialité ». Retirer ton accord sur les conversations efface aussitôt celles déjà enregistrées."),
    ],
  },
  {
    id: "tuteur",
    titre: t("Le Tuteur IA et ses fournisseurs"),
    points: [
      t("Pour répondre, ta question, l'extrait d'épreuve concerné et les derniers échanges sont transmis à un fournisseur d'IA : Gemini (Google) ou Groq, selon la disponibilité."),
      t("Ton nom, ton adresse e-mail et tes autres données de compte ne sont pas transmis à ces fournisseurs ; la réponse revient dans ton navigateur sans être publiée."),
      t("Ces fournisseurs peuvent traiter les requêtes en dehors du Cameroun, dans leurs centres de données habituels ; leurs propres conditions s'appliquent à ce traitement."),
    ],
  },
  {
    id: "durees",
    titre: t("Combien de temps nous les conservons"),
    points: [
      t("Session : le cookie de connexion expire après 7 jours sans activité et 14 jours au maximum, même si tu restes actif ; le serveur n'en conserve qu'une empreinte SHA-256, jamais le jeton lui-même."),
      t("Notes et conversations : conservées tant que tu y consens et que ton compte existe ; les conversations sont effacées dès le retrait du consentement, le reste à la suppression du compte."),
      t("Lecture hors-ligne : les épreuves téléchargées restent dans ton navigateur 30 jours au plus, puis sont purgées."),
      t("Journal d'audit de la console : l'e-mail de l'administrateur et l'action réalisée sont conservés pour la sécurité du service."),
    ],
  },
  {
    id: "hebergement",
    titre: t("Où sont hébergées tes données"),
    points: [
      t("Le service tourne chez Render (serveur applicatif et site), avec une base PostgreSQL hébergée chez Supabase et un stockage de fichiers compatible S3."),
      t("Les images d'épreuves sont servies par des liens signés de courte durée, et la console n'expose jamais les identifiants du stockage."),
    ],
  },
  {
    id: "droits",
    titre: t("Tes droits"),
    intro: t("Tu exerces ces droits directement dans l'application, sans attendre notre réponse."),
    points: [
      t("Accès et portabilité : « Exporter mes données », dans ton profil, onglet « Confidentialité », télécharge en un fichier JSON tout ce qui est conservé sur toi."),
      t("Effacement : « Supprimer mon compte » efface immédiatement et définitivement ton profil, tes sessions, tes notes, tes conversations, tes consultations, tes essais, tes signalements, ton avatar, tes abonnements et tes paiements."),
      t("Rectification : ton nom, ton niveau, ta classe, ton établissement et ta photo se modifient dans ton profil."),
      t("Retrait du consentement : décoche une finalité dans l'onglet « Confidentialité » puis appuie sur « Enregistrer mes choix »."),
    ],
  },
  {
    id: "securite",
    titre: t("Sécurité"),
    points: [
      t("Le cookie de session est httpOnly et SameSite=Lax, et marqué Secure en production : il n'est pas lisible par le JavaScript de la page."),
      t("Un seul appareil est connecté à la fois ; une nouvelle connexion ferme la précédente et prévient l'ancienne."),
      t("Les pages consultées portent un filigrane avec ton identité et l'horodatage : il dissuade la rediffusion des épreuves et permet de retrouver l'origine d'une fuite."),
      t("Les échanges passent en HTTPS en production, et la politique de sécurité du site limite les scripts aux domaines nécessaires, dont Google pour la connexion."),
    ],
  },
  {
    id: "contact",
    titre: t("Une question sur tes données"),
    intro: t("Écris à l'adresse e-mail affichée dans ton profil, onglet « Confidentialité ». Si la réponse ne te satisfait pas, tu peux saisir l'ANTIC, l'autorité camerounaise chargée de la protection des données personnelles."),
  },
];

const SECTIONS_CONDITIONS: Section[] = [
  {
    id: "objet",
    titre: t("Ce que couvre ce document"),
    intro: t("Copies & Corrigés donne accès à des épreuves et à leurs corrigés du secondaire camerounais, de la 6e à la Terminale, ainsi qu'à des outils de révision : Tuteur IA, notes, chronomètre, examen blanc, révision espacée et calendrier des examens."),
    points: [
      t("En créant un compte ou en utilisant le service, tu acceptes ces conditions et la politique de confidentialité."),
      t("Si tu es mineur, tu utilises le service avec l'accord et sous la responsabilité de ton représentant légal."),
    ],
  },
  {
    id: "compte",
    titre: t("Ton compte"),
    points: [
      t("La connexion se fait avec un compte Google : nous ne conservons aucun mot de passe."),
      t("Un compte est personnel et un seul appareil peut l'utiliser à la fois ; partager ses identifiants est interdit."),
      t("Donne des informations exactes : ton nom, ta classe et ton établissement servent à adapter le catalogue et le suivi de ta révision."),
      t("Tu peux supprimer ton compte à tout moment depuis ton profil ; la suppression est définitive."),
    ],
  },
  {
    id: "contenus",
    titre: t("Épreuves, corrigés et propriété"),
    points: [
      t("Les épreuves proviennent d'annales d'examens officiels et de documents transmis à l'équipe ; les corrigés et les fiches sont rédigés ou relus par l'équipe avant publication."),
      t("Le service t'est fourni pour ta révision personnelle. La revente, la rediffusion publique, l'extraction massive et le contournement du filigrane ou d'un abonnement sont interdits."),
      t("Le filigrane qui porte ton identité sur les pages consultées permet de retrouver l'origine d'une diffusion non autorisée."),
    ],
  },
  {
    id: "abonnements",
    titre: t("Abonnements et paiement"),
    points: [
      t("Une formule ouvre une épreuve, une matière, une année ou une série pour la durée affichée au moment de l'achat ; le prix est indiqué en FCFA."),
      t("Le paiement se fait par Orange Money ou MTN Mobile Money via un prestataire de paiement : nous ne voyons ni ne conservons tes identifiants bancaires."),
      t("Il n'y a pas de reconduction automatique : l'abonnement s'arrête à sa date de fin."),
      t("Tu peux annuler un abonnement actif depuis ton profil ; l'accès est alors révoqué immédiatement, sans remboursement au prorata."),
    ],
  },
  {
    id: "tuteur-ia",
    titre: t("Le Tuteur IA"),
    points: [
      t("Le Tuteur est une aide à la révision : il peut se tromper, oublier une étape ou proposer une méthode différente de celle de ton professeur. Le corrigé officiel et ton professeur restent la référence."),
      t("Le nombre de questions est limité par jour pour rester disponible pour tous ; une fois la limite atteinte, réessaie le lendemain."),
      t("N'écris pas dans le Tuteur de données sensibles (santé, mots de passe, coordonnées d'autres personnes) : elles seraient transmises au fournisseur d'IA."),
    ],
  },
  {
    id: "usage",
    titre: t("Usage acceptable"),
    points: [
      t("Ne partage pas ton compte, n'automatise pas le téléchargement du catalogue et ne contourne pas les protections du lecteur."),
      t("Les signalements doivent décrire un problème réel ; un envoi répété de messages sans rapport peut être bloqué."),
      t("Un compte qui enfreint ces règles peut être suspendu ou fermé, avec conservation du journal d'audit nécessaire à la sécurité."),
    ],
  },
  {
    id: "disponibilite",
    titre: t("Disponibilité et évolutions"),
    points: [
      t("Le service est fourni en l'état, sans garantie de disponibilité continue : il peut être interrompu pour maintenance, mise à jour ou incident d'hébergement."),
      t("Les épreuves téléchargées restent lisibles hors connexion pendant 30 jours."),
      t("Le catalogue, les formules et ces conditions peuvent évoluer ; la date de mise à jour figure en tête de page et un changement important est annoncé dans l'application."),
    ],
  },
  {
    id: "responsabilite",
    titre: t("Responsabilité"),
    points: [
      t("Les contenus sont pédagogiques : ils ne garantissent aucun résultat à un examen."),
      t("Dans les limites permises par la loi camerounaise, notre responsabilité ne couvre pas les dommages indirects liés à l'usage du service, notamment la perte de données locales effacées par le navigateur."),
    ],
  },
  {
    id: "donnees-perso",
    titre: t("Données personnelles"),
    intro: t("Le traitement de tes données, les durées de conservation et tes droits sont décrits en détail dans la politique de confidentialité."),
  },
  {
    id: "droit-applicable",
    titre: t("Droit applicable"),
    points: [
      t("Ces conditions sont régies par le droit camerounais ; les tribunaux camerounais sont compétents en cas de litige."),
      t("Une question sur ces conditions ? Écris à l'adresse e-mail affichée dans ton profil."),
    ],
  },
];

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const confidentialite = kind === "privacy";
  const sections = confidentialite ? SECTIONS_CONFIDENTIALITE : SECTIONS_CONDITIONS;
  const date = DATE_REVISION.toLocaleDateString(locale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <article className="mx-auto max-w-3xl space-y-8">
      <header>
        <p className="font-mono-tag text-[11px] uppercase tracking-wide text-ink-soft">{t("Informations légales")}</p>
        <h1 className="mt-1 font-serif-brand text-3xl">
          {t(confidentialite ? "Politique de confidentialité" : "Conditions d'utilisation")}
        </h1>
        <p className="mt-2 text-xs text-slate">{t("Dernière mise à jour : {date}", { date })}</p>
        <p className="mt-3 rounded-md bg-highlight-soft px-3 py-2 text-xs text-ink-soft">
          {t("Version de travail : ce texte décrit le service tel qu'il fonctionne aujourd'hui, mais il doit encore être relu juridiquement avant l'ouverture commerciale.")}
        </p>
      </header>

      <nav aria-label={t("Sommaire")} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <p className="font-mono-tag text-[10px] uppercase tracking-wide text-ink-soft">{t("Sommaire")}</p>
        <ol className="mt-2 space-y-1 text-sm">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="hover:text-ink hover:underline">
                {s.titre}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-titre`} className="scroll-mt-20">
          <h2 id={`${s.id}-titre`} className="font-serif-brand text-xl">
            {s.titre}
          </h2>
          {s.intro && <p className="mt-2 text-sm leading-relaxed text-ink">{s.intro}</p>}
          {s.points && (
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
              {s.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <footer className="space-y-3 border-t border-ink-soft/15 pt-6 text-sm">
        <p>
          <Link to={confidentialite ? "/conditions" : "/confidentialite"} className="underline hover:text-ink">
            {t(confidentialite ? "Lire les conditions d'utilisation" : "Lire la politique de confidentialité")}
          </Link>
        </p>
        <p>
          <Link to="/aide" className="underline hover:text-ink">
            {t("Ouvrir l'aide")}
          </Link>
        </p>
      </footer>
    </article>
  );
}
