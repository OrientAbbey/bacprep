from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .db import Base, UTCDateTime, utc_now


def _uid() -> str:
    """Identifiant par défaut (hex UUID4) pour les tables sans slug lisible
    (utilisateurs, souscriptions, paiements, discussions, fichiers...)."""
    return uuid.uuid4().hex


def _short_uid() -> str:
    """Identifiant court d'épreuve (8 hex, ex. ``8f3a2c91``) — utilisé dans
    les storage_key ``epreuves/{niveau}/{annee}/{id}/...``."""
    return uuid.uuid4().hex[:8]


class UserORM(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uid)
    email = Column(String, unique=True, nullable=False, index=True)
    nom = Column(String, nullable=False, default="")
    consent_given_at = Column(UTCDateTime, nullable=True)
    created_at = Column(UTCDateTime, default=utc_now)


class SessionORM(Base):
    __tablename__ = "sessions"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    token = Column(String, unique=True, nullable=False, index=True)
    platform = Column(String, default="web")
    issued_at = Column(UTCDateTime, default=utc_now)


class KickoutNoticeORM(Base):
    __tablename__ = "kickout_notices"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    message = Column(String, nullable=False)


class AdminLockORM(Base):
    """Verrou de session admin — UNE seule ligne (id='singleton'), qui
    matérialise l'admin actuellement connecté. Persisté en base (et non
    plus dans une simple variable Python en mémoire) pour survivre à un
    redémarrage du backend : un redémarrage ne doit plus libérer
    silencieusement l'accès admin tant que la session n'a pas expiré
    (30 min d'inactivité) ou été explicitement fermée."""

    __tablename__ = "admin_lock"

    id = Column(String, primary_key=True, default="singleton")
    email = Column(String, nullable=False)
    token = Column(String, nullable=False, index=True)
    since = Column(UTCDateTime, nullable=False)
    last_activity = Column(UTCDateTime, nullable=False)


