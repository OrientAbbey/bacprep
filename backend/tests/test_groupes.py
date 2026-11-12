"""Catalogue regroupé : une entrée par matière × évaluation × classe."""
from __future__ import annotations


def _creer(admin, matiere, annee, evaluation="BAC", classe="terminale", gratuit=True, publier=True):
    r = admin.post("/api/admin/epreuves", json={
        "niveau": "SECONDAIRE", "classe": classe, "evaluation": evaluation, "matiere": matiere,
        "annee": annee, "gratuit": gratuit, "filieres": ["C"], "contenu_markdown": "# S\n\nQ1",
    })
    assert r.status_code == 200, r.text
    eid = r.json()["id"]
    if publier:
        assert admin.post(f"/api/admin/epreuves/{eid}/publish").status_code == 200
    return eid


def test_annees_regroupees_dans_une_seule_carte(admin, eleve):
    ids = [_creer(admin, "Physique", a) for a in ("2021", "2023", "2022")]
    r = eleve.get("/api/epreuves/groupes?matiere=Physique")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["total"] == 1
    g = data["groupes"][0]
    assert (g["matiere"], g["evaluation"], g["classe"], g["nb_epreuves"]) == ("Physique", "BAC", "terminale", 3)
    assert [a["annee"] for a in g["annees"]] == ["2023", "2022", "2021"]  # récentes d'abord
    assert {a["id"] for a in g["annees"]} == set(ids)


def test_evaluation_et_classe_separent_les_groupes(admin, eleve):
    _creer(admin, "Chimie", "2023", evaluation="BAC")
    _creer(admin, "Chimie", "2023", evaluation="SEQUENCE 1")
    _creer(admin, "Chimie", "2023", evaluation="BAC", classe="premiere")
    data = eleve.get("/api/epreuves/groupes?matiere=Chimie").json()
    assert data["total"] == 3 and len(data["groupes"]) == 3


def test_pagination_par_groupe_sans_couper_un_groupe(admin, eleve):
    for m in ("Anglais", "Biologie", "Chimie2"):
        for a in ("2020", "2021"):
            _creer(admin, m, a)
    p1 = eleve.get("/api/epreuves/groupes?limit=2&offset=0&evaluation=BAC&classe=terminale").json()
    p2 = eleve.get("/api/epreuves/groupes?limit=2&offset=2&evaluation=BAC&classe=terminale").json()
    assert p1["total"] >= 3
    assert all(g["nb_epreuves"] == 2 for g in p1["groupes"] + p2["groupes"] if g["matiere"] in ("Anglais", "Biologie", "Chimie2"))
    noms = [g["matiere"] for g in p1["groupes"] + p2["groupes"]]
    assert len(noms) == len(set(noms))  # aucun groupe en double d'une page à l'autre


def test_brouillons_exclus_et_filtres_respectes(admin, eleve):
    _creer(admin, "Latin", "2020", publier=False)
    assert eleve.get("/api/epreuves/groupes?matiere=Latin").json() == {"total": 0, "groupes": []}
    _creer(admin, "Latin", "2021", gratuit=False)
    g = eleve.get("/api/epreuves/groupes?matiere=Latin&acces_type=payant").json()["groupes"][0]
    assert g["nb_epreuves"] == 1 and g["annees"][0]["acces"] == "payant"


def test_visiteur_anonyme_peut_lister(admin, visiteur):
    _creer(admin, "Philo", "2022")
    r = visiteur.get("/api/epreuves/groupes?matiere=Philo")
    assert r.status_code == 200 and r.json()["total"] == 1


def test_limites_validees(eleve):
    assert eleve.get("/api/epreuves/groupes?limit=0").status_code == 422
    assert eleve.get("/api/epreuves/groupes?limit=500").status_code == 422
