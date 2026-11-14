"""Monnaie interne « AK » : série de connexions récompensée, solde, débits.

Deux responsabilités, volontairement séparées :

* ``calculer_gain_serie`` — **fonction pure** (aucun accès base) : c'est la
  règle métier, testable exhaustivement sans SQLite ;
* ``recompenser_connexion`` / ``debiter_ak`` — écritures **atomiques** en
  base, dans une transaction unique avec le journal ``ak_mouvements``.

Invariant vérifié par les tests : ``users.solde_ak == SUM(ak_mouvements.montant)``.
Le solde est un cache d'affichage ; le journal est la source de vérité
comptable (audit, export RGPD, litiges).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import update
from sqlalchemy.orm import Session

from ..db_models import AKMouvementORM, UserORM
from .logging_config import get_logger

log = get_logger("ak")

# Paliers cumulatifs (demande produit) : la série ne se remet PAS à zéro au
# 4e jour, les gains augmentent par palier jusqu'à 10 AK/jour.
GAIN_JOURS_1_3 = 3
GAIN_JOURS_4_6 = 7
GAIN_JOURS_7_PLUS = 10

# Absence de 7 jours pleins ou plus -> la série repart de zéro. En dessous,
# la série continue de s'incrémenter (récompense de l'habitude, pas de la
# connexion quotidienne stricte).
RESET_APRES_JOURS = 7


def aujourd_hui_utc() -> str:
    """Date du jour en ISO ``AAAA-MM-JJ``, en UTC.

    Le projet n'a aucun fuseau configuré (tout est UTC, cf. ``db.utc_now``) :
    on ne réinvente pas une règle « heure de Douala » qui n'existerait nulle
    part ailleurs. Le format texte se compare lexicographiquement, ce qui
    rend l'idempotence par jour triviale en SQL.
    """
    return datetime.now(timezone.utc).date().isoformat()


def _ecart_jours(dernier: str, courant: str) -> Optional[int]:
    """Nombre de jours entre deux dates ISO ; ``None`` si une valeur est
    illisible (compte ancien, donnée corrompue) — l'appelant traite alors
    comme une première connexion plutôt que de planter."""
    try:
        return (date.fromisoformat(courant) - date.fromisoformat(dernier)).days
    except (TypeError, ValueError):
        return None


def gain_pour_serie(serie: int) -> int:
    """Gain en AK pour un jour de série donné (1 = première connexion)."""
    if serie <= 0:
        return 0
    if serie <= 3:
        return GAIN_JOURS_1_3
    if serie <= 6:
        return GAIN_JOURS_4_6
    return GAIN_JOURS_7_PLUS


def calculer_gain_serie(
    serie: int, dernier_jour: Optional[str], jour: str
) -> tuple[int, int]:
    """Renvoie ``(nouvelle_serie, gain_ak)``. **Aucun accès base.**

    Table de vérité (``serie`` = série courante, ``dernier_jour`` = date du
    dernier gain) :

    ============================  =================  =========
    Cas                           nouvelle série     gain
    ============================  =================  =========
    dernier gain aujourd'hui       inchangée          0
    aucun historique               1                  3
    veille (écart 1 j)             série + 1          3/7/10
    écart 2 à 6 jours              série + 1          3/7/10
    écart ≥ 7 jours                1                  3
    ============================  =================  =========
    """
    if dernier_jour == jour:
        # Idempotence : plusieurs visites le même jour ne rapportent rien de
        # plus qu'une seule.
        return serie, 0

    if not dernier_jour:
        nouvelle = 1
    else:
        ecart = _ecart_jours(dernier_jour, jour)
        if ecart is None or ecart < 0:
            # Date illisible ou dans le futur : on repart proprement.
            nouvelle = 1
        elif ecart >= RESET_APRES_JOURS:
            nouvelle = 1
        else:
            nouvelle = max(serie, 0) + 1

    return nouvelle, gain_pour_serie(nouvelle)


def _motif_connexion(serie: int) -> str:
    return "connexion_j7plus" if serie >= 7 else f"connexion_j{serie}"


def recompenser_connexion(
    db: Session, user: UserORM, jour: Optional[str] = None
) -> dict:
    """Crédite le gain du jour si l'élève ne l'a pas déjà touché.

    L'écriture est **conditionnelle** : ``UPDATE ... WHERE ak_dernier_jour IS
    NULL OR ak_dernier_jour != :jour``. Deux onglets qui rechargent la page au
    même instant ne peuvent donc pas créditer deux fois — le second voit
    ``rowcount == 0`` et repart sans rien écrire. C'est ce qui rend
    l'appel depuis ``/me`` (toutes les heures) inoffensif.

    Retourne ``{"gain", "serie", "solde_ak"}`` (gain 0 = déjà crédité).
    """
    jour = jour or aujourd_hui_utc()
    serie_actuelle = int(user.ak_serie_jours or 0)
    nouvelle_serie, gain = calculer_gain_serie(serie_actuelle, user.ak_dernier_jour, jour)

    if gain <= 0:
        return {"gain": 0, "serie": serie_actuelle, "solde_ak": int(user.solde_ak or 0)}

    resultat = db.execute(
        update(UserORM)
        .where(
            UserORM.id == user.id,
            (UserORM.ak_dernier_jour.is_(None)) | (UserORM.ak_dernier_jour != jour),
        )
        .values(
            solde_ak=UserORM.solde_ak + gain,
            ak_serie_jours=nouvelle_serie,
            ak_dernier_jour=jour,
        )
    )
    if resultat.rowcount == 0:
        # Course perdue : un autre appel a déjà crédité ce jour-là. Aucune
        # écriture n'a eu lieu (l'UPDATE n'a touché aucune ligne) — surtout
        # pas de rollback ici, qui annulerait le travail en cours de
        # l'appelant (`/me` vient de committer la dernière connexion).
        user_db = db.query(UserORM).filter(UserORM.id == user.id).one_or_none()
        solde = int(user_db.solde_ak or 0) if user_db else int(user.solde_ak or 0)
        return {"gain": 0, "serie": serie_actuelle, "solde_ak": solde}

    db.add(
        AKMouvementORM(
            user_id=user.id,
            montant=gain,
            motif=_motif_connexion(nouvelle_serie),
            details_json=json.dumps(
                {"jour": jour, "serie": nouvelle_serie}, ensure_ascii=False
            ),
        )
    )
    db.commit()
    db.refresh(user)
    log.info(
        "Gain AK: user_id=%s jour=%s serie=%s gain=%s solde=%s",
        user.id, jour, nouvelle_serie, gain, user.solde_ak,
    )
    return {"gain": gain, "serie": nouvelle_serie, "solde_ak": int(user.solde_ak or 0)}


def debiter_ak(
    db: Session, user: UserORM, montant: int, motif: str, details: Optional[dict] = None
) -> bool:
    """Débite ``montant`` AK au profit d'un achat. ``False`` si le solde est
    insuffisant (aucune écriture dans ce cas).

    Le garde-fou ``solde_ak >= :montant`` est **dans** l'``UPDATE`` : deux
    achats concurrents ne peuvent pas faire passer le solde sous zéro, même
    si la vérification Python en amont a lu un solde suffisant pour les deux.
    """
    if montant <= 0:
        raise ValueError("Le montant d'un débit AK doit être strictement positif")

    resultat = db.execute(
        update(UserORM)
        .where(UserORM.id == user.id, UserORM.solde_ak >= montant)
        .values(solde_ak=UserORM.solde_ak - montant)
    )
    if resultat.rowcount == 0:
        # Solde insuffisant (ou achat concurrent l'ayant épuisé) : rien n'a
        # été écrit, on rend la main sans rollback (l'appelant peut avoir du
        # travail en cours dans la même transaction).
        return False

    db.add(
        AKMouvementORM(
            user_id=user.id,
            montant=-montant,
            motif=motif,
            details_json=json.dumps(details or {}, ensure_ascii=False),
        )
    )
    db.commit()
    db.refresh(user)
    log.info("Débit AK: user_id=%s montant=%s motif=%s solde=%s", user.id, montant, motif, user.solde_ak)
    return True


def crediter_ak(
    db: Session, user: UserORM, montant: int, motif: str, details: Optional[dict] = None
) -> None:
    """Crédit manuel (ajustement support/admin). Même discipline atomique."""
    if montant <= 0:
        raise ValueError("Le montant d'un crédit AK doit être strictement positif")

    db.execute(
        update(UserORM)
        .where(UserORM.id == user.id)
        .values(solde_ak=UserORM.solde_ak + montant)
    )
    db.add(
        AKMouvementORM(
            user_id=user.id,
            montant=montant,
            motif=motif,
            details_json=json.dumps(details or {}, ensure_ascii=False),
        )
    )
    db.commit()
    db.refresh(user)


def mouvements_recents(db: Session, user_id: str, limite: int = 20) -> list[AKMouvementORM]:
    """Derniers mouvements, du plus récent au plus ancien (affichage profil)."""
    return (
        db.query(AKMouvementORM)
        .filter(AKMouvementORM.user_id == user_id)
        .order_by(AKMouvementORM.created_at.desc())
        .limit(limite)
        .all()
    )
