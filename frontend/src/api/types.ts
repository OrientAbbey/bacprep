/** Épreuve résumée pour les listes et le catalogue, sans son contenu Markdown. */
export interface EpreuveListItem {
  id: string;
  niveau: string; // ex. "SECONDAIRE"
  classe: string; // code canonique, ex. "terminale", "3e"
  evaluation: string; // ex. "BAC", "BEPC", "SEQUENCE 1"
  matiere: string;
  annee: string;
  duree: string | null;
  coefficient: string | null;
  extrait: string;
  gratuit: boolean;
  statut: string;
  filieres: string[];
  corrige_disponible: boolean;
  acces: "gratuit" | "ouvert" | "payant";
}

/** Fichier attaché à une épreuve : document Markdown ou image d'illustration, avec sa cible sujet/corrigé. */
export interface EpreuveFile {
  id: string;
  cible: "sujet" | "corrige";
  format: "md" | "image";
  filename: string;
  url: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  mime_type: string;
}

/** Un sujet d'une épreuve : son contenu et son corrigé (optionnel). */
export interface SujetContent {
  index: number;
  contenu_markdown: string;
  corrige_markdown: string;
  corrige_disponible: boolean;
}

/** Détail complet d'une épreuve : tous ses sujets et corrigés, ses fichiers et ses métadonnées de catalogue. */
export interface EpreuveDetail extends EpreuveListItem {
  contenu_markdown: string;
  corrige_markdown: string;
  assets: EpreuveFile[];
  /** Tous les sujets de l'épreuve (chacun avec son corrigé optionnel). */
  sujets: SujetContent[];
  nb_sujets: number;
}

/** Valeurs disponibles pour les filtres du catalogue (séries, matières, années, évaluations). */
export interface Filtres {
  filieres: string[];
  matieres: string[];
  annees: string[];
  evaluations: string[];
}

// ---------- Navigation (Accueil → Niveau → Classe) ----------

/** Entrée de navigation par classe avec le nombre d'épreuves publiées et l'état actif. */
export interface ClasseNav {
  code: string; // ex. "terminale"
  label: string; // ex. "Terminale"
  epreuves: number;
  actif: boolean;
}

/** Groupe de navigation par niveau scolaire, avec ses classes et son état actif. */
export interface NiveauNav {
  code: string; // "SECONDAIRE" | "PRIMAIRE"
  label: string;
  actif: boolean;
  classes: ClasseNav[];
}

/** Arborescence de navigation du site : niveaux puis classes, alimentée par le serveur. */
export interface NavigationOut {
  niveaux: NiveauNav[];
}

// ---------- Abonnements ----------

/** Abonnement actif de l'utilisateur avec son périmètre résolu et ses libellés. */
export interface SubscriptionOut {
  id: string;
  scope: string;
  scope_label: string;
  evaluation: string;
  classe: string;
  filiere: string;
  matiere: string;
  annee: string;
  epreuve_id: string | null;
  epreuve_label: string | null;
  epreuves_couvertes: number;
  start_date: string;
  end_date: string;
  statut: string;
}

/** Consultation d'une épreuve par l'utilisateur, utilisée dans son activité et ses statistiques. */
export interface Consultation {
  epreuve_id: string;
  matiere: string;
  annee: string;
  classe: string;
  evaluation: string;
  filieres: string[];
  consulted_at: string;
}

// ---------- Import massif (admin) ----------

/** Rapport détaillé d'un job d'import : fichiers analysés, épreuves créées, images importées et erreurs. */
export interface ImportJobReport {
  racine?: string;
  analyses?: number;
  epreuves_creees?: number;
  images_importees?: number;
  creees?: { fichier: string; epreuve_id?: string; cible?: string; storage_key?: string; dry_run?: boolean }[];
  doublons?: { fichier: string; doublon_de: string }[];
  /** Contenu identique déjà présent ailleurs : INFORMATION, pas un blocage.
   *  Un logo commun à plusieurs épreuves est légitime. */
  contenus_partages?: { fichier: string; deja_dans: string[] }[];
  /** Références d'images non réécrites vers l'URL contrôlée : l'image
   *  s'affichera cassée. Comptées pour être visibles, jamais ignorées. */
  references_non_reecrites?: { fichier: string; document: string; image: string; nb: number }[];
  ignores?: string[];
  erreurs?: { fichier: string; erreur: string }[];
  metadonnees_manquantes?: { fichier: string; manquants: string[] }[];
}

