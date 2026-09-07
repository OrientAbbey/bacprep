from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core import referentiel, store
from ..core.logging_config import get_logger
from ..core.subscriptions import SCOPE_LABELS, scope_of, sub_to_out
from ..db import get_db, utc_now
from ..db_models import (
    AIConversationORM,
    ConsultationORM,
    EpreuveORM,
    NoteORM,
    PaymentORM,
    SessionORM,
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
        "abonnements": [sub_to_out(db, s).model_dump() for s in subs],
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
    le frontend passe l'assistant en mode éphémère."""
    user.consent_ia = payload.partage_conversations_ia
    user.consent_notes = payload.partage_notes
    user.consent_given_at = utc_now()
    db.add(user)
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
    l'épreuve une par une (centaines de requêtes sur un compte ancien)."""
    items: list[dict] = []

    def _recent(model, order_col, n=50):
        return (
            db.query(model)
            .filter(model.user_id == user.id)
            .order_by(order_col.desc())
            .limit(n)
            .all()
        )

    for s in _recent(SessionORM, SessionORM.issued_at):
        items.append(
            {"type": "connexion", "date": s.issued_at, "libelle": "Connexion à ton compte", "epreuve_id": None, "details": s.platform or "web", "conversation_id": None}
        )

    consultations = _recent(ConsultationORM, ConsultationORM.consulted_at)
    subscriptions = _recent(SubscriptionORM, SubscriptionORM.start_date)
    notes = _recent(NoteORM, NoteORM.updated_at)
    conversations = _recent(AIConversationORM, AIConversationORM.updated_at)

    epreuve_ids = {c.epreuve_id for c in consultations}
    epreuve_ids |= {n.epreuve_id for n in notes}
    epreuve_ids |= {conv.epreuve_id for conv in conversations}
    epreuves = {
        e.id: e
        for e in db.query(EpreuveORM).filter(EpreuveORM.id.in_(list(epreuve_ids) or [""])).all()
    }

    for c in consultations:
        e = epreuves.get(c.epreuve_id)
        if not e:
            continue
        series = ", ".join(e.filieres)
        items.append(
            {
                "type": "consultation",
                "date": c.consulted_at,
                # Contexte complet : matière, classe, séries, évaluation, année.
                "libelle": f"Consultation de {e.matiere} — {e.classe} ({e.evaluation} {e.annee})",
                "epreuve_id": e.id,
                "details": f"Séries : {series}" if series else "",
                "conversation_id": None,
            }
        )

    for s in subscriptions:
        # Libellé de portée SANS sub_to_out (qui recalcule les épreuves
        # couvertes par requête — un N+1 inutile ici) : la timeline se
        # contente du libellé, pas du décompte.
        scope_label = SCOPE_LABELS[scope_of(s)]
        items.append(
            {
                "type": "abonnement",
                "date": s.start_date,
                "libelle": f"Abonnement {s.statut} — {scope_label}",
                "epreuve_id": s.epreuve_id,
                "details": "",
                "conversation_id": None,
            }
        )

    for p in db.query(PaymentORM).filter(PaymentORM.user_id == user.id, PaymentORM.statut == "confirmed").order_by(PaymentORM.confirmed_at.desc()).limit(50).all():
        items.append(
            {
                "type": "paiement",
                "date": p.confirmed_at or p.created_at,
                "libelle": f"Paiement confirmé — {p.montant} FCFA ({p.provider})",
                "epreuve_id": None,
                "details": p.reference_agregateur,
                "conversation_id": None,
            }
        )

    for n in notes:
        e = epreuves.get(n.epreuve_id)
        items.append(
            {
                "type": "note",
                "date": n.updated_at,
                "libelle": (
                    f"Note sur {e.matiere} — {e.classe} ({e.evaluation} {e.annee})"
                    if e
                    else "Note personnelle"
                ),
                "epreuve_id": n.epreuve_id,
                "details": "",
                "conversation_id": None,
            }
        )

    for conv in conversations:
        e = epreuves.get(conv.epreuve_id)
        items.append(
            {
                "type": "discussion_ia",
                "date": conv.updated_at,
                "libelle": (
                    f"Discussion « {conv.label} » — {e.matiere} ({e.evaluation} {e.annee})"
                    if e
                    else f"Discussion « {conv.label} »"
                ),
                "epreuve_id": conv.epreuve_id,
                # Permet de rouvrir l'onglet de discussion exact depuis le
                # profil (lecteur : /epreuve/{id}?conv={id}).
                "details": e.matiere if e else "",
                "conversation_id": conv.id,
            }
        )

    items.sort(key=lambda i: i["date"] or utc_now(), reverse=True)
    return items[:_MAX_ACTIVITE]
