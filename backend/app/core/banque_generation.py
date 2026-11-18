"""Algorithme PUR de composition d'épreuves à partir de la banque d'exercices
(cahier V4.10, section 4).

Aucune dépendance base de données ni réseau : l'entrée est un *snapshot*
(dataclasses), la sortie est une liste d'identifiants tirés plus les événements
techniques à journaliser. Le tirage reçoit son générateur aléatoire (`rng`), ce
qui rend la recette exhaustive reproductible.

Deux écarts assumés avec le cahier, documentés dans `_PLAN_V410_GENERATEUR.md` :

- le nombre de séquences vient du référentiel (`sequences_connues`), jamais du
  littéral 6 : si la liste passe de 3 à 6 entrées, « Séquence 5-6 des classes
  inférieures » suit sans modification (ce sont les deux DERNIÈRES séquences) ;
- la garantie d'unicité 4.i est bornée (`MAX_TENTATIVES`) : au-delà, l'épreuve
  est rendue telle quelle. Les contraintes pédagogiques priment toujours.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

# Nombre d'exercices par difficulté d'épreuve (cahier 2.1 : Moyen = 4,
# Difficile = 6 ; Facile = 2, seul pair cohérent restant).
N_PAR_DIFFICULTE: dict[str, int] = {"Facile": 2, "Moyen": 4, "Difficile": 6}

DIFFICULTES: tuple[str, ...] = ("Facile", "Moyen", "Difficile")

MODES: tuple[str, ...] = ("sequence", "examen", "examen_blanc", "vide")

#: Valeur de spécialité « universelle » : un exercice qui la porte est visible
#: par toutes les spécialités, y compris quand l'élève n'en renseigne aucune.
SPECIAL_AUCUNE = "SPECIAL:Aucune"

#: Pondération 7.4 du niveau intrinsèque : (difficulté demandée, niveau
#: exercice) → poids. La pondération oriente le tirage, elle ne l'interdit pas.
POIDS: dict[tuple[str, str], int] = {
    ("Facile", "Facile"): 3,
    ("Facile", "Moyen"): 2,
    ("Facile", "Difficile"): 1,
    ("Moyen", "Facile"): 1,
    ("Moyen", "Moyen"): 3,
    ("Moyen", "Difficile"): 1,
    ("Difficile", "Facile"): 1,
    ("Difficile", "Moyen"): 2,
    ("Difficile", "Difficile"): 3,
}

#: Rejeux complets autorisés pour éviter une combinaison déjà générée. Au-delà,
#: l'épreuve est rendue telle quelle (doublon silencieux) : la pédagogie prime.
MAX_TENTATIVES = 20

GENERATION = "GENERATION"
RULE_50_RELAXED = "RULE_50_RELAXED"
UNIQUENESS_SATURATED = "UNIQUENESS_SATURATED"
INCOMPLETE_EXAM = "INCOMPLETE_EXAM"


@dataclass(frozen=True)
class ClasseMeta:
    """Paramètres d'une classe (cahier 3.2.c). L'ordre de rang, lui, n'est PAS
    stocké : il est donné par `Parametres.classes` (ordre du référentiel)."""

    a_examen: bool = False
    specialite_obligatoire: bool = False


@dataclass(frozen=True)
class ExerciceBanque:
    """Un exercice de la banque, réduit à ce dont l'algorithme a besoin.

    `session` est le numéro d'une séquence du référentiel (cahier 7.2), ou
    None pour un exercice hors séquence.
    """

    id: str
    partie_id: str
    #: Classes ciblées (multi-sélection du cahier 3.1). L'ordre n'importe pas :
    #: c'est la classe éligible la plus proche de la classe demandée qui sert
    #: au rang (4.e/4.f). `classe` n'est donc PAS un champ séparé — un exercice
    #: qui ciblerait une classe « principale » et d'autres en douce rendrait le
    #: calcul de rang ambigu.
    classes: tuple[str, ...] = ()
    matieres: tuple[str, ...] = ()
    series: tuple[str, ...] = ()
    session: int | None = None
    niveau: str = "Moyen"
    tag_examen: bool = False

    def __post_init__(self) -> None:
        if not self.classes:
            raise ValueError(f"exercice {self.id} sans classe")


@dataclass(frozen=True)
class Parametres:
    matiere: str
    classe: str
    serie: str | None = None
    # Index 1-based dans `sequences_connues` ; None = épreuve sans séquence.
    sequence: int | None = None
    mode: str = "sequence"
    difficulte: str = "Moyen"
    nb_exercices: int | None = None
    sequences_connues: tuple[str, ...] = ()
    #: Codes de classe du référentiel, dans l'ordre croissant de scolarité.
    classes: tuple[str, ...] = ()
    classes_meta: Mapping[str, ClasseMeta] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.mode not in MODES:
            raise ValueError(f"mode inconnu : {self.mode}")
        if self.difficulte not in N_PAR_DIFFICULTE:
            raise ValueError(f"difficulté inconnue : {self.difficulte}")
        if self.mode == "sequence" and self.sequence is None:
            # Une épreuve « sans séquence » n'est PAS une épreuve de séquence
            # vide de contrainte : c'est le mode "vide" (tableau 4.0). Refuser
            # ici évite une épreuve silencieusement vide.
            raise ValueError("mode séquence sans séquence demandée")
        if self.sequence is not None and self.sequence < 1:
            raise ValueError("séquence hors bornes")
        if self.nb_exercices is not None and self.nb_exercices < 0:
            raise ValueError("nombre d'exercices négatif")

    @property
    def n(self) -> int:
        return self.nb_exercices if self.nb_exercices is not None else N_PAR_DIFFICULTE[self.difficulte]


def canonique(ids: Iterable[str]) -> tuple[str, ...]:
    """Empreinte d'une combinaison : le MULTIENSEMBLE d'identifiants, l'ordre
    indifférent (cahier 4.i)."""
    return tuple(sorted(ids))


def poids(difficulte: str, niveau: str) -> int:
    """Poids 7.4 d'un exercice dans une épreuve de cette difficulté."""
    return POIDS.get((difficulte, niveau), 1)


