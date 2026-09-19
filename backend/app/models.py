from __future__ import annotations

from datetime import datetime
from typing import ClassVar, Optional

from pydantic import BaseModel, Field, field_validator


# ---------- Auth ----------

class MockLoginIn(BaseModel):
    email: str = Field(max_length=254)
    nom: str = Field(default="", max_length=120)
    platform: str = Field(default="web", max_length=20)


class GoogleLoginIn(BaseModel):
    id_token: str = Field(max_length=4096)
    platform: str = Field(default="web", max_length=20)


class UserOut(BaseModel):
    id: str
    email: str
    nom: str
    created_at: datetime
    # Gating admin côté client : vrai si l'email est le ROOT (ADMIN_ROOT) ou
    # un admin promu (calculé serveur — la liste elle-même ne part pas au frontend).
    is_admin: bool = False
    # Consentements (NULL = pas encore demandé, la modale doit s'afficher).
    consent_ia: Optional[bool] = None
    consent_notes: Optional[bool] = None


class ConsentementIn(BaseModel):
    """Choix de consentement recueillis à la connexion (modale granulaire) :
    persistance des conversations IA et des notes. `False` = refus explicite
    (aucune donnée de cette finalité n'est stockée)."""

    partage_conversations_ia: bool
    partage_notes: bool


class AuthConfigOut(BaseModel):
    mode: str  # "mock" | "google"
    google_client_id: Optional[str] = None


# ---------- Epreuves ----------

class EpreuveListItem(BaseModel):
    id: str
    niveau: str
    classe: str  # code canonique du référentiel (ex. "terminale")
    evaluation: str  # ex. "BAC", "BEPC", "SEQUENCE 1"
    matiere: str
    annee: str
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    extrait: str = ""
    gratuit: bool
    statut: str
    filieres: list[str]
    corrige_disponible: bool
    acces: str = "payant"  # "gratuit" | "ouvert" | "payant" — calculé serveur


class EpreuveFileOut(BaseModel):
    """Métadonnées d'un fichier d'épreuve ; `url` pointe vers la route
    d'accès contrôlé GET /api/files/{id} (streaming ou redirection vers une
    URL signée selon le backend de stockage)."""

    id: str
    cible: str  # sujet|corrige
    format: str  # md|image
    filename: str
    url: str
    size_bytes: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    mime_type: str = ""


class SujetOut(BaseModel):
    """Un sujet d'une épreuve : son contenu Markdown et son corrigé — le
    corrigé est optionnel et peut être absent (« corrigé manquant »)."""

    index: int
    contenu_markdown: str = ""
    corrige_markdown: Optional[str] = ""
    corrige_disponible: bool = False


class SujetIn(BaseModel):
    """Un sujet fourni à la création/mise à jour d'une épreuve."""

    index: int
    contenu_markdown: str = Field(default="", max_length=2_000_000)
    corrige_markdown: Optional[str] = Field(default=None, max_length=2_000_000)


class EpreuveDetail(EpreuveListItem):
    # Champs historiques : l'index 0 (sujet principal) est exposé à plat
    # pour rétrocompatibilité — le tableau `sujets` fait autorité pour le
    # multi-sujets.
    contenu_markdown: str
    corrige_markdown: Optional[str] = ""
    assets: list[EpreuveFileOut] = []  # images d'illustration uniquement
    sujets: list[SujetOut] = []
    nb_sujets: int = 1


class EpreuveIn(BaseModel):
    # Aucune valeur par défaut « inventée » : un brouillon enregistré sans
    # ses champs obligatoires (niveau, classe, évaluation…) garde des
    # valeurs VIDES — c'est l'interface qui bloque l'enregistrement tant
    # qu'elles manquent (revue 2026-09-18).
    niveau: str = ""
    classe: str = ""
    evaluation: str = ""
    matiere: str = Field(default="", max_length=120)
    annee: str = Field(default="", max_length=4, pattern=r"^\d{0,4}$")
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    gratuit: bool = False
    statut: str = "brouillon"
    filieres: list[str] = Field(default_factory=list)
    contenu_markdown: str = Field(default="", max_length=2_000_000)
    corrige_markdown: Optional[str] = Field(default=None, max_length=2_000_000)
    # Multi-sujets : si fourni (non nul), cette liste fait autorité et les
    # champs plats ci-dessus sont ignorés (rétrocompatibilité).
    sujets: Optional[list[SujetIn]] = None