class EpreuveORM(Base):
    """Une épreuve = des métadonnées de classement en base + des FICHIERS
    (sujet.md, corrige.md, images) dans le stockage objet, référencés par
    `epreuve_files.storage_key`. Le contenu Markdown n'est JAMAIS stocké
    dans la base.

    Classification : niveau (SECONDAIRE/PRIMAIRE) → classe (6e...Terminale,
    code canonique du référentiel) → évaluation (BAC, BEPC, SEQUENCE 1...)
    → matière + année + séries (many-to-many, une épreuve peut couvrir
    plusieurs séries). Toute la classification vit ICI, pas dans
    l'arborescence physique du stockage."""

    __tablename__ = "epreuves"

    id = Column(String, primary_key=True, default=_short_uid)
    niveau = Column(String, nullable=False, default="SECONDAIRE", index=True)
    classe = Column(String, nullable=False, default="terminale", index=True)
    evaluation = Column(String, nullable=False, default="BAC", index=True)
    matiere = Column(String, nullable=False, index=True)
    annee = Column(String, nullable=False, index=True)
    session = Column(String, default="")
    duree = Column(String, nullable=True)
    coefficient = Column(String, nullable=True)
    gratuit = Column(Boolean, default=False)
    statut = Column(String, default="brouillon")  # brouillon|a_reviser|publie
    created_at = Column(UTCDateTime, default=utc_now)
    updated_at = Column(UTCDateTime, default=utc_now, onupdate=utc_now)

    filieres_rel = relationship(
        "EpreuveFiliereORM",
        backref="epreuve",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    files_rel = relationship(
        "EpreuveFileORM",
        backref="epreuve",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    @property
    def filieres(self) -> list[str]:
        """Liste des séries/filières couvertes (chargées en `selectin`, une
        seule requête groupée pour tout un listing plutôt qu'une par épreuve)."""
        return [f.filiere for f in self.filieres_rel]

    @property
    def images(self) -> list["EpreuveFileORM"]:
        """Images d'illustration (toutes cibles confondues)."""
        return [f for f in self.files_rel if f.format == "image"]

    @property
    def corrige_disponible(self) -> bool:
        """Vrai si un corrigé existe — la présence de la ligne `epreuve_files`
        du document équivaut à un contenu non vide (un enregistrement avec
        contenu vide est supprimé à l'écriture, voir `write_document`)."""
        return any(f.cible == "corrige" and f.format == "md" for f in self.files_rel)


class EpreuveFiliereORM(Base):
    __tablename__ = "epreuve_filieres"
    __table_args__ = (UniqueConstraint("epreuve_id", "filiere", name="uq_epreuve_filiere"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    filiere = Column(String, nullable=False, index=True)


class EpreuveFileORM(Base):
    """Fichier attaché à une épreuve dans le stockage objet :

    - `format='md'` : le document d'une cible (sujet ou corrigé) — au plus
      UN par cible (remplacé au ré-enregistrement) ;
    - `format='image'` : une image d'illustration insérée dans le Markdown.

    La base ne conserve que les métadonnées + `storage_key` ; le checksum
    SHA-256 sert à la détection de doublons lors de l'import massif."""

    __tablename__ = "epreuve_files"

    id = Column(String, primary_key=True, default=_uid)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    cible = Column(String, nullable=False)  # sujet|corrige
    format = Column(String, nullable=False)  # md|image
    filename = Column(String, nullable=False)
    storage_key = Column(String, nullable=False, unique=True, index=True)
    mime_type = Column(String, nullable=False, default="")
    size_bytes = Column(Integer, nullable=True)
    checksum_sha256 = Column(String, nullable=True, index=True)
    uploaded_at = Column(UTCDateTime, default=utc_now)


class SubscriptionORM(Base):
    """Abonnement payant. Depuis la refonte multi-classes, un abonnement
    (hors « épreuve précise ») est TOUJOURS acheté dans le cadre d'une
    classe : `classe` vaut le code de la classe visée ("ALL" = joker pour
    compatibilité). `evaluation` suit la même convention (« ALL » couvre
    toutes les évaluations de la classe)."""

    __tablename__ = "subscriptions"

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    evaluation = Column(String, nullable=False, default="ALL")
    classe = Column(String, nullable=False, default="ALL")
    filiere = Column(String, nullable=False)
    matiere = Column(String, nullable=False, default="ALL")
    annee = Column(String, nullable=False, default="ALL")
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=True)
    start_date = Column(UTCDateTime, default=utc_now)
    end_date = Column(UTCDateTime, nullable=False)
    statut = Column(String, default="annulee")  # active|expiree|annulee


class ImportJobORM(Base):
    """Job d'import massif (upload zip côté admin). Le rapport JSON
    (créées / doublons / erreurs / métadonnées manquantes) est écrit à la
    fin du traitement par la tâche de fond."""

    __tablename__ = "import_jobs"

    id = Column(String, primary_key=True, default=_uid)
    filename = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="pending")  # pending|running|done|error
    report_json = Column(Text, nullable=False, default="{}")
    created_at = Column(UTCDateTime, default=utc_now)
    finished_at = Column(UTCDateTime, nullable=True)


class PaymentORM(Base):
    __tablename__ = "payments"

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    subscription_id = Column(String, ForeignKey("subscriptions.id"), nullable=False)
    provider = Column(String, default="orange")
    montant = Column(Integer, nullable=False)
    reference_agregateur = Column(String, unique=True, nullable=False, index=True)
    statut = Column(String, default="pending")  # pending|confirmed|failed
    created_at = Column(UTCDateTime, default=utc_now)
    confirmed_at = Column(UTCDateTime, nullable=True)


class AIConversationORM(Base):
    __tablename__ = "ai_conversations"

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    label = Column(String, nullable=False, default="Nouvelle discussion")
    contexte = Column(Text, nullable=False, default="")
    messages_json = Column(Text, nullable=False, default="[]")
    created_at = Column(UTCDateTime, default=utc_now)
    updated_at = Column(UTCDateTime, default=utc_now, onupdate=utc_now)


class ConsultationORM(Base):
    __tablename__ = "consultations"
    __table_args__ = (UniqueConstraint("user_id", "epreuve_id", name="uq_user_epreuve"),)

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    consulted_at = Column(UTCDateTime, default=utc_now)


class AdminEventORM(Base):
    __tablename__ = "admin_events"

    id = Column(String, primary_key=True, default=_uid)
    epreuve_id = Column(String, nullable=True, index=True)
    action = Column(String, nullable=False)
    created_at = Column(UTCDateTime, default=utc_now)