def seuil_sequences_basses(sequences_connues: Sequence[str]) -> int:
    """Première « séquence basse » (5 dans un référentiel à 6, 2 dans un
    référentiel à 3) : les classes inférieures n'y ont accès qu'à partir de là."""
    numeros = sorted(
        int(morceaux[1])
        for code in sequences_connues
        if len(morceaux := code.strip().split()) == 2
        and morceaux[0].upper() == "SEQUENCE"
        and morceaux[1].isdigit()
    )
    return numeros[-2] if len(numeros) >= 2 else (numeros[0] if numeros else 1)


def _derniere_sequence_connue(sequences_connues: Sequence[str]) -> int:
    """Numéro le plus élevé réellement configuré (les numéros peuvent avoir des trous)."""
    numeros = [
        int(morceaux[1])
        for code in sequences_connues
        if len(morceaux := code.strip().split()) == 2
        and morceaux[0].upper() == "SEQUENCE"
        and morceaux[1].isdigit()
    ]
    return max(numeros, default=0)


def _meta(p: Parametres, classe: str) -> ClasseMeta:
    return p.classes_meta.get(classe, ClasseMeta())


def _rangs_inferieurs(p: Parametres) -> list[int]:
    """Profondeurs de remontée autorisées (4.e / 4.k) : 2 niveaux si la classe
    demandée a un examen, 1 sinon, et AUCUNE pour une épreuve Difficile."""
    if p.difficulte == "Difficile" or not p.classes:
        return []
    try:
        rang = list(p.classes).index(p.classe)
    except ValueError:
        return []
    profondeur = 2 if _meta(p, p.classe).a_examen else 1
    return [d for d in range(1, profondeur + 1) if rang - d >= 0]


def classes_eligibles(p: Parametres) -> list[str]:
    """Classe demandée puis classes inférieures autorisées, de la plus proche
    à la plus lointaine."""
    if not p.classes or p.classe not in p.classes:
        return [p.classe]
    rang = list(p.classes).index(p.classe)
    return [p.classe] + [p.classes[rang - d] for d in _rangs_inferieurs(p)]


def _serie_ok(exercice: ExerciceBanque, serie: str | None) -> bool:
    """4.d : « SPECIAL:Aucune » est universel ; sinon l'exercice doit couvrir
    la spécialité demandée (ou l'élève n'en avoir renseigné aucune)."""
    if SPECIAL_AUCUNE in exercice.series:
        return True
    if serie is None:
        return True
    return serie in exercice.series


