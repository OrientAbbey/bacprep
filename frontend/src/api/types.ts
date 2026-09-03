export interface EpreuveListItem {
  id: string;
  niveau: string; // ex. "SECONDAIRE"
  classe: string; // code canonique, ex. "terminale", "3e"
  evaluation: string; // ex. "BAC", "BEPC", "SEQUENCE 1"
  matiere: string;
  annee: string;
  session: string;
  duree: string | null;
  coefficient: string | null;
  gratuit: boolean;
  statut: string;
  filieres: string[];
  corrige_disponible: boolean;
}

export interface EpreuveFile {
  id: string;
  cible: "sujet" | "corrige";
  format: "md" | "image";
  filename: string;
  url: string;
}

export interface EpreuveDetail extends EpreuveListItem {
  contenu_markdown: string;
  corrige_markdown: string;
  assets: EpreuveFile[];
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
}
