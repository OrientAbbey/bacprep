"""Assistant IA du back-office, tous onglets : résumés de lecture et outils d'action.

Principe : le modèle PROPOSE, l'admin CONFIRME. Une action est un bloc
```action {"outil": "...", "args": {...}}``` dans la réponse ; le serveur la
valide ici contre une LISTE BLANCHE (`TOOLS`) puis l'exécute en appelant les
handlers admin existants (mêmes validations et même journal que l'interface).
Rien n'est supprimé ni restauré par l'assistant, et il ne touche jamais aux
rôles (promotion/rétrogradation) : ces outils n'existent tout simplement pas.

Vie privée : les résumés envoyés au fournisseur LLM ne contiennent ni nom ni
adresse e-mail complète (adresse masquée) — seulement ce qu'il faut pour
désigner un élève par son identifiant."""
from __future__ import annotations

import inspect
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from fastapi import BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db_models import (
    AdminEventORM,
    EpreuveORM,
    EvenementORM,
    ImportJobORM,
    NotificationORM,
    PlanORM,
    ReferentielOptionORM,
    SauvegardeJobORM,
    SignalementORM,
    SubscriptionORM,
    UserORM,
)
from ..models import BannirIn, NotificationIn
from ..routers import (
    admin_epreuves,
    admin_misc,
    admin_notifications,
    admin_plans,
    admin_referentiel,
    admin_sauvegardes,
    calendrier,
)

ONGLETS = ("import", "sauvegardes", "utilisateurs", "parametres", "formules", "calendrier", "notifications", "signalements", "journal", "stats")


def masquer_email(email: str) -> str:
    """`prenom.nom@gmail.com` → `p***@gmail.com`."""
    local, _, domaine = (email or "").partition("@")
    return f"{local[:1]}***@{domaine}" if domaine else "***"


# ---------------------------------------------------------------- lecture
def _lignes(rows, fmt) -> str:
    out = [fmt(r) for r in rows]
    return "\n".join(out) if out else "(aucun)"


def _resume_import(db: Session) -> str:
    jobs = db.query(ImportJobORM).order_by(ImportJobORM.created_at.desc()).limit(5).all()
    return "Derniers imports :\n" + _lignes(jobs, lambda j: f"- {j.created_at:%Y-%m-%d %H:%M} · {j.filename} · {j.status}")


def _resume_sauvegardes(db: Session) -> str:
    jobs = db.query(SauvegardeJobORM).order_by(SauvegardeJobORM.created_at.desc()).limit(5).all()
    return "Dernières sauvegardes/restaurations :\n" + _lignes(jobs, lambda j: f"- {j.created_at:%Y-%m-%d %H:%M} · {j.kind} · {j.status}")


def _resume_utilisateurs(db: Session) -> str:
    total = db.query(func.count(UserORM.id)).scalar()
    bannis = db.query(func.count(UserORM.id)).filter(UserORM.banni.is_(True)).scalar()
    recents = db.query(UserORM).order_by(UserORM.created_at.desc()).limit(10).all()
    return f"Utilisateurs : {total} (dont {bannis} bannis). 10 derniers inscrits :\n" + _lignes(
        recents, lambda u: f"- id={u.id} · {masquer_email(u.email)} · {u.role}{' · BANNI' if u.banni else ''}"
    )


def _resume_parametres(db: Session) -> str:
    rows = db.query(ReferentielOptionORM).order_by(ReferentielOptionORM.scope, ReferentielOptionORM.position).all()
    par_scope: dict[str, list[str]] = {}
    for o in rows:
        par_scope.setdefault(o.scope, []).append(o.code)
    return "Options du référentiel :\n" + _lignes(par_scope.items(), lambda kv: f"- {kv[0]} : {', '.join(kv[1][:40])}")


def _resume_formules(db: Session) -> str:
    plans = db.query(PlanORM).order_by(PlanORM.ordre).all()
    return "Formules d'abonnement :\n" + _lignes(
        plans, lambda p: f"- id={p.id} · {p.scope} · « {p.libelle} » · {p.prix} FCFA · {p.duree_jours} j · {'active' if p.actif else 'inactive'}"
    )


