"""Recette de l'algorithme de génération (cahier V4.10, section 4).

Deux familles de tests :

- **table de vérité** : chaque règle du cahier est vérifiée seule, avec un pool
  construit à la main (4.0, 4.a E1/E2/E3, 4.b, 4.c, 4.d, 4.e, 4.f, 4.g, 4.h,
  4.k, 4.l, 4.m) ;
- **propriétés** : sur 1000 tirages, aucune contrainte pédagogique n'est violée,
  y compris quand la banque est riche (c'est le seul moyen d'attraper une
  contrainte oubliée dans un chemin de tirage).

Le module testé est PUR : pas de base, pas de réseau, `random.Random` injecté.
"""
from __future__ import annotations

import random

import pytest

from app.core.banque_generation import (
    INCOMPLETE_EXAM,
    MAX_TENTATIVES,
    N_PAR_DIFFICULTE,
    POIDS,
    RULE_50_RELAXED,
    SPECIAL_AUCUNE,
    UNIQUENESS_SATURATED,
    ClasseMeta,
    ExerciceBanque,
    Parametres,
    canonique,
    classe_effective,
    classes_eligibles,
    composer,
    eligibles,
    generer,
    poids,
    quotas_parties,
    seuil_sequences_basses,
)

CLASSES = ("6e", "5e", "4e", "3e", "2nde", "1ere", "terminale")
SEQ3 = ("SEQUENCE 1", "SEQUENCE 2", "SEQUENCE 3")
SEQ6 = tuple(f"SEQUENCE {i}" for i in range(1, 7))


def ex(
    id: str,
    *,
    classes: tuple[str, ...] = ("terminale",),
    partie: str = "p1",
    session: int | None = 1,
    matiere: str = "MATHS",
    series: tuple[str, ...] = (),
    niveau: str = "Moyen",
    tag_examen: bool = False,
) -> ExerciceBanque:
    return ExerciceBanque(
        id=id,
        partie_id=partie,
        classes=classes,
        matieres=(matiere,),
        series=series,
        session=session,
        niveau=niveau,
        tag_examen=tag_examen,
    )


def params(**kw) -> Parametres:
    base = dict(
        matiere="MATHS",
        classe="terminale",
        mode="vide",
        sequences_connues=SEQ6,
        classes=CLASSES,
    )
    base.update(kw)
    return Parametres(**base)


def ids(lot) -> list[str]:
    return [e.id for e in lot]


# ---------------------------------------------------------------------------
# Paramètres et garde-fous
# ---------------------------------------------------------------------------

def test_nombre_d_exercices_par_difficulte():
    """Cahier 2.1 : Moyen = 4, Difficile = 6 ; Facile = 2 (seul pair restant)."""
    assert N_PAR_DIFFICULTE == {"Facile": 2, "Moyen": 4, "Difficile": 6}


def test_ponderation_7_4_exacte():
    """Table 7.4 : la pondération oriente le tirage, elle n'exclut rien."""
    attendu = {
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
    assert POIDS == attendu
    for (difficulte, niveau), poids_attendu in attendu.items():
        assert poids(difficulte, niveau) == poids_attendu
    # Niveau inconnu : jamais une exclusion, un poids neutre.
    assert poids("Moyen", "Inconnu") == 1


def test_parametres_invalides_refuses():
    with pytest.raises(ValueError):
        params(mode="hasard")
    with pytest.raises(ValueError):
        params(difficulte="Expert")
    with pytest.raises(ValueError):
        params(mode="sequence", sequence=None)
    with pytest.raises(ValueError):
        params(sequence=0)
    with pytest.raises(ValueError):
        ex("x", classes=())


def test_seuil_sequences_basses_suit_le_referentiel():
    """Jamais le littéral 6 : le seuil est « l'avant-dernière séquence »."""
    assert seuil_sequences_basses(SEQ6) == 5
    assert seuil_sequences_basses(SEQ3) == 2
    assert seuil_sequences_basses(("SEQUENCE 1",)) == 1
    assert seuil_sequences_basses(()) == 1


# ---------------------------------------------------------------------------
# 4.0 — tableau d'éligibilité session demandée × session de l'exercice
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "mode,sequence,session,tag,attendu",
    [
        # Séquence demandée 3 : éligible si session <= 3, tagué ou non.
        ("sequence", 3, 1, False, True),
        ("sequence", 3, 3, False, True),
        ("sequence", 3, 3, True, True),
        ("sequence", 3, 4, False, False),
        ("sequence", 3, None, False, False),
        ("sequence", 3, None, True, False),
        # Examen / examen blanc : tag obligatoire, session vide toujours admise.
        ("examen", None, 2, False, False),
        ("examen", None, 2, True, True),
        ("examen", None, None, False, True),
        ("examen_blanc", None, 5, True, True),
        ("examen_blanc", None, 5, False, False),
        # Session vide demandée : toutes les séquences et la session vide.
        ("vide", None, 1, False, True),
        ("vide", None, 6, False, True),
        ("vide", None, None, False, True),
    ],
)
def test_tableau_4_0(mode, sequence, session, tag, attendu):
    e = ex("e1", session=session, tag_examen=tag)
    pool = eligibles([e], params(mode=mode, sequence=sequence))
    assert bool(pool) is attendu


