"""Routes admin : connexion (jeton + liste blanche), statistiques, journal
d'audit et signalements — découpé de l'ancien admin.py monolithique.

Sécurité du login (renforcée) :
- ``ADMIN_TOKEN`` sans valeur par défaut : absent → 500 explicite ; valeur
  d'exemple ``admin123`` refusée en production (ENV=prod) ;
- comparaison à temps constant + rate-limit mémoire (5 tentatives/min/IP).
"""
from __future__ import annotations

import json
import os
import secrets
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import admin_session, store
from ..core.config import is_prod
from ..core.logging_config import get_logger
from ..core.rate_limit import SlidingWindowLimiter, client_ip
from ..db import get_db, utc_now
from ..db_models import (
    AdminEventORM,
    AIConversationORM,
    ConsultationORM,
    EpreuveFileORM,
    EpreuveORM,
    KickoutNoticeORM,
    NoteORM,
    PaymentORM,
    SessionORM,
    SignalementORM,
    SubscriptionORM,
    UserORM,
)
from ..models import AdminLoginIn, BannirIn
from .deps import log_admin_event, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])
log = get_logger("admin")

EXAMPLE_TOKEN = "admin123"
# Freine le brute-force du jeton admin : 5 tentatives/minute/IP (limiteur
# mémoire partagé, cf. core/rate_limit.py ; désactivable via
# LOGIN_RATE_LIMIT pour les tests — défaut ACTIVÉ, y compris en dev).
_login_limiter = SlidingWindowLimiter(
    max_attempts=5,
    window_seconds=60.0,
    message="Trop de tentatives — réessaie dans une minute",
    env_switch="LOGIN_RATE_LIMIT",
)