def _resume_calendrier(db: Session) -> str:
    ev = db.query(EvenementORM).order_by(EvenementORM.date_debut).limit(30).all()
    return "Calendrier :\n" + _lignes(ev, lambda e: f"- id={e.id} · {e.date_debut} · {e.type} · {e.titre}{'' if e.visible else ' (masqué)'}")


def _resume_notifications(db: Session) -> str:
    n = db.query(NotificationORM).order_by(NotificationORM.created_at.desc()).limit(10).all()
    return "Dernières notifications :\n" + _lignes(n, lambda x: f"- id={x.id} · {x.type} · {x.titre}{'' if x.actif else ' (inactive)'}")


def _resume_signalements(db: Session) -> str:
    ouverts = db.query(SignalementORM).filter(SignalementORM.statut == "ouvert").order_by(SignalementORM.created_at.desc()).limit(15).all()
    total = db.query(func.count(SignalementORM.id)).filter(SignalementORM.statut == "ouvert").scalar()
    return f"Signalements ouverts : {total}. Les plus récents :\n" + _lignes(
        ouverts, lambda s: f"- id={s.id} · épreuve={s.epreuve_id} · {s.motif} · « {(s.message or '')[:160]} »"
    )


def _resume_journal(db: Session) -> str:
    ev = db.query(AdminEventORM).order_by(AdminEventORM.created_at.desc()).limit(15).all()
    return "Dernières actions admin :\n" + _lignes(ev, lambda e: f"- {e.created_at:%Y-%m-%d %H:%M} · {e.action} · {masquer_email(e.email)}")


def _resume_stats(db: Session) -> str:
    c = lambda m, *f: db.query(func.count(m.id)).filter(*f).scalar()  # noqa: E731
    return (
        f"Utilisateurs : {c(UserORM)} · Épreuves publiées : {c(EpreuveORM, EpreuveORM.statut == 'publie')} "
        f"(brouillons/à réviser : {c(EpreuveORM, EpreuveORM.statut != 'publie')}) · Abonnements : {c(SubscriptionORM)} · "
        f"Signalements ouverts : {c(SignalementORM, SignalementORM.statut == 'ouvert')}"
    )


RESUMES: dict[str, Callable[[Session], str]] = {
    "import": _resume_import, "sauvegardes": _resume_sauvegardes, "utilisateurs": _resume_utilisateurs,
    "parametres": _resume_parametres, "formules": _resume_formules, "calendrier": _resume_calendrier,
    "notifications": _resume_notifications, "signalements": _resume_signalements, "journal": _resume_journal,
    "stats": _resume_stats,
}


def resume_onglet(db: Session, onglet: str) -> str:
    return RESUMES.get(onglet, _resume_stats)(db)


# ---------------------------------------------------------------- actions
class IdArgs(BaseModel):
    id: str = Field(min_length=1, max_length=64)


class BannirArgs(IdArgs):
    motif: str = Field(default="", max_length=500)


class PlanModifierArgs(admin_plans.PlanUpdate):
    id: str = Field(min_length=1, max_length=64)


class EvenementArgs(calendrier.EvenementIn):
    pass


class OptionArgs(admin_referentiel.ReferentielOptionIn):
    pass


class VideArgs(BaseModel):
    pass


@dataclass
class Outil:
    description: str  # affichée à l'admin sur la carte de confirmation
    schema: type[BaseModel]
    run: Callable[..., Any | Awaitable[Any]]