def test_session_vide_exclue_des_epreuves_de_sequence():
    """Même en difficulté Facile, une session vide ne entre jamais dans une
    épreuve de séquence (4.0, note de priorité)."""
    e = ex("e1", session=None, tag_examen=True)
    for difficulte in ("Facile", "Moyen", "Difficile"):
        pool = eligibles([e], params(mode="sequence", sequence=3, difficulte=difficulte))
        assert pool == []


# ---------------------------------------------------------------------------
# 4.a — parties différentes, trois exceptions
# ---------------------------------------------------------------------------

def test_4_a_parties_distinctes_quand_p_superieur_a_n():
    """Exception 3 : P > N → N parties tirées, chacune une fois."""
    banque = [ex(f"e{i}", partie=f"p{i}") for i in range(5)]
    rng = random.Random(1)
    tires, _ = composer(eligibles(banque, params()), params(), rng)
    assert len(tires) == 4
    assert len({e.partie_id for e in tires}) == 4


def test_4_a_reutilisation_quand_p_inferieur_a_n():
    """Exception 2 : P < N → q, r = divmod(N, P) ; r parties reçoivent q+1."""
    banque = [
        ex(f"a{i}", partie="pa", session=i + 1) for i in range(4)
    ] + [ex(f"b{i}", partie="pb", session=i + 1) for i in range(4)]
    p = params()
    for graine in range(20):
        tires, evenements = composer(eligibles(banque, p), p, random.Random(graine))
        assert len(tires) == 4
        assert INCOMPLETE_EXAM not in evenements
        comptes = {}
        for e in tires:
            comptes[e.partie_id] = comptes.get(e.partie_id, 0) + 1
        assert sorted(comptes.values()) == [2, 2]


def test_4_a_trois_parties_pour_quatre_exercices():
    """N=4, P=3 → q=1, r=1 → une partie utilisée 2 fois, deux une fois."""
    banque = [
        ex(f"{partie}{i}", partie=partie, session=i + 1)
        for partie in ("pa", "pb", "pc")
        for i in range(4)
    ]
    p = params()
    for graine in range(20):
        tires, evenements = composer(eligibles(banque, p), p, random.Random(graine))
        assert len(tires) == 4
        assert INCOMPLETE_EXAM not in evenements
        comptes = {}
        for e in tires:
            comptes[e.partie_id] = comptes.get(e.partie_id, 0) + 1
        assert sorted(comptes.values()) == [1, 1, 2]


def test_4_a_partie_unique_levée():
    """Exception 1 : une seule partie → toute l'épreuve peut en venir."""
    banque = [ex(f"e{i}", partie="seule", session=i + 1) for i in range(6)]
    p = params(difficulte="Difficile")
    tires, evenements = composer(eligibles(banque, p), p, random.Random(3))
    assert len(tires) == 6
    assert INCOMPLETE_EXAM not in evenements


