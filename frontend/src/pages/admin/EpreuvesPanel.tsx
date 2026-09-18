import { useEffect, useState } from "react";
import { Bot, Check, Plus, Search, X } from "lucide-react";
import { api, ApiError, ensureReferentielOption } from "../../api/client";
import { AdminEpreuveCounts, EpreuveDetail, ReferentielOptions } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { CLASSES_SECONDAIRE, EVALUATIONS, NIVEAUX, SERIES_CONNUES, classeLabel } from "../../lib/referentiel";
import { AdminAssistantPanel } from "./AdminAssistantPanel";
import type { ModificationsEpreuve } from "../../lib/adminAssistant";
import { authHeaders, Asset, ContentBlock, DocumentFile, EditableSelect, EMPTY_FORM, EpreuveForm, escapeRegExp, extraireBaliseImage, Field, remplacerLargeur, SujetFormData } from "./shared";

interface AdminEpreuveSummary {
  id: string;
  matiere: string;
  annee: string;
  classe: string;
  evaluation: string;
  filieres: string[];
  statut: string;
  gratuit: boolean;
  corrige_disponible: boolean;
}

const SIDEBAR_LIMIT = 30;

/** Années proposées dans la liste déroulante du champ « Année » : de
 * l'année courante jusqu'à 15 ans en arrière (bornes d'une session
 * d'examen raisonnable) — la saisie libre reste possible (EditableSelect). */
function anneesProposees(): string[] {
  const courante = new Date().getFullYear();
  return Array.from({ length: 16 }, (_, i) => String(courante - i));
}

/** Retire la première occurrence d'une balise `![...](url)` référençant
 * cette URL précise, quel que soit le texte de légende (l'admin a pu le
 * modifier depuis l'insertion automatique) et un éventuel fragment de
 * taille d'affichage (`#w=NNN`) — utilisé quand une image est supprimée,
 * pour garder le Markdown cohérent avec les fichiers restants. */
