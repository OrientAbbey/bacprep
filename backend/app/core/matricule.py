"""Génération du matricule public des comptes élèves.

Format : ``CC-26-A7K3M9`` — préfixe produit, année de création sur deux
chiffres, puis six caractères tirés d'un alphabet de 32 symboles **sans
caractères ambigus** (ni ``0/O``, ni ``1/I``) : le matricule se dicte au
téléphone et se recopie à la main sans erreur.

Aucune donnée personnelle n'y entre : il sera un jour communiqué à un tiers
(cadeau de formule d'un parent à son enfant), il ne doit donc rien révéler.
32^6 ≈ 1,07 milliard de combinaisons pour un parc de quelques milliers de
comptes — les collisions sont traitées à l'insertion (index UNIQUE +
``IntegrityError``), pas prévenues ici.

Le module est **pur** (aucun accès base) pour rester testable : l'unicité
est la responsabilité de l'appelant (``core.store.get_or_create_user``).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Optional

# Alphabet Crockford-base32 adapté : ni 0/O ni 1/I, ni L (confondu avec I
# dans certaines polices manuscrites). 32 symboles exactement -> 5 bits par
# caractère, tirage uniforme sans biais de modulo.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LONGUEUR_SUFFIXE = 6
PREFIXE = "CC"


def _annee_courante() -> int:
    """Année UTC. Le projet n'a aucun fuseau configuré (tout est UTC) : on ne
    réinvente pas une règle « heure de Douala » qui n'existe nulle part
    ailleurs dans le code."""
    return datetime.now(timezone.utc).year


def generer_matricule(annee: Optional[int] = None, rng: Optional[secrets.SystemRandom] = None) -> str:
    """Renvoie un matricule neuf, ex. ``CC-26-A7K3M9``.

    `annee` et `rng` sont injectables pour les tests (déterminisme) ; en
    production, aucun argument n'est passé.
    """
    annee = annee if annee is not None else _annee_courante()
    source = rng or secrets.SystemRandom()
    suffixe = "".join(source.choice(ALPHABET) for _ in range(LONGUEUR_SUFFIXE))
    return f"{PREFIXE}-{annee % 100:02d}-{suffixe}"


def est_valide(matricule: str) -> bool:
    """Vérifie la forme canonique (utilisé par la recherche support et les
    tests). Volontairement strict : préfixe, année, longueur, alphabet."""
    if not isinstance(matricule, str):
        return False
    parties = matricule.split("-")
    if len(parties) != 3:
        return False
    prefixe, annee, suffixe = parties
    if prefixe != PREFIXE:
        return False
    if len(annee) != 2 or not annee.isdigit():
        return False
    if len(suffixe) != LONGUEUR_SUFFIXE:
        return False
    return all(c in ALPHABET for c in suffixe)