def test_quotas_parties_distribution():
    """La distribution 4.a est calculée, pas devinée."""
    rng = random.Random(0)
    assert quotas_parties([], 4, rng) == {}
    assert quotas_parties(["a"], 4, rng) == {"a": 4}
    assert quotas_parties(["a", "b"], 4, rng) == {"a": 2, "b": 2}
    assert quotas_parties(["a", "b", "c"], 4, rng) in (
        {"a": 2, "b": 1, "c": 1},
        {"a": 1, "b": 2, "c": 1},
        {"a": 1, "b": 1, "c": 2},
    )
    assert quotas_parties(["a", "b", "c", "d", "e"], 4, rng) == {
        "a": 1, "b": 1, "c": 1, "d": 1, "e": 1
    }


def test_4_a_pas_de_doublon_d_exercice():
    """Tirage sans remise : un exercice n'apparaît jamais deux fois."""
    banque = [ex(f"e{i}", partie="p1") for i in range(10)]
    p = params()
    tires, _ = composer(eligibles(banque, p), p, random.Random(7))
    assert len(ids(tires)) == len(set(ids(tires)))


# ---------------------------------------------------------------------------
# 4.b / 4.c — périmètre des séquences des classes inférieures
# ---------------------------------------------------------------------------

def test_4_b_classe_demandee_sequences_inferieures_ou_egales():
    banque = [ex(f"e{s}", session=s) for s in (1, 2, 3, 4)]
    pool = eligibles(banque, params(mode="sequence", sequence=2))
    assert ids(pool) == ["e1", "e2"]


def test_4_b_classe_inferieure_limitée_aux_deux_dernières():
    """Séquence 1 d'une classe inférieure interdite, même si la séquence
    demandée est 3 (4.b prime sur le tableau 4.0)."""
    basse = ex("e1", classes=("1ere",), session=1)
    haute = ex("e2", classes=("1ere",), session=2)
    pool = eligibles(
        [basse, haute],
        params(mode="sequence", sequence=3, difficulte="Facile", sequences_connues=SEQ3),
    )
    assert ids(pool) == ["e2"]


def test_4_c_exercice_tagué_examen_d_une_classe_inferieure_reste_limite():
    """« Même tagué Examen » (4.0, note de priorité)."""
    e = ex("e1", classes=("1ere",), session=1, tag_examen=True)
    assert eligibles([e], params(mode="examen", difficulte="Facile")) == []


def test_4_h_classe_inferieure_examen_exige_le_tag():
    """4.h s'ajoute à 4.b : une séquence haute non taguée reste exclue."""
    non_tague = ex("e1", classes=("1ere",), session=6)
    tague = ex("e2", classes=("1ere",), session=6, tag_examen=True)
    pool = eligibles([non_tague, tague], params(mode="examen", difficulte="Facile"))
    assert ids(pool) == ["e2"]


# ---------------------------------------------------------------------------
# 4.d / 4.l — spécialité « Aucune » et classe inférieure sans spécialité
# ---------------------------------------------------------------------------

def test_4_d_specialite_aucune_est_universelle():
    universel = ex("e1", series=(SPECIAL_AUCUNE,))
    assert eligibles([universel], params(serie="C")) != []
    assert eligibles([universel], params(serie=None)) != []


def test_4_d_specialite_demandee_filtre_les_autres():
    c = ex("e1", series=("C",))
    d = ex("e2", series=("D",))
    pool = eligibles([c, d], params(serie="C"))
    assert ids(pool) == ["e1"]


def test_sans_specialite_tout_est_visible():
    c = ex("e1", series=("C",))
    d = ex("e2", series=("D",))
    assert ids(eligibles([c, d], params(serie=None))) == ["e1", "e2"]


def test_4_l_classe_inferieure_sans_specialite_exclue():
    """4.l : classe inférieure sans spécialité + élève avec spécialité → exclu."""
    sans_specialite = ex("e1", classes=("1ere",), session=6, series=("C",))
    p = params(serie="C", difficulte="Facile")
    assert eligibles([sans_specialite], p) == []