class EpreuveUpdate(BaseModel):
    niveau: Optional[str] = None
    classe: Optional[str] = None
    evaluation: Optional[str] = None
    matiere: Optional[str] = Field(default=None, max_length=120)
    annee: Optional[str] = Field(default=None, max_length=4, pattern=r"^\d{0,4}$")
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    gratuit: Optional[bool] = None
    statut: Optional[str] = None
    filieres: Optional[list[str]] = None
    contenu_markdown: Optional[str] = Field(default=None, max_length=2_000_000)
    corrige_markdown: Optional[str] = Field(default=None, max_length=2_000_000)
    # Multi-sujets : si fourni (non nul), remplace TOUTE la collection de
    # documents (les sujets absents du tableau sont supprimés).
    sujets: Optional[list[SujetIn]] = None


# ---------- Subscriptions ----------

class CheckoutIn(BaseModel):
    scope: str  # epreuve|matiere_annee|matiere|annee|filiere
    filiere: Optional[str] = None
    matiere: Optional[str] = None
    annee: Optional[str] = None
    classe: Optional[str] = None  # requis sauf pour scope="epreuve"
    epreuve_id: Optional[str] = None
    # Liste fermée : la valeur part telle quelle en base et sert à
    # l'affichage du profil — on refuse tout autre libellé.
    provider: str = "orange"

    @field_validator("provider")
    @classmethod
    def _provider_connu(cls, v: str) -> str:
        if v not in ("orange", "mtn"):
            raise ValueError("provider doit valoir 'orange' ou 'mtn'")
        return v


class SubscriptionOut(BaseModel):
    id: str
    scope: str
    scope_label: str
    evaluation: str
    classe: str
    filiere: str
    matiere: str
    annee: str
    epreuve_id: Optional[str] = None
    epreuve_label: Optional[str] = None
    epreuves_couvertes: int
    start_date: datetime
    end_date: datetime
    statut: str


class WebhookIn(BaseModel):
    """Notification de confirmation d'un agrégateur de paiement (Notch Pay /
    Monetbil — voir PAIEMENT.md) : le contenu est authentifié par une
    signature HMAC (`signature`) calculée sur le message normalisé
    ``{provider}|{reference}|{montant}|{timestamp}`` avec le secret
    ``PAYMENT_WEBHOOK_SECRET``. `timestamp` (epoch) borne l'actualité de la
    notification (anti-replay)."""

    provider: str = ""
    reference_agregateur: str
    montant: Optional[int] = None
    timestamp: Optional[int] = None
    signature: str = ""


# ---------- Admin ----------

class AdminLoginIn(BaseModel):
    email: str
    token: str
    force: bool = False


# ---------- Assistant ----------

class ConversationCreateIn(BaseModel):
    contexte: str = Field(default="", max_length=20000)
    label: str = Field(default="Nouvelle discussion", max_length=120)


class ConversationUpdateIn(BaseModel):
    """Mise à jour d'une discussion : messages remplaçables en bloc par le
    client. Bornés ici (nombre + taille) — sans plafond, un client pouvait
    faire grossir `messages_json` en base sans limite et gonfler l'entrée
    LLM suivante."""

    MAX_MESSAGES: ClassVar[int] = 60
    MAX_MESSAGE_CHARS: ClassVar[int] = 8000

    messages: list[dict]
    label: Optional[str] = Field(default=None, max_length=120)
    contexte: Optional[str] = Field(default=None, max_length=20000)

    @field_validator("messages")
    @classmethod
    def _bornes_messages(cls, v: list[dict]) -> list[dict]:
        if len(v) > cls.MAX_MESSAGES:
            raise ValueError(f"au maximum {cls.MAX_MESSAGES} messages")
        for m in v:
            if not isinstance(m, dict) or not isinstance(m.get("content"), str):
                raise ValueError("message invalide (dict avec role/content attendu)")
            if len(m["content"]) > cls.MAX_MESSAGE_CHARS:
                raise ValueError(f"message trop long ({cls.MAX_MESSAGE_CHARS} caractères max)")
        return v


