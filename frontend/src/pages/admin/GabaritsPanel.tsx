import { AlertTriangle, Check, Clock, Eye } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { MarkdownContent } from "../../shared/ui/MarkdownContent";
import { Spinner } from "../../shared/ui/Spinner";
import { useToast } from "../../shared/ui/Toast";
import {
  type ApercuVariante,
  type LigneGabarit,
  type SignalementGabarit,
  type StatutGabarit,
  formaterPoints,
  graineAleatoire,
} from "../../features/entrainement/lib/entrainement";
import { classeLabel } from "../../shared/lib/referentiel";
import { formatRelativeTime } from "../../shared/lib/time";
import { authHeaders, erreurDetail, purgerSessionExpiree } from "./shared";

/**
 * Exercices types (gabarits paramétrés de la page Entraînement) : l'enseignant
 * relit des variantes AVEC correction, regarde le contrôle automatique, puis
 * valide — seul ce geste rend un exercice visible des élèves. Traite aussi les
 * signalements des élèves (variante exacte retrouvée par sa graine).
 *
 * Console admin : textes en français uniquement (comme les autres panneaux).
 */
/** Panneau de relecture et validation des exercices types (gabarits paramétrés). */
export function GabaritsPanel({ token }: { token: string }) {
  const { showToast } = useToast();
  const [lignes, setLignes] = useState<LigneGabarit[] | null>(null);
  const [invalides, setInvalides] = useState<Record<string, string>>({});
  const [signalements, setSignalements] = useState<SignalementGabarit[]>([]);
  const [erreur, setErreur] = useState(false);
  const [apercu, setApercu] = useState<{ id: string; variante: ApercuVariante | null; erreur: boolean } | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const [liste, sig] = await Promise.all([
        api.get<{ gabarits: LigneGabarit[]; fichiers_invalides: Record<string, string> }>("/api/admin/gabarits", authHeaders(token)),
        api.get<SignalementGabarit[]>("/api/admin/gabarits/signalements", authHeaders(token)),
      ]);
      setLignes(liste.gabarits);
      setInvalides(liste.fichiers_invalides);
      setSignalements(sig);
      setErreur(false);
    } catch (err) {
      if (!purgerSessionExpiree(err)) setErreur(true);
    }
  }, [token]);

  useEffect(() => {
    void charger();
  }, [charger]);

  async function voir(id: string, graine: number = graineAleatoire()) {
    setApercu({ id, variante: null, erreur: false });
    try {
      const variante = await api.get<ApercuVariante>(`/api/admin/gabarits/${encodeURIComponent(id)}/apercu?graine=${graine}`, authHeaders(token));
      setApercu({ id, variante, erreur: false });
    } catch (err) {
      if (!purgerSessionExpiree(err)) setApercu({ id, variante: null, erreur: true });
    }
  }

  async function agir(id: string, action: "valider" | "retirer") {
    setOccupe(id);
    try {
      if (action === "valider") await api.post(`/api/admin/gabarits/${encodeURIComponent(id)}/validation`, undefined, authHeaders(token));
      else await api.del(`/api/admin/gabarits/${encodeURIComponent(id)}/validation`, authHeaders(token));
      showToast(action === "valider" ? "Gabarit validé : il est visible des élèves." : "Validation retirée : l'exercice disparaît de l'entraînement.", "success");
      await charger();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast(erreurDetail(err, "L'action a échoué — réessaie."), "error");
    } finally {
      setOccupe(null);
    }
  }

  async function resoudre(id: string) {
    try {
      await api.post(`/api/admin/gabarits/signalements/${encodeURIComponent(id)}/resoudre`, undefined, authHeaders(token));
      showToast("Signalement résolu.", "success");
      await charger();
    } catch (err) {
      if (!purgerSessionExpiree(err)) showToast(erreurDetail(err, "La résolution a échoué — réessaie."), "error");
    }
  }

  const bouton = "inline-flex min-h-[44px] items-center gap-2 rounded-full border border-ink-soft/25 px-4 text-sm font-medium hover:bg-highlight-soft disabled:opacity-60";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif-brand text-lg">Exercices types</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Chaque gabarit fabrique des exercices dont les valeurs changent. Relis une variante avec sa correction, vérifie le contrôle automatique, puis valide :
          sans validation, l&apos;exercice n&apos;apparaît pas sur la page Entraînement.
        </p>
      </div>

      <details className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
        <summary className="cursor-pointer font-serif-brand text-lg">
          Guide : de la relecture à la publication
        </summary>
        <div className="mt-3 space-y-3 text-sm text-ink-soft">
          <p>
            <strong>1. Relire.</strong> « Voir une variante » tire un exemple au hasard
            et l&apos;affiche avec sa correction. « Autre variante » en tire un nouveau :
            c&apos;est le geste principal de la relecture — un seul exemple ne prouve pas
            qu&apos;un gabarit est fiable.
          </p>
          <p>
            <strong>2. Vérifier le rapport automatique.</strong> Le serveur tire plusieurs
            variantes et vérifie que chacune se génère et se corrige. Il compte aussi les
            énoncés distincts : un gabarit qui produit toujours le même énoncé passe le
            contrôle mais n&apos;a aucun intérêt pédagogique. Le rapport affiche les deux
            informations séparément.
          </p>
          <p>
            <strong>3. Valider.</strong> La validation est le seul geste qui rend
            l&apos;exercice visible des élèves. Un gabarit à valider ou modifié depuis sa
            validation reste invisible de l&apos;entraînement.
          </p>
          <p>
            <strong>Variantes et graine.</strong> Une variante est une version concrète du
            gabarit (valeurs, données, questions). Sa <em>graine</em> est le nombre qui l&apos;a
            produite : la même graine redonne exactement la même variante. C&apos;est ce
            qui permet de retrouver la variante signalée par un élève.
          </p>
          <p>
            <strong>Énoncé, réponse, méthode.</strong> L&apos;énoncé est ce que lit
            l&apos;élève. La <em>réponse</em> est le résultat attendu, souvent court. La
            <em>méthode</em> est la démarche détaillée qui y conduit. Les trois sont
            relus : une réponse juste avec une méthode fausse apprend une erreur.
          </p>
          <p>
            <strong>Pourquoi le contrôle peut bloquer.</strong> Si un tirage échoue, si une
            variante est incomplète ou si le rapport est en échec, le bouton « Valider »
            reste désactivé. Ce n&apos;est pas une panne : publier un exercice qui ne se
            génère pas exposerait les élèves à une page vide. Corrige le gabarit, puis
            recharge la page.
          </p>
          <div>
            <p className="font-medium text-ink">Statuts</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
              <li><strong>À valider</strong> — jamais publié, ou validation retirée. Invisible des élèves.</li>
              <li><strong>Validé</strong> — relu et publié. Visible de l&apos;entraînement.</li>
              <li><strong>Modifié depuis la validation</strong> — le fichier a changé après la publication. La version en ligne n&apos;est plus celle qui a été relue : revalide après vérification.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-ink">Avant de valider — checklist</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
              <li>Au moins trois variantes relues, dont une avec des valeurs limites.</li>
              <li>Le rapport automatique est vert et le nombre d&apos;énoncés distincts est suffisant.</li>
              <li>Chaque question a une réponse ET une méthode.</li>
              <li>Les unités, arrondis et notations sont cohérents avec le niveau visé.</li>
              <li>Aucun signalement ouvert ne concerne ce gabarit.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-ink">Signalements élèves</p>
            <p className="mt-1 text-xs">
              Un élève peut signaler une variante précise. Le signalement affiche sa graine :
              « Voir la variante signalée » recharge exactement cette version. Après
              correction du gabarit, marque le signalement comme résolu — il quitte la liste
              ouverte. Si le problème vient du gabarit lui-même, retire la validation le
              temps de corriger : la variante fautive cesse d&apos;être servie.
            </p>
          </div>
          <div>
            <p className="font-medium text-ink">Quand utiliser « Retirer » et « Revalider »</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
              <li><strong>Retirer</strong> — dépublie immédiatement un exercice validé. À utiliser dès qu&apos;un défaut est confirmé, sans attendre la correction.</li>
              <li><strong>Revalider</strong> — republie un gabarit modifié après une nouvelle relecture. Le libellé n&apos;apparaît que sur un statut « Modifié depuis la validation ».</li>
            </ul>
          </div>
          <p className="rounded border border-ink-soft/15 bg-paper p-3 text-xs">
            <strong>Fichiers illisibles.</strong> Un gabarit dont le fichier ne se lit pas
            est listé en tête de page avec son motif et ignoré : il ne peut ni être relu ni
            être validé. Corrige le fichier source puis recharge la page — aucune validation
            n&apos;est perdue pour les autres gabarits.
          </p>
        </div>
      </details>

      {erreur && (
        <div role="alert" className="rounded-lg border border-correction/30 bg-correction-soft p-5 text-sm text-correction">
          <p>Impossible de charger les exercices types.</p>
          <button type="button" onClick={() => void charger()} className="mt-2 min-h-[44px] underline">
            Réessayer
          </button>
        </div>
      )}
      {!lignes && !erreur && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-soft">
          <Spinner /> Chargement des exercices types.
        </p>
      )}
      {Object.keys(invalides).length > 0 && (
        <p role="alert" className="rounded-lg border border-correction/30 p-3 text-sm text-correction">
          Fichiers de gabarit illisibles (ignorés) : {Object.entries(invalides).map(([f, m]) => `${f} (${m})`).join(" ; ")}
        </p>
      )}
      {lignes && lignes.length === 0 && <p className="rounded-lg border border-ink-soft/15 bg-paper-raised p-5 text-sm">Aucun gabarit n'est installé.</p>}

      <ul className="space-y-3">
        {lignes?.map((g) => (
          <li key={g.id} className="rounded-lg border border-ink-soft/15 bg-paper-raised p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{g.titre}</h3>
              <span className="ml-auto">
                <Statut s={g.statut} />
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-soft">
              {g.matiere} · {g.chapitre} · {g.classes.map(classeLabel).join(", ")} · Difficulté {g.difficulte} sur 3 · Total :{" "}
              {formaterPoints(g.total_points, "fr")} points
            </p>
            {g.valide_par && g.statut !== "a_valider" && (
              <p className="mt-1 text-xs text-ink-soft">
                Validé par {g.valide_par}
                {g.valide_le ? ` ${formatRelativeTime(g.valide_le)}` : ""}
              </p>
            )}
            <p className={`mt-2 text-sm ${g.rapport.ok ? "" : "text-correction"}`}>
              {g.rapport.ok
                ? `Contrôle automatique : ${g.rapport.n} variantes tirées, ${g.rapport.enonces_distincts} énoncés distincts.`
                : `Contrôle automatique en échec : ${g.rapport.echecs} tirage(s) impossible(s), ${g.rapport.defauts} variante(s) incomplète(s) sur ${g.rapport.n}. ${g.rapport.exemple_erreur ?? ""}`}
            </p>
            {g.rapport.ok && g.rapport.enonces_distincts < 10 && (
              <p className="text-sm text-correction">Peu de variété : seulement {g.rapport.enonces_distincts} énoncés distincts sur {g.rapport.n} tirages.</p>
            )}
            {g.signalements_ouverts > 0 && <p className="mt-1 text-sm text-correction">{g.signalements_ouverts} signalement(s) ouvert(s).</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void voir(g.id)} className={bouton}>
                <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                Voir une variante
                <span className="sr-only"> : {g.titre}</span>
              </button>
              {g.statut !== "valide" && (
                <button
                  type="button"
                  onClick={() => void agir(g.id, "valider")}
                  disabled={!g.rapport.ok || occupe === g.id}
                  className={`${bouton} bg-ink text-paper hover:bg-ink`}
                >
                  {occupe === g.id ? <Spinner /> : <Check size={16} strokeWidth={1.75} aria-hidden="true" />}
                  {g.statut === "modifie" ? "Revalider" : "Valider"}
                  <span className="sr-only"> : {g.titre}</span>
                </button>
              )}
              {g.statut !== "a_valider" && (
                <button type="button" onClick={() => void agir(g.id, "retirer")} disabled={occupe === g.id} className={bouton}>
                  Retirer
                  <span className="sr-only"> : {g.titre}</span>
                </button>
              )}
            </div>

            {apercu?.id === g.id && (
              <div className="mt-4 space-y-3 border-t border-ink-soft/10 pt-3" aria-live="polite">
                {!apercu.variante && !apercu.erreur && (
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <Spinner /> Chargement de l'aperçu.
                  </p>
                )}
                {apercu.erreur && (
                  <p role="alert" className="text-sm text-correction">
                    Impossible de produire cette variante — réessaie avec une autre graine.
                  </p>
                )}
                {apercu.variante && <Apercu variante={apercu.variante} />}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void voir(g.id)} className={bouton}>
                    Autre variante
                  </button>
                  <button type="button" onClick={() => setApercu(null)} className={bouton}>
                    Fermer l'aperçu
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <section aria-labelledby="gab-signalements" className="space-y-2">
        <h2 id="gab-signalements" className="font-serif-brand text-lg">
          Signalements d'exercices
        </h2>
        {signalements.length === 0 && <p className="text-sm text-ink-soft">Aucun signalement ouvert.</p>}
        <ul className="space-y-2">
          {signalements.map((s) => (
            <li key={s.id} className="rounded-lg border border-correction/30 bg-paper-raised p-3">
              <p className="font-medium">
                {s.titre} — variante n° {s.graine}
              </p>
              <p className="mt-1 text-sm text-ink-soft">{s.message ? `« ${s.message} »` : "Sans message."}</p>
              <p className="mt-1 font-mono-tag text-[10px] text-slate">
                {s.email || "compte supprimé"} · {formatRelativeTime(s.created_at)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void voir(s.gabarit_id, s.graine)} className={bouton}>
                  Voir la variante signalée
                  <span className="sr-only"> : {s.titre}</span>
                </button>
                <button type="button" onClick={() => void resoudre(s.id)} className={bouton}>
                  Marquer comme résolu
                  <span className="sr-only"> : {s.titre}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Statut({ s }: { s: StatutGabarit }) {
  const [Icone, libelle, classes] =
    s === "valide"
      ? [Check, "Validé", "bg-valide-soft text-valide"]
      : s === "modifie"
        ? [AlertTriangle, "Modifié depuis la validation", "bg-correction-soft text-correction"]
        : [Clock, "À valider", "bg-highlight-soft text-ink"];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono-tag text-[10px] ${classes}`}>
      <Icone size={12} strokeWidth={2} aria-hidden="true" />
      {libelle}
    </span>
  );
}

function Apercu({ variante }: { variante: ApercuVariante }) {
  return (
    <div className="space-y-3">
      <p className="font-mono-tag text-[10px] text-slate">Variante n° {variante.graine}</p>
      <div className="prose-exam rounded border border-ink-soft/15 bg-paper p-3 text-sm">
        <MarkdownContent content={variante.enonce} variant="epreuve" />
      </div>
      <ol className="space-y-3">
        {variante.questions.map((q, i) => (
          <li key={i} className="rounded border border-ink-soft/15 bg-paper p-3 text-sm">
            <p className="font-mono-tag text-[10px] text-slate">
              Question {i + 1} · {formaterPoints(q.points, "fr")} pts
            </p>
            <div className="prose-exam">
              <MarkdownContent content={q.enonce} variant="epreuve" />
            </div>
            {variante.corrections[i] && (
              <>
                <p className="mt-2 font-mono-tag text-[10px] text-valide">Réponse</p>
                <div className="prose-exam">
                  <MarkdownContent content={variante.corrections[i].reponse} variant="epreuve" />
                </div>
                <p className="mt-2 font-mono-tag text-[10px] text-slate">Méthode</p>
                <div className="prose-exam">
                  <MarkdownContent content={variante.corrections[i].etapes} variant="epreuve" />
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
