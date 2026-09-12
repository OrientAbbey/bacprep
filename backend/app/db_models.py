from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    Column,
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
    """Identifiant court d'épreuve (12 hex, ex. ``8f3a2c91ab47``) — utilisé
    dans les storage_key ``epreuves/{niveau}/{annee}/{id}/...``. 12 hex (48
    bits) : une épreuve ne devient pas devinable pour autant (les ids
    restent hors du catalogue public — seuls statut et gratuits s'y voient)."""
    return uuid.uuid4().hex[:12]


class UserORM(Base):
    """Compte élève : email, profil (niveau/classe/établissement),
    consentements RGPD, modération (bannissement) et historique de connexion.

    `role` : "user" (élève) ou "admin" (promu par le root depuis le
    back-office). Le root lui-même n'est PAS représenté par cette colonne —
    il est issu de la variable d'environnement ADMIN_ROOT ; à son login sa
    ligne est alignée sur "admin" pour que la cohérence globale soit lisible."""
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uid)
    email = Column(String, unique=True, nullable=False, index=True)
    nom = Column(String, nullable=False, default="")
    role = Column(String(16), nullable=False, default="user", server_default="user")
    # Profil étendu (optionnel, renseigné par l'élève dans sa page Profil) :
    # niveau et classe suivis, établissement.
    niveau = Column(String, nullable=True)
    classe = Column(String, nullable=True)
    etablissement = Column(String, nullable=True)
    # Consentement recueilli À LA CONNEXION (modale granulaire, révocable
    # depuis le profil) : NULL = pas encore demandé ; False = refus explicite
    # (aucune persistance des données concernées) ; True = accepté.
    consent_ia = Column(Boolean, nullable=True)
    consent_notes = Column(Boolean, nullable=True)
    consent_given_at = Column(UTCDateTime, nullable=True)
    # Modération back-office : un compte banni ne peut plus ouvrir (ni
    # conserver) une session ; motif conservé pour le journal admin.
    banni = Column(Boolean, nullable=False, default=False)
    banni_motif = Column(String, nullable=True)
    # Dernière connexion RÉELLE (posée à chaque login, jamais effacée par une
    # déconnexion — contrairement à la table `sessions`, purgée au logout).
    derniere_connexion = Column(UTCDateTime, nullable=True)
    created_at = Column(UTCDateTime, default=utc_now)


class SessionORM(Base):
    """Session élève active : une seule session par utilisateur, purgée au
    logout, expirée par inactivité (7 j glissants) ou durée maximale (14 j)."""
    __tablename__ = "sessions"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    token = Column(String, unique=True, nullable=False, index=True)
    platform = Column(String, default="web")
    issued_at = Column(UTCDateTime, default=utc_now)
    # Dernier accès constaté (expiration GLISSANTE) — distinct d'issued_at,
    # qui borne la durée de vie MAXIMALE absolue de la session.
    last_seen = Column(UTCDateTime, default=utc_now)


class KickoutNoticeORM(Base):
    """Notification de déconnexion forcée (ancienneté v0, remplacée par
    WebSocket) — filet de secours par sondage."""
    __tablename__ = "kickout_notices"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True)
    message = Column(String, nullable=False)


class AdminLockORM(Base):
    """Verrou de session admin — UNE seule ligne (id='singleton'), qui
    matérialise l'admin actuellement connecté. Persisté en base (et non
    plus dans une simple variable Python en mémoire) pour survivre à un
    redémarrage du backend : un redémarrage ne doit plus libérer
    silencieusement l'accès admin tant que la session n'a pas expiré
    (fenêtre d'inactivité configurée, par défaut 3 min) ou été
    explicitement fermée."""

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
    extrait = Column(String, nullable=False, default="")
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
    """Table de jointure many-to-many épreuve ↔ série/filière."""
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
    # Dimensions des images en pixels (remplies à l'upload via Pillow ;
    # NULL pour les documents Markdown et les images non mesurables).
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
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
    # Lignes de journal accumulées pendant l'exécution (affichées en direct
    # par l'interface admin via polling) — liste JSON de chaînes.
    logs_json = Column(Text, nullable=False, default="[]")
    created_at = Column(UTCDateTime, default=utc_now)
    finished_at = Column(UTCDateTime, nullable=True)


class PaymentORM(Base):
    """Paiement lié à une souscription : référence agrégateur, montant,
    statut (pending/confirmed/failed) et horodatage de confirmation."""
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
    """Discussion IA (onglet) d'un élève sur une épreuve : messages
    persistés si consentement IA accordé, sinon vide (mode éphémère)."""
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
    """Consultation d'une épreuve par un élève : une seule ligne par
    (utilisateur, épreuve) pour la télémétrie catalogue (historique récent)."""
    __tablename__ = "consultations"
    __table_args__ = (UniqueConstraint("user_id", "epreuve_id", name="uq_user_epreuve"),)

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    consulted_at = Column(UTCDateTime, default=utc_now)


class AdminEventORM(Base):
    """Journal d'audit du back-office : chaque action admin (création,
    publication, suppression, import, login/logout...) y est tracée avec
    l'email de son auteur et un détail libre en JSON."""

    __tablename__ = "admin_events"

    id = Column(String, primary_key=True, default=_uid)
    epreuve_id = Column(String, nullable=True, index=True)
    action = Column(String, nullable=False)
    email = Column(String, nullable=False, default="")
    details = Column(Text, nullable=False, default="{}")
    created_at = Column(UTCDateTime, default=utc_now)


class NoteORM(Base):
    """Note personnelle d'un élève, liée à une épreuve (et souvent à un
    passage précis de celle-ci, conservé dans `contexte_extrait`). Le
    contenu est du Markdown : rédaction manuelle ou réponse de l'assistant
    sauvegardée telle quelle."""

    __tablename__ = "notes"

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    cible = Column(String, nullable=False, default="sujet")  # sujet|corrige
    contexte_extrait = Column(Text, nullable=False, default="")
    contenu = Column(Text, nullable=False, default="")
    created_at = Column(UTCDateTime, default=utc_now)
    updated_at = Column(UTCDateTime, default=utc_now, onupdate=utc_now)


class SignalementORM(Base):
    """Signalement d'un problème sur une épreuve par un élève (contenu
    illisible, erreur d'énoncé, corrigé manquant, image cassée, autre).
    Statut ouvert → résolu, traité dans le back-office."""

    __tablename__ = "signalements"

    id = Column(String, primary_key=True, default=_uid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    motif = Column(String, nullable=False)
    message = Column(Text, nullable=False, default="")
    statut = Column(String, nullable=False, default="ouvert")  # ouvert|resolu
    created_at = Column(UTCDateTime, default=utc_now)
    resolved_at = Column(UTCDateTime, nullable=True)