def test_4_d_prime_sur_4_l():
    """Un exercice tagué Aucune reste éligible, même en classe inférieure sans
    spécialité."""
    universel = ex("e1", classes=("1ere",), session=6, series=(SPECIAL_AUCUNE,))
    p = params(serie="C", difficulte="Facile")
    assert ids(eligibles([universel], p)) == ["e1"]


def test_4_l_classe_inferieure_avec_specialite_obligatoire_accepte():
    e = ex("e1", classes=("1ere",), session=6, series=("C",))
    p = params(
        serie="C",
        difficulte="Facile",
        classes_meta={"1ere": ClasseMeta(specialite_obligatoire=True)},
    )
    assert ids(eligibles([e], p)) == ["e1"]


# ---------------------------------------------------------------------------
# 4.e / 4.f / 4.k — profondeur de remontée et politique par difficulté
# ---------------------------------------------------------------------------

def test_4_e_sans_examen_remontee_d_un_niveau():
    assert classes_eligibles(params(classe="terminale")) == ["terminale", "1ere"]


def test_4_e_avec_examen_remontee_de_deux_niveaux():
    p = params(classe="terminale", classes_meta={"terminale": ClasseMeta(a_examen=True)})
    assert classes_eligibles(p) == ["terminale", "1ere", "2nde"]


def test_4_e_difficile_aucune_remontee():
    p = params(
        difficulte="Difficile",
        classes_meta={"terminale": ClasseMeta(a_examen=True)},
    )
    assert classes_eligibles(p) == ["terminale"]


def test_4_e_bord_de_chaine():
    """La classe la plus basse ne remonte nulle part (cas limite §6)."""
    assert classes_eligibles(params(classe="6e")) == ["6e"]


def test_4_k_facile_accepte_les_deux_dernières_sequences_inferieures():
    deux = ex("e2", classes=("1ere",), session=5)
    derniere = ex("e3", classes=("1ere",), session=6)
    pool = eligibles([deux, derniere], params(difficulte="Facile"))
    assert ids(pool) == ["e2", "e3"]


def test_4_k_moyen_restreint_a_la_derniere_sequence_inferieure():
    """4.k renforce 4.b : en Moyen, le recours aux classes inférieures se
    limite à la DERNIÈRE séquence, pas aux deux dernières."""
    deux = ex("e2", classes=("1ere",), session=5)
    derniere = ex("e3", classes=("1ere",), session=6)
    pool = eligibles([deux, derniere], params(difficulte="Moyen"))
    assert ids(pool) == ["e3"]


def test_4_f_un_seul_exercice_par_niveau_inferieur():
    banque = [
        ex(f"t{i}", partie=f"pt{i}", session=1) for i in range(3)
    ] + [
        ex("p1", classes=("1ere",), partie="pp1", session=6),
        ex("p2", classes=("1ere",), partie="pp2", session=6),
        ex("s1", classes=("2nde",), partie="ps1", session=6),
        ex("s2", classes=("2nde",), partie="ps2", session=6),
    ]
    p = params(difficulte="Facile", classes_meta={"terminale": ClasseMeta(a_examen=True)})
    for graine in range(30):
        tires, _ = composer(eligibles(banque, p), p, random.Random(graine))
        par_classe = {}
        for e in tires:
            c = classe_effective(e, p)
            par_classe[c] = par_classe.get(c, 0) + 1
        assert par_classe.get("1ere", 0) <= 1
        assert par_classe.get("2nde", 0) <= 1