function removeImageTag(markdown: string, url: string): string {
  // Matching sur l'URL SANS jeton : la balise du texte peut porter un jeton
  // différent de `assets[].url` (re-signé à chaque GET) — sans cela la
  // balise resterait après la suppression du fichier (lien mort).
  const base = escapeRegExp(url.split("?")[0].split("#")[0]);
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${base}(?:\\?[^#)]*)?(?:#w=\\d+)?\\)\\n?`, "g");
  return markdown.replace(re, "");
}

/** Liste + éditeur des épreuves. L'état vit ICI (liste, recherche, formulaire,
 * confirmations) et non dans le shell `/admin` : les autres panneaux n'en ont
 * pas besoin. */
export function EpreuvesPanel({
  token,
  onSessionExpiree,
  detailAOpenir,
  onDetailOuvert,
  onEpreuvesChange,
}: {
  token: string;
  onSessionExpiree: () => void;
  detailAOpenir?: string | null;
  onDetailOuvert?: () => void;
  onEpreuvesChange?: () => void;
}) {
  const { showToast } = useToast();
  const [epreuves, setEpreuves] = useState<AdminEpreuveSummary[]>([]);
  const [search, setSearch] = useState("");
  const [statutFiltre, setStatutFiltre] = useState<string>("");
  const [counts, setCounts] = useState<AdminEpreuveCounts | null>(null);
  const [form, setForm] = useState<EpreuveForm>(EMPTY_FORM);
  const [nouvelleSerie, setNouvelleSerie] = useState("");
  // Sujet en cours d'édition : la rangée d'onglets (Sujet 1, Sujet 2…)
  // passe de l'un à l'autre. Chaque sujet garde son propre état d'aperçu
  // (texte/rendu) pour le sujet et pour le corrigé.
  const [sujetActif, setSujetActif] = useState(0);
  const [previewSujet, setPreviewSujet] = useState<Record<number, boolean>>({});
  const [previewCorrige, setPreviewCorrige] = useState<Record<number, boolean>>({});
  const [listeChargement, setListeChargement] = useState(true);
  const [listeErreur, setListeErreur] = useState(false);
  // Confirmation en attente pour les actions irréversibles (suppression
  // épreuve, image ou document) — remplace window.confirm.
  const [confirmation, setConfirmation] = useState<{
    titre: string;
    message: string;
    action: () => void | Promise<void>;
  } | null>(null);
  // Options du référentiel (table `referentiel_options`, onglet Paramètres)
  // : alimentent les listes du formulaire. `null` avant le premier
  // chargement — les constantes `lib/referentiel.ts` servent alors de repli.
  const [referentiel, setReferentiel] = useState<ReferentielOptions | null>(null);
  // Statut de l'épreuve en cours d'édition (pour le snapshot envoyé à
  // l'assistant admin) — dérivé du détail chargé par `fetchDetail`, mis à
  // jour après publication/dépublication, et remis à "brouillon" quand on
  // passe en mode « Nouvelle épreuve ».
  const [statutForm, setStatutForm] = useState("brouillon");
  // État du tiroir droit de l'assistant admin.
  const [assistantOuvert, setAssistantOuvert] = useState(false);

  /** Recharge les listes du référentiel — aussi après une sauvegarde (le
   * serveur auto-ajoute matières/sessions/séries saisies hors liste). Échec
   * silencieux : le formulaire retombe sur les constantes. */
  function refreshReferentiel() {
    api
      .get<ReferentielOptions>("/api/admin/referentiel-options", authHeaders(token))
      .then(setReferentiel)
      .catch(() => undefined);
  }

  useEffect(() => {
    refreshReferentiel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Session admin expirée côté serveur (401) : purge le jeton local pour
   * repasser par le formulaire de connexion. Retourne vrai si c'était un
   * 401 — les autres erreurs restent à la charge de l'appelant. */
  function handle401(err: unknown): boolean {
    if (!(err instanceof ApiError && err.status === 401)) return false;
    onSessionExpiree();
    return true;
  }

  /**
   * Charge la liste des épreuves (limitée à SIDEBAR_LIMIT, filtrable par
   * recherche — voir `search`) ainsi que les compteurs par statut.
   */
  async function loadAll(t: string, searchTerm: string, statut = "") {
    setListeChargement(true);
    setListeErreur(false);
    try {
      const params = new URLSearchParams({ limit: String(SIDEBAR_LIMIT) });
      if (searchTerm.trim()) params.set("q", searchTerm.trim());
      if (statut) params.set("statut", statut);
      const list = await api.get<AdminEpreuveSummary[]>(`/api/admin/epreuves?${params}`, authHeaders(t));
      setEpreuves(list);
      const cnt = await api.get<AdminEpreuveCounts>("/api/admin/epreuves/counts", authHeaders(t));
      setCounts(cnt);
    } catch (err) {
      if (!handle401(err)) setListeErreur(true);
    } finally {
      setListeChargement(false);
    }
  }

  // Recharge la liste à chaque frappe dans la recherche ou changement de
  // puces de statut (avec un léger anti-rebond pour ne pas spammer l'API).
  useEffect(() => {
    const timer = setTimeout(() => loadAll(token, search, statutFiltre), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, statutFiltre]);

  // Ouverture d'une épreuve depuis le journal d'audit (lien cliquable du
  // panneau Journal) : précharge le détail et signale au shell que le lien
  // a été consommé (sinon l'effet repartirait à chaque re-rendu).
  useEffect(() => {
    if (detailAOpenir) {
      fetchDetail(detailAOpenir);
      onDetailOuvert?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailAOpenir]);

  /** Charge le détail complet d'une épreuve (métadonnées + contenu chargé
   * depuis le stockage + fichiers) dans le formulaire d'édition. */
  async function fetchDetail(id: string) {
    try {
      const detail = await api.get<EpreuveDetail>(
        `/api/admin/epreuves/${id}`,
        authHeaders(token)
      );
      setForm({
        id: detail.id,
        niveau: detail.niveau || "SECONDAIRE",
        classe: detail.classe || "terminale",
        evaluation: detail.evaluation || "BAC",
        matiere: detail.matiere || "",
        annee: detail.annee || "",
        session: detail.session || "",
        duree: detail.duree || "",
        coefficient: detail.coefficient || "",
        gratuit: Boolean(detail.gratuit),
        filieres: detail.filieres || [],
        // Les sujets de l'épreuve (chacun avec son corrigé optionnel) —
        // repli sur l'index 0 à plat pour les épreuves précédant ce
        // chantier.
        sujets:
          detail.sujets && detail.sujets.length > 0
            ? detail.sujets
            : [
                {
                  index: 0,
                  contenu_markdown: detail.contenu_markdown || "",
                  corrige_markdown: detail.corrige_markdown || "",
                },
              ],
        assets: detail.assets || [],
        documents: (detail as unknown as { documents?: DocumentFile[] }).documents || [],
      });
      setSujetActif(0);
      setStatutForm(detail.statut || "brouillon");
    } catch (err) {
      if (!handle401(err)) {
        showToast("Le détail de l'épreuve n'a pas pu être chargé.", "error");
      }
    }
  }

  function toggleSerie(serie: string) {
    setForm((f) => ({
      ...f,
      filieres: f.filieres.includes(serie)
        ? f.filieres.filter((s) => s !== serie)
        : [...f.filieres, serie],
    }));
  }

  /** Options d'un scope : celles de la table (onglet « Paramètres »)
   * fusionnées avec les constantes `lib/referentiel.ts` — une valeur héritée
   * reste proposable même si la table est vidée ou incomplète. */
  function scopeOptions(scope: "niveau" | "classe" | "evaluation" | "serie"): { value: string; label: string }[] {
    const ref = (referentiel?.[scope] ?? []).map((o) => ({ value: o.code, label: o.label || o.code }));
    const chute: { value: string; label: string }[] =
      scope === "niveau"
        ? NIVEAUX.map((n) => ({ value: n.code, label: n.label }))
        : scope === "classe"
          ? CLASSES_SECONDAIRE.map((c) => ({ value: c.code, label: c.label }))
          : scope === "evaluation"
            ? EVALUATIONS.map((ev) => ({ value: ev, label: ev }))
            : SERIES_CONNUES.map((s) => ({ value: s, label: s }));
    const vus = new Set(ref.map((o) => o.value));
    return [...ref, ...chute.filter((c) => !vus.has(c.value))];
  }

  async function save() {
    const payload = {
      niveau: form.niveau,
      classe: form.classe,
      evaluation: form.evaluation,
      matiere: form.matiere,
      annee: form.annee,
      session: form.session,
      duree: form.duree || null,
      coefficient: form.coefficient || null,
      gratuit: form.gratuit,
      filieres: form.filieres,
      // L'ensemble des sujets (chacun avec son corrigé optionnel) — le
      // serveur remplace la collection complète.
      sujets: form.sujets.map((s) => ({
        index: s.index,
        contenu_markdown: s.contenu_markdown,
        corrige_markdown: s.corrige_markdown,
      })),
    };
    try {
      let id = form.id;
      if (id) {
        await api.put(`/api/admin/epreuves/${id}`, payload, authHeaders(token));
        showToast("Épreuve mise à jour.", "success");
      } else {
        const res = await api.post<{ id: string }>("/api/admin/epreuves", payload, authHeaders(token));
        id = res.id;
        setForm((f) => ({ ...f, id: res.id }));
        showToast("Épreuve créée (brouillon).", "success");
      }
      // Recharger le détail APRÈS l'enregistrement : la liste `documents`
      // et les URLs signées (`assets[].url`) doivent refléter l'état
      // serveur — sans ce refetch, la liste affiche d'anciens ids (la
      // collection n'a pas été recréée mais elle a pu changer) et la
      // suppression d'un document part en 404 (revue 2026-09, F3/F4).
      if (id) {
        const indexAvant = sujetActif;
        await fetchDetail(id);
        setSujetActif(indexAvant);
      }
      loadAll(token, search, statutFiltre);
      onEpreuvesChange?.();
      refreshReferentiel();
    } catch {
      showToast("Échec de l'enregistrement — vérifie les champs.", "error");
    }
  }

  function onEditFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    save();
  }

  async function publish() {
    if (!form.id) return;
    try {
      await api.post(`/api/admin/epreuves/${form.id}/publish`, undefined, authHeaders(token));
      setStatutForm("publie");
      showToast("Épreuve publiée.", "success");
      loadAll(token, search, statutFiltre);
      onEpreuvesChange?.();
    } catch {
      showToast("Publication refusée — sujet et au moins une série sont requis.", "error");
    }
  }

  async function unpublish() {
    if (!form.id) return;
    try {
      await api.post(`/api/admin/epreuves/${form.id}/unpublish`, undefined, authHeaders(token));
      setStatutForm("a_reviser");
      showToast("Épreuve dépubliée.", "info");
      loadAll(token, search, statutFiltre);
      onEpreuvesChange?.();
    } catch (err) {
      if (!handle401(err)) {
        showToast("La dépublication a échoué — réessaie.", "error");
      }
    }
  }

  async function remove(id: string) {
    setConfirmation({
      titre: "Supprimer cette épreuve ?",
      message: "Supprimer définitivement cette épreuve (et son corrigé, ses images) ?",
      action: async () => {
        try {
          await api.del(`/api/admin/epreuves/${id}`, authHeaders(token));
          setForm(EMPTY_FORM);
          setStatutForm("brouillon");
          showToast("Épreuve supprimée.", "info");
          loadAll(token, search, statutFiltre);
          onEpreuvesChange?.();
        } catch (err) {
          if (!handle401(err)) {
            showToast("La suppression a échoué — réessaie.", "error");
          }
        }
      },
    });
  }

  async function uploadImage(file: File, cible: "sujet" | "corrige") {
    if (!form.id) {
      showToast("Enregistre d'abord l'épreuve avant d'ajouter des images.", "error");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("cible", cible);
    try {
      const asset = await api.upload<Asset>(`/api/admin/epreuves/${form.id}/images`, fd, authHeaders(token));
      if (asset.doublon_de) {
        showToast(`Image identique déjà présente sur l'épreuve ${asset.doublon_de}.`, "info");
      }
      const tag = `![légende](${asset.url})`;
      setForm((f) => ({
        ...f,
        assets: [...f.assets, asset],
        // La balise rejoint le SUJET EN COURS d'édition (les images restent
        // rattachées à leur cible sujet/corrigé, pas à un index précis).
        sujets: f.sujets.map((s) =>
          s.index === sujetActif
            ? cible === "sujet"
              ? { ...s, contenu_markdown: s.contenu_markdown + "\n" + tag }
              : { ...s, corrige_markdown: s.corrige_markdown + "\n" + tag }
            : s
        ),
      }));
      showToast("Image téléversée et insérée.", "success");
    } catch {
      showToast("Échec de l'upload d'image.", "error");
    }
  }

  /** Bouton "x" sur une vignette : supprime le fichier côté serveur ET
   * retire la balise Markdown correspondante du texte, pour ne pas
   * laisser un lien mort dans le sujet/corrigé. */
  async function deleteImage(asset: Asset) {
    setConfirmation({
      titre: "Retirer cette image ?",
      message: "Retirer cette image des fichiers de l'épreuve ?",
      action: async () => {
        try {
          await api.del(`/api/admin/files/${asset.id}`, authHeaders(token));
          setForm((f) => ({
            ...f,
            assets: f.assets.filter((a) => a.id !== asset.id),
            // La balise de l'image est retirée de TOUS les sujets dont elle
            // apparaît dans le texte de la cible correspondante (une image
            // peut avoir été insérée dans plusieurs sujets).
            sujets: f.sujets.map((s) => ({
              ...s,
              contenu_markdown:
                asset.cible === "sujet" ? removeImageTag(s.contenu_markdown, asset.url) : s.contenu_markdown,
              corrige_markdown:
                asset.cible === "corrige" ? removeImageTag(s.corrige_markdown, asset.url) : s.corrige_markdown,
            })),
          }));
          showToast("Image retirée.", "success");
        } catch {
          showToast("Échec de la suppression de l'image.", "error");
        }
      },
    });
  }

  /** Supprime un DOCUMENT (sujet.md/corrige.md) de la liste — le contenu
   * de la cible est perdu, confirmation explicite. */
  async function deleteDocument(doc: DocumentFile) {
    setConfirmation({
      titre: "Supprimer ce document ?",
      message: `Supprimer le document « ${doc.filename} » (${doc.cible}) ? Le contenu correspondant sera perdu.`,
      action: async () => {
        try {
          await api.del(`/api/admin/files/${doc.id}`, authHeaders(token));
          setForm((f) => ({ ...f, documents: f.documents.filter((d) => d.id !== doc.id) }));
          showToast("Document supprimé.", "success");
        } catch {
          showToast("Échec de la suppression du document.", "error");
        }
      },
    });
  }

  /** Bouton "+" sur une vignette : insère la balise Markdown de cette image
   * dans le texte correspondant (une seule rangée — jamais de doublon ; si
   * la balise y est déjà, la taille d'affichage ci-dessous redimensionne).
   * Une largeur d'affichage (`#w=NNN`, chantier « images redimensionnables »)
   * est accolée à l'URL si demandée — elle est ensuite respectée par le
   * rendu de l'éditeur ET du lecteur. */
  function insertImageTag(asset: Asset, width?: number) {
    const sujet = form.sujets.find((s) => s.index === sujetActif);
    if (!sujet) return;
    const zone = asset.cible === "sujet" ? sujet.contenu_markdown : sujet.corrige_markdown;
    if (extraireBaliseImage(zone, asset.url).presente) {
      showToast("Cette image est déjà dans le texte — utilise la taille ci-dessous.", "info");
      return;
    }
    const taille = width && width > 0 ? `#w=${width}` : "";
    const tag = `![légende](${asset.url}${taille})`;
    setForm((f) => ({
      ...f,
      // Insérée dans le SUJET EN COURS d'édition — la cible (sujet/corrigé)
      // de l'image détermine la zone touchée.
      sujets: f.sujets.map((s) =>
        s.index === sujetActif
          ? asset.cible === "sujet"
            ? { ...s, contenu_markdown: s.contenu_markdown + "\n" + tag }
            : { ...s, corrige_markdown: s.corrige_markdown + "\n" + tag }
          : s
      ),
    }));
    showToast("Balise image insérée dans le texte.", "success");
  }

  /** Sélecteur « Taille d'affichage » : réécrit la largeur `#w=NNN` de la
   * balise DÉJÀ insérée dans le texte du sujet en cours (la balise absente
   * est insérée avec la largeur choisie). Contrairement à l'ancien
   * comportement (largeur mémorisée puis balise insérée par « + »), le
   * redimensionnement agit À LA VOLÉE et sans jamais dupliquer l'image. */
  function resizeImage(asset: Asset, width: number) {
    const sujet = form.sujets.find((s) => s.index === sujetActif);
    if (!sujet) return;
    const zone = asset.cible === "sujet" ? sujet.contenu_markdown : sujet.corrige_markdown;
    if (extraireBaliseImage(zone, asset.url).presente) {
      setForm((f) => ({
        ...f,
        sujets: f.sujets.map((s) =>
          s.index === sujetActif
            ? {
                ...s,
                contenu_markdown:
                  asset.cible === "sujet" ? remplacerLargeur(s.contenu_markdown, asset.url, width) : s.contenu_markdown,
                corrige_markdown:
                  asset.cible === "corrige" ? remplacerLargeur(s.corrige_markdown, asset.url, width) : s.corrige_markdown,
              }
            : s
        ),
      }));
    } else {
      insertImageTag(asset, width || undefined);
    }
  }

  /** Met à jour un champ (sujet ou corrigé) d'un sujet précis. */
  function updateSujet(index: number, champ: "contenu_markdown" | "corrige_markdown", valeur: string) {
    setForm((f) => ({
      ...f,
      sujets: f.sujets.map((s) => (s.index === index ? { ...s, [champ]: valeur } : s)),
    }));
  }

  /** Bouton « + » de la rangée d'onglets : ajoute un nouveau sujet à
   * l'épreuve (index suivant, texte vide) et bascule dessus. */
  function addSujet() {
    const maxIndex = form.sujets.reduce((m, s) => Math.max(m, s.index), -1);
    const nouvelIndex = maxIndex + 1;
    setForm((f) => ({
      ...f,
      sujets: [...f.sujets, { index: nouvelIndex, contenu_markdown: "", corrige_markdown: "" }],
    }));
    setSujetActif(nouvelIndex);
  }

  /** Bouton « x » d'un onglet : retire un sujet (et son corrigé éventuel)
   * de l'édition — le contenu marqué pour suppression n'est réellement
   * effacé que lorsque l'admin confirme. On ne supprime jamais le dernier
   * sujet (une épreuve garde au moins un sujet). */
  function removeSujet(index: number) {
    if (form.sujets.length <= 1) {
      showToast("Une épreuve garde au moins un sujet.", "info");
      return;
    }
    const rang = form.sujets.findIndex((s) => s.index === index) + 1;
    setConfirmation({
      titre: "Supprimer ce sujet ?",
      message: `Le sujet n°${rang} — et son corrigé éventuel — sera retiré de cette épreuve.`,
      action: async () => {
        const restants = form.sujets.filter((s) => s.index !== index);
        setForm((f) => ({ ...f, sujets: restants }));
        if (sujetActif === index) {
          setSujetActif(restants[0]?.index ?? 0);
        }
        showToast("Sujet retiré.", "info");
      },
    });
  }

  /** Import d'un fichier `.md` fourni par un collègue : le contenu est
   * recopié dans la zone de texte de la cible (l'admin garde la main,
   * rien n'est envoyé au serveur à part le Markdown déjà enregistré avec
   * l'épreuve). Écrasement confirmé si la zone n'est pas vide. */
  function importMarkdown(text: string, cible: "sujet" | "corrige") {
    const sujet = form.sujets.find((s) => s.index === sujetActif);
    const current = cible === "sujet" ? sujet?.contenu_markdown || "" : sujet?.corrige_markdown || "";
    const appliquer = () => {
      const clean = text.replace(/^\uFEFF/, "");
      setForm((f) => ({
        ...f,
        // Import dans le SUJET EN COURS d'édition.
        sujets: f.sujets.map((s) =>
          s.index === sujetActif
            ? cible === "sujet"
              ? { ...s, contenu_markdown: clean }
              : { ...s, corrige_markdown: clean }
            : s
        ),
      }));
      showToast("Fichier importé dans la zone de texte.", "success");
    };
    if (current.trim()) {
      setConfirmation({
        titre: "Remplacer le contenu ?",
        message: `Le ${cible === "sujet" ? "sujet" : "corrigé"} contient déjà du texte — il sera remplacé par le contenu du fichier importé.`,
        action: appliquer,
      });
    } else {
      appliquer();
    }
  }

  /** Applique une modification proposée par l'assistant admin au formulaire
   * d'édition (sujet et/ou corrigé réécrits par le LLM). Les zones sont
   * remplies, mais l'admin garde la main : rien n'est envoyé au serveur —
   * l'enregistrement ne se fait qu'avec son clic explicite sur
   * « Enregistrer ». */
  function appliquerModifications(modifications: ModificationsEpreuve) {
    const { sujet, corrige, form: modifForm } = modifications;
    if (!sujet && !corrige && !modifForm) return;
    // Applique la modification au sujet EN COURS d'édition (onglet actif) et
    // les métadonnées au formulaire (le `statut` vit dans `statutForm`, pas
    // dans `form`). Les valeurs numériques JSON du modèle (durée, coefficient)
    // sont ramenées en chaîne pour le formulaire ; `statut` n'est accepté que
    // s'il est dans la liste des statuts valides du formulaire.
    setForm((f) => ({
      ...f,
      ...(modifForm
        ? {
            niveau: modifForm.niveau ?? f.niveau,
            classe: modifForm.classe ?? f.classe,
            evaluation: modifForm.evaluation ?? f.evaluation,
            matiere: modifForm.matiere ?? f.matiere,
            annee: modifForm.annee ?? f.annee,
            session: modifForm.session ?? f.session,
            duree: modifForm.duree !== undefined ? String(modifForm.duree) : f.duree,
            coefficient: modifForm.coefficient !== undefined ? String(modifForm.coefficient) : f.coefficient,
            gratuit: modifForm.gratuit ?? f.gratuit,
            filieres: modifForm.filieres ?? f.filieres,
          }
        : {}),
      sujets: f.sujets.map((s) =>
        s.index === sujetActif
          ? {
              ...s,
              contenu_markdown: sujet ? sujet : s.contenu_markdown,
              corrige_markdown: corrige ? corrige : s.corrige_markdown,
            }
          : s
      ),
    }));
    const STATUTS_FORM = ["brouillon", "a_reviser", "publie"];
    if (modifForm?.statut && STATUTS_FORM.includes(modifForm.statut)) {
      setStatutForm(modifForm.statut);
    }
    showToast("Modification de l'assistant appliquée au formulaire.", "success");
  }

  // Sujet actuellement affiché dans les zones d'édition (onglet actif).
  const sujetActifData = form.sujets.find((s) => s.index === sujetActif) ?? form.sujets[0];
  const rangSujetActif = form.sujets.findIndex((s) => s.index === sujetActifData.index) + 1;

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          <button
            onClick={() => { setForm(EMPTY_FORM); setStatutForm("brouillon"); }}
            className="min-h-[44px] w-full rounded-full border border-ink-soft/25 text-sm"
          >
            + Nouvelle épreuve
          </button>

          {/* Puces de statut avec compteurs : cadrent la liste sans tout
              charger (« Tous (180) », « Brouillon (50) »...). */}
          {counts && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["", "Tous", counts.tous],
                  ["publie", "Publiées", counts.publie],
                  ["a_reviser", "À réviser", counts.a_reviser],
                  ["brouillon", "Brouillons", counts.brouillon],
                ] as [string, string, number][]
              ).map(([value, label, count]) => (
                <button
                  key={value || "tous"}
                  type="button"
                  onClick={() => setStatutFiltre(value)}
                  aria-pressed={statutFiltre === value}
                  className={`rounded-full border px-2.5 py-1 font-mono-tag text-[10px] transition-colors ${
                    statutFiltre === value
                      ? "border-ink bg-ink text-paper"
                      : "border-ink-soft/20 text-ink-soft hover:border-highlight/50"
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <Search
              size={15}
              strokeWidth={1.75}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
              aria-hidden="true"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher une épreuve…"
              aria-label="Rechercher une épreuve par matière ou année"
              className="min-h-[44px] w-full rounded-full border border-ink-soft/25 bg-paper-raised pl-9 pr-3 text-sm"
            />
          </div>

          {listeChargement && epreuves.length === 0 ? (
            <div role="status" aria-label="Chargement de la liste des épreuves" className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : listeErreur ? (
            <div
              role="alert"
              className="rounded-lg border border-correction/30 bg-correction-soft p-4 text-sm text-correction"
            >
              <p>La liste des épreuves n'a pas pu être chargée.</p>
              <button type="button" onClick={() => loadAll(token, search, statutFiltre)} className="mt-2 underline">
                Réessayer
              </button>
            </div>
          ) : epreuves.length === 0 ? (
            <p className="px-1 text-sm text-slate">Aucune épreuve publiée.</p>
          ) : (
            epreuves.map((e) => {
              const selected = form.id === e.id;
              return (
                <button
                  key={e.id}
                  onClick={() => fetchDetail(e.id)}
                  aria-current={selected}
                  className={`block w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                    selected
                      ? "border-highlight bg-highlight-soft"
                      : "border-ink-soft/15 bg-paper-raised hover:border-highlight/50 hover:bg-highlight-soft/40"
                  }`}
                >
                  <p className="font-medium">
                    {e.matiere} — {e.annee}
                  </p>
                  <p className="font-mono-tag text-[10px] text-slate">
                    {classeLabel(e.classe)} · {e.evaluation} · {e.statut} · {e.filieres.join(",")}
                  </p>
                </button>
              );
            })
          )}
          {epreuves.length === SIDEBAR_LIMIT && (
            <p className="px-1 text-xs text-slate">
              Affichage limité aux {SIDEBAR_LIMIT} épreuves les plus récentes — affine la recherche pour en
              trouver d'autres.
            </p>
          )}
        </div>

        <form
          onSubmit={onEditFormSubmit}
          className="space-y-4 rounded-lg border border-ink-soft/15 bg-paper-raised p-5"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <EditableSelect
              label="Niveau"
              value={form.niveau}
              onChange={(v) => setForm((f) => ({ ...f, niveau: v }))}
              options={scopeOptions("niveau")}
            />
            <EditableSelect
              label="Classe"
              value={form.classe}
              onChange={(v) => setForm((f) => ({ ...f, classe: v }))}
              options={scopeOptions("classe")}
            />
            <EditableSelect
              label="Évaluation"
              value={form.evaluation}
              onChange={(v) => setForm((f) => ({ ...f, evaluation: v }))}
              options={scopeOptions("evaluation")}
            />
            <EditableSelect
              label="Année"
              value={form.annee}
              onChange={(v) => setForm((f) => ({ ...f, annee: v }))}
              placeholder="ex. 2024"
              options={anneesProposees().map((a) => ({ value: a, label: a }))}
            />
            {/* Matière / Session : saisie libre (champ + datalist), valeurs
                déjà connues du référentiel proposées — toute valeur hors
                liste est mémorisée par le serveur à l'enregistrement. */}
            <EditableSelect
              label="Matière"
              value={form.matiere}
              onChange={(v) => setForm((f) => ({ ...f, matiere: v }))}
              placeholder="ex. Mathématiques"
              options={(referentiel?.matiere ?? []).map((o) => ({ value: o.label || o.code, label: o.label || o.code }))}
            />
            <EditableSelect
              label="Session"
              value={form.session}
              onChange={(v) => setForm((f) => ({ ...f, session: v }))}
              placeholder="ex. Session normale"
              options={(referentiel?.session ?? []).map((o) => ({ value: o.label || o.code, label: o.label || o.code }))}
            />
            <Field
              label="Durée"
              value={form.duree}
              onChange={(v) => setForm((f) => ({ ...f, duree: v }))}
              placeholder="ex. 4h"
            />
            <Field
              label="Coefficient"
              value={form.coefficient}
              onChange={(v) => setForm((f) => ({ ...f, coefficient: v }))}
              placeholder="ex. 5"
            />
          </div>

          {/* Séries : sélection multiple par puces (une épreuve peut couvrir
              PLUSIEURS séries) + champ libre pour une série hors référentiel.
              Les puces viennent de la table `referentiel_options` (onglet
              Paramètres), et toute nouvelle série saisie y est mémorisée
              (best-effort). */}
          <div>
            <p className="mb-1 font-mono-tag text-[10px] text-ink-soft">Séries / filières</p>
            <div className="flex flex-wrap gap-1.5">
              {scopeOptions("serie").map(({ value: s, label }) => {
                const active = form.filieres.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSerie(s)}
                    aria-pressed={active}
                    className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? "border-ink bg-ink text-paper"
                        : "border-ink-soft/25 text-ink-soft hover:border-highlight/50"
                    }`}
                  >
                    {active && <Check size={12} strokeWidth={2.5} aria-hidden="true" />}
                    {label}
                  </button>
                );
              })}
              {form.filieres
                .filter((s) => !scopeOptions("serie").some((o) => o.value === s))
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSerie(s)}
                    aria-pressed
                    className="flex min-h-[44px] items-center gap-1 rounded-full border border-ink bg-ink px-3 text-xs text-paper"
                  >
                    <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                    {s}
                  </button>
                ))}
            </div>
            <input
              value={nouvelleSerie}
              onChange={(e) => setNouvelleSerie(e.target.value)}
              onKeyDown={(e) => {
                // Bug corrigé : l'input était contrôlé avec value="" —
                // chaque caractère tapé était ajouté comme série (taper
                // "ESP" créait "E", "S", "P") et le placeholder promettait
                // Entrée sans la gérer.
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = nouvelleSerie.trim();
                  if (v && !form.filieres.includes(v)) {
                    setForm((f) => ({ ...f, filieres: [...f.filieres, v] }));
                    // Mémorise la valeur hors liste dans le référentiel
                    // (best-effort, jamais bloquant) puis rafraîchit pour
                    // qu'elle apparaisse dans les puces.
                    void ensureReferentielOption("serie", v, authHeaders(token)).then(() =>
                      refreshReferentiel()
                    );
                  }
                  setNouvelleSerie("");
                }
              }}
              placeholder="Ajouter une série hors référentiel puis Entrée…"
              className="mt-2 min-h-[44px] w-full rounded-[2px] border border-ink-soft/25 bg-paper-raised px-3 text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.gratuit}
              onChange={(e) => setForm((f) => ({ ...f, gratuit: e.target.checked }))}
            />
            Contenu gratuit de découverte
          </label>

          {/* Rangée d'onglets des sujets : un onglet par sujet (Sujet 1,
              Sujet 2…) + bouton « + » pour en ajouter. Le sujet affiché
              ci-dessous suit l'onglet actif — chaque sujet garde son
              corrigé optionnel. */}
          <div role="tablist" aria-label="Sujets de l'épreuve" className="flex flex-wrap items-center gap-1.5">
            {form.sujets.map((s, i) => {
              const actif = s.index === sujetActifData.index;
              const label = `Sujet ${i + 1}`;
              return (
                <div
                  key={s.index}
                  className={`flex items-center rounded-full border transition-colors ${
                    actif ? "border-ink bg-ink text-paper" : "border-ink-soft/20 text-ink-soft"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`sujet-tab-${s.index}`}
                    aria-selected={actif}
                    aria-controls="panel-sujets"
                    tabIndex={actif ? 0 : -1}
                    onClick={() => setSujetActif(s.index)}
                    onKeyDown={(e) => {
                      // Navigation clavier ←/→ entre les sujets.
                      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                      if (!dir || form.sujets.length <= 1) return;
                      e.preventDefault();
                      const suivant = (i + dir + form.sujets.length) % form.sujets.length;
                      setSujetActif(form.sujets[suivant].index);
                    }}
                    className="min-h-[44px] rounded-full px-4 py-1.5 text-sm"
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSujet(s.index);
                    }}
                    aria-label={`Supprimer ${label.toLowerCase()}`}
                    title={`Supprimer ${label.toLowerCase()}`}
                    data-no-activate="true"
                    className={`min-h-[44px] self-stretch px-2 text-paper/60 hover:text-correction ${
                      actif ? "" : "text-ink-soft/60 hover:text-correction"
                    }`}
                  >
                    <X size={12} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={addSujet}
              title="Ajouter un sujet à cette épreuve"
              aria-label="Ajouter un sujet"
              className="flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/20 px-3 text-sm text-ink-soft transition-colors hover:border-highlight/50"
            >
              <Plus size={13} strokeWidth={2.5} aria-hidden="true" />
              Sujet
            </button>
          </div>

          <div role="tabpanel" id="panel-sujets" aria-labelledby={`sujet-tab-${sujetActifData.index}`} className="space-y-4">
            <ContentBlock
              title={rangSujetActif === 1 ? "Sujet" : `Sujet n°${rangSujetActif}`}
              required={sujetActifData.index === 0}
              markdown={sujetActifData.contenu_markdown}
              preview={Boolean(previewSujet[sujetActifData.index])}
              onTogglePreview={() => setPreviewSujet((p) => ({ ...p, [sujetActifData.index]: !p[sujetActifData.index] }))}
              onChange={(v) => updateSujet(sujetActifData.index, "contenu_markdown", v)}
              onUpload={(file) => uploadImage(file, "sujet")}
              onImportMarkdown={(text) => importMarkdown(text, "sujet")}
              assets={form.assets.filter((a) => a.cible === "sujet")}
              documents={form.documents.filter((d) => d.cible === "sujet")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
              onResizeImage={resizeImage}
              onDeleteDocument={deleteDocument}
            />

            <ContentBlock
              title={rangSujetActif === 1 ? "Corrigé (optionnel)" : `Corrigé n°${rangSujetActif} (optionnel)`}
              required={false}
              markdown={sujetActifData.corrige_markdown}
              preview={Boolean(previewCorrige[sujetActifData.index])}
              onTogglePreview={() =>
                setPreviewCorrige((p) => ({ ...p, [sujetActifData.index]: !p[sujetActifData.index] }))
              }
              onChange={(v) => updateSujet(sujetActifData.index, "corrige_markdown", v)}
              onUpload={(file) => uploadImage(file, "corrige")}
              onImportMarkdown={(text) => importMarkdown(text, "corrige")}
              assets={form.assets.filter((a) => a.cible === "corrige")}
              documents={form.documents.filter((d) => d.cible === "corrige")}
              onDeleteImage={deleteImage}
              onInsertImage={insertImageTag}
              onResizeImage={resizeImage}
              onDeleteDocument={deleteDocument}
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-ink-soft/10 pt-4">
            <button type="submit" className="min-h-[44px] rounded-full bg-ink px-5 text-sm text-paper">
              Enregistrer
            </button>
            {form.id && (
              <>
                <button
                  type="button"
                  onClick={publish}
                  className="min-h-[44px] rounded-full bg-valide px-5 text-sm text-paper"
                >
                  Publier
                </button>
                <button
                  type="button"
                  onClick={unpublish}
                  className="min-h-[44px] rounded-full border border-ink-soft/25 px-5 text-sm"
                >
                  Dépublier
                </button>
                <button
                  type="button"
                  onClick={() => remove(form.id!)}
                  className="min-h-[44px] rounded-full border border-correction/40 px-5 text-sm text-correction"
                >
                  Supprimer
                </button>
              </>
            )}
          </div>
        </form>
      </div>

      {/* Bouton flottant de l'assistant admin : fixé en bas à droite, il
          reste accessible pendant toute l'édition ; le tiroir s'ouvre
          par-dessus (arrière-plan assombri). */}
      <button
        type="button"
        onClick={() => setAssistantOuvert(true)}
        title="Poser une question à l'assistant admin"
        aria-label="Ouvrir l'assistant admin"
        className="fixed bottom-6 right-6 z-30 flex min-h-[48px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-paper shadow-lg"
      >
        <Bot size={18} strokeWidth={1.75} aria-hidden="true" />
        Assistant
      </button>

      {/* Tiroir assistant admin : conversation persistée si l'épreuve est
          déjà enregistrée (`epreuveId`), sinon éphémère ; contexte =
          formulaire d'édition courant. */}
      {assistantOuvert && (
        <AdminAssistantPanel
          form={form}
          statut={statutForm}
          epreuveId={form.id}
          onClose={() => setAssistantOuvert(false)}
          onAppliquer={appliquerModifications}
        />
      )}

      {confirmation && (
        <ConfirmDialog
          tone="danger"
          title={confirmation.titre}
          message={confirmation.message}
          onConfirm={confirmation.action}
          onClose={() => setConfirmation(null)}
        />
      )}
    </>
  );
}