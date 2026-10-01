from __future__ import annotations

import uuid

from sqlalchemy import (
    Boolean,
    Column,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
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
        """Vrai si un corrigé existe (au moins un sujet en possède un) — la
        présence de la ligne `epreuve_files` du document équivaut à un
        contenu non vide (un enregistrement avec contenu vide est supprimé
        à l'écriture, voir `write_document`)."""
        return any(f.cible == "corrige" and f.format == "md" for f in self.files_rel)

    @property
    def nb_sujets(self) -> int:
        """Nombre de sujets distincts (documents `sujet` Markdown), jamais
        inférieur à 1 — une épreuve possède toujours au moins un sujet."""
        indices = {f.sujet_index for f in self.files_rel if f.cible == "sujet" and f.format == "md"}
        return max(len(indices), 1)


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
      UN par (`cible`, `sujet_index`) (remplacé au ré-enregistrement) ;
    - `format='image'` : une image d'illustration insérée dans le Markdown.

    `sujet_index` distingue les multiples sujets d'une même épreuve : 0
    pour la version historique (fichier `sujet.md`/`corrige.md`), puis 1,
    2… pour les sujets supplémentaires (`sujet_1.md`…). Les images ne
    portent pas d'index (elles restent rattachées à leur cible).

    La base ne conserve que les métadonnées + `storage_key` ; le checksum
    SHA-256 sert à la détection de doublons lors de l'import massif."""

    __tablename__ = "epreuve_files"

    id = Column(String, primary_key=True, default=_uid)
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=False, index=True)
    cible = Column(String, nullable=False)  # sujet|corrige
    format = Column(String, nullable=False)  # md|image
    # Index du sujet pour les documents Markdown (0 = historique / sujet
    # principal). Pour les images, reste à 0 (valeur par défaut).
    sujet_index = Column(Integer, nullable=False, default=0)
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

    # Au plus UN document Markdown par (epreuve, cible, sujet) : c'est
    # l'invariant que suppose `write_document` (upsert) et que lisait
    # `get_document` via `.one_or_none()` — deux lignes renvoyant un
    # MultipleResultsFound, donc un 500 sur l'écriture d'un sujet ou d'un
    # corrigé. L'index le fait garantir par le SGBD.
    #
    # Partiel (`WHERE format='md'`) car les IMAGES partagent ces colonnes
    # avec sujet_index=0 et peuvent être multiples pour une même cible.
    __table_args__ = (
        Index(
            "uq_epreuve_files_document",
            "epreuve_id",
            "cible",
            "sujet_index",
            unique=True,
            sqlite_where=text("format = 'md'"),
            postgresql_where=text("format = 'md'"),
        ),
    )


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


class SauvegardeJobORM(Base):
    """Job de sauvegarde (export ou restauration) — Phase 3 du plan
    `PLAN_SAUVEGARDES.md`.

    Distinct de `ImportJobORM` : une sauvegarde se décrit par des compteurs de
    progression (octets, parties) là où un import ne compte que des fichiers.
    Réutiliser la même table aurait forcé à rendre compteurs optionnels pour
    tous les importers existants.

    Aucune migration : `create_all` au lifespan crée la table sur SQLite comme
    sur PostgreSQL.
    """

    __tablename__ = "sauvegarde_jobs"

    id = Column(String, primary_key=True, default=_uid)
    kind = Column(String, nullable=False, default="export")  # export|restore
    status = Column(String, nullable=False, default="pending")  # pending|running|done|error
    # Préfixe de stockage écrit par un export (`_sauvegardes/...`), vide pour
    # une restauration. Sert à retrouver la sauvegarde depuis la liste.
    destination = Column(String, nullable=False, default="")
    # Pour une restauration, ce qui est lu : préfixe de stockage ou dossier
    # local, selon le mode.
    source = Column(String, nullable=False, default="")
    mode = Column(String, nullable=False, default="")  # bucket|disaster (restore)
    # Compteurs de progression, mis à jour pendant la tâche de fond. L'IHM
    # n'affiche que ceux qui sont pertinents pour le `kind` en cours.
    total_fichiers = Column(Integer, nullable=False, default=0)
    fichiers_faits = Column(Integer, nullable=False, default=0)
    total_octets = Column(Integer, nullable=False, default=0)
    octets_faits = Column(Integer, nullable=False, default=0)
    partie_courante = Column(Integer, nullable=False, default=0)
    parties_total = Column(Integer, nullable=False, default=0)
    report_json = Column(Text, nullable=False, default="{}")
    logs_json = Column(Text, nullable=False, default="[]")
    created_at = Column(UTCDateTime, default=utc_now)
    finished_at = Column(UTCDateTime, nullable=True)


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


