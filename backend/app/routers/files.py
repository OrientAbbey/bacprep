from __future__ import annotations

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

    if not (token and verify_file_token(file_id, token)):
        if user is None:
            raise HTTPException(401, "Non authentifié")
        epreuve = db.query(EpreuveORM).filter(EpreuveORM.id == f.epreuve_id).one_or_none()
        if not epreuve or not store.has_access(db, user.id, epreuve):
            raise HTTPException(403, "Accès non autorisé — un abonnement est requis")

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

    media_type = f.mime_type or "application/octet-stream"
    if f.mime_type == "image/svg+xml":
        # SVG accepté historiquement mais XSS-able (embarque <script>) :
        # jamais rendu inline, toujours proposé au téléchargement.
        return Response(
            content=data,
            media_type=media_type,
            headers={
                "Content-Disposition": f'attachment; filename="{f.filename}"',
                "Cache-Control": "no-store",
            },
        )
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
        headers={"Cache-Control": "no-store"} if f.format == "md" else {"Cache-Control": "private, max-age=86400"},
    )