class ConversationOut(BaseModel):
    id: str
    epreuve_id: str
    label: str
    contexte: str
    messages: list[dict]
    created_at: datetime
    updated_at: datetime


class AskIn(BaseModel):
    """Question à l'assistant. Deux voies exclusives :

    - PERSISTÉE : `conversation_id` présent — l'échange est stocké dans la
      discussion (exige le consentement IA) ;
    - ÉPHÉMÈRE : `epreuve_id` (+ contexte/historique fournis par le client)
      et SANS `conversation_id` — refus du consentement IA : rien n'est
      écrit en base, la discussion ne vit que côté client.
    """

    conversation_id: Optional[str] = Field(default=None, max_length=64)
    epreuve_id: Optional[str] = Field(default=None, max_length=64)
    contexte: str = Field(default="", max_length=20000)
    historique: list[dict[str, str]] = Field(default_factory=list, max_length=40)
    message: str = Field(min_length=1, max_length=4000)

    @field_validator("historique")
    @classmethod
    def _bornes_historique(cls, v: list[dict[str, str]]) -> list[dict[str, str]]:
        for m in v:
            role = m.get("role", "")
            content = m.get("content", "")
            if role not in ("user", "assistant") or not isinstance(content, str) or len(content) > 8000:
                raise ValueError("entrée d'historique invalide (role user/assistant, content <= 8000)")
        return v


# ---------- Profil élève ----------

class ProfilUpdateIn(BaseModel):
    """Mise à jour du profil étendu (tout optionnel : seuls les champs
    fournis sont modifiés)."""

    nom: Optional[str] = None
    niveau: Optional[str] = None
    classe: Optional[str] = None
    etablissement: Optional[str] = None


class NoteIn(BaseModel):
    cible: str = "sujet"  # sujet|corrige
    contexte_extrait: str = Field(default="", max_length=2000)
    contenu: str = Field(min_length=1, max_length=20000)


class NoteUpdateIn(BaseModel):
    contexte_extrait: Optional[str] = Field(default=None, max_length=2000)
    contenu: Optional[str] = Field(default=None, min_length=1, max_length=20000)


class NoteOut(BaseModel):
    id: str
    epreuve_id: str
    cible: str
    contexte_extrait: str
    contenu: str
    created_at: datetime
    updated_at: datetime


class NoteWithEpreuveOut(NoteOut):
    """Note enrichie des infos d'épreuve (affichage dans « Mes notes » du
    profil sans aller-retour supplémentaire)."""

    matiere: str = ""
    annee: str = ""
    classe: str = ""
    evaluation: str = ""


class SignalementIn(BaseModel):
    motif: str  # contenu_illisible|erreur_enonce|corrige_manquant|image_cassee|autre
    message: str = Field(default="", max_length=1000)


class BannirIn(BaseModel):
    motif: str = Field(default="", max_length=500)


# ---------- Notifications ----------

# Types de notification proposés dans le back-office (libellés affichés) —
# singleton de référence pour le formulaire admin ET le contrat API.
TYPES_NOTIFICATION = ("information", "nouvelle_epreuve", "modification", "maintenance")


class NotificationIn(BaseModel):
    """Création d'une notification administrateur. `epreuve_id` est OPTIONNEL :
    renseigner une épreuve publie un lien « aller à l'épreuve » depuis la
    cloche (cas publication de nouvelle épreuve) ; l'absence de lien laisse
    la notification purement informative (modification, maintenance...)."""

    titre: str = Field(min_length=1, max_length=200)
    message: str = Field(default="", max_length=5000)
    type: str = Field(default="information", max_length=32)
    epreuve_id: Optional[str] = Field(default=None, max_length=40)
    actif: bool = True


class NotificationUpdate(BaseModel):
    """Mise à jour partielle d'une notification (seuls les champs fournis
    sont modifiés). `actif` pilote la visibilité : une notification désactivée
    reste stockée mais disparaît des cloches."""

    titre: Optional[str] = Field(default=None, min_length=1, max_length=200)
    message: Optional[str] = Field(default=None, max_length=5000)
    type: Optional[str] = Field(default=None, max_length=32)
    epreuve_id: Optional[str] = Field(default=None, max_length=40)
    actif: Optional[bool] = None
