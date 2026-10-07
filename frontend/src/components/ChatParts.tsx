import { Bot, Check, Clock, Pencil, RotateCcw, Send } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { t } from "../i18n";
import { dateLongue, heureCourte } from "../lib/dates";
import { getInitials } from "../lib/initials";
import { MarkdownContent } from "./MarkdownContent";

/** Éléments de discussion partagés par l'assistant de l'élève (AssistantPanel) et
 * celui de l'admin (AdminAssistantPanel) : seules les actions propres à chaque
 * rôle diffèrent, elles se branchent par les emplacements `actionsHaut` et
 * `actionsEnLigne` de `ChatBubble`. */

export const ASSISTANT_TITRE = t("Tuteur IA Prep");
export const ASSISTANT_SIGNATURE = t("Assistant Pédagogique");
export const INPUT_MAX_HEIGHT_PX = 120;

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Horodatage ISO posé par le serveur (voie persistée) ou le client (éphémère),
   * affiché en HH:MM ; absent des messages stockés avant son introduction. */
  ts?: string;
}

const CLASSE_ACTION =
  "relative inline-flex items-center gap-1 font-mono-tag text-[10px] text-slate hover:text-ink after:absolute after:-inset-[10px] after:content-['']";

/** Petit bouton texte sous une bulle (zone tactile élargie par `after:`). */
export function ActionTexte({
  icone: Icone,
  libelle,
  titre,
  onClick,
}: {
  icone: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: "true" }>;
  libelle: string;
  titre: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} title={titre} className={CLASSE_ACTION}>
      <Icone size={11} strokeWidth={1.75} aria-hidden="true" />
      {libelle}
    </button>
  );
}

/** Bulle de message : avatar, auteur, horodatage, contenu Markdown. L'élève ou l'admin
 * peut modifier sa question (régénération depuis ce point) ; la DERNIÈRE réponse peut
 * être relancée. Actions spécifiques : `actionsHaut` (sous la bulle) et `actionsEnLigne`
 * (dans la rangée de boutons texte, avant « Réessayer »). */
export function ChatBubble({
  m,
  userNom,
  estDernier,
  enCours,
  onEditer,
  onRegenerer,
  actionsHaut,
  actionsEnLigne,
}: {
  m: Message;
  userNom: string;
  estDernier: boolean;
  enCours: boolean;
  onEditer?: (contenu: string) => void;
  onRegenerer?: () => void;
  actionsHaut?: ReactNode;
  actionsEnLigne?: ReactNode;
}) {
  const isUser = m.role === "user";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(m.content);
  const heure = heureCourte(m.ts);
  const titreDate = dateLongue(m.ts);
  const nom = isUser ? userNom : ASSISTANT_SIGNATURE;

  function validerEdition() {
    const contenu = editValue.trim();
    if (!contenu) return;
    setEditing(false);
    onEditer?.(contenu);
  }

  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <Avatar role={m.role} nom={nom} />
      <div className="min-w-0 max-w-[78%]">
        <p className={`mb-0.5 flex items-center gap-1.5 font-mono-tag text-[10px] text-slate ${isUser ? "flex-row-reverse" : ""}`}>
          <span>{nom}</span>
          {heure && (
            <span title={titreDate ?? undefined} className="text-slate/70">
              {heure}
            </span>
          )}
        </p>
        {editing ? (
          <div className="rounded-2xl border border-ink-soft/15 bg-paper px-3 py-2">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={3}
              aria-label={t("Modifier ta question")}
              className="w-full resize-y rounded-[2px] border border-ink-soft/20 bg-paper-raised px-3 py-2 text-sm text-ink outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={validerEdition}
                disabled={!editValue.trim()}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-valide px-4 text-xs font-medium text-paper disabled:opacity-40"
              >
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                {t("Valider")}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-ink-soft/25 px-4 text-xs text-ink-soft hover:text-ink"
              >
                {t("Annuler")}
              </button>
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl px-3 py-2 ${isUser ? "bg-highlight-soft text-ink" : "border border-ink-soft/15 bg-paper text-ink"}`}>
            <MarkdownContent content={m.content} variant="chat" />
          </div>
        )}
        {!editing && actionsHaut}
        {!editing && (
          <div className="mt-0.5 flex flex-wrap gap-x-3">
            {isUser && onEditer && (
              <ActionTexte
                icone={Pencil}
                libelle={t("Modifier")}
                titre={t("Modifier ta question et régénérer la réponse")}
                onClick={() => {
                  setEditValue(m.content);
                  setEditing(true);
                }}
              />
            )}
            {actionsEnLigne}
            {!isUser && estDernier && onRegenerer && !enCours && (
              <ActionTexte icone={RotateCcw} libelle={t("Réessayer")} titre={t("Relancer la même question")} onClick={onRegenerer} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Champ de question + bouton d'envoi. Pendant une réponse, l'envoi reste possible :
 * la question part en file d'attente, signalée au-dessus du champ. */
export function MessageComposer({
  inputRef,
  input,
  onChange,
  onKeyDown,
  onSend,
  queueCount,
  placeholder = t("Pose ta question… (Maj+Entrée pour une nouvelle ligne)"),
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  input: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  queueCount: number;
  placeholder?: string;
}) {
  return (
    <div className="border-t border-ink-soft/15 bg-paper">
      {queueCount > 0 && (
        <p role="status" className="flex items-center gap-1.5 px-3 pt-2 font-mono-tag text-[10px] text-slate">
          <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
          {queueCount} question{queueCount > 1 ? "s" : ""} en attente…
        </p>
      )}
      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={t("Question à Tuteur IA Prep")}
          rows={1}
          style={{ maxHeight: INPUT_MAX_HEIGHT_PX }}
          className="min-h-[44px] flex-1 resize-none overflow-y-auto rounded-[2px] border border-ink-soft/20 bg-paper-raised px-4 py-2.5 text-sm text-ink outline-none placeholder:text-slate"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!input.trim()}
          aria-label={t("Envoyer")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full verrou-highlight disabled:opacity-40"
        >
          <Send size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Avatar rond : initiales de l'utilisateur, icône robot pour l'assistant (tokens de couleur adaptatifs, lisibles dans les deux thèmes). */
export function Avatar({ role, nom }: { role: "user" | "assistant"; nom: string }) {
  return (
    <div
      aria-hidden="true"
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
        role === "user" ? "bg-ink font-mono-tag text-[10px] font-semibold text-paper" : "bg-highlight text-highlight-ink"
      }`}
    >
      {role === "user" ? getInitials(nom) : <Bot size={14} strokeWidth={2} />}
    </div>
  );
}
