from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, false as sql_false
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.assistant_context import contexte_verifie
from ..core.textsearch import contient
from ..core import epreuve_files, referentiel, signing, store
from ..core.logging_config import get_logger
from ..db import get_db
from ..db_models import (
    EpreuveFiliereORM,
    EpreuveFileORM,
    EpreuveORM,
    NoteORM,
    SignalementORM,
    SubscriptionORM,
)
from ..models import (
    ConversationCreateIn,
    ConversationOut,
    ConversationUpdateIn,
    EpreuveDetail,
    EpreuveFileOut,
    EpreuveListItem,
    NoteIn,
    NoteOut,
    SignalementIn,
    SujetOut,
)
from .auth import optional_user, require_user
from .deps import get_public_epreuve_or_404

router = APIRouter(prefix="/api/epreuves", tags=["epreuves"])
log = get_logger("epreuves")


def _to_list_item(e: EpreuveORM, covered_ids: set[str] | None = None) -> EpreuveListItem:
    """Projette une épreuve ORM vers le schéma de liste (sans le contenu,
    chargé séparément depuis le stockage pour un catalogue léger).
    Si `covered_ids` est fourni, calcule le champ `acces` côté serveur."""
    if e.gratuit:
        acces = "gratuit"
    elif covered_ids is not None and e.id in covered_ids:
        acces = "ouvert"
    else:
        acces = "payant"
    return EpreuveListItem(
        id=e.id,
        niveau=e.niveau,
        classe=e.classe,
        evaluation=e.evaluation,
        matiere=e.matiere,
        annee=e.annee,
        duree=e.duree,
        coefficient=e.coefficient,
        extrait=e.extrait or "",
        gratuit=e.gratuit,
        statut=e.statut,
        filieres=e.filieres,
        corrige_disponible=e.corrige_disponible,
        acces=acces,
    )


def _covered_epreuve_ids(db: Session, user_id: str):
    """Sous-requête des ids d'épreuves PAYANTES couvertes par un abonnement
    actif de cet utilisateur — dérive de la règle unique
    `store.covered_epreuves_condition` (miroir de `has_access`). Permet de
    filtrer "Ouvert"/"Payant" AVANT la pagination serveur (bug corrigé :
    le filtrage se faisait côté client APRÈS pagination, une page pouvait
    afficher moins de cartes que demandé)."""
    return (
        db.query(EpreuveORM.id)
        .join(SubscriptionORM, store.covered_epreuves_condition(db, user_id))
        .filter(EpreuveORM.gratuit.is_(False))
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
    user_id: Optional[str] = None,
):
    """Applique les filtres combinables du catalogue (série via jointure
    many-to-many, matière, année, évaluation, présence d'un corrigé, accès
    gratuit/payant/ouvert) à une requête épreuves existantes. "Ouvert"
    (payante déjà couverte par un abonnement actif) et "Payant" (payante
    non couverte) nécessitent l'utilisateur courant — sans session, les
    deux se ramènent respectivement à « aucune » / « toutes payantes »."""
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
    if acces_type in ("gratuit", "ouvert", "payant"):
        query = query.filter(EpreuveORM.gratuit.is_(acces_type == "gratuit"))
    if acces_type == "ouvert":
        if user_id:
            query = query.filter(EpreuveORM.id.in_(_covered_epreuve_ids(db, user_id)))
        else:
            # Pas de session : aucune épreuve payante n'est "ouverte".
            query = query.filter(sql_false())
    elif acces_type == "payant" and user_id:
        query = query.filter(~EpreuveORM.id.in_(_covered_epreuve_ids(db, user_id)))
    return query.distinct()


def _search_filter(db: Session, query, q: str):
    """Recherche texte GLOBALE : porte sur la matière, l'évaluation et les
    séries, et NE filtre PAS par classe (l'utilisateur doit pouvoir chercher
    dans tout le catalogue, cf. prompt d'amélioration §3)."""
    serie_subquery = db.query(EpreuveFiliereORM.epreuve_id).filter(contient(EpreuveFiliereORM.filiere, q))
    return query.filter(
        contient(EpreuveORM.matiere, q)
        | contient(EpreuveORM.evaluation, q)
        | EpreuveORM.id.in_(serie_subquery)
    )