# Chaque `run(db, lock, bg, args)` délègue à un handler admin EXISTANT.
TOOLS: dict[str, Outil] = {
    "signalement_resoudre": Outil("Marquer un signalement comme résolu", IdArgs,
        lambda db, lock, bg, a: admin_misc.admin_resoudre_signalement(a.id, db=db, lock=lock)),
    "utilisateur_bannir": Outil("Bannir un élève (ses sessions sont fermées)", BannirArgs,
        lambda db, lock, bg, a: admin_misc.admin_bannir_utilisateur(a.id, BannirIn(motif=a.motif), db=db, lock=lock)),
    "utilisateur_debannir": Outil("Débannir un élève", IdArgs,
        lambda db, lock, bg, a: admin_misc.admin_debannir_utilisateur(a.id, db=db, lock=lock)),
    "plan_creer": Outil("Créer une formule d'abonnement", admin_plans.PlanIn,
        lambda db, lock, bg, a: admin_plans.creer(a, db=db, lock=lock)),
    "plan_modifier": Outil("Modifier une formule d'abonnement", PlanModifierArgs,
        lambda db, lock, bg, a: admin_plans.modifier(a.id, admin_plans.PlanUpdate(**a.model_dump(exclude={"id"}, exclude_unset=True)), db=db, lock=lock)),
    "evenement_creer": Outil("Ajouter un événement au calendrier", EvenementArgs,
        lambda db, lock, bg, a: calendrier.creer(a, db=db, lock=lock)),
    "notification_creer": Outil("Créer une notification pour les élèves", NotificationIn,
        lambda db, lock, bg, a: admin_notifications.admin_create_notification(a, db=db, lock=lock)),
    "option_referentiel_ajouter": Outil("Ajouter une option au référentiel", OptionArgs,
        lambda db, lock, bg, a: admin_referentiel.admin_create_referentiel_option(a, db=db, lock=lock)),
    "epreuve_publier": Outil("Publier une épreuve", IdArgs,
        lambda db, lock, bg, a: admin_epreuves.admin_publish(a.id, db=db, lock=lock)),
    "epreuve_retirer": Outil("Retirer une épreuve du catalogue (sans la supprimer)", IdArgs,
        lambda db, lock, bg, a: admin_epreuves.admin_unpublish(a.id, db=db, lock=lock)),
    "sauvegarde_lancer": Outil("Lancer une sauvegarde (export)", VideArgs,
        lambda db, lock, bg, a: admin_sauvegardes.lancer_export(bg, admin_sauvegardes.SauvegardeExportDemande(), db=db, lock=lock)),
}


async def executer(db: Session, lock, bg: BackgroundTasks, outil: str, args: dict) -> Any:
    """Valide `args` contre le schéma de l'outil puis l'exécute. Un outil inconnu
    ou un champ en trop lève une ValueError (traduite en 422 par la route)."""
    spec = TOOLS.get(outil)
    if spec is None:
        raise ValueError(f"Outil inconnu : {outil}")
    valides = spec.schema.model_validate(args, strict=False)
    extra = set(args) - set(spec.schema.model_fields)
    if extra:
        raise ValueError(f"Champs non autorisés : {', '.join(sorted(extra))}")
    res = spec.run(db, lock, bg, valides)
    return await res if inspect.isawaitable(res) else res


def catalogue_outils() -> str:
    """Liste des outils, avec leurs arguments, pour l'invite du modèle."""
    lignes = []
    for nom, o in TOOLS.items():
        champs = ", ".join(
            f"{k}{'' if f.is_required() else '?'}" for k, f in o.schema.model_fields.items()
        )
        lignes.append(f"- {nom}({champs}) : {o.description}")
    return "\n".join(lignes)


def prompt_onglet(onglet: str, resume: str, question: str, historique: list[dict]) -> str:
    """Invite complète pour un onglet autre que l'édition d'épreuve."""
    lignes = [
        "Tu es l'assistant du back-office de BacPrep (Copies & Corrigés), au service d'un "
        "administrateur. Réponds en français, de façon brève et factuelle.",
        f"Onglet affiché : {onglet}. Voici l'état actuel (extrait, lecture seule) :",
        resume,
        "",
        "Tu peux PROPOSER des actions avec ces outils (rien ne s'exécute sans la confirmation de l'admin) :",
        catalogue_outils(),
        "Pour proposer une action, écris UN SEUL bloc de code fencé « action » contenant un objet "
        'JSON {"outil": "<nom>", "args": {...}}, précédé d\'une phrase d\'explication. '
        "N'invente JAMAIS un identifiant : utilise uniquement ceux de l'état ci-dessus ; s'il en manque "
        "un, demande-le. Tu ne peux ni supprimer, ni restaurer une sauvegarde, ni changer des rôles : "
        "dis-le simplement si on te le demande.",
        "",
    ]
    for m in historique[-6:]:
        if m.get("role") == "user" and m.get("content") == question:
            continue
        lignes.append(f"{'Admin' if m.get('role') == 'user' else 'Assistant'} : {m.get('content', '')}")
    lignes.append(f"Admin : {question}")
    return "\n".join(lignes)
