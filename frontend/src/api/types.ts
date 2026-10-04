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

export interface EpreuveDetail extends EpreuveListItem {
  contenu_markdown: string;
  corrige_markdown: string;
  assets: EpreuveFile[];
  /** Tous les sujets de l'épreuve (chacun avec son corrigé optionnel). */
  sujets: SujetContent[];
  nb_sujets: number;
}

export interface Filtres {
  filieres: string[];
  matieres: string[];
  annees: string[];
  evaluations: string[];
}

// ---------- Navigation (Accueil → Niveau → Classe) ----------

export interface ClasseNav {
  code: string; // ex. "terminale"
  label: string; // ex. "Terminale"
  epreuves: number;
  actif: boolean;
}

export interface NiveauNav {
  code: string; // "SECONDAIRE" | "PRIMAIRE"
  label: string;
  actif: boolean;
  classes: ClasseNav[];
}

export interface NavigationOut {
  niveaux: NiveauNav[];
}

// ---------- Abonnements ----------

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

export interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  created_at: string;
  finished_at: string | null;
  report: ImportJobReport;
  logs: string[];
}

// ---------- Notes personnelles ----------

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

export type MotifSignalement =
  | "contenu_illisible"
  | "erreur_enonce"
  | "corrige_manquant"
  | "image_cassee"
  | "autre";

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

export type TypeActivite =
  | "connexion"
  | "consultation"
  | "abonnement"
  | "paiement"
  | "note"
  | "discussion_ia";

export interface ActiviteItem {
  type: TypeActivite;
  date: string;
  libelle: string;
  epreuve_id: string | null;
  details: string;
  /** Présent sur les items `discussion_ia` : permet de rouvrir l'onglet de
   * discussion exact dans le lecteur (/epreuve/{id}?conv={id}). */
  conversation_id?: string | null;
}

// ---------- Admin ----------

/** Liste énumérative du référentiel (table `referentiel_options`,
 * onglet « Paramètres » du back-office). */
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

export interface AdminEpreuveCounts {
  tous: number;
  brouillon: number;
  a_reviser: number;
  publie: number;
}

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
export interface AdminUtilisateur {
  id: string;
  nom: string;
  email: string;
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

// ---------- Notifications ----------

// Le `type` est une CHAÎNE LIBRE depuis la revue 2026-09-18 : l'admin peut
// en saisir d'autres (information, nouvelle_epreuve, modification,
// maintenance restent les valeurs usuelles — la pub d'épreuve génère
// `nouvelle_epreuve`).

/** Notification telle qu'affichée dans la cloche d'un élève : uniquement
 * les notifications ACTIVES, avec l'état « lu » propre à l'utilisateur. */
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
export interface SauvegardePartie {
  nom: string;
  octets: number;
  sha256: string | null;
  nb_fichiers: number;
}

/** Récapitulatif d'une sauvegarde présente dans le stockage, lu depuis son
 *  index (et non recompté : l'index est la référence). */
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
export interface SauvegardeInventaire {
  sauvegardes: SauvegardeResume[];
  total_octets: number;
}

/** Rapport d'un export ou d'une restauration. Les compteurs sont optionnels
 *  parce qu'un job en échec n'a produit qu'une liste d'erreurs. */
/** Rapport d'un job terminé. Les DEUX services écrivent des clés différentes et
 *  l'IHM ne peut pas les confondre : l'export parle de `nb_fichiers`, la
 *  restauration de `fichiers`/`ecrits`/`deja_presents`. Une clé inventée ici ne
 *  provoque pas d'erreur de compilation — elle affiche `0` en silence, ce qui
 *  est pire : un export réussi s'afficherait « 0 fichier écrit ». D'où les deux
 *  formes, toutes deux optionnelles, et la discrimination par `dry_run`. */
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
  created_at: string | null;
  finished_at: string | null;
}

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

export interface Revision {
  epreuve_id: string;
  matiere: string;
  annee: string;
  evaluation: string;
  classe: string;
  derniere_note: number | null;
  retard_jours: number;
}

export interface EssaiHistorique {
  essais: { epreuve_id: string; matiere: string; annee: string; evaluation: string; note: number | null; duree_s: number | null; date: string }[];
  moyennes: { matiere: string; moyenne: number; essais: number }[];
}