def test_compensation_4_g_ne_pioche_jamais_dans_les_classes_inferieures():
    """4.g : déficit impossible à combler dans la classe demandée → épreuve
    incomplète, la classe inférieure ne compense pas, phase 2b sautée."""
    banque = [
        ex("t1", partie="pt1", session=3),
        ex("t2", partie="pt2", session=3),
        ex("t3", partie="pt3", session=1),
        ex("i1", classes=("1ere",), partie="pi1", session=6),
        ex("i2", classes=("1ere",), partie="pi2", session=6),
    ]
    p = params(mode="sequence", sequence=3, difficulte="Difficile")
    tires, evenements = composer(eligibles(banque, p), p, random.Random(0))
    assert RULE_50_RELAXED in evenements
    assert INCOMPLETE_EXAM in evenements
    # Phase 1 : 2 exercices de la séquence exacte. Phase 2a : la classe
    # demandée ne peut fournir que t3 → cible atteinte (3), mais N=6 est
    # inatteignable sans les classes inférieures interdites en Difficile.
    assert set(ids(tires)) == {"t1", "t2", "t3"}


def test_4_g_relachement_compense_par_la_classe_demandee():
    """Déficit comblé par une autre séquence de la classe demandée : 4.g est
    relâchée, l'épreuve reste complète."""
    banque = [
        ex("t1", partie="pt1", session=3),
        ex("t2", partie="pt2", session=1),
        ex("t3", partie="pt3", session=2),
        ex("t4", partie="pt4", session=2),
    ]
    p = params(mode="sequence", sequence=3, difficulte="Moyen")
    tires, evenements = composer(eligibles(banque, p), p, random.Random(5))
    assert len(tires) == 4
    assert RULE_50_RELAXED in evenements
    assert INCOMPLETE_EXAM not in evenements


def test_4_g_tirage_exact_en_premier():
    """Phase 1 : au moins N/2 exercices de la séquence exacte quand la banque
    le permet, et aucun relâchement."""
    banque = [
        ex("t1", partie="pt1", session=3),
        ex("t2", partie="pt2", session=3),
        ex("t3", partie="pt3", session=3),
        ex("t4", partie="pt4", session=1),
        ex("t5", partie="pt5", session=2),
    ]
    p = params(mode="sequence", sequence=3, difficulte="Moyen")
    for graine in range(20):
        tires, evenements = composer(eligibles(banque, p), p, random.Random(graine))
        exacts = [e for e in tires if e.session == 3]
        assert len(exacts) >= 2
        assert RULE_50_RELAXED not in evenements


def test_epreuve_incomplete_quand_banque_insuffisante():
    banque = [ex("e1", partie="p1")]
    p = params(difficulte="Moyen")
    tires, evenements = composer(eligibles(banque, p), p, random.Random(0))
    assert len(tires) == 1
    assert INCOMPLETE_EXAM in evenements


def test_banque_vide_ne_leve_jamais():
    """Cas limite §6 : aucune erreur bloquante, épreuve vide silencieuse."""
    p = params()
    tires, evenements = composer(eligibles([], p), p, random.Random(0))
    assert tires == []
    assert evenements == [INCOMPLETE_EXAM]


# ---------------------------------------------------------------------------
# 4.i — unicité bornée
# ---------------------------------------------------------------------------

def test_unicite_evite_une_combinaison_deja_vue():
    banque = [ex(f"e{i}", partie=f"p{i}") for i in range(6)]
    p = params(difficulte="Moyen")
    premier, _ = generer(banque, p, random.Random(0))
    historique = [canonique(e.id for e in premier)]
    for graine in range(1, 30):
        tires, evenements = generer(banque, p, random.Random(graine), historique)
        if canonique(e.id for e in tires) != historique[0]:
            assert UNIQUENESS_SATURATED not in evenements
            return
    pytest.fail("aucune combinaison inédite trouvée alors que la banque le permet")


def test_unicite_saturee_apres_la_borne():
    """Banque minuscule : une seule combinaison possible → au-delà de
    `max_tentatives`, l'épreuve est rendue quand même, signalée."""
    banque = [ex(f"e{i}", partie=f"p{i}") for i in range(4)]
    p = params(difficulte="Moyen")
    premier, _ = generer(banque, p, random.Random(0))
    tires, evenements = generer(
        banque, p, random.Random(0), [canonique(e.id for e in premier)]
    )
    assert canonique(e.id for e in tires) == canonique(e.id for e in premier)
    assert UNIQUENESS_SATURATED in evenements
    assert MAX_TENTATIVES == 20