def _session_ok_demande(exercice: ExerciceBanque, p: Parametres) -> bool:
    """Tableau 4.0 et 4.h pour la classe DEMANDÉE."""
    if exercice.session is None:
        # Session vide : éligible aux examens et aux épreuves sans séquence,
        # jamais à une épreuve de séquence (4.0).
        return p.mode in ("examen", "examen_blanc", "vide")
    if p.mode in ("examen", "examen_blanc"):
        return exercice.tag_examen
    if p.mode == "vide":
        return True
    # mode == "sequence"
    if p.sequence is None:
        return False
    return exercice.session <= p.sequence


def _session_ok_inferieure(exercice: ExerciceBanque, p: Parametres) -> bool:
    """4.b / 4.c / 4.h / 4.k pour une classe INFÉRIEURE.

    4.b prime sur le tableau 4.0 : seules les dernières séquences sont
    accessibles, quelle que soit la séquence demandée. En mode examen, 4.h
    s'ajoute (le tag Examen reste exigé, « même tagué Examen » ne lève que la
    4.c, jamais l'exigence de tag). Un exercice de session vide d'une classe
    inférieure est exclu : il n'appartient à aucune des séquences autorisées.
    """
    if exercice.session is None:
        return False
    if p.mode in ("examen", "examen_blanc") and not exercice.tag_examen:
        return False
    seuil = seuil_sequences_basses(p.sequences_connues)
    if p.difficulte == "Moyen":
        # 4.k renforce : séquence la plus haute uniquement.
        return exercice.session == _derniere_sequence_connue(p.sequences_connues)
    return exercice.session >= seuil


def classe_effective(exercice: ExerciceBanque, p: Parametres) -> str | None:
    """Classe à laquelle cet exercice participe dans cette épreuve : la plus
    proche de la classe demandée parmi ses classes ciblées (4.e/4.f). None =
    hors périmètre de classes."""
    return next((c for c in classes_eligibles(p) if c in exercice.classes), None)


def _classe_inferieure_ok(exercice: ExerciceBanque, p: Parametres, classe: str) -> bool:
    """4.l : une classe inférieure sans spécialité est exclue pour un élève qui
    en renseigne une, sauf exercice tagué « Aucune » (4.d prime sur 4.l)."""
    if _meta(p, classe).specialite_obligatoire or p.serie is None:
        return True
    return SPECIAL_AUCUNE in exercice.series


def eligibles(banque: Iterable[ExerciceBanque], p: Parametres) -> list[ExerciceBanque]:
    """Pool éligible : 4.0 + 4.b + 4.c + 4.d + 4.e + 4.k + 4.l."""
    out: list[ExerciceBanque] = []
    for e in banque:
        if p.matiere not in e.matieres:
            continue
        classe = classe_effective(e, p)
        if classe is None:
            continue
        if not _serie_ok(e, p.serie):
            continue
        if classe == p.classe:
            if not _session_ok_demande(e, p):
                continue
        else:
            if not _session_ok_inferieure(e, p):
                continue
            if not _classe_inferieure_ok(e, p, classe):
                continue
        out.append(e)
    return sorted(out, key=lambda e: e.id)


def quotas_parties(parties: Sequence[str], n: int, rng: random.Random) -> dict[str, int]:
    """Règle 4.a et ses trois exceptions, sous forme de quota par partie.

    - une seule partie (exception 1) : tout vient d'elle ;
    - P < N (exception 2) : q = N // P, r = N % P ; r parties tirées au hasard
      reçoivent q+1, les autres q (la distribution du cahier) ;
    - P >= N (exception 3) : chaque partie une fois au plus.

    Le quota est calculé sur l'ensemble de l'épreuve : il s'applique aussi aux
    phases 1 et 2a, pas seulement aux compléments.
    """
    uniques = sorted(set(parties))
    if not uniques:
        return {}
    if len(uniques) == 1:
        return {uniques[0]: max(n, 1)}
    if len(uniques) < n:
        q, r = divmod(n, len(uniques))
        supplementaires = set(rng.sample(uniques, r)) if r else set()
        return {pa: q + (1 if pa in supplementaires else 0) for pa in uniques}
    return {pa: 1 for pa in uniques}


