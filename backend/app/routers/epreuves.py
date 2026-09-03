from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core import epreuve_files, referentiel, signing, store
from ..core.logging_config import get_logger
from ..db import get_db
from ..db_models import EpreuveFiliereORM, EpreuveFileORM, EpreuveORM
from ..models import (
    ConversationCreateIn,
    ConversationOut,
    ConversationUpdateIn,
    EpreuveDetail,
    EpreuveFileOut,
    EpreuveListItem,
)
from .auth import require_user

router = APIRouter(prefix="/api/epreuves", tags=["epreuves"])
log = get_logger("epreuves")


def _to_list_item(e: EpreuveORM) -> EpreuveListItem:
    """Projette une épreuve ORM vers le schéma de liste (sans le contenu,
    chargé séparément depuis le stockage pour un catalogue léger)."""
    return EpreuveListItem(
        id=e.id,
        niveau=e.niveau,
        classe=e.classe,
        evaluation=e.evaluation,
        matiere=e.matiere,
        annee=e.annee,
        session=e.session,
        duree=e.duree,
        coefficient=e.coefficient,
        gratuit=e.gratuit,
        statut=e.statut,
        filieres=e.filieres,
        corrige_disponible=e.corrige_disponible,
    )


def _apply_filters(
    db: Session,
    query,
    filiere: Optional[str],
    matiere: Optional[str],
    annee: Optional[str],
    evaluation: Optional[str],
    q: Optional[str],
    corrige: Optional[str],
    acces_type: Optional[str],
):
    """Applique les filtres combinables du catalogue (série via jointure
    many-to-many, matière, année, évaluation, présence d'un corrigé, accès
    gratuit/payant) à une requête épreuves existante."""
    query = query.filter(EpreuveORM.statut == "publie")
    if filiere:
        query = query.join(EpreuveFiliereORM, EpreuveFiliereORM.epreuve_id == EpreuveORM.id).filter(
            EpreuveFiliereORM.filiere == filiere
        )
    if matiere:
        query = query.filter(EpreuveORM.matiere == matiere)
    if annee:
        query = query.filter(EpreuveORM.annee == annee)
    if evaluation:
        query = query.filter(EpreuveORM.evaluation == evaluation)
    if corrige == "avec":
        query = query.join(
            EpreuveFileORM,
            (EpreuveFileORM.epreuve_id == EpreuveORM.id)
            & (EpreuveFileORM.cible == "corrige")
            & (EpreuveFileORM.format == "md"),
        )
    elif corrige == "sans":
        corrige_subquery = db.query(EpreuveFileORM.epreuve_id).filter(
            EpreuveFileORM.cible == "corrige",
            EpreuveFileORM.format == "md",
        )
        query = query.filter(~EpreuveORM.id.in_(corrige_subquery))
    if acces_type == "gratuit":
        query = query.filter(EpreuveORM.gratuit.is_(True))
    elif acces_type == "payant":
        query = query.filter(EpreuveORM.gratuit.is_(False))
    return query.distinct()


def _search_filter(db: Session, query, q: str):
    """Recherche texte GLOBALE : porte sur la matière, l'évaluation et les
    séries, et NE filtre PAS par classe (l'utilisateur doit pouvoir chercher
    dans tout le catalogue, cf. prompt d'amélioration §3)."""
    like = f"%{q}%"
    serie_subquery = db.query(EpreuveFiliereORM.epreuve_id).filter(EpreuveFiliereORM.filiere.ilike(like))
    return query.filter(
        EpreuveORM.matiere.ilike(like)
        | EpreuveORM.evaluation.ilike(like)
        | EpreuveORM.id.in_(serie_subquery)
    )


@router.get("/navigation")
def navigation(db: Session = Depends(get_db)) -> dict:
    """Arborescence de navigation Accueil → Niveau → Classe : les niveaux
    connus du référentiel avec, pour chaque niveau, la liste des classes et
    le nombre d'épreuves PUBLIÉES de chacune — le frontend désactive les
    cartes de classe sans épreuve (prompt d'amélioration §3)."""
    counts = dict(
        db.query(EpreuveORM.classe, func.count(EpreuveORM.id))
        .filter(
            EpreuveORM.statut == "publie",
            EpreuveORM.niveau == referentiel.NIVEAU_SECONDAIRE,
        )
        .group_by(EpreuveORM.classe)
        .all()
    )
    niveaux = []
    for niveau in referentiel.NIVEAUX:
        classes = []
        for entry in referentiel.CLASSES_SECONDAIRE:
            code = entry["code"]
            count = counts.get(code, 0)
            classes.append(
                {
                    "code": code,
                    "label": entry["label"],
                    "epreuves": count,
                    "actif": count > 0,
                }
            )
        niveaux.append(
            {"code": niveau["code"], "label": niveau["label"], "actif": niveau["actif"], "classes": classes}
        )
    return {"niveaux": niveaux}