/** Job d'import asynchrone exposé au back-office avec son statut et son rapport. */
export interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  created_at: string;
  /** Prise en charge RÉELLE par le worker (la demande peut attendre). */
  started_at?: string | null;
  heartbeat_at?: string | null;
  finished_at: string | null;
  /** Durée d'exécution calculée par le serveur, en millisecondes. */
  duration_ms?: number | null;
  report: ImportJobReport;
  logs: string[];
}

// ---------- Notes personnelles ----------

/** Note privée d'un admin sur une cible sujet/corrigé, avec l'extrait de contexte auquel elle se rattache. */
export interface Note {
  id: string;
  epreuve_id: string;
  cible: "sujet" | "corrige";
  contexte_extrait: string;
  contenu: string;
  created_at: string;
  updated_at: string;
  matiere?: string;
  annee?: string;
  classe?: string;
  evaluation?: string;
}

// ---------- Signalements ----------

/** Liste fermée des motifs de signalement d'une épreuve ou d'un gabarit fautif. */
export type MotifSignalement =
  | "contenu_illisible"
  | "erreur_enonce"
  | "corrige_manquant"
  | "image_cassee"
  | "autre";

/** Signalement utilisateur sur une épreuve, avec motif, message et état de traitement. */
export interface Signalement {
  id: string;
  epreuve_id: string;
  motif: MotifSignalement;
  message: string;
  statut: "ouvert" | "resolu";
  created_at: string;
  resolved_at: string | null;
  matiere: string;
  annee: string;
  classe: string;
  auteur_email: string;
}

// ---------- Activité (profil) ----------

/** Liste fermée des types d'événements affichés dans le journal d'activité de l'utilisateur. */
export type TypeActivite =
  | "connexion"
  | "consultation"
  | "abonnement"
  | "paiement"
  | "note"
  | "discussion_ia";

/** Événement du journal d'activité : type, date, libellé et épreuve associée éventuelle. */
export interface ActiviteItem {
  type: TypeActivite;
  date: string;
  libelle: string;
  epreuve_id: string | null;
  details: string;
  /** Gabarit français (`{variable}`) et valeurs de `libelle` : le client les traduit avec `t(cle, params)`. */
  cle?: string;
  params?: Record<string, string | number>;
  /** Présent sur les items `discussion_ia` : permet de rouvrir l'onglet de
   * discussion exact dans le lecteur (/epreuve/{id}?conv={id}). */
  conversation_id?: string | null;
}

// ---------- Admin ----------

/** Liste énumérative du référentiel (table `referentiel_options`,
 * onglet « Paramètres » du back-office). */
/** Portées possibles d'une option du référentiel partagé. */
export type ReferentielScope = "niveau" | "classe" | "evaluation" | "matiere" | "serie";

/** Option d'une liste du référentiel. `label` est le libellé affiché
 * (repli sur `code` côté serveur) ; `en_usage` compte les épreuves qui
 * utilisent encore cette valeur (utile avant une suppression). */
export interface ReferentielOption {
  id: string;
  scope: ReferentielScope;
  code: string;
  label: string;
  position: number;
  en_usage: number;
}

/** Options du référentiel groupées par scope (réponse de
 * GET /api/admin/referentiel-options). */
export type ReferentielOptions = Partial<Record<ReferentielScope, ReferentielOption[]>>;

/** Comptage des épreuves par statut pour les onglets du back-office. */
export interface AdminEpreuveCounts {
  tous: number;
  brouillon: number;
  a_reviser: number;
  publie: number;
}