class AdminAIConversationORM(Base):
    """Discussion IA du back-office : une conversation « roulante » par
    (email admin, épreuve) — l'assistant redevient persistant entre deux
    ouvertures du tiroir. Pas de FK vers epreuves (la purge se fait
    explicitement à la suppression de l'épreuve, comme les autres tables
    qui la référencent)."""
    __tablename__ = "admin_ai_conversations"

    id = Column(String, primary_key=True, default=_uid)
    email = Column(String, nullable=False, index=True)
    epreuve_id = Column(String, nullable=False, index=True)
    label = Column(String, nullable=False, default="Discussion admin")
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


class ReferentielOptionORM(Base):
    """Option d'une liste énumérative du référentiel (chantier « paramètres
    à valeurs discrètes reconfigurables ») : `scope` nomme la liste (niveau,
    classe, evaluation, matiere, session, serie), `code` est la valeur
    canonique stockée sur les épreuves et `label` le libellé affiché (repli
    sur `code` si absent). Seedée au démarrage depuis `core/referentiel.py`,
    puis alimentée par l'onglet « Paramètres » du back-office et par l'usage
    (auto-ajout d'une matière/série/session saisie hors liste)."""

    __tablename__ = "referentiel_options"
    __table_args__ = (UniqueConstraint("scope", "code", name="uq_referentiel_scope_code"),)

    id = Column(String, primary_key=True, default=_uid)
    scope = Column(String, nullable=False, index=True)
    code = Column(String, nullable=False)
    label = Column(String, nullable=True)
    position = Column(Integer, nullable=False, default=0)
    created_at = Column(UTCDateTime, default=utc_now)


class NotificationORM(Base):
    """Notification diffusée à TOUS les utilisateurs (bandeau + cloche dans
    le menu). Gérée depuis l'onglet Notifications du back-office : création,
    modification, activation/désactivation (une notification inactive reste
    stockée mais n'est plus exhibée), suppression. `epreuve_id` lie la
    notification à une épreuve pour que la cloche puisse proposer
    d'y aller directement (cas « publication d'une nouvelle épreuve »).

    La lecture est suivie PAR UTILISATEUR dans `NotificationReadORM` — la
    cloche affiche le nombre de notifications non lues. Les lignes de lecture
    sont purgées à la suppression du compte (droit à l'effacement)."""

    __tablename__ = "notifications"

    id = Column(String, primary_key=True, default=_uid)
    titre = Column(String, nullable=False)
    message = Column(Text, nullable=False, default="")
    type = Column(String(32), nullable=False, default="information")  # information|nouvelle_epreuve|modification|maintenance
    epreuve_id = Column(String, ForeignKey("epreuves.id"), nullable=True, index=True)
    actif = Column(Boolean, nullable=False, default=True)
    created_at = Column(UTCDateTime, default=utc_now)
    updated_at = Column(UTCDateTime, default=utc_now, onupdate=utc_now)


class NotificationReadORM(Base):
    """Marqueur « lu par l'utilisateur » d'une notification : une ligne par
    (notification, utilisateur). L'absence de ligne = non lue, la cloche
    l'affiche en surbrillance jusqu'au passage « marquer comme lue »."""

    __tablename__ = "notification_reads"
    __table_args__ = (
        UniqueConstraint("notification_id", "user_id", name="uq_notification_user"),
    )

    notification_id = Column(String, ForeignKey("notifications.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    read_at = Column(UTCDateTime, default=utc_now)