def test_unicite_bornee_respecte_max_tentatives():
    banque = [ex(f"e{i}", partie=f"p{i}") for i in range(4)]
    p = params(difficulte="Moyen")
    premier, _ = generer(banque, p, random.Random(0))
    tires, evenements = generer(
        banque, p, random.Random(0), [canonique(e.id for e in premier)], max_tentatives=1
    )
    assert UNIQUENESS_SATURATED in evenements
    assert len(tires) == 4


def test_canonique_ignore_l_ordre_mais_pas_le_multiensemble():
    assert canonique(["b", "a"]) == canonique(["a", "b"])
    assert canonique(["a", "a"]) != canonique(["a", "b"])


# ---------------------------------------------------------------------------
# Propriétés sur 1000 tirages
# ---------------------------------------------------------------------------

def _banque_riche(n_par_classe: int = 12) -> list[ExerciceBanque]:
    banque: list[ExerciceBanque] = []
    for classe in CLASSES:
        for i in range(n_par_classe):
            banque.append(
                ex(
                    f"{classe}-{i}",
                    classes=(classe,),
                    # Une partie par exercice : P = 12 > N pour toutes les
                    # difficultés, ce qui exerce l'exception 3 de 4.a.
                    partie=f"p{classe}-{i}",
                    session=(i % len(SEQ6)) + 1,
                    niveau=("Facile", "Moyen", "Difficile")[i % 3],
                    series=("C",) if i % 4 else (SPECIAL_AUCUNE,),
                    tag_examen=bool(i % 2),
                )
            )
    return banque


@pytest.mark.parametrize("difficulte", ["Facile", "Moyen", "Difficile"])
@pytest.mark.parametrize("mode,sequence", [("sequence", 3), ("examen", None), ("vide", None)])
def test_proprietes_sur_1000_tirages(difficulte, mode, sequence):
    """Aucune contrainte pédagogique violée, quel que soit le chemin de tirage."""
    banque = _banque_riche()
    p = params(
        mode=mode,
        sequence=sequence,
        difficulte=difficulte,
        serie="C",
        classes_meta={"terminale": ClasseMeta(a_examen=True)},
    )
    pool = eligibles(banque, p)
    assert pool, "la banque de test doit alimenter le pool"

    rng = random.Random(2026)
    for _ in range(1000):
        tires, evenements = composer(pool, p, rng)

        # Sans remise global.
        assert len(ids(tires)) == len(set(ids(tires)))
        # Jamais plus que N.
        assert len(tires) <= p.n
        # Tous éligibles (4.0 + 4.b + 4.c + 4.d + 4.e + 4.k + 4.l).
        assert all(e.id in {c.id for c in pool} for e in tires)

        par_classe: dict[str, list[str]] = {}
        for e in tires:
            c = classe_effective(e, p)
            assert c in classes_eligibles(p)
            par_classe.setdefault(c or "?", []).append(e.id)

        # 4.f : un exercice au plus par niveau inférieur.
        for classe, lot in par_classe.items():
            if classe != p.classe:
                assert len(lot) <= 1

        # 4.g : N/2 exercices de la séquence exacte quand la banque le permet.
        exacts_dispo = [e for e in pool if e.session == sequence]
        if mode == "sequence" and len(exacts_dispo) >= p.n // 2:
            assert len([e for e in tires if e.session == sequence]) >= p.n // 2
            assert RULE_50_RELAXED not in evenements


def test_propriete_4_a_quotas_respectes_sur_1000_tirages():
    banque = _banque_riche()
    p = params(difficulte="Difficile", serie="C")
    pool = eligibles(banque, p)
    # P > N ici : chaque partie au plus une fois.
    parties_dispo = {e.partie_id for e in pool}
    assert len(parties_dispo) > p.n

    rng = random.Random(11)
    for _ in range(1000):
        tires, _ = composer(pool, p, rng)
        assert len({e.partie_id for e in tires}) == len(tires)

    rng = random.Random(11)
    for _ in range(1000):
        tires, _ = composer(pool, p, rng)
        assert len({e.partie_id for e in tires}) == len(tires)