/** Ligne du journal d'audit admin : action, auteur, cible et contexte. */
export interface AdminEvent {
  id: string;
  action: string;
  epreuve_id: string | null;
  email: string;
  details: Record<string, unknown>;
  created_at: string;
  /** Résumé lisible de l'épreuve concernée (matière — classe (BAC 2023)). */
  epreuve_resume?: string;
}

/** Ligne de la table « Utilisateurs » du back-office — volontairement
 * limitée aux informations de compte et compteurs d'usage (aucune donnée
 * sensible : pas de mot de passe, pas de code de paiement). */
/** Utilisateur vu du back-office avec ses droits, abonnements et activité. */
export interface AdminUtilisateur {
  id: string;
  nom: string;
  email: string;
  /** Identifiant public dictable (« CC-26-A7K3M9 ») : le seul que l'élève
   * communique au support. `null` sur un compte créé avant la migration
   * 2026-11 et pas encore rétrofillé. */
  matricule?: string | null;
  /** Solde de la monnaie interne AK (le journal `ak_mouvements` fait foi).
   * FACULTATIF : un backend antérieur à la migration 2026-11 ne renvoie pas
   * ce champ — l'affichage retombe sur 0 au lieu de planter toute la table
   * (`undefined.toLocaleString()` faisait tomber l'écran entier). */
  solde_ak?: number | null;
  niveau: string | null;
  classe: string | null;
  etablissement: string | null;
  consent_ia: boolean | null;
  consent_notes: boolean | null;
  /** Compte admin (ROOT ∪ promus, calculé serveur) — colonne `role`. */
  is_admin: boolean;
  /** Compte admin ROOT (ADMIN_ROOT) : non bannissable, non supprimable,
   * seul habilité à promouvoir/révoquer les admins délégués. */
  racine: boolean;
  banni: boolean;
  banni_motif: string | null;
  created_at: string;
  derniere_connexion: string | null;
  notes: number;
  discussions_ia: number;
  consultations: number;
  abonnements_actifs: number;
  total_depense_fcfa: number;
}

/** Chiffres-clés affichés en tête du back-office (utilisateurs, revenus, épreuves, stockage). */
export interface AdminStats {
  utilisateurs: number;
  abonnements_actifs: number;
  revenu_total_fcfa: number;
  epreuves_par_statut: Record<string, number>;
  epreuves_par_classe: Record<string, number>;
  stockage: {
    total_octets: number;
    par_format: Record<string, number>;
    nb_fichiers: number;
  };
  revenus_par_mois: Record<string, number>;
  consultations: number;
  notes: number;
  discussions_ia: number;
  signalements_ouverts: number;
}

// ---------- Banque d'exercices V4.10 ----------

/** Partie de la Banque : groupe logique d'exercices rattaché à une matière. */
export interface BanquePartie {
  id: string;
  matiere: string;
  nom: string;
  ordre: number;
}

/** Exercice de la Banque avec son sujet, son corrigé et ses critères de ciblage. */
export interface BanqueExercice {
  id: string;
  sujet: string;
  corrige: string;
  partie_id: string;
  session: number | null;
  niveau_intrinseque: "Facile" | "Moyen" | "Difficile";
  tag_examen: boolean;
  actif: boolean;
  matieres: string[];
  classes: string[];
  series: string[];
  created_at: string;
  updated_at: string;
}

/** Métadonnées de classe pour le tirage : examen et caractère obligatoire de la spécialité. */
export interface BanqueClasseMeta {
  a_examen: boolean;
  specialite_obligatoire: boolean;
}

/** Données complètes du panneau Banque : parties, exercices, référentiel, métadonnées et journal. */
export interface BanqueAdminData {
  parties: BanquePartie[];
  exercices: BanqueExercice[];
  classes_meta: Record<string, BanqueClasseMeta>;
  referentiel: {
    matiere: string[];
    classe: string[];
    serie: string[];
    sequences: number[];
  };
}

