from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, Response
from sqlalchemy.orm import Session

from ..core import store
from ..core.logging_config import get_logger
from ..core.signing import verify_file_token
from ..core.storage import StorageError, get_storage, presigned_url_or_none
from ..db import get_db
from ..db_models import EpreuveFileORM, EpreuveORM
from .auth import optional_user

router = APIRouter(prefix="/api/files", tags=["files"])
log = get_logger("files")

_UNSAFE_IN_FILENAME = re.compile(r"[^A-Za-z0-9._-]")


def safe_filename(name: str | None, fallback: str) -> str:
    """Nom de fichier réduit à un alphabet sûr pour un en-tête HTTP.

    Le nom est stocké en base et réinjecté dans ``Content-Disposition`` : sans
    filtrage, un guillemet ou un CR/LF dans le nom allowait de casser
    l'en-tête. On ne garde que le nom de base (les séparateurs de chemin sont
    donc exclus par construction).
    """
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = _UNSAFE_IN_FILENAME.sub("_", base).strip("._")
    return cleaned[:120] or fallback


def _load_file_or_404(db: Session, file_id: str) -> EpreuveFileORM:
    f = db.query(EpreuveFileORM).filter(EpreuveFileORM.id == file_id).one_or_none()
    if not f:
        raise HTTPException(404, "Fichier introuvable")
    return f


@router.get("/{file_id}")
def get_file(
    file_id: str,
    token: str = Query(default=""),
    db: Session = Depends(get_db),
    user=Depends(optional_user),
):
    """Accès contrôlé à un fichier d'épreuve (document Markdown ou image).

    Deux voies d'accès, reflétant le modèle « URL signée temporaire » de
    l'architecture technique :

    - jeton valide (``?token=``) : URL générée par le backend à la lecture
      du détail d'épreuve, APRÈS vérification des droits — pas besoin de
      session ici (les balises ``<img>`` cross-origin ne transportent pas
      le cookie) ;
    - session valide : accès direct, soumis au même contrôle
      ``has_access`` que le détail de l'épreuve.

    Backend local : le fichier est servi par FastAPI. Backend objet
    (s3) : redirection 302 vers une URL signée (les credentials ne
    quittent jamais le serveur)."""
    f = _load_file_or_404(db, file_id)
    epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == f.epreuve_id).one_or_none()

    # Jeton signé : il doit correspondre au fichier ET à l'épreuve ET à son
    # statut COURANT (la dépublication révoque donc immédiatement les URLs
    # déjà répandues, voir core/signing.py) — l'épreuve supprimée ou retirée
    # laisse le jeton invalide quelle que soit sa fraîcheur.
    token_ok = bool(token) and epreuve is not None and verify_file_token(
        file_id=f.id, epreuve_id=epreuve.id, statut=epreuve.statut, token=token
    )
    if not token_ok:
        if user is None:
            raise HTTPException(401, "Non authentifié")
        if not epreuve or not store.has_access(db, user.id, epreuve):
            raise HTTPException(403, "Accès non autorisé — un abonnement est requis")

    media_type = f.mime_type or "application/octet-stream"

    # SVG accepté historiquement mais XSS-able (il embarque <script>) : il ne
    # doit JAMAIS être rendu inline. Ce test passe AVANT la branche objet —
    # une redirection vers une URL signée du bucket servirait le SVG inline
    # avec son vrai Content-Type, et neutraliserait l'attachement ci-dessous.
    if f.mime_type == "image/svg+xml":
        disposition = f'attachment; filename="{safe_filename(f.filename, "image.svg")}"'
        if get_storage().backend != "local":
            signed = presigned_url_or_none(f.storage_key, expires_seconds=300, content_disposition="attachment")
            if signed:
                return RedirectResponse(signed, status_code=302)
        try:
            data = get_storage().get_bytes(f.storage_key)
        except StorageError:
            raise HTTPException(404, "Fichier introuvable")
        return Response(
            content=data,
            media_type=media_type,
            headers={"Content-Disposition": disposition, "Cache-Control": "no-store"},
        )

    # Backend objet (s3) : on délègue le servir au stockage via une URL
    # signée courte plutôt que de transiter par FastAPI (recommandation
    # architecture : réduire la charge du backend sur les fichiers).
    if get_storage().backend != "local":
        signed = presigned_url_or_none(f.storage_key, expires_seconds=300)
        if signed:
            return RedirectResponse(signed, status_code=302)

    try:
        data = get_storage().get_bytes(f.storage_key)
    except StorageError:
        raise HTTPException(404, "Fichier introuvable")

    if f.format == "image":
        # Cache long : les images sont immuables (clé unique par upload)
        # — réduit fortement les rechargements pendant la lecture.
        return Response(
            content=data,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=86400"},
        )
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "no-store"},
    )