def test_propriete_4_a_quand_p_inferieur_a_n():
    banque = [
        ex(f"{partie}{i}", partie=partie, session=i + 1)
        for partie in ("pa", "pb", "pc")
        for i in range(5)
    ]
    p = params(difficulte="Difficile")
    pool = eligibles(banque, p)
    rng = random.Random(12)
    for _ in range(1000):
        tires, evenements = composer(pool, p, rng)
        assert len(tires) == 6
        comptes = {}
        for e in tires:
            comptes[e.partie_id] = comptes.get(e.partie_id, 0) + 1
        # N=6, P=3 → q=2, r=0 → 2 par partie.
        assert sorted(comptes.values()) == [2, 2, 2]
        assert INCOMPLETE_EXAM not in evenements


# ---------------------------------------------------------------------------
# Différentiel 3 séquences (référentiel réel) vs 6 séquences (hypothèse)
# ---------------------------------------------------------------------------

def test_differentiel_sequences_basses_3_vs_6():
    """Rien n'est codé en dur sur 6 : les classes inférieures suivent les deux
    DERNIÈRES séquences du référentiel fourni."""
    for sequences, seuil in ((SEQ3, 2), (SEQ6, 5)):
        for session in range(1, len(sequences) + 1):
            e = ex(f"e{session}", classes=("1ere",), session=session)
            pool = eligibles([e], params(difficulte="Facile", sequences_connues=sequences))
            attendu = session >= seuil
            assert bool(pool) is attendu, (len(sequences), session)


def test_differentiel_moyen_derniere_sequence_3_vs_6():
    """En Moyen, la dernière séquence seulement — quel que soit le référentiel."""
    for sequences, derniere in ((SEQ3, 3), (SEQ6, 6)):
        for session in range(1, len(sequences) + 1):
            e = ex(f"e{session}", classes=("1ere",), session=session)
            pool = eligibles([e], params(difficulte="Moyen", sequences_connues=sequences))
            assert bool(pool) is (session == derniere), (len(sequences), session)


def test_differentiel_composition_complete():
    """Les mêmes paramètres produisent une épreuve complète et conforme dans
    les deux référentiels (aucune dépendance à la longueur)."""
    for sequences in (SEQ3, SEQ6):
        banque = [
            ex(f"t{i}", partie=f"pt{i}", session=(i % len(sequences)) + 1)
            for i in range(6)
        ] + [
            ex(f"i{i}", classes=("1ere",), partie=f"pi{i}", session=len(sequences))
            for i in range(3)
        ]
        p = params(
            difficulte="Moyen",
            sequences_connues=sequences,
            mode="vide",
            sequence=None,
        )
        tires, evenements = composer(eligibles(banque, p), p, random.Random(4))
        assert len(tires) == 4
        assert INCOMPLETE_EXAM not in evenements
        inferieurs = [e for e in tires if "1ere" in e.classes]
        assert len(inferieurs) <= 1


# ---------------------------------------------------------------------------
# Robustesse : la combinaison de toutes les règles ne boucle pas
# ---------------------------------------------------------------------------

def test_aucun_chemin_ne_boucle_sur_les_petits_pools():
    """Balayage exhaustif de petites banques : la génération termine toujours
    et ne dépasse jamais N."""
    petites = [
        [ex("a", partie="pa", session=1)],
        [ex("a", partie="pa", session=1), ex("b", partie="pa", session=2)],
        [ex("a", partie="pa", session=None, tag_examen=True)],
        [ex("a", classes=("1ere",), partie="pa", session=6)],
    ]
    for banque in petites:
        for mode, sequence in (("sequence", 1), ("sequence", 3), ("examen", None), ("vide", None)):
            for difficulte in ("Facile", "Moyen", "Difficile"):
                p = params(mode=mode, sequence=sequence, difficulte=difficulte)
                tires, evenements = composer(eligibles(banque, p), p, random.Random(0))
                assert len(tires) <= p.n
                assert all(ev in (RULE_50_RELAXED, INCOMPLETE_EXAM) for ev in evenements)
