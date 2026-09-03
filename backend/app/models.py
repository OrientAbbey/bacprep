from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ---------- Auth ----------

class MockLoginIn(BaseModel):
    email: str
    nom: str
    platform: str = "web"


class GoogleLoginIn(BaseModel):
    id_token: str
    platform: str = "web"


class UserOut(BaseModel):
    id: str
    email: str
    nom: str
    created_at: datetime


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
    session: str
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    gratuit: bool
    statut: str
    filieres: list[str]
    corrige_disponible: bool


class EpreuveFileOut(BaseModel):
    """Métadonnées d'un fichier d'épreuve ; `url` pointe vers la route
    d'accès contrôlé GET /api/files/{id} (streaming ou redirection vers une
    URL signée selon le backend de stockage)."""

    id: str
    cible: str  # sujet|corrige
    format: str  # md|image
    filename: str
    url: str


class EpreuveDetail(EpreuveListItem):
    contenu_markdown: str
    corrige_markdown: Optional[str] = ""
    assets: list[EpreuveFileOut] = []  # images d'illustration uniquement


class EpreuveIn(BaseModel):
    niveau: str = "SECONDAIRE"
    classe: str = "terminale"
    evaluation: str = "BAC"
    matiere: str
    annee: str
    session: str = ""
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    gratuit: bool = False
    statut: str = "brouillon"
    filieres: list[str] = Field(default_factory=list)
    contenu_markdown: str = ""
    corrige_markdown: Optional[str] = ""


class EpreuveUpdate(BaseModel):
    niveau: Optional[str] = None
    classe: Optional[str] = None
    evaluation: Optional[str] = None
    matiere: Optional[str] = None
    annee: Optional[str] = None
    session: Optional[str] = None
    duree: Optional[str] = None
    coefficient: Optional[str] = None
    gratuit: Optional[bool] = None
    statut: Optional[str] = None
    filieres: Optional[list[str]] = None
    contenu_markdown: Optional[str] = None
    corrige_markdown: Optional[str] = None


# ---------- Subscriptions ----------

class CheckoutIn(BaseModel):
    scope: str  # epreuve|matiere_annee|matiere|annee|filiere
    filiere: Optional[str] = None
    matiere: Optional[str] = None
    annee: Optional[str] = None
    classe: Optional[str] = None  # requis sauf pour scope="epreuve"
    epreuve_id: Optional[str] = None
    provider: str = "orange"


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
    reference_agregateur: str


# ---------- Admin ----------

class AdminLoginIn(BaseModel):
    email: str
    token: str
    force: bool = False


# ---------- Assistant ----------

class ConversationCreateIn(BaseModel):
    contexte: str = ""
    label: str = "Nouvelle discussion"


class ConversationUpdateIn(BaseModel):
    messages: list[dict]
    label: Optional[str] = None
    contexte: Optional[str] = None


class ConversationOut(BaseModel):
    id: str
    epreuve_id: str
    label: str
    contexte: str
    messages: list[dict]
    created_at: datetime
    updated_at: datetime


class AskIn(BaseModel):
    conversation_id: str
    message: str