class _Tirage:
    """État d'un tirage sans remise : quotas de parties et plafond 4.f (un
    exercice au plus par niveau de classe inférieure)."""

    def __init__(self, p: Parametres, pool: Sequence[ExerciceBanque], rng: random.Random) -> None:
        self.p = p
        self.quotas = quotas_parties([e.partie_id for e in pool], p.n, rng)
        self.classe_de = {e.id: c for e in pool if (c := classe_effective(e, p)) is not None}
        self.inferieures: dict[str, int] = {}
        self.tires: list[ExerciceBanque] = []
        self._ids: set[str] = set()

    def ajouter(self, e: ExerciceBanque) -> None:
        self.tires.append(e)
        self._ids.add(e.id)
        self.quotas[e.partie_id] = self.quotas.get(e.partie_id, 1) - 1
        classe = self.classe_de.get(e.id)
        if classe is not None and classe != self.p.classe:
            self.inferieures[classe] = self.inferieures.get(classe, 0) + 1

    def disponible(self, e: ExerciceBanque) -> bool:
        if e.id in self._ids:
            return False
        if self.quotas.get(e.partie_id, 1) <= 0:
            return False
        classe = self.classe_de.get(e.id)
        if classe is not None and classe != self.p.classe and self.inferieures.get(classe, 0) >= 1:
            return False  # 4.f : un seul exercice par niveau inférieur
        return True

    def tirer(self, candidats: Sequence[ExerciceBanque], k: int, rng: random.Random) -> list[ExerciceBanque]:
        pris: list[ExerciceBanque] = []
        while len(pris) < k:
            pool = [e for e in candidats if self.disponible(e)]
            if not pool:
                break
            choix = rng.choices(pool, weights=[poids(self.p.difficulte, e.niveau) for e in pool], k=1)[0]
            self.ajouter(choix)
            pris.append(choix)
        return pris


def composer(
    pool: Sequence[ExerciceBanque], p: Parametres, rng: random.Random
) -> tuple[list[ExerciceBanque], list[str]]:
    """Une passe complète de l'algorithme 4.m. Renvoie les exercices tirés et
    les événements (`RULE_50_RELAXED`, `INCOMPLETE_EXAM`)."""
    evenements: list[str] = []
    n = p.n
    tirage = _Tirage(p, pool, rng)

    if p.mode == "sequence" and p.sequence is not None:
        cible = n // 2
        exact = [e for e in pool if e.session == p.sequence]
        tirage.tirer(exact, cible, rng)
        deficit = cible - len(tirage.tires)
        if deficit > 0:
            evenements.append(RULE_50_RELAXED)
            # Phase 2a : compensation par la classe DEMANDÉE seulement (4.g).
            compensation = [e for e in pool if tirage.classe_de.get(e.id) == p.classe]
            tirage.tirer(compensation, deficit, rng)
            if len(tirage.tires) < cible:
                # La classe demandée ne suffit pas : épreuve incomplète, et
                # jamais de classe inférieure pour compenser 4.g. Phase 2b
                # sautée (décision 26).
                evenements.append(INCOMPLETE_EXAM)
                return tirage.tires, evenements

    # Phase 2b : compléments normaux.
    tirage.tirer(pool, n - len(tirage.tires), rng)
    if len(tirage.tires) < n:
        evenements.append(INCOMPLETE_EXAM)
    return tirage.tires, evenements


def generer(
    banque: Sequence[ExerciceBanque],
    p: Parametres,
    rng: random.Random | None = None,
    historique: Iterable[tuple[str, ...]] = (),
    max_tentatives: int = MAX_TENTATIVES,
) -> tuple[list[ExerciceBanque], list[str]]:
    """Composition avec unicité bornée (4.i).

    On rejoue la composition tant que la combinaison est déjà dans
    l'historique de CET utilisateur. Après `max_tentatives`, on rend la
    dernière épreuve et on signale `UNIQUENESS_SATURATED` : les contraintes
    pédagogiques n'ont jamais été relâchées pour obtenir l'unicité.
    """
    rng = rng or random.Random()
    pool = eligibles(banque, p)
    connues = set(historique)
    tires: list[ExerciceBanque] = []
    evenements: list[str] = []
    for _ in range(max(1, max_tentatives)):
        tires, evenements = composer(pool, p, rng)
        if canonique(e.id for e in tires) not in connues:
            return tires, evenements
    return tires, evenements + [UNIQUENESS_SATURATED]
