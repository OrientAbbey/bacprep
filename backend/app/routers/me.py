from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import referentiel, store
from ..core.logging_config import get_logger
from ..core.subscriptions import SCOPE_LABELS, scope_of, subs_to_out
from ..db import get_db, utc_now
from ..db_models import (
    AIConversationORM,
    ConsultationORM,
    EpreuveORM,
    KickoutNoticeORM,
    NoteORM,
    NotificationReadORM,
    PaymentORM,
    SessionORM,
    SignalementORM,
    SubscriptionORM,
)
from ..models import ConsentementIn, NoteUpdateIn, NoteWithEpreuveOut, ProfilUpdateIn
from .auth import require_user

router = APIRouter(prefix="/api/me", tags=["me"])
log = get_logger("me")


@router.get("/profil")
def profil(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Page Profil : identité (y compris infos étendues niveau/classe/
    établissement), abonnements actifs enrichis (portée lisible, épreuves
    couvertes, dates) et total dépensé (calculé sur les paiements confirmés,
    donc toujours exact même après annulation d'un abonnement — voir
    Module 10 du cahier des charges)."""
    subs = (
        db.query(SubscriptionORM)
        .filter(SubscriptionORM.user_id == user.id, SubscriptionORM.statut == "active")
        .order_by(SubscriptionORM.start_date.desc())
        .all()
    )
    total_depense = sum(
        p.montant
        for p in db.query(PaymentORM).filter(PaymentORM.user_id == user.id, PaymentORM.statut == "confirmed").all()
    )
    return {
        "email": user.email,
        "nom": user.nom,
        "niveau": user.niveau,
        "classe": user.classe,
        "etablissement": user.etablissement,
        "membre_depuis": user.created_at,
        "abonnements": [o.model_dump() for o in subs_to_out(db, subs)],
        "total_depense_fcfa": total_depense,
    }


@router.put("/profil")
def update_profil(
    payload: ProfilUpdateIn, db: Session = Depends(get_db), user=Depends(require_user)
) -> dict:
    """Mise à jour du profil étendu : nom, niveau, classe, établissement
    (tous optionnels — seuls les champs fournis sont modifiés). Le niveau
    et la classe sont normalisés contre le référentiel quand ils sont
    fournis non vides ; une chaîne vide les efface."""
    data = payload.model_dump(exclude_unset=True)
    if "nom" in data:
        user.nom = (data["nom"] or "").strip()
    if "niveau" in data:
        user.niveau = referentiel.normalize_niveau(data["niveau"]) if data["niveau"] else None
    if "classe" in data:
        user.classe = referentiel.normalize_classe(data["classe"]) if data["classe"] else None
    if "etablissement" in data:
        user.etablissement = (data["etablissement"] or "").strip() or None
    db.add(user)
    db.commit()
    return {"ok": True}


@router.put("/consentement")
def update_consentement(
    payload: ConsentementIn, db: Session = Depends(get_db), user=Depends(require_user)
) -> dict:
    """Recueil (et révocation) du consentement, demandé à la connexion via
    une modale granulaire : persistance des conversations IA et des notes,
    chaque finalité étant acceptée ou refusée séparément (pratique RGPD :
    libre, spécifique, univoque et révocable). Un refus est effectif
    immédiatement : les gardes serveur bloquent toute nouvelle écriture, et
    le frontend passe l'assistant en mode éphémère. RÉVOQUER le consentement
    IA purge aussitôt les conversations déjà stockées (Art. 17) — c'était un
    trou du cycle de vie : les données restaient conservées alors que la
    finalité avait été retirée (corrigé 2026-09)."""
    revoque_ia = payload.partage_conversations_ia is False and user.consent_ia is True
    user.consent_ia = payload.partage_conversations_ia
    user.consent_notes = payload.partage_notes
    user.consent_given_at = utc_now()
    db.add(user)
    if revoque_ia:
        db.query(AIConversationORM).filter(AIConversationORM.user_id == user.id).delete()
        log.info("Consentement IA révoqué pour %s — conversations purgées", user.email)
    db.commit()
    log.info(
        "Consentement mis à jour pour %s (ia=%s notes=%s)",
        user.email,
        user.consent_ia,
        user.consent_notes,
    )
    return {"ok": True, "consent_ia": user.consent_ia, "consent_notes": user.consent_notes}


# ---------- Notes personnelles & historique ----------


@router.get("/historique")
def historique(db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Les 10 dernières épreuves consultées par l'utilisateur (plus
    récentes en premier), affichées en tête du catalogue — épreuves
    préchargées en une requête `IN` (une requête par consultation
    saturait inutilement)."""
    consultations = store.get_recent_consultations(db, user.id)
    epreuves = {
        e.id: e
        for e in db.query(EpreuveORM)
        .filter(EpreuveORM.id.in_([c.epreuve_id for c in consultations] or [""]))
        .all()
    }
    out = []
    for c in consultations:
        e = epreuves.get(c.epreuve_id)
        if not e:
            continue
        out.append(
            {
                "epreuve_id": e.id,
                "matiere": e.matiere,
                "annee": e.annee,
                "classe": e.classe,
                "evaluation": e.evaluation,
                "filieres": e.filieres,
                "consulted_at": c.consulted_at,
            }
        )
    return out


def _note_to_out(note: NoteORM, epreuve: EpreuveORM | None) -> dict:
    """Projette une note (enrichie des infos d'épreuve pour l'affichage
    « Mes notes » sans aller-retour supplémentaire)."""
    out = NoteWithEpreuveOut(
        id=note.id,
        epreuve_id=note.epreuve_id,
        cible=note.cible,
        contexte_extrait=note.contexte_extrait,
        contenu=note.contenu,
        created_at=note.created_at,
        updated_at=note.updated_at,
    ).model_dump()
    if epreuve:
        out.update(
            matiere=epreuve.matiere,
            annee=epreuve.annee,
            classe=epreuve.classe,
            evaluation=epreuve.evaluation,
        )
    return out


@router.get("/notes")
def list_notes(db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Toutes les notes de l'utilisateur (les plus récemment modifiées
    d'abord), enrichies des informations de leur épreuve."""
    notes = (
        db.query(NoteORM)
        .filter(NoteORM.user_id == user.id)
        .order_by(NoteORM.updated_at.desc())
        .all()
    )
    epreuves = {
        e.id: e
        for e in db.query(EpreuveORM)
        .filter(EpreuveORM.id.in_([n.epreuve_id for n in notes] or [""]))
        .all()
    }
    return [_note_to_out(n, epreuves.get(n.epreuve_id)) for n in notes]


@router.put("/notes/{note_id}")
def update_note(
    note_id: str,
    payload: NoteUpdateIn,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Modifie une note de l'utilisateur (contenu et/ou contexte) — 404 si
    elle n'existe pas ou n'appartient pas à cet utilisateur."""
    note = (
        db.query(NoteORM)
        .filter(NoteORM.id == note_id, NoteORM.user_id == user.id)
        .one_or_none()
    )
    if not note:
        raise HTTPException(404, "Note introuvable")
    data = payload.model_dump(exclude_unset=True)
    if data.get("contenu") is not None:
        note.contenu = data["contenu"]
    if data.get("contexte_extrait") is not None:
        note.contexte_extrait = data["contexte_extrait"]
    note.updated_at = utc_now()
    db.add(note)
    db.commit()
    epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == note.epreuve_id).one_or_none()
    return _note_to_out(note, epreuve)


@router.delete("/notes/{note_id}")
def delete_note(note_id: str, db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Supprime une note de l'utilisateur."""
    note = (
        db.query(NoteORM)
        .filter(NoteORM.id == note_id, NoteORM.user_id == user.id)
        .one_or_none()
    )
    if not note:
        raise HTTPException(404, "Note introuvable")
    db.delete(note)
    db.commit()
    return {"ok": True}


# ---------- RGPD : portabilité & effacement ----------


@router.get("/export")
def export_donnees(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Export de TOUTES les données personnelles de l'utilisateur au format
    JSON lisible (droit à la portabilité, Art. 20 GDPR) — un seul appel,
    tout est renvoyé : profil, notes, conversations IA, consultations,
    abonnements et paiements."""
    epreuves_ids = {
        n.epreuve_id
        for n in db.query(NoteORM).filter(NoteORM.user_id == user.id).all()
    }
    epreuves_ids |= {
        c.epreuve_id
        for c in db.query(AIConversationORM).filter(AIConversationORM.user_id == user.id).all()
    }
    epreuves = {
        e.id: {"matiere": e.matiere, "annee": e.annee, "classe": e.classe, "evaluation": e.evaluation}
        for e in db.query(EpreuveORM).filter(EpreuveORM.id.in_(list(epreuves_ids) or [""])).all()
    }
    return {
        "profil": {
            "email": user.email,
            "nom": user.nom,
            "niveau": user.niveau,
            "classe": user.classe,
            "etablissement": user.etablissement,
            "membre_depuis": user.created_at,
            "consent_ia": user.consent_ia,
            "consent_notes": user.consent_notes,
            "banni": user.banni,
        },
        "notes": [
            _note_to_out(n, None) | {"epreuve": epreuves.get(n.epreuve_id)}
            for n in db.query(NoteORM).filter(NoteORM.user_id == user.id).all()
        ],
        "conversations_ia": [
            store.conversation_to_dict(c) | {"epreuve": epreuves.get(c.epreuve_id)}
            for c in db.query(AIConversationORM).filter(AIConversationORM.user_id == user.id).all()
        ],
        "consultations": [
            {"epreuve_id": c.epreuve_id, "epreuve": epreuves.get(c.epreuve_id), "consulted_at": c.consulted_at}
            for c in db.query(ConsultationORM).filter(ConsultationORM.user_id == user.id).all()
        ],
        "abonnements": [
            {"id": s.id, "scope": scope_of(s), "statut": s.statut, "start_date": s.start_date, "end_date": s.end_date}
            for s in db.query(SubscriptionORM).filter(SubscriptionORM.user_id == user.id).all()
        ],
        "paiements": [
            {
                "provider": p.provider,
                "montant": p.montant,
                "reference": p.reference_agregateur,
                "statut": p.statut,
                "confirmed_at": p.confirmed_at,
            }
            for p in db.query(PaymentORM).filter(PaymentORM.user_id == user.id).all()
        ],
    }


@router.delete("/compte")
def supprimer_compte(db: Session = Depends(get_db), user=Depends(require_user)) -> dict:
    """Suppression du compte par l'utilisateur lui-même (droit à
    l'effacement, Art. 17) : purge de TOUTES les données personnelles —
    sessions, notes, conversations IA, consultations, signalements,
    abonnements et paiements — puis suppression de la ligne utilisateur.
    Comportement unifié avec la suppression admin
    (admin_misc.admin_supprimer_utilisateur) : les deux voies effacent
    strictement, plus de divergence anonymisation/effacement. La session
    courante et les autres sessions sont révoquées."""
    u_id = user.id
    db.query(SessionORM).filter(SessionORM.user_id == u_id).delete()
    db.query(KickoutNoticeORM).filter(KickoutNoticeORM.user_id == u_id).delete()
    db.query(NoteORM).filter(NoteORM.user_id == u_id).delete()
    db.query(AIConversationORM).filter(AIConversationORM.user_id == u_id).delete()
    db.query(ConsultationORM).filter(ConsultationORM.user_id == u_id).delete()
    # Ordre important : les paiements référencent les abonnements
    # (payments.subscription_id → subscriptions.id, FK RESTRICT) — il faut
    # donc purger les paiements AVANT les abonnements, sinon le DELETE des
    # abonnements échoue en FOREIGN KEY constraint failed.
    db.query(PaymentORM).filter(PaymentORM.user_id == u_id).delete()
    db.query(SubscriptionORM).filter(SubscriptionORM.user_id == u_id).delete()
    db.query(SignalementORM).filter(SignalementORM.user_id == u_id).delete()
    db.query(NotificationReadORM).filter(NotificationReadORM.user_id == u_id).delete()
    db.delete(user)
    db.commit()
    log.info("Compte supprimé (effacement strict) — user %s", u_id)
    return {"ok": True}


# ---------- Historique d'activité ----------

_MAX_ACTIVITE = 50


@router.get("/activite")
def activite(db: Session = Depends(get_db), user=Depends(require_user)) -> list[dict]:
    """Timeline d'activité de l'utilisateur : connexions, consultations
    d'épreuves, abonnements souscrits, paiements confirmés, notes créées ou
    modifiées et discussions IA — fusionnés, triés du plus récent au plus
    ancien, plafonnés aux 50 dernières entrées. Sert l'onglet « Activité »
    de la page Profil.

    Chaque source est bornée en SQL (LIMIT 50, les plus récentes) et les
    épreuves référencées préchargées en une requête `IN` — la version
    antérieure chargeait TOUTES les lignes de 6 tables puis interrogeait
    l'épreuve une par une (centaines de requêtes sur un compte ancien).

    Réordonnancée en petits bâtisseurs dédiés (un par source) pour la
    lisibilité — même logique, même tri, même plafond."""
    consultations = _activite_recent(db, user, ConsultationORM, ConsultationORM.consulted_at)
    subscriptions = _activite_recent(db, user, SubscriptionORM, SubscriptionORM.start_date)
    notes = _activite_recent(db, user, NoteORM, NoteORM.updated_at)
    conversations = _activite_recent(db, user, AIConversationORM, AIConversationORM.updated_at)

    epreuves = _activite_map_epreuves(db, consultations, notes, conversations)

    items = (
        _activite_connexions(db, user)
        + _activite_consultations(consultations, epreuves)
        + _activite_abonnements(subscriptions)
        + _activite_paiements(db, user)
        + _activite_notes(notes, epreuves)
        + _activite_discussions(conversations, epreuves)
    )
    items.sort(key=lambda i: i["date"] or utc_now(), reverse=True)
    return items[:_MAX_ACTIVITE]


def _activite_item(type_, date, libelle, *, epreuve_id=None, details="", conversation_id=None) -> dict:
    """Canonise une entrée de timeline — tous les bâtisseurs ci-dessous
    utilisent cette forme, le tri et le plafonnement sont centralisés dans
    `activite`."""
    return {
        "type": type_,
        "date": date,
        "libelle": libelle,
        "epreuve_id": epreuve_id,
        "details": details,
        "conversation_id": conversation_id,
    }


def _activite_recent(db: Session, user, model, order_col):
    """Les `_MAX_ACTIVITE` lignes les plus récentes de `model` pour l'utilisateur."""
    return (
        db.query(model)
        .filter(model.user_id == user.id)
        .order_by(order_col.desc())
        .limit(_MAX_ACTIVITE)
        .all()
    )


def _activite_map_epreuves(db: Session, *sources) -> dict[str, EpreuveORM]:
    """Précharge les épreuves référencées par les sources en une requête `IN`."""
    ids: set[str] = set()
    for rows in sources:
        for row in rows:
            if getattr(row, "epreuve_id", None):
                ids.add(row.epreuve_id)
    return {e.id: e for e in db.query(EpreuveORM).filter(EpreuveORM.id.in_(list(ids) or [""])).all()}


def _activite_connexions(db: Session, user) -> list[dict]:
    """Connexions passées, libellé distinguant la plateforme de l'appareil
    (« mobile » = tel, « ordinateur » = web) — posée par le frontend à la
    connexion (champ `platform` de MockLoginIn/GoogleLoginIn)."""
    out = []
    for s in _activite_recent(db, user, SessionORM, SessionORM.issued_at):
        mobile = (s.platform or "web") != "web"
        out.append(
            _activite_item(
                "connexion",
                s.issued_at,
                "Connexion à ton compte (mobile)" if mobile else "Connexion à ton compte (ordinateur)",
                details=s.platform or "web",
            )
        )
    return out


def _activite_consultations(consultations, epreuves) -> list[dict]:
    items = []
    for c in consultations:
        e = epreuves.get(c.epreuve_id)
        if not e:
            continue
        series = ", ".join(e.filieres)
        items.append(
            _activite_item(
                "consultation",
                c.consulted_at,
                # Contexte complet : matière, classe, séries, évaluation, année.
                f"Consultation de {e.matiere} — {e.classe} ({e.evaluation} {e.annee})",
                epreuve_id=e.id,
                details=f"Séries : {series}" if series else "",
            )
        )
    return items


def _activite_abonnements(subscriptions) -> list[dict]:
    items = []
    for s in subscriptions:
        # Libellé de portée SANS sub_to_out (qui recalcule les épreuves
        # couvertes par requête — un N+1 inutile ici) : la timeline se
        # contente du libellé, pas du décompte.
        scope_label = SCOPE_LABELS[scope_of(s)]
        items.append(
            _activite_item(
                "abonnement",
                s.start_date,
                f"Abonnement {s.statut} — {scope_label}",
                epreuve_id=s.epreuve_id,
            )
        )
    return items


def _activite_paiements(db: Session, user) -> list[dict]:
    return [
        _activite_item(
            "paiement",
            p.confirmed_at or p.created_at,
            f"Paiement confirmé — {p.montant} FCFA ({p.provider})",
            details=p.reference_agregateur,
        )
        for p in (
            db.query(PaymentORM)
            .filter(PaymentORM.user_id == user.id, PaymentORM.statut == "confirmed")
            .order_by(PaymentORM.confirmed_at.desc())
            .limit(_MAX_ACTIVITE)
            .all()
        )
    ]


def _activite_notes(notes, epreuves) -> list[dict]:
    items = []
    for n in notes:
        e = epreuves.get(n.epreuve_id)
        items.append(
            _activite_item(
                "note",
                n.updated_at,
                (
                    f"Note sur {e.matiere} — {e.classe} ({e.evaluation} {e.annee})"
                    if e
                    else "Note personnelle"
                ),
                epreuve_id=n.epreuve_id,
            )
        )
    return items


def _activite_discussions(conversations, epreuves) -> list[dict]:
    items = []
    for conv in conversations:
        e = epreuves.get(conv.epreuve_id)
        libelle = _tronquer_libelle(conv.label or "")
        items.append(
            _activite_item(
                "discussion_ia",
                conv.updated_at,
                (
                    f"Discussion « {libelle} » — {e.matiere} ({e.evaluation} {e.annee})"
                    if e
                    else f"Discussion « {libelle} »"
                ),
                epreuve_id=conv.epreuve_id,
                # Permet de rouvrir l'onglet de discussion exact depuis le
                # profil (lecteur : /epreuve/{id}?conv={id}).
                details=e.matiere if e else "",
                conversation_id=conv.id,
            )
        )
    return items


def _tronquer_libelle(libelle: str, max_len: int = 60) -> str:
    """Raccourcit le libellé libre d'une discussion pour que les entrées
    du journal d'activité restent courtes (une seule ligne d'affichage —
    la valeur complète reste dans la table sous-jacente)."""
    plat = " ".join(libelle.split())
    return plat if len(plat) <= max_len else f"{plat[: max_len - 1].strip()}…"