/** Entrée du journal d'exploitation de la Banque (génération ou modification admin). */
export interface BanqueJournalEntry {
  id: string;
  user_id: string;
  generation_id: string;
  type: string;
  params: Record<string, unknown>;
  details: Record<string, unknown>;
  created_at: string;
}

/** Mode de composition d'une épreuve : séquence, examen, examen blanc ou feuille vide. */
export type BanqueMode = "sequence" | "examen" | "examen_blanc" | "vide";
/** Niveau de difficulté demandé pour le tirage d'une épreuve. */
export type BanqueDifficulte = "Facile" | "Moyen" | "Difficile";

/** Choix de l'élève pour composer une épreuve depuis la Banque. */
export interface BanqueGenerationInput {
  matiere: string;
  classe: string;
  serie?: string;
  sequence?: number;
  mode: BanqueMode;
  difficulte: BanqueDifficulte;
}

/** Options disponibles pour le formulaire de génération (matières, classes, séries, séquences). */
export interface BanqueOptions {
  matieres: string[];
  classes: string[];
  classes_meta: Record<string, BanqueClasseMeta>;
  series: string[];
  sequences: number[];
}

/** Un exercice numéroté d'une épreuve générée, avec son sujet (ou son contenu). */
export interface BanqueGenerationExercice {
  numero: number;
  sujet?: string;
  contenu?: string;
}

/** Épreuve générée : identifiant de référence, exercices et paramètres de tirage. */
export interface BanqueGenerationOutput {
  generation_id: string;
  exercices: BanqueGenerationExercice[];
  parametres: {
    matiere: string;
    classe: string;
    serie: string | null;
    sequence: number | null;
    mode: BanqueMode;
    difficulte: BanqueDifficulte;
    nb_exercices: number;
  };
}

// ---------- Notifications ----------

// Le `type` est une CHAÎNE LIBRE depuis la revue 2026-09-18 : l'admin peut
// en saisir d'autres (information, nouvelle_epreuve, modification,
// maintenance restent les valeurs usuelles — la pub d'épreuve génère
// `nouvelle_epreuve`).

/** Notification telle qu'affichée dans la cloche d'un élève : uniquement
 * les notifications ACTIVES, avec l'état « lu » propre à l'utilisateur. */
/** Notification destinée à l'élève, affichée dans son fil avec son type et sa date. */
export interface NotificationEleve {
  id: string;
  titre: string;
  message: string;
  type: string;
  /** Épreuve liée (publication) : la cloche propose d'y aller directement. */
  epreuve_id: string | null;
  lue: boolean;
  created_at: string;
  updated_at: string;
}

/** Réponse de GET /api/notifications (cloche). */
export interface NotificationsEleve {
  non_lues: number;
  items: NotificationEleve[];
}

/** Notification vue du back-office : toutes (actives et désactivées). */
export interface NotificationAdmin extends Omit<NotificationEleve, "lue"> {
  actif: boolean;
}

// ---------- Sauvegardes ----------

/** Une partie d'archive : autonome, restaurable seule, avec son empreinte.
 *  `sha256` est la preuve d'intégrité affichée à l'admin — sans elle, la
 *  sauvegarde n'aurait qu'une taille, ce qui ne prouve rien. */
/** Partie composant une sauvegarde : nom, taille, empreinte et nombre de fichiers. */
export interface SauvegardePartie {
  nom: string;
  octets: number;
  sha256: string | null;
  nb_fichiers: number;
}

/** Récapitulatif d'une sauvegarde présente dans le stockage, lu depuis son
 *  index (et non recompté : l'index est la référence). */
/** Sauvegarde disponible dans le stockage objet, avec sa date et sa taille. */
export interface SauvegardeResume {
  cle: string;
  nom: string;
  taille_octets: number;
  modifie_le: string | null;
  parties: SauvegardePartie[];
  epreuves: number;
  fichiers: number;
  url: string | null;
}

/** GET /api/admin/sauvegardes : l'inventaire et le volume total occupé. Aucun
 *  indicateur de santé ni de saturation : la suppression reste une décision
 *  humaine. */