@router.get("/navigation")
def navigation(db: Session = Depends(get_db)) -> dict:
    """Arborescence de navigation Accueil → Niveau → Classe : les niveaux
    connus du référentiel avec, pour chaque niveau, la liste des classes et
    le nombre d'épreuves PUBLIÉES de chacune — le frontend désactive les
    cartes de classe sans épreuve (prompt d'amélioration §3)."""
    rows = (
        db.query(EpreuveORM.niveau, EpreuveORM.classe, func.count(EpreuveORM.id))
        .filter(EpreuveORM.statut == "publie")
        .group_by(EpreuveORM.niveau, EpreuveORM.classe)
        .all()
    )
    counts = {(niveau, classe): total for niveau, classe, total in rows}
    niveaux = []
    for niveau in referentiel.NIVEAUX:
        # Chaque niveau ne montre QUE ses propres classes (PRIMAIRE n'en a
        # aucune dans le référentiel) — sinon le comptage du secondaire
        # serait affiché sur toutes les cartes de niveau.
        classes_du_niveau = (
            referentiel.CLASSES_SECONDAIRE if niveau["code"] == referentiel.NIVEAU_SECONDAIRE else []
        )
        classes = []
        for entry in classes_du_niveau:
            code = entry["code"]
            count = counts.get((niveau["code"], code), 0)
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
    limit: int = Query(default=24, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user=Depends(optional_user),
) -> list[EpreuveListItem]:
    """Catalogue filtré (page Catalogue), paginé (`limit`/`offset`, défaut
    24 par page). `classe` cadre la navigation (Accueil → Classe →
    catalogue) ; `q` est au contraire une recherche GLOBALE qui ignore la
    classe courante. Ne retourne que les épreuves publiées, triées par
    année décroissante puis matière. La route est PUBLIQUE mais accepte une
    session élève : le filtre `acces_type="ouvert"|"payant"` en a besoin
    pour distinguer les épreuves payantes couvertes par un abonnement actif
    (résolu côté serveur, AVANT pagination)."""
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
        user_id=user.id if user else None,
    )
    if q:
        query = _search_filter(db, query, q)
    elif classe:
        query = query.filter(EpreuveORM.classe == classe)
    epreuves = (
        query.order_by(EpreuveORM.annee.desc(), EpreuveORM.matiere.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    # Précalculer les ids couverts par un abonnement actif (UNE seule
    # requête) pour alimenter le champ `acces` côté serveur.
    covered_ids: set[str] | None = None
    if user:
        covered_ids = {row[0] for row in _covered_epreuve_ids(db, user.id).all()}
    return [_to_list_item(e, covered_ids) for e in epreuves]


@router.get("/matieres")
def get_matieres(
    classe: Optional[str] = None,
    filiere: Optional[str] = None,
    evaluation: Optional[str] = None,
    annee: Optional[str] = None,
    db: Session = Depends(get_db),
) -> list[dict]:
    """Matières avec leur nombre d'épreuves publiées (et de gratuites) dans le
    cadre courant — alimente les tuiles du catalogue (une matière = une tuile,
    au lieu d'une liste dominée par une seule matière sur plusieurs années)."""
    q = db.query(
        EpreuveORM.matiere,
        func.count(func.distinct(EpreuveORM.id)),
        func.count(func.distinct(case((EpreuveORM.gratuit.is_(True), EpreuveORM.id)))),
    ).filter(EpreuveORM.statut == "publie")
    if classe:
        q = q.filter(EpreuveORM.classe == classe)
    if evaluation:
        q = q.filter(EpreuveORM.evaluation == evaluation)
    if annee:
        q = q.filter(EpreuveORM.annee == annee)
    if filiere:
        q = q.join(EpreuveFiliereORM, EpreuveFiliereORM.epreuve_id == EpreuveORM.id).filter(
            EpreuveFiliereORM.filiere == filiere
        )
    rows = q.group_by(EpreuveORM.matiere).order_by(EpreuveORM.matiere).all()
    return [{"matiere": m, "total": t, "gratuits": g} for m, t, g in rows if m]


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
    user=Depends(optional_user),
) -> EpreuveDetail:
    """Détail d'une épreuve : métadonnées + contenu Markdown chargé depuis
    le stockage objet (sujet ET corrigé dans la même réponse) + images
    d'illustration (URLs d'accès contrôlé `/api/files/{id}`).

    MODE VISITEUR (sans session) : les épreuves GRATUITES sont consultables
    par tous (vitrine freemium) — aucune consultation n'est alors
    enregistrée, l'historique restant une fonctionnalité des comptes. Une
    épreuve payante exige une connexion (401, distinct du 403 « abonnement
    requis » d'un utilisateur connecté non couvert)."""
    e = db.query(EpreuveORM).filter(EpreuveORM.id == epreuve_id).one_or_none()
    if not e or e.statut != "publie":
        raise HTTPException(404, "Épreuve introuvable")
    if user is None:
        if not store.is_gratuit(e):
            raise HTTPException(401, "Connecte-toi pour consulter cette épreuve payante")
    else:
        if not store.has_access(db, user.id, e):
            raise HTTPException(403, "Accès non autorisé — un abonnement est requis")
        store.record_consultation(db, user.id, epreuve_id)

    # Tableau des sujets : un par index ayant au moins un document (sujet
    # ou corrigé) — chaque sujet porte son corrigé optionnel. L'index 0 est
    # aussi exposé à plat (rétrocompatibilité).
    indices = sorted({f.sujet_index for f in e.files_rel if f.format == "md"})
    if not indices:
        indices = [0]
    sujets = [
        SujetOut(
            index=idx,
            contenu_markdown=epreuve_files.sign_image_urls(
                epreuve_files.read_document_content(db, e.id, "sujet", idx), e,
            ),
            corrige_markdown=epreuve_files.sign_image_urls(
                epreuve_files.read_document_content(db, e.id, "corrige", idx), e,
            ),
            corrige_disponible=epreuve_files.get_document(db, e.id, "corrige", idx) is not None,
        )
        for idx in indices
    ]
    sujet0 = sujets[0] if sujets else None

    return EpreuveDetail(
        **_to_list_item(e, {e.id} if user and store.has_access(db, user.id, e) else None).model_dump(),
        contenu_markdown=sujet0.contenu_markdown if sujet0 else "",
        corrige_markdown=sujet0.corrige_markdown if sujet0 else "",
        sujets=sujets,
        nb_sujets=e.nb_sujets,
        assets=[
            EpreuveFileOut(
                id=f.id,
                cible=f.cible,
                format=f.format,
                filename=f.filename,
                url=signing.signed_file_url(f.id, e.id, e.statut),
                size_bytes=f.size_bytes,
                width=f.width,
                height=f.height,
                mime_type=f.mime_type,
            )
            for f in e.images
        ],
    )


# ---------- Conversations ----------

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
    atteint. Garde serveur du consentement : un utilisateur ayant REFUSÉ le
    stockage de ses conversations IA (consent_ia=False) n'en a aucune
    persistée — 403 (le frontend fonctionne alors en mode éphémère)."""
    if user.consent_ia is False:
        raise HTTPException(403, "Tu as refusé le stockage de tes conversations IA — révoque ou modifie ton choix dans ton profil.")
    epreuve = get_public_epreuve_or_404(db, epreuve_id, user)
    try:
        conv = store.create_conversation(
            db, user.id, epreuve_id, contexte_verifie(db, epreuve, payload.contexte), payload.label
        )
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


@router.get("/{epreuve_id}/conversations/{conv_id}", response_model=ConversationOut)
def get_conversation(
    epreuve_id: str, conv_id: str, db: Session = Depends(get_db), user=Depends(require_user)
) -> ConversationOut:
    """Récupère une discussion appartenant à cet utilisateur/épreuve, ou
    lève 404. Utilisé par le lecteur (AssistantPanel) pour la réconciliation
    avant chaque tentative de streaming : rejouer la MÊME question exige de
    ramener les messages serveur à l'état d'avant — sans cette route, le GET
    renvoyait un 404 « ressource introuvable » que le front interprétait à
    tort comme une discussion fermée. Aucune garde d'épreuve ici (comme PUT/
    DELETE) : une épreuve retirée laisse la discussion LISIBLE par son
    propriétaire, et c'est la route d'interrogation LLM qui lève le 403
    explicite (voir `_load_conversation_and_epreuve`, assistant.py)."""
    conv = _get_conversation_or_404(db, user.id, epreuve_id, conv_id)
    return ConversationOut(**store.conversation_to_dict(conv))


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
    contexte = payload.contexte
    epreuve = db.get(EpreuveORM, epreuve_id)
    if contexte is not None and epreuve is not None:  # épreuve retirée : on ne touche à rien
        contexte = contexte_verifie(db, epreuve, contexte)
    conv = store.update_conversation(db, conv, payload.messages, payload.label, contexte)
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


# ---------- Notes & signalements ----------

MOTIFS_SIGNALEMENT = (
    "contenu_illisible",
    "erreur_enonce",
    "corrige_manquant",
    "image_cassee",
    "autre",
)


@router.post("/{epreuve_id}/notes")
def create_note(
    epreuve_id: str,
    payload: NoteIn,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> NoteOut:
    """Crée une note personnelle de l'utilisateur sur cette épreuve (rédaction
    manuelle ou réponse de l'assistant sauvegardée). Garde serveur du
    consentement : un utilisateur ayant REFUSÉ le stockage de ses notes
    (consent_notes=False) ne peut pas en créer — 403."""
    if user.consent_notes is False:
        raise HTTPException(403, "Tu as refusé le stockage de tes notes — révoque ou modifie ton choix dans ton profil.")
    e = get_public_epreuve_or_404(db, epreuve_id, user)
    note = NoteORM(
        user_id=user.id,
        epreuve_id=e.id,
        cible=payload.cible if payload.cible in ("sujet", "corrige") else "sujet",
        contexte_extrait=payload.contexte_extrait,
        contenu=payload.contenu,
    )
    db.add(note)
    db.commit()
    return NoteOut(
        id=note.id,
        epreuve_id=note.epreuve_id,
        cible=note.cible,
        contexte_extrait=note.contexte_extrait,
        contenu=note.contenu,
        created_at=note.created_at,
        updated_at=note.updated_at,
    )


@router.post("/{epreuve_id}/signalements")
def create_signalement(
    epreuve_id: str,
    payload: SignalementIn,
    db: Session = Depends(get_db),
    user=Depends(require_user),
) -> dict:
    """Signale un problème sur cette épreuve (contenu illisible, erreur
    d'énoncé, corrigé manquant, image cassée, autre). Un même utilisateur ne
    peut pas ouvrir deux fois le même motif sur la même épreuve (409)."""
    get_public_epreuve_or_404(db, epreuve_id, user)
    if payload.motif not in MOTIFS_SIGNALEMENT:
        raise HTTPException(400, "Motif de signalement inconnu")
    doublon = (
        db.query(SignalementORM)
        .filter(
            SignalementORM.user_id == user.id,
            SignalementORM.epreuve_id == epreuve_id,
            SignalementORM.motif == payload.motif,
            SignalementORM.statut == "ouvert",
        )
        .one_or_none()
    )
    if doublon:
        raise HTTPException(409, "Tu as déjà signalé ce problème sur cette épreuve — il est en attente de traitement.")
    row = SignalementORM(
        user_id=user.id,
        epreuve_id=epreuve_id,
        motif=payload.motif,
        message=payload.message,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "id": row.id}
