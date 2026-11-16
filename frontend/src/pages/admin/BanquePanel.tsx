import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FileUp, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type {
  BanqueAdminData,
  BanqueClasseMeta,
  BanqueExercice,
  BanqueJournalEntry,
  BanquePartie,
} from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatRelativeTime } from "../../lib/time";
import { authHeaders, erreurDetail, purgerSessionExpiree } from "./shared";

type PartieForm = { matiere: string; nom: string; ordre: string };
type ExerciceForm = {
  sujet: string;
  corrige: string;
  partie_id: string;
  session: string;
  niveau_intrinseque: BanqueExercice["niveau_intrinseque"];
  tag_examen: boolean;
  actif: boolean;
  matieres: string[];
  classes: string[];
  series: string[];
};

const exerciceVide = (partie_id = ""): ExerciceForm => ({
  sujet: "",
  corrige: "",
  partie_id,
  session: "",
  niveau_intrinseque: "Moyen",
  tag_examen: false,
  actif: true,
  matieres: [],
  classes: [],
  series: [],
});

/** Administration de la banque V4.10 : contenu, métadonnées de classe,
 * journal des générations et sauvegarde JSON. */
export function BanquePanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const fichierRef = useRef<HTMLInputElement>(null);
  const modeImportRef = useRef<"fusionner" | "remplacer">("fusionner");
  const [data, setData] = useState<BanqueAdminData | null>(null);
  const [journal, setJournal] = useState<BanqueJournalEntry[]>([]);
  const [journalErreur, setJournalErreur] = useState(false);
  const [erreur, setErreur] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [partieActive, setPartieActive] = useState("");
  const [partieForm, setPartieForm] = useState<PartieForm | null>(null);
  const [partieEnEdition, setPartieEnEdition] = useState<string | null>(null);
  const [exerciceForm, setExerciceForm] = useState<ExerciceForm | null>(null);
  const [exerciceEnEdition, setExerciceEnEdition] = useState<string | null>(null);
  const [suppression, setSuppression] = useState<{ type: "partie" | "exercice"; id: string; nom: string } | null>(null);
  const [importEnAttente, setImportEnAttente] = useState<{ snapshot: Record<string, unknown>; mode: "fusionner" | "remplacer" } | null>(null);
  const [operation, setOperation] = useState(false);
  const [metaEnCours, setMetaEnCours] = useState<Record<string, boolean>>({});

  const charger = useCallback(async () => {
    setErreur(false);
    setChargement(true);
    try {
      const result = await api.get<BanqueAdminData>("/api/admin/banque", authHeaders(token));
      setData(result);
      setPartieActive((current) => (result.parties.some((p) => p.id === current) ? current : result.parties[0]?.id ?? ""));
    } catch (err) {
      if (!purgerSessionExpiree(err)) setErreur(true);
    } finally {
      setChargement(false);
    }
    try {
      setJournal(await api.get<BanqueJournalEntry[]>("/api/admin/banque/journal?limit=100", authHeaders(token)));
      setJournalErreur(false);
    } catch (err) {
      if (!purgerSessionExpiree(err)) setJournalErreur(true);
    }
  }, [token]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const parties = data?.parties ?? [];
  const exercices = useMemo(
    () => (data?.exercices ?? []).filter((ex) => !partieActive || ex.partie_id === partieActive),
    [data?.exercices, partieActive],
  );
  const partieSelectionnee = parties.find((p) => p.id === partieActive);

  function erreurAction(err: unknown, message: string) {
    if (!purgerSessionExpiree(err)) showToast(erreurDetail(err, message), "error");
  }

  async function enregistrerPartie(e: React.FormEvent) {
    e.preventDefault();
    if (!partieForm) return;
    setOperation(true);
    const payload = { ...partieForm, ordre: Number(partieForm.ordre) || 0 };
    try {
      const saved = partieEnEdition
        ? await api.patch<BanquePartie>(`/api/admin/banque/parties/${partieEnEdition}`, payload, authHeaders(token))
        : await api.post<BanquePartie>("/api/admin/banque/parties", payload, authHeaders(token));
      showToast(partieEnEdition ? "Partie mise à jour." : "Partie créée.", "success");
      setPartieForm(null);
      setPartieEnEdition(null);
      setPartieActive(saved.id);
      await charger();
    } catch (err) {
      erreurAction(err, "L'enregistrement de la partie a échoué — vérifie les champs puis réessaie.");
    } finally {
      setOperation(false);
    }
  }

  function nouvellePartie() {
    setPartieEnEdition(null);
    setPartieForm({ matiere: data?.referentiel.matiere[0] ?? "", nom: "", ordre: "0" });
  }

  function editerPartie(partie: BanquePartie) {
    setPartieEnEdition(partie.id);
    setPartieForm({ matiere: partie.matiere, nom: partie.nom, ordre: String(partie.ordre) });
  }

  function nouveauExercice() {
    if (!partieActive) {
      showToast("Crée ou sélectionne une partie avant d'ajouter un exercice.", "info");
      return;
    }
    setExerciceEnEdition(null);
    setExerciceForm({
      ...exerciceVide(partieActive),
      matieres: partieSelectionnee ? [partieSelectionnee.matiere] : [],
      classes: data?.referentiel.classe.slice(0, 1) ?? [],
    });
  }

  function editerExercice(ex: BanqueExercice) {
    setExerciceEnEdition(ex.id);
    setExerciceForm({
      sujet: ex.sujet,
      corrige: ex.corrige,
      partie_id: ex.partie_id,
      session: ex.session === null ? "" : String(ex.session),
      niveau_intrinseque: ex.niveau_intrinseque,
      tag_examen: ex.tag_examen,
      actif: ex.actif,
      matieres: [...ex.matieres],
      classes: [...ex.classes],
      series: ex.series.includes("SPECIAL:Aucune") ? ["SPECIAL:Aucune"] : [...ex.series],
    });
  }

  async function enregistrerExercice(e: React.FormEvent) {
    e.preventDefault();
    if (!exerciceForm) return;
    setOperation(true);
    const payload = { ...exerciceForm, session: exerciceForm.session ? Number(exerciceForm.session) : null };
    try {
      if (exerciceEnEdition) {
        await api.put(`/api/admin/banque/exercices/${exerciceEnEdition}`, payload, authHeaders(token));
      } else {
        await api.post("/api/admin/banque/exercices", payload, authHeaders(token));
      }
      showToast(exerciceEnEdition ? "Exercice mis à jour." : "Exercice créé.", "success");
      setExerciceForm(null);
      setExerciceEnEdition(null);
      await charger();
    } catch (err) {
      erreurAction(err, "L'enregistrement de l'exercice a échoué — vérifie les contenus et les classes.");
    } finally {
      setOperation(false);
    }
  }

  async function supprimer() {
    if (!suppression) return;
    setOperation(true);
    try {
      await api.del(`/api/admin/banque/${suppression.type === "partie" ? "parties" : "exercices"}/${suppression.id}`, authHeaders(token));
      showToast(suppression.type === "partie" ? "Partie supprimée." : "Exercice supprimé.", "info");
      setSuppression(null);
      if (suppression.type === "partie" && partieActive === suppression.id) setPartieActive("");
      await charger();
    } catch (err) {
      erreurAction(err, "La suppression a échoué. Vérifie que cette partie ne contient plus d'exercice.");
    } finally {
      setOperation(false);
    }
  }

  async function modifierMeta(classe: string, champ: keyof BanqueClasseMeta, valeur: boolean) {
    if (!data) return;
    if (metaEnCours[classe]) return;
    const avant = data.classes_meta[classe] ?? { a_examen: false, specialite_obligatoire: false };
    const meta = { ...avant, [champ]: valeur };
    setMetaEnCours((current) => ({ ...current, [classe]: true }));
    setData((current) => current ? {
      ...current,
      classes_meta: { ...current.classes_meta, [classe]: meta },
    } : current);
    try {
      await api.put(`/api/admin/banque/classes/${encodeURIComponent(classe)}`, meta, authHeaders(token));
      showToast("Métadonnées de classe enregistrées.", "success");
    } catch (err) {
      setData((current) => current ? {
        ...current,
        classes_meta: { ...current.classes_meta, [classe]: avant },
      } : current);
      erreurAction(err, "La mise à jour des métadonnées a échoué.");
    } finally {
      setMetaEnCours((current) => ({ ...current, [classe]: false }));
    }
  }

  async function exporter() {
    try {
      const snapshot = await api.get<Record<string, unknown>>("/api/admin/banque/export", authHeaders(token));
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const lien = document.createElement("a");
      lien.href = url;
      lien.download = `banque-exercices-${new Date().toISOString().slice(0, 10)}.json`;
      lien.click();
      URL.revokeObjectURL(url);
      showToast("Export de la banque téléchargé.", "success");
    } catch (err) {
      erreurAction(err, "L'export n'a pas pu être préparé.");
    }
  }

  async function lireFichier(file: File | undefined, mode: "fusionner" | "remplacer") {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("format");
      setImportEnAttente({ snapshot: parsed as Record<string, unknown>, mode });
    } catch {
      showToast("Ce fichier JSON ne contient pas un export de banque valide.", "error");
    }
  }

  async function importer() {
    if (!importEnAttente) return;
    setOperation(true);
    try {
      const result = await api.post<{ exercices: number; parties: number }>("/api/admin/banque/import", importEnAttente, authHeaders(token));
      showToast(`Import terminé : ${result.parties} partie(s), ${result.exercices} exercice(s).`, "success");
      setImportEnAttente(null);
      await charger();
    } catch (err) {
      erreurAction(err, "L'import n'a pas abouti. Vérifie le fichier et le référentiel.");
      throw err;
    } finally {
      setOperation(false);
    }
  }

  if (erreur) {
    return (
      <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction">
        <p>La banque d'exercices n'a pas pu être chargée.</p>
        <button type="button" onClick={() => void charger()} className="mt-2 min-h-[44px] underline">Réessayer</button>
      </div>
    );
  }
  if (chargement || !data) {
    return <div className="space-y-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-5" aria-busy="true">{[1, 2, 3].map((n) => <Skeleton key={n} className="h-12 w-full" />)}</div>;
  }

  const bouton = "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-ink-soft/25 px-3 text-sm hover:bg-highlight-soft disabled:opacity-50";
  const cases = (label: string, options: string[], selected: string[], onChange: (next: string[]) => void) => (
    <fieldset className="space-y-1">
      <legend className="mb-1 font-mono-tag text-[10px] text-ink-soft">{label} *</legend>
      <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded border border-ink-soft/15 p-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={selected.includes(option)} onChange={(e) => onChange(e.target.checked ? [...selected, option] : selected.filter((v) => v !== option))} />
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif-brand text-lg">Banque d'exercices</h2>
          <p className="mt-1 text-sm text-ink-soft">Gère les parties, les exercices et leurs critères de génération.</p>
        </div>
        <button type="button" onClick={() => void charger()} className={bouton}><RefreshCw size={14} aria-hidden="true" /> Actualiser</button>
      </header>

      <details className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <summary className="cursor-pointer font-serif-brand text-lg">
          Comprendre la banque d&apos;exercices
        </summary>
        <div className="mt-3 space-y-2 text-sm text-ink-soft">
          <p>
            <strong>Partie</strong> — groupe logique auquel appartiennent des exercices
            (par exemple « Fonctions » en Mathématiques). Une partie porte une seule
            matière ; c&apos;est elle que le générateur choisit avant de tirer un exercice.
          </p>
          <p>
            <strong>Matière</strong> — matière de rattachement de la partie. Elle doit
            correspondre au référentiel : elle détermine dans quelles épreuves la partie
            peut apparaître.
          </p>
          <p>
            <strong>Nom</strong> — nom lisible et unique dans une matière. Deux parties de
            la même matière ne peuvent pas porter le même nom. C&apos;est ce libellé que
            l&apos;administrateur voit partout ensuite.
          </p>
          <p>
            <strong>Ordre</strong> — ordre d&apos;affichage, du plus petit au plus grand.
            Ce n&apos;est <em>pas</em> une priorité de tirage : un exercice d&apos;ordre 1
            n&apos;est pas plus souvent choisi qu&apos;un exercice d&apos;ordre 9. Il sert
            seulement à ranger les parties dans un ordre stable et prévisible.
          </p>
          <p>
            <strong>Difficulté</strong> — niveau intrinsèque de l&apos;exercice (Facile,
            Moyen, Difficile). Il sert au générateur à équilibrer un sujet ; il ne change
            pas la difficulté de l&apos;épreuve elle-même.
          </p>
          <p>
            <strong>Classes</strong> — niveaux pour lesquels l&apos;exercice est valable.
            Laisser vide revient à ne le rendre disponible pour aucune classe : coche au
            moins une classe pour qu&apos;il puisse être tiré.
          </p>
          <p>
            <strong>Spécialités</strong> — séries concernées (A, C, D…). « Aucune
            spécialité (toutes les séries) » rend l&apos;exercice disponible pour toutes
            les séries, y compris les classes qui n&apos;en ont pas. Choisir une série
            précise le réserve aux élèves de cette série.
          </p>
          <p>
            <strong>Session</strong> — séquence pédagogique à laquelle l&apos;exercice
            appartient. Laisser vide si l&apos;exercice ne dépend pas d&apos;une
            progression (révision, annales).
          </p>
          <p>
            <strong>Épreuve d&apos;examen</strong> — marque l&apos;exercice comme déjà
            tombé à un examen. La case n&apos;est disponible que si une session est
            choisie : un exercice hors progression ne peut pas porter ce tag.
          </p>
          <p>
            <strong>Actif</strong> — l&apos;exercice est éligible au tirage. Un exercice
            inactif reste dans la banque et garde son historique, mais le générateur ne
            le choisit plus.
          </p>
          <p className="rounded border border-ink-soft/15 bg-paper p-3">
            <strong>Exemple complet.</strong> Pour ajouter les suites en Terminale D :
            crée une partie « Suites » (matière Mathématiques, ordre 3), puis un exercice
            dans cette partie (difficulté Moyen, classes Terminale, spécialité D, session
            « Suites et récurrence », actif). Renseigne le sujet et le corrigé, enregistre.
            L&apos;exercice devient tirable dès qu&apos;il est actif et qu&apos;au moins
            une classe le couvre.
          </p>
        </div>
      </details>

      <section aria-labelledby="banque-parties" className="space-y-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="banque-parties" className="font-serif-brand">Parties</h3>
          <button type="button" onClick={nouvellePartie} className={bouton}><Plus size={14} aria-hidden="true" /> Nouvelle partie</button>
        </div>
        {parties.length === 0 ? <p className="text-sm text-slate">Aucune partie. Crée une partie pour commencer.</p> : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {parties.map((partie) => (
              <li key={partie.id} className={`flex min-w-0 items-center gap-2 rounded border p-2 ${partieActive === partie.id ? "border-highlight bg-highlight-soft/40" : "border-ink-soft/15"}`}>
                <button type="button" onClick={() => { setPartieActive(partie.id); setExerciceForm(null); }} aria-pressed={partieActive === partie.id} className="min-h-[40px] min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium">{partie.nom}</span>
                  <span className="block truncate font-mono-tag text-[10px] text-slate">{partie.matiere} · ordre {partie.ordre}</span>
                </button>
                <button type="button" className={bouton} aria-label={`Modifier la partie ${partie.nom}`} onClick={() => editerPartie(partie)}>Modifier</button>
                <button type="button" className="min-h-[40px] rounded p-2 text-correction hover:bg-correction-soft" aria-label={`Supprimer la partie ${partie.nom}`} onClick={() => setSuppression({ type: "partie", id: partie.id, nom: partie.nom })}><Trash2 size={15} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        {partieForm && (
          <form className="grid gap-3 border-t border-ink-soft/10 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_7rem_auto_auto]" onSubmit={(e) => void enregistrerPartie(e)}>
            <label className="text-xs">Matière<select required title="Matière de rattachement de la partie" value={partieForm.matiere} onChange={(e) => setPartieForm({ ...partieForm, matiere: e.target.value })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm">{data.referentiel.matiere.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label className="text-xs">Nom<input required maxLength={160} title="Nom lisible, unique dans la matière" value={partieForm.nom} onChange={(e) => setPartieForm({ ...partieForm, nom: e.target.value })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm" /></label>
            <label className="text-xs">Ordre<input type="number" min={0} max={10000} title="Ordre d'affichage, du plus petit au plus grand — pas une priorité de tirage" value={partieForm.ordre} onChange={(e) => setPartieForm({ ...partieForm, ordre: e.target.value })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm" /></label>
            <button disabled={operation} className={`${bouton} self-end bg-ink text-paper`}><Save size={14} aria-hidden="true" /> Enregistrer</button>
            <button type="button" onClick={() => { setPartieForm(null); setPartieEnEdition(null); }} className={`${bouton} self-end`}>Annuler</button>
            <p className="text-[10px] text-slate sm:col-span-5">L&apos;ordre range les parties à l&apos;écran ; il ne change pas la fréquence de tirage des exercices.</p>
          </form>
        )}
      </section>

      <section aria-labelledby="banque-exercices" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h3 id="banque-exercices" className="font-serif-brand">Exercices</h3>
            <label className="text-xs text-ink-soft">Partie
              <select value={partieActive} onChange={(e) => { setPartieActive(e.target.value); setExerciceForm(null); }} className="ml-2 min-h-[40px] rounded border border-ink-soft/25 bg-paper-raised px-2 text-sm">
                {parties.map((p) => <option key={p.id} value={p.id}>{p.matiere} — {p.nom}</option>)}
              </select>
            </label>
          </div>
          <button type="button" onClick={nouveauExercice} disabled={!parties.length} className={`${bouton} bg-ink text-paper`}><Plus size={14} aria-hidden="true" /> Nouvel exercice</button>
        </div>
        {exercices.length === 0 ? <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4 text-sm text-slate">Aucun exercice dans cette partie.</p> : (
          <ul className="space-y-2">
            {exercices.map((ex) => (
              <li key={ex.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-soft/15 bg-paper-raised p-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 whitespace-pre-wrap text-sm">{ex.sujet}</p>
                  <p className="mt-1 font-mono-tag text-[10px] text-slate">{ex.niveau_intrinseque} · {ex.session === null ? "Sans session" : `Séquence ${ex.session}`} · {ex.actif ? "Actif" : "Inactif"}</p>
                </div>
                <button type="button" className={bouton} onClick={() => editerExercice(ex)}>Modifier</button>
                <button type="button" className="min-h-[40px] rounded p-2 text-correction hover:bg-correction-soft" aria-label="Supprimer cet exercice" onClick={() => setSuppression({ type: "exercice", id: ex.id, nom: ex.sujet.slice(0, 60) })}><Trash2 size={15} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
        {exerciceForm && (
          <form className="space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-4" onSubmit={(e) => void enregistrerExercice(e)}>
            <h4 className="font-serif-brand">{exerciceEnEdition ? "Modifier l'exercice" : "Nouvel exercice"}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs">Partie *<select required title="Partie qui contient l'exercice" value={exerciceForm.partie_id} onChange={(e) => setExerciceForm({ ...exerciceForm, partie_id: e.target.value })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm">{parties.map((p) => <option key={p.id} value={p.id}>{p.matiere} — {p.nom}</option>)}</select></label>
              <label className="text-xs">Difficulté<select title="Niveau intrinsèque de l'exercice" value={exerciceForm.niveau_intrinseque} onChange={(e) => setExerciceForm({ ...exerciceForm, niveau_intrinseque: e.target.value as ExerciceForm["niveau_intrinseque"] })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm">{["Facile", "Moyen", "Difficile"].map((v) => <option key={v}>{v}</option>)}</select></label>
              <label className="text-xs">Séquence (laisser vide si non applicable)<select title="Progression pédagogique ; vide = exercice hors séquence" value={exerciceForm.session} onChange={(e) => setExerciceForm({ ...exerciceForm, session: e.target.value, tag_examen: e.target.value ? exerciceForm.tag_examen : false })} className="mt-1 min-h-[44px] w-full rounded border border-ink-soft/25 bg-paper px-2 text-sm"><option value="">Aucune</option>{data.referentiel.sequences.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <div className="flex flex-wrap items-end gap-4 pb-2 text-sm">
                <label className="flex items-center gap-2" title="Nécessite une séquence choisie"><input type="checkbox" checked={exerciceForm.tag_examen} disabled={!exerciceForm.session} onChange={(e) => setExerciceForm({ ...exerciceForm, tag_examen: e.target.checked })} /> Épreuve d'examen</label>
                <label className="flex items-center gap-2" title="Un exercice inactif n'est jamais tiré"><input type="checkbox" checked={exerciceForm.actif} onChange={(e) => setExerciceForm({ ...exerciceForm, actif: e.target.checked })} /> Exercice actif</label>
              </div>
            </div>
            {cases("Matières", data.referentiel.matiere, exerciceForm.matieres, (matieres) => setExerciceForm({ ...exerciceForm, matieres }))}
            {cases("Classes", data.referentiel.classe, exerciceForm.classes, (classes) => setExerciceForm({ ...exerciceForm, classes }))}
            <fieldset className="space-y-1">
              <legend className="mb-1 font-mono-tag text-[10px] text-ink-soft">Spécialités *</legend>
              <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto rounded border border-ink-soft/15 p-2">
                {data.referentiel.serie.map((serie) => (
                  <label key={serie} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={exerciceForm.series.includes(serie)} onChange={(e) => setExerciceForm({ ...exerciceForm, series: e.target.checked ? [...exerciceForm.series.filter((value) => value !== "SPECIAL:Aucune"), serie] : exerciceForm.series.filter((value) => value !== serie) })} />
                    {serie}
                  </label>
                ))}
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={exerciceForm.series.includes("SPECIAL:Aucune")} onChange={(e) => setExerciceForm({ ...exerciceForm, series: e.target.checked ? ["SPECIAL:Aucune"] : [] })} />
                  Aucune spécialité (toutes les séries)
                </label>
              </div>
              <p className="text-[10px] text-ink-soft">Cette option inclut aussi les classes sans spécialité.</p>
            </fieldset>
            <p className="text-[10px] text-slate">Coche au moins une classe : sans classe, l&apos;exercice n&apos;est proposé à aucun élève. Les spécialités restreignent le tirage aux séries cochées ; « Aucune spécialité » l&apos;ouvre à toutes.</p>
            <label className="block text-xs">Sujet *<textarea required maxLength={100000} rows={7} value={exerciceForm.sujet} onChange={(e) => setExerciceForm({ ...exerciceForm, sujet: e.target.value })} className="mt-1 w-full rounded border border-ink-soft/25 bg-paper p-3 font-mono text-sm" /></label>
            <label className="block text-xs">Corrigé *<textarea required maxLength={100000} rows={7} value={exerciceForm.corrige} onChange={(e) => setExerciceForm({ ...exerciceForm, corrige: e.target.value })} className="mt-1 w-full rounded border border-ink-soft/25 bg-paper p-3 font-mono text-sm" /></label>
            <div className="flex flex-wrap gap-2">
              <button disabled={operation} className={`${bouton} bg-ink text-paper`}><Save size={14} aria-hidden="true" /> Enregistrer</button>
              <button type="button" onClick={() => { setExerciceForm(null); setExerciceEnEdition(null); }} className={bouton}>Annuler</button>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="banque-classes" className="space-y-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <h3 id="banque-classes" className="font-serif-brand">Métadonnées des classes</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead><tr className="border-b border-ink-soft/15 text-xs text-slate"><th className="py-2 pr-3">Classe</th><th className="py-2 pr-3">Classe d'examen</th><th className="py-2">Spécialité obligatoire</th></tr></thead>
            <tbody>{data.referentiel.classe.map((classe) => {
              const meta = data.classes_meta[classe] ?? { a_examen: false, specialite_obligatoire: false };
              return <tr key={classe} className="border-b border-ink-soft/10"><th scope="row" className="py-2 pr-3 font-medium">{classe}</th>
                {(["a_examen", "specialite_obligatoire"] as const).map((champ) => <td key={champ} className="py-2 pr-3"><input type="checkbox" aria-label={`${champ === "a_examen" ? "Classe d'examen" : "Spécialité obligatoire"} : ${classe}`} checked={meta[champ]} disabled={metaEnCours[classe]} onChange={(e) => void modifierMeta(classe, champ, e.target.checked)} /></td>)}
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="banque-transfert" className="space-y-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <h3 id="banque-transfert" className="font-serif-brand">Import et export</h3>
        <p className="text-sm text-ink-soft">L&apos;export produit un fichier JSON unique contenant les parties, les exercices, le référentiel (matières, classes, séries, séquences) et les métadonnées de classe. Il sert de sauvegarde ou de transfert entre environnements.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void exporter()} className={bouton}><Download size={14} aria-hidden="true" /> Exporter en JSON</button>
          <label className="flex min-h-[40px] items-center gap-2 rounded-full border border-ink-soft/25 px-3 text-sm">
            <FileUp size={14} aria-hidden="true" /> Importer
            <input ref={fichierRef} type="file" accept=".json,application/json" aria-label="Fichier JSON de la banque" className="max-w-48 text-xs" onChange={(e) => { void lireFichier(e.target.files?.[0], modeImportRef.current); modeImportRef.current = "fusionner"; e.target.value = ""; }} />
          </label>
          <button type="button" onClick={() => { modeImportRef.current = "remplacer"; fichierRef.current?.click(); }} className={`${bouton} border-correction/40 text-correction`}>Importer en remplaçant…</button>
        </div>
        <div className="space-y-1 text-xs text-slate">
          <p><strong>Fusionner</strong> — ajoute les éléments du fichier et met à jour ceux qui portent le même identifiant. Les parties, exercices et métadonnées absents du fichier sont conservés.</p>
          <p><strong>Remplacer</strong> — efface la banque actuelle (exercices, parties, métadonnées) puis écrit le contenu du fichier. Aucun retour en arrière automatique : une confirmation explicite est demandée avant l&apos;écriture.</p>
          <p>Les deux imports sont précédés d&apos;un aperçu du contenu. Un import volumineux reste traité en une seule requête : ne ferme pas l&apos;onglet avant le message de fin.</p>
        </div>
      </section>

      <section aria-labelledby="banque-journal" className="space-y-3 rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="banque-journal" className="font-serif-brand">Journal des générations</h3><span className="font-mono-tag text-[10px] text-slate">{journal.length} entrée(s) récente(s)</span></div>
        {journalErreur ? <p role="alert" className="text-sm text-correction">Le journal n'a pas pu être chargé.</p> : journal.length === 0 ? <p className="text-sm text-slate">Aucune génération enregistrée.</p> : (
          <ul className="max-h-96 divide-y divide-ink-soft/10 overflow-y-auto">
            {journal.map((entry) => <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-mono-tag text-[10px] text-slate">{entry.type}</span>
              <span className="min-w-0 flex-1 truncate">{String(entry.params.matiere ?? "—")} · {String(entry.params.classe ?? "—")} · {String(entry.details.count ?? "—")} exercice(s)</span>
              <span className="text-xs text-slate" title={new Date(entry.created_at).toLocaleString("fr-FR")}>{formatRelativeTime(entry.created_at)}</span>
            </li>)}
          </ul>
        )}
      </section>

      {suppression && <ConfirmDialog tone="danger" title={`Supprimer ${suppression.type} « ${suppression.nom} » ?`} message={suppression.type === "partie" ? "La partie ne peut être supprimée que si elle ne contient aucun exercice et si une autre partie existe pour cette matière." : "L'exercice et ses contenus seront supprimés de la banque."} confirmLabel="Supprimer" onConfirm={supprimer} onClose={() => setSuppression(null)} />}
      {importEnAttente && <ConfirmDialog tone={importEnAttente.mode === "remplacer" ? "danger" : "default"} title={importEnAttente.mode === "remplacer" ? "Remplacer la banque ?" : "Fusionner cet import ?"} message={importEnAttente.mode === "remplacer" ? "Cette action remplace les exercices, les parties et les métadonnées actuellement enregistrés." : "Les éléments du fichier seront ajoutés ou mis à jour dans la banque."} confirmLabel="Importer" onConfirm={importer} onClose={() => setImportEnAttente(null)} />}
    </div>
  );
}