/** Objet de sauvegarde illisible ou inachevé, signalé mais non restaurable. */
export interface SauvegardeIgnoree {
  cle: string;
  raison: string;
}

/** Inventaire des sauvegardes avec les objets ignorés et le volume total. */
export interface SauvegardeInventaire {
  sauvegardes: SauvegardeResume[];
  total_octets: number;
  /** Sauvegardes présentes dans le stockage mais non restaurables : export
   *  encore en cours, interrompu, ou index illisible. Les lister évite de
   *  faire croire à une perte de données. */
  ignorees?: SauvegardeIgnoree[];
}

/** Rapport d'un export ou d'une restauration. Les compteurs sont optionnels
 *  parce qu'un job en échec n'a produit qu'une liste d'erreurs. */
/** Rapport d'un job terminé. Les DEUX services écrivent des clés différentes et
 *  l'IHM ne peut pas les confondre : l'export parle de `nb_fichiers`, la
 *  restauration de `fichiers`/`ecrits`/`deja_presents`. Une clé inventée ici ne
 *  provoque pas d'erreur de compilation — elle affiche `0` en silence, ce qui
 *  est pire : un export réussi s'afficherait « 0 fichier écrit ». D'où les deux
 *  formes, toutes deux optionnelles, et la discrimination par `dry_run`. */
/** Rapport d'une opération de sauvegarde ou de restauration (dry-run compris). */
export interface SauvegardeRapport {
  dry_run?: boolean;
  // -- restauration --
  epreuves?: number;
  fichiers?: number;
  ecrits?: number;
  deja_presents?: number;
  introuvables?: string[];
  corrompues?: { partie: string; motif: string }[];
  // -- export --
  nb_fichiers?: number;
  total_octets?: number;
  // -- communes --
  ecarts?: number;
  octets?: number;
  parties?: unknown[];
  /** Empreinte lisible d'un objet au moment de l'export : `annonce` est ce que la
   *  base affirmait, `calcule` ce que l'objet contenait réellement. Les DEUX
   *  services nomment ces champs ainsi — voir `export_service` comme
   *  `restore_service`. */
  incoherences?: { fichier: string; annonce: string; calcule: string }[];
  absents?: { fichier?: string; storage_key: string; erreur: string }[];
  erreurs?: { fichier?: string; partie?: string; erreur: string }[];
  [cle: string]: unknown;
}

/** Un job d'export ou de restauration. Les compteurs servent à la barre de
 *  progression ; `report` et `logs` ne sont remplis qu'en fin de course. */
/** Job asynchrone d'export ou de restauration, suivi dans le back-office. */
export interface SauvegardeJob {
  id: string;
  kind: "export" | "restore" | string;
  status: "pending" | "running" | "done" | "error" | string;
  destination: string;
  source: string;
  mode: string;
  total_fichiers: number;
  fichiers_faits: number;
  total_octets: number;
  octets_faits: number;
  partie_courante: number;
  parties_total: number;
  report: SauvegardeRapport;
  logs: string[];
  /** Étape courante côté serveur (`manifeste`, `lecture`, `upload`, `index`,
   *  `finalisation`). Vide sur les jobs antérieurs à l'instrumentation. */
  phase?: string;
  /** Durée d'exécution calculée par le serveur, en millisecondes. */
  duration_ms?: number | null;
  created_at: string | null;
  started_at?: string | null;
  heartbeat_at?: string | null;
  finished_at: string | null;
}

/** Événement du calendrier : type, évaluation ciblée, dates, lien officiel et visibilité. */
export interface Evenement {
  id: string;
  titre: string;
  type: "examen" | "resultats" | "inscription";
  evaluation: string;
  date_debut: string; // AAAA-MM-JJ
  date_fin: string;
  lien_officiel: string;
  visible: boolean;
}

/** Échéance de révision calculée après un essai sur une épreuve. */
export interface Revision {
  epreuve_id: string;
  matiere: string;
  annee: string;
  evaluation: string;
  classe: string;
  derniere_note: number | null;
  retard_jours: number;
}