@router.get("", response_model=list[EpreuveListItem])
def list_epreuves(
    classe: Optional[str] = None,
    filiere: Optional[str] = None,
    matiere: Optional[str] = None,
    annee: Optional[str] = None,
    evaluation: Optional[str] = None,
    q: Optional[str] = None,
    corrige: Optional[str] = None,
    acces_type: Optional[str] = None,
    limit: int = 24,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> list[EpreuveListItem]:
    """Catalogue filtré (page Catalogue), paginé (`limit`/`offset`, défaut
    24 par page). `classe` cadre la navigation (Accueil → Classe →
    catalogue) ; `q` est au contraire une recherche GLOBALE qui ignore la
    classe courante. Ne retourne que les épreuves publiées, triées par
    année décroissante puis matière."""
    query = _apply_filters(
        db,
        db.query(EpreuveORM),
        filiere,
        matiere,
        annee,
        evaluation,
        None,
        corrige,
        acces_type,
    )
    if q:
        query = _search_filter(db, query, q)
    elif classe:
        query = query.filter(EpreuveORM.classe == classe)
    epreuves = (
        query.order_by(EpreuveORM.annee.desc(), EpreuveORM.matiere.asc())
        .offset(max(0, offset))
        .limit(max(1, min(limit, 100)))
        .all()
    )
    return [_to_list_item(e) for e in epreuves]


@router.get("/filtres")
def get_filtres(
    classe: Optional[str] = None,
    evaluation: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """Valeurs DISTINCTES (séries, matières, années, évaluations)
    disponibles parmi les épreuves publiées, calculées en SQL (GROUP BY) —
    alimente les menus déroulants du catalogue. `classe`/`evaluation`
    scopent les valeurs au contexte de navigation courant (filtres
    dynamiques)."""
    base = db.query(EpreuveORM).filter(EpreuveORM.statut == "publie")
    if classe:
        base = base.filter(EpreuveORM.classe == classe)
    if evaluation:
        base = base.filter(EpreuveORM.evaluation == evaluation)

    ids = base.with_entities(EpreuveORM.id).subquery()
    filieres = [
        row[0]
        for row in db.query(EpreuveFiliereORM.filiere)
        .filter(EpreuveFiliereORM.epreuve_id.in_(ids))
        .distinct()
        .order_by(EpreuveFiliereORM.filiere)
        .all()
    ]
    matieres = [
        row[0] for row in base.with_entities(EpreuveORM.matiere).distinct().order_by(EpreuveORM.matiere).all() if row[0]
    ]
    annees = [row[0] for row in base.with_entities(EpreuveORM.annee).distinct().order_by(EpreuveORM.annee.desc()).all() if row[0]]
    evaluations = [
        row[0] for row in base.with_entities(EpreuveORM.evaluation).distinct().order_by(EpreuveORM.evaluation).all() if row[0]
    ]
    return {
        "filieres": filieres,
        "matieres": matieres,
        "annees": annees,
        "evaluations": evaluations,
    }


@router.get("/count")
def count_epreuves(
    classe: Optional[str] = None,
    filiere: Optional[str] = None,
    matiere: Optional[str] = None,
    annee: Optional[str] = None,
    epreuve_id: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """Nombre d'épreuves publiées correspondant à une combinaison de
    filtres — utilisé par la page Abonnement pour afficher "N épreuves
    couvertes" en temps réel au fil de la sélection (dans le cadre de la
    classe choisie)."""
    count = store.matching_epreuves_count(
        db,
        classe=classe,
        filiere=filiere,
        matiere=matiere,
        annee=annee,
        epreuve_id=epreuve_id,
    )
    return {"count": count}


@router.get("/{epreuve_id}", response_model=EpreuveDetail)
def get_epreuve(
    epreuve_id: str,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> EpreuveDetail:
    """Détail d'une épreuve : métadonnées + contenu Markdown chargé depuis
    le stockage objet (sujet ET corrigé dans la même réponse) + images
    d'illustration (URLs d'accès contrôlé `/api/files/{id}`). Vérifie
    l'accès (gratuit ou abonnement actif couvrant) et enregistre la
    consultation dans l'historique."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e or e.statut != "publie":
        raise HTTPException(404, "Épreuve introuvable")
    if not store.has_access(db, user.id, e):
        raise HTTPException(403, "Accès non autorisé — un abonnement est requis")

    store.record_consultation(db, user.id, epreuve_id)

    return EpreuveDetail(
        **_to_list_item(e).model_dump(),
        contenu_markdown=epreuve_files.sign_image_urls(
            epreuve_files.read_document_content(db, e.id, "sujet")
        ),
        corrige_markdown=epreuve_files.sign_image_urls(
            epreuve_files.read_document_content(db, e.id, "corrige")
        ),
        assets=[
            EpreuveFileOut(
                id=f.id,
                cible=f.cible,
                format=f.format,
                filename=f.filename,
                url=signing.signed_file_url(f.id),
            )
            for f in e.images
        ],
    )


# ---------- Conversations ----------

def _get_epreuve_or_404(db: Session, epreuve_id: str) -> EpreuveORM:
    """Récupère une épreuve par id ou lève 404."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e:
        raise HTTPException(404, "Épreuve introuvable")
    return e


@router.get("/{epreuve_id}/conversations", response_model=list[ConversationOut])
def list_conversations(
    epreuve_id: str, db: Session = Depends(get_db), user=Depends(require_user)
) -> list[ConversationOut]:
    """Discussions de l'utilisateur courant sur cette épreuve (tous les
    onglets ouverts dans le panneau assistant)."""
    convs = store.list_conversations(db, user.id, epreuve_id)
    return [ConversationOut(**store.conversation_to_dict(c)) for c in convs]


@router.post("/{epreuve_id}/conversations", response_model=ConversationOut)
def create_conversation(
    epreuve_id: str,
    payload: ConversationCreateIn,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> ConversationOut:
    """Crée une nouvelle discussion (onglet) sur cette épreuve — 409 si le
    plafond de 5 discussions actives par (utilisateur, épreuve) est déjà
    atteint."""
    _get_epreuve_or_404(db, epreuve_id)
    try:
        conv = store.create_conversation(db, user.id, epreuve_id, payload.contexte, payload.label)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return ConversationOut(**store.conversation_to_dict(conv))


def _get_conversation_or_404(db: Session, user_id: str, epreuve_id: str, conv_id: str):
    """Récupère une discussion appartenant à cet utilisateur/épreuve, ou
    lève 404 (empêche d'accéder à la discussion d'un autre utilisateur)."""
    from ..db_models import AIConversationORM

    conv = (
        db.query(AIConversationORM)
        .filter(
            AIConversationORM.id == conv_id,
            AIConversationORM.user_id == user_id,
            AIConversationORM.epreuve_id == epreuve_id,
        )
        .one_or_none()
    )
    if not conv:
        raise HTTPException(404, "Discussion introuvable")
    return conv


@router.put("/{epreuve_id}/conversations/{conv_id}", response_model=ConversationOut)
def update_conversation(
    epreuve_id: str,
    conv_id: str,
    payload: ConversationUpdateIn,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> ConversationOut:
    """Remplace les messages d'une discussion (après un aller-retour avec
    l'assistant), et optionnellement son libellé d'onglet et/ou son
    contexte (voir docstring de `store.update_conversation`)."""
    conv = _get_conversation_or_404(db, user.id, epreuve_id, conv_id)
    conv = store.update_conversation(db, conv, payload.messages, payload.label, payload.contexte)
    return ConversationOut(**store.conversation_to_dict(conv))


@router.delete("/{epreuve_id}/conversations/{conv_id}")
def delete_conversation(
    epreuve_id: str, conv_id: str, db: Session = Depends(get_db), user=Depends(require_user)
) -> dict:
    """Ferme (supprime) une discussion — libère une place dans le plafond
    de 5 discussions actives par épreuve."""
    conv = _get_conversation_or_404(db, user.id, epreuve_id, conv_id)
    store.delete_conversation(db, conv)
    return {"ok": True}