@router.post("/login")
def admin_login(
    payload: AdminLoginIn,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Connexion admin : jeton partagé (ADMIN_TOKEN) + email dans la liste
    blanche (ADMIN_EMAILS). Si un autre admin est déjà connecté (verrou
    persisté en base, voir admin_session.py), répond 409 avec qui est
    connecté depuis quand — sauf si `force=true`, qui prend le contrôle.

    Le jeton de session part dans un cookie httpOnly (SameSite=Strict,
    Secure en prod) : il n'est JAMAIS restitué au JavaScript — un XSS
    même-origine ne peut plus l'exfiltrer. Le champ session_token reste
    dans la réponse pour les clients non-navigateur (curl/tests) qui
    l'utilisent via l'en-tête X-Admin-Session."""
    _login_limiter.check(client_ip(request))

    expected_token = os.getenv("ADMIN_TOKEN", "")
    if not expected_token:
        log.error("ADMIN_TOKEN non configuré — connexion admin refusée")
        raise HTTPException(500, "ADMIN_TOKEN non configuré côté serveur")
    if is_prod() and expected_token == EXAMPLE_TOKEN:
        log.error("ADMIN_TOKEN vaut la valeur d'exemple en production — connexion refusée")
        raise HTTPException(500, "ADMIN_TOKEN d'exemple refusé en production")
    if not secrets.compare_digest(payload.token, expected_token):
        raise HTTPException(401, "Jeton invalide")

    allowed = admin_session.allowed_emails()
    email = payload.email.strip().lower()
    if not allowed:
        # Sans liste blanche, quiconque devine le jeton devient admin.
        # En dev on tolère (warning) ; en production c'est un refus franc.
        if is_prod():
            log.error("ADMIN_EMAILS vide en production — connexion admin refusée")
            raise HTTPException(500, "ADMIN_EMAILS non configuré côté serveur")
        log.warning("ADMIN_EMAILS vide — tout email valide avec le bon jeton est autorisé")
    elif email not in allowed:
        raise HTTPException(401, "Adresse e-mail non autorisée")

    lock, blocker = admin_session.attempt_login(db, email, force=payload.force)
    if blocker:
        raise HTTPException(409, detail=blocker)
    response.set_cookie(
        "admin_session",
        lock.token,
        httponly=True,
        samesite="strict",
        secure=is_prod(),
        path="/",
        max_age=int(admin_session.session_timeout().total_seconds()),
    )
    log_admin_event(db, None, "admin_login", email=email, details={"force": payload.force})
    return {"session_token": lock.token, "email": lock.email}


@router.post("/logout")
def admin_logout(
    response: Response,
    x_admin_session: str = Header(default=""),
    admin_session_cookie: str = Cookie(default=""),
    db: Session = Depends(get_db),
) -> dict:
    """Libère le verrou admin s'il correspond au jeton fourni et efface le
    cookie de session. Le jeton est lu dans le cookie httpOnly (chemin
    normal du navigateur) avec repli sur l'en-tête X-Admin-Session
    (curl / tests), l'ancien canal de transport."""
    token = x_admin_session or admin_session_cookie
    from ..db_models import AdminLockORM

    lock = db.query(AdminLockORM).filter(AdminLockORM.token == token).one_or_none()
    email = lock.email if lock else ""
    admin_session.logout(db, token)
    response.delete_cookie("admin_session", path="/")
    if lock:
        log_admin_event(db, None, "admin_logout", email=email)
    return {"ok": True}


@router.post("/heartbeat")
def admin_heartbeat(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Battement de cœur de la console admin : appelé périodiquement PAR LE
    FRONTEND tant que la page /admin est ouverte, il rafraîchit le verrou
    (`require_admin` touche déjà l'horodatage) — l'admin restant sur la
    console n'est JAMAIS déconnecté. La déconnexion automatique ne survient
    qu'après avoir QUITTÉ la page (onglet fermé ou navigation ailleurs) :
    les battements s'arrêtent et le verrou expire après
    ADMIN_SESSION_TIMEOUT_MINUTES (défaut 3)."""
    return {
        "ok": True,
        "timeout_minutes": admin_session.session_timeout().total_seconds() / 60,
    }


@router.get("/stats")
def admin_stats(db: Session = Depends(get_db), lock=Depends(require_admin)) -> dict:
    """Compteurs pour le tableau de bord admin (utilisateurs, abonnements
    actifs, revenu confirmé, épreuves par statut et par classe) + indicateurs
    enrichis : stockage objet (poids total, répartition documents/images),
    revenus des 6 derniers mois, consultations, notes, signalements ouverts
    et discussions IA. Calcul réparti en petits compteurs dédiés (lisibilité,
    même logique, mêmes requêtes)."""
    paiements = _admin_paiements_confirmes(db)
    revenus_par_mois, six_derniers = _admin_revenus_par_mois(paiements)
    stockage_par_format, nb_fichiers = _admin_stockage(db)
    return {
        "utilisateurs": _admin_nb_eleves(db),
        "abonnements_actifs": db.query(SubscriptionORM).filter(SubscriptionORM.statut == "active").count(),
        "revenu_total_fcfa": sum(p.montant for p in paiements),
        "epreuves_par_statut": _admin_epreuves_par_statut(db),
        "epreuves_par_classe": _admin_epreuves_par_classe(db),
        "stockage": {
            "total_octets": sum(stockage_par_format.values()),
            "par_format": stockage_par_format,
            "nb_fichiers": nb_fichiers,
        },
        "revenus_par_mois": {m: revenus_par_mois.get(m, 0) for m in six_derniers},
        "consultations": db.query(ConsultationORM).count(),
        "notes": db.query(NoteORM).count(),
        "discussions_ia": db.query(AIConversationORM).count(),
        "signalements_ouverts": db.query(SignalementORM).filter(SignalementORM.statut == "ouvert").count(),
    }


def _admin_paiements_confirmes(db: Session) -> list[PaymentORM]:
    return db.query(PaymentORM).filter(PaymentORM.statut == "confirmed").all()


def _admin_epreuves_par_classe(db: Session) -> dict:
    return dict(
        db.query(EpreuveORM.classe, func.count(EpreuveORM.id))
        .filter(EpreuveORM.statut == "publie")
        .group_by(EpreuveORM.classe)
        .all()
    )


def _admin_epreuves_par_statut(db: Session) -> dict:
    return {
        statut: db.query(EpreuveORM).filter(EpreuveORM.statut == statut).count()
        for statut in ("brouillon", "a_reviser", "publie")
    }


def _admin_nb_eleves(db: Session) -> int:
    """La métrique « Utilisateurs » ne compte que les élèves : les comptes
    dont l'email est dans la liste blanche admin sont exclus (un admin
    connecté en élève pour tester ne doit pas gonfler le compteur)."""
    admins = admin_session.allowed_emails()
    return (
        db.query(UserORM)
        .filter(~func.lower(UserORM.email).in_(list(admins) or [""]))
        .count()
        if admins
        else db.query(UserORM).count()
    )


def _admin_stockage(db: Session) -> tuple[dict, int]:
    """Stockage objet : somme des tailles connues en base, répartition par
    format + nombre de fichiers."""
    par_format = dict(
        db.query(EpreuveFileORM.format, func.coalesce(func.sum(EpreuveFileORM.size_bytes), 0))
        .group_by(EpreuveFileORM.format)
        .all()
    )
    return par_format, db.query(EpreuveFileORM.id).count()


def _admin_revenus_par_mois(paiements: list[PaymentORM]) -> tuple[dict[str, int], list[str]]:
    """Revenus agrégés par mois (clé "AAAA-MM"), calculés en Python — le
    volume de paiements reste faible à ce stade — ET la liste ordonnée des
    6 derniers mois calendaires (un mois vide vaut 0) : trier les seules
    clés présentes ferait disparaître d'un graphique un mois sans revenu et
    n'afficherait pas 6 points stables (corrigé 2026-09)."""
    revenus: dict[str, int] = {}
    for p in paiements:
        d = p.confirmed_at or p.created_at
        if d is None:
            continue
        cle = f"{d.year:04d}-{d.month:02d}"
        revenus[cle] = revenus.get(cle, 0) + p.montant
    six_derniers: list[str] = []
    now = utc_now()
    for i in range(5, -1, -1):
        y, m = (now.year, now.month - i) if now.month > i else (now.year - 1, now.month - i + 12)
        six_derniers.append(f"{y:04d}-{m:02d}")
    return revenus, six_derniers


@router.get("/events")
def admin_events(
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    """Journal d'audit : les actions admin tracées (login/logout, création,
    publication, suppression, import...), les plus récentes d'abord. Chaque
    entrée référençant une épreuve est enrichie de son résumé (matière,
    classe, année) pour un affichage lisible sans aller-retour, et
    `epreuve_id` reste cliquable côté UI (ouverture dans la section
    « Épreuves »)."""
    rows = (
        db.query(AdminEventORM)
        .order_by(AdminEventORM.created_at.desc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 300)))
        .all()
    )
    epreuve_ids = {r.epreuve_id for r in rows if r.epreuve_id}
    epreuves = {
        e.id: e
        for e in db.query(EpreuveORM).filter(EpreuveORM.id.in_(epreuve_ids or [""])).all()
    }
    out = []
    for r in rows:
        try:
            details = json.loads(r.details or "{}")
        except ValueError:
            details = {}
        e = epreuves.get(r.epreuve_id) if r.epreuve_id else None
        out.append(
            {
                "id": r.id,
                "action": r.action,
                "epreuve_id": r.epreuve_id,
                "email": r.email,
                "details": details,
                "created_at": r.created_at,
                # Résumé lisible de l'épreuve concernée (le détail complet de
                # l'action — champs modifiés, fichier supprimé... — est dans
                # `details`, rempli par les routes d'admin).
                "epreuve_resume": (
                    f"{e.matiere} — {e.classe} ({e.evaluation} {e.annee})" if e else ""
                ),
            }
        )
    return out


@router.get("/signalements")
def admin_list_signalements(
    statut: Optional[str] = None,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    """Signalements d'épreuves ouverts (ou résolus si `statut=resolu`),
    enrichis des infos d'épreuve et de l'auteur pour le back-office —
    épreuves et auteurs préchargés en deux requêtes `IN` (une paire de
    requêtes par ligne saturait à quelques centaines de signalements)."""
    query = db.query(SignalementORM)
    if statut in ("ouvert", "resolu"):
        query = query.filter(SignalementORM.statut == statut)
    rows = query.order_by(SignalementORM.created_at.desc()).limit(200).all()
    epreuve_ids = {s.epreuve_id for s in rows}
    user_ids = {s.user_id for s in rows}
    epreuves = {
        e.id: e
        for e in db.query(EpreuveORM).filter(EpreuveORM.id.in_(epreuve_ids or [""])).all()
    }
    users = {u.id: u for u in db.query(UserORM).filter(UserORM.id.in_(user_ids or [""])).all()}
    out = []
    for s in rows:
        e = epreuves.get(s.epreuve_id)
        u = users.get(s.user_id)
        out.append(
            {
                "id": s.id,
                "epreuve_id": s.epreuve_id,
                "motif": s.motif,
                "message": s.message,
                "statut": s.statut,
                "created_at": s.created_at,
                "resolved_at": s.resolved_at,
                "matiere": e.matiere if e else "",
                "annee": e.annee if e else "",
                "classe": e.classe if e else "",
                "auteur_email": u.email if u else "",
            }
        )
    return out


@router.post("/signalements/{signalement_id}/resoudre")
def admin_resoudre_signalement(
    signalement_id: str,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Marque un signalement comme résolu."""
    s = db.query(SignalementORM).filter(SignalementORM.id == signalement_id).one_or_none()
    if not s:
        raise HTTPException(404, "Signalement introuvable")
    s.statut = "resolu"
    s.resolved_at = utc_now()
    db.add(s)
    db.commit()
    log_admin_event(db, s.epreuve_id, "signalement_resolu", email=lock.email, details={"signalement_id": s.id})
    return {"ok": True}


# ---------- Utilisateurs (gouvernance RGPD) ----------

# Tables liant des données personnelles à un compte : purgées lors d'une
# suppression (droit à l'effacement). Les PAIEMENTS sont conservés mais
# anonymisés (user_id vidé côté applicatif impossible — colonne non nullable
# — donc l'utilisateur est supprimé APRÈS anonymisation de la référence).
# Aucun secret n'est de toute façon stocké dans ce système : connexion par
# Google/mock (pas de mot de passe), paiement simulé par référence — la
# table admin n'expose que des informations de compte et des compteurs.


def _compte_hors_admins(query):
    """Filtre une requête UserORM : exclut les emails de la liste blanche
    admin (la métrique et la table utilisateurs ne concernent que les
    élèves)."""
    admins = admin_session.allowed_emails()
    if not admins:
        return query
    return query.filter(~func.lower(UserORM.email).in_(list(admins)))


@router.get("/utilisateurs")
def admin_list_utilisateurs(
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> list[dict]:
    """Table utilisateurs du back-office : identité déclarée, profil, choix
    de consentement, statut de modération et compteurs d'usage par élève
    (notes, discussions IA, consultations, abonnements actifs, dépenses
    confirmées). Volontairement SANS aucune donnée secrète : les seuls
    identifiants de paiement sont des références d'agrégateur, jamais des
    codes — et il n'existe pas de mot de passe local."""
    users = _compte_hors_admins(db.query(UserORM)).order_by(UserORM.created_at.desc()).limit(500).all()
    ids = [u.id for u in users]
    notes = _admin_comptes_par_user(db, NoteORM, ids)
    convs = _admin_comptes_par_user(db, AIConversationORM, ids)
    consults = _admin_comptes_par_user(db, ConsultationORM, ids)
    subs_actifs = _admin_comptes_par_user(db, SubscriptionORM, ids, SubscriptionORM.statut == "active")
    depenses = _admin_depenses_par_user(db, ids)
    sessions = _admin_derniere_connexion_par_user(db, ids)
    return [_admin_utilisateur_out(u, notes, convs, consults, subs_actifs, depenses, sessions) for u in users]


def _admin_comptes_par_user(db: Session, model, ids: list, extra=None) -> dict[str, int]:
    """Nombre de lignes `model` par user_id (hors admins) pour le top-500,
    avec filtre optionnel (ex. abonnements actifs)."""
    q = db.query(model.user_id, func.count(model.id))
    if extra is not None:
        q = q.filter(extra)
    grouped = q.filter(model.user_id.in_(ids or [""])).group_by(model.user_id).all() if ids else []
    return dict(grouped)


def _admin_depenses_par_user(db: Session, ids: list) -> dict[str, int]:
    """Somme des paiements confirmés par utilisateur — même logique que
    `ProfilePage.total_depense_fcfa` mais sur tout le tank admin."""
    if not ids:
        return {}
    return {
        r[0]: r[1]
        for r in db.query(PaymentORM.user_id, func.coalesce(func.sum(PaymentORM.montant), 0))
        .filter(PaymentORM.user_id.in_(ids), PaymentORM.statut == "confirmed")
        .group_by(PaymentORM.user_id)
        .all()
    }


def _admin_derniere_connexion_par_user(db: Session, ids: list) -> dict[str, object]:
    """Horodatage de la dernière session (issued_at) — utilisée en repli
    pour `derniere_connexion` si la colonne persistante est vide."""
    if not ids:
        return {}
    return {
        r[0]: r[1]
        for r in db.query(SessionORM.user_id, func.max(SessionORM.issued_at))
        .filter(SessionORM.user_id.in_(ids))
        .group_by(SessionORM.user_id)
        .all()
    }


def _admin_utilisateur_out(u, notes, convs, consults, subs_actifs, depenses, sessions) -> dict:
    """Formate une ligne utilisateur pour le tableau du back-office."""
    return {
        "id": u.id,
        "nom": u.nom,
        "email": u.email,
        "niveau": u.niveau,
        "classe": u.classe,
        "etablissement": u.etablissement,
        "consent_ia": u.consent_ia,
        "consent_notes": u.consent_notes,
        "banni": u.banni,
        "banni_motif": u.banni_motif,
        "created_at": u.created_at,
        # Horodatage persistant posé à chaque login (survit à la
        # déconnexion — la table `sessions`, elle, est purgée) ;
        # repli sur la session courante pour les comptes antérieurs.
        "derniere_connexion": u.derniere_connexion or sessions.get(u.id),
        "notes": notes.get(u.id, 0),
        "discussions_ia": convs.get(u.id, 0),
        "consultations": consults.get(u.id, 0),
        "abonnements_actifs": subs_actifs.get(u.id, 0),
        "total_depense_fcfa": depenses.get(u.id, 0),
    }


@router.post("/utilisateurs/{user_id}/bannir")
async def admin_bannir_utilisateur(
    user_id: str,
    payload: BannirIn,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Bannit un élève : toute session existante est supprimée (kick-out
    WebSocket immédiat) et tout nouveau login est refusé (403). Le motif
    est conservé pour le journal d'audit."""
    u = db.query(UserORM).filter(UserORM.id == user_id).one_or_none()
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if u.email.lower() in admin_session.allowed_emails():
        raise HTTPException(400, "Un compte admin (liste blanche) ne peut pas être banni")
    u.banni = True
    u.banni_motif = payload.motif.strip() or None
    db.add(u)
    sess = db.query(SessionORM).filter(SessionORM.user_id == u.id).one_or_none()
    if sess:
        await store.notify_kickout(db, u.id, "Ton compte a été suspendu par l'équipe — contacte-nous si tu penses que c'est une erreur.")
        db.delete(sess)
    db.commit()
    log_admin_event(
        db, None, "utilisateur_banni", email=lock.email,
        details={"user_id": u.id, "email": u.email, "motif": u.banni_motif or ""},
    )
    return {"ok": True}


@router.post("/utilisateurs/{user_id}/debannir")
def admin_debannir_utilisateur(
    user_id: str,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Lève le bannissement : l'élève peut se reconnecter normalement."""
    u = db.query(UserORM).filter(UserORM.id == user_id).one_or_none()
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    u.banni = False
    u.banni_motif = None
    db.add(u)
    db.commit()
    log_admin_event(db, None, "utilisateur_debanni", email=lock.email, details={"user_id": u.id, "email": u.email})
    return {"ok": True}


@router.delete("/utilisateurs/{user_id}")
def admin_supprimer_utilisateur(
    user_id: str,
    db: Session = Depends(get_db),
    lock=Depends(require_admin),
) -> dict:
    """Supprime un élève et toutes ses données personnelles (droit à
    l'effacement) : sessions, notes, discussions IA, consultations,
    abonnements, signalements, paiements. Les revenus confirmés disparaissent
    du total (cohérence : plus de rattachement possible) — l'action est
    tracée au journal avec l'email supprimé."""
    u = db.query(UserORM).filter(UserORM.id == user_id).one_or_none()
    if not u:
        raise HTTPException(404, "Utilisateur introuvable")
    if u.email.lower() in admin_session.allowed_emails():
        raise HTTPException(400, "Un compte admin (liste blanche) ne peut pas être supprimé depuis cette interface")
    details = {"user_id": u.id, "email": u.email, "nom": u.nom}
    db.query(SessionORM).filter(SessionORM.user_id == u.id).delete()
    db.query(KickoutNoticeORM).filter(KickoutNoticeORM.user_id == u.id).delete()
    db.query(NoteORM).filter(NoteORM.user_id == u.id).delete()
    db.query(AIConversationORM).filter(AIConversationORM.user_id == u.id).delete()
    db.query(ConsultationORM).filter(ConsultationORM.user_id == u.id).delete()
    # Ordre important : les paiements référencent les abonnements
    # (payments.subscription_id → subscriptions.id, FK RESTRICT) — il faut
    # donc purger les paiements AVANT les abonnements, sinon le DELETE des
    # abonnements échoue en FOREIGN KEY constraint failed.
    db.query(PaymentORM).filter(PaymentORM.user_id == u.id).delete()
    db.query(SubscriptionORM).filter(SubscriptionORM.user_id == u.id).delete()
    db.query(SignalementORM).filter(SignalementORM.user_id == u.id).delete()
    db.delete(u)
    db.commit()
    log_admin_event(db, None, "utilisateur_supprime", email=lock.email, details=details)
    return {"ok": True}
