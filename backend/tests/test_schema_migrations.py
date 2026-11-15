"""Réparation du schéma au démarrage sur une base EXISTANTE en retard.

Contexte (panne de production du 15/11/2026) : `Base.metadata.create_all`
ne crée que les tables absentes, jamais une colonne. Une base déployée avant
le chantier « matricule + monnaie AK » n'avait donc ni `plans.prix_ak`, ni
`users.matricule` / `users.solde_ak`. Résultat observable :

- `GET /api/pricing` → `500` (`UndefinedColumn: plans.prix_ak`) ;
- connexion / chaque requête authentifiée → `500` sur `users.matricule`.

Ces tests utilisent une base **jetable** (table `plans` volontairement sans
`prix_ak`) et non la base partagée de `conftest`, pour prouver le rattrapage
sans dépendre de l'ordre d'exécution de la suite.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app.core import schema_migrations
from app.core.plans import plans_actifs
from app.db_models import Base, PlanORM, UserORM

@pytest.fixture()
def base_en_retard(tmp_path):
    """Base complète, puis amputée des colonnes du chantier AK.

    On part du schéma courant (pour avoir `users` avec toutes ses autres
    colonnes) et on retire celles qui n'existaient pas en production —
    exactement l'état d'une base déployée avant la refonte.
    """
    moteur = create_engine(f"sqlite:///{(tmp_path / 'retard.db').as_posix()}")
    Base.metadata.create_all(bind=moteur)
    Session = sessionmaker(bind=moteur)

    with Session() as db:
        db.add(UserORM(email="ancien@test.cm", nom="Ancien"))
        db.add(PlanORM(scope="epreuve", libelle="Une épreuve", prix=400, ordre=0, prix_ak=25))
        db.commit()

    with moteur.begin() as conn:
        for instruction in (
            "DROP INDEX IF EXISTS ix_users_matricule",
            "DROP INDEX IF EXISTS ix_plans_scope",
            "ALTER TABLE payments DROP COLUMN monnaie",
            "ALTER TABLE plans DROP COLUMN prix_ak",
            "ALTER TABLE users DROP COLUMN matricule",
            "ALTER TABLE users DROP COLUMN solde_ak",
            "ALTER TABLE users DROP COLUMN ak_serie_jours",
            "ALTER TABLE users DROP COLUMN ak_dernier_jour",
            "DROP TABLE ak_mouvements",
        ):
            conn.execute(text(instruction))

    # Sanity check : la base est bien celle d'avant le chantier.
    colonnes = {c["name"] for c in inspect(moteur).get_columns("plans")}
    assert "prix_ak" not in colonnes

    yield moteur, Session
    moteur.dispose()


def test_base_en_retard_casse_vraiment_la_lecture_des_plans(base_en_retard):
    """Sans réparation, l'ORM échoue — c'est la panne constatée en production."""
    moteur, Session = base_en_retard
    with Session() as db:
        with pytest.raises(Exception) as excinfo:
            plans_actifs(db)
    assert "prix_ak" in str(excinfo.value)


def test_reparation_ajoute_les_colonnes_du_chantier_ak(base_en_retard):
    moteur, Session = base_en_retard

    applique = schema_migrations.reparer_schema(moteur)
    assert set(applique["ajoutees"]) >= {
        "users.matricule",
        "users.solde_ak",
        "users.ak_serie_jours",
        "users.ak_dernier_jour",
        "plans.prix_ak",
        "payments.monnaie",
    }

    assert "prix_ak" in {c["name"] for c in inspect(moteur).get_columns("plans")}
    assert "solde_ak" in {c["name"] for c in inspect(moteur).get_columns("users")}


def test_pricing_devient_lisible_apres_reparation(base_en_retard):
    """Le contrat de `/api/pricing` : des formules avec un prix AK."""
    moteur, Session = base_en_retard

    schema_migrations.reparer_schema(moteur)
    schema_migrations.assurer_index(moteur)
    with Session() as db:
        schema_migrations.retrofill_prix_ak(db)

    with Session() as db:
        plans = plans_actifs(db)
        assert [(p.scope, p.prix) for p in plans] == [("epreuve", 400)]
        # Le rétrofill applique le prix AK par défaut, sans écraser un choix admin.
        assert plans[0].prix_ak == 25


def test_retrofill_matricule_donne_un_identifiant_aux_comptes_anciens(base_en_retard):
    moteur, Session = base_en_retard

    schema_migrations.reparer_schema(moteur)
    schema_migrations.assurer_index(moteur)
    with Session() as db:
        assert schema_migrations.retrofill_matricules(db) == 1

    with Session() as db:
        user = db.query(UserORM).one()
        assert user.matricule and user.matricule.startswith("CC-")
        # Colonne NOT NULL DEFAULT 0 : les comptes anciens partent de zéro.
        assert user.solde_ak == 0


def test_reparation_est_idempotente(base_en_retard):
    """Rejouer au démarrage suivant ne doit rien casser ni rien réécrire."""
    moteur, Session = base_en_retard

    premier = schema_migrations.reparer_schema(moteur)
    assert premier["ajoutees"]

    second = schema_migrations.reparer_schema(moteur)
    assert second == {"renommees": [], "ajoutees": []}

    assert schema_migrations.assurer_index(moteur)  # premier passage : les crée
    assert schema_migrations.assurer_index(moteur) == []  # second : ne fait rien

    with Session() as db:
        assert schema_migrations.retrofill_matricules(db) == 1
        assert schema_migrations.retrofill_prix_ak(db) == 1
    with Session() as db:
        # Rejoués au démarrage suivant : plus rien à compléter.
        assert schema_migrations.retrofill_matricules(db) == 0
        assert schema_migrations.retrofill_prix_ak(db) == 0


def test_renommage_des_anciennes_colonnes_de_plans(tmp_path):
    """Une base encore sur `nom_fr`/`description_fr` est remise à niveau."""
    moteur = create_engine(f"sqlite:///{(tmp_path / 'ancienne.db').as_posix()}")
    with moteur.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE plans ("
                "id VARCHAR(32) PRIMARY KEY, scope VARCHAR(32) NOT NULL, "
                "nom_fr VARCHAR(255) NOT NULL, nom_en VARCHAR(255) NOT NULL DEFAULT '', "
                "description_fr VARCHAR(1024) NOT NULL DEFAULT '', "
                "description_en VARCHAR(1024) NOT NULL DEFAULT '', "
                "prix INTEGER NOT NULL, duree_jours INTEGER NOT NULL DEFAULT 365, "
                "actif BOOLEAN NOT NULL DEFAULT 1, ordre INTEGER NOT NULL DEFAULT 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO plans (id, scope, nom_fr, prix, ordre) "
                "VALUES ('p1', 'epreuve', 'Une épreuve', 400, 0)"
            )
        )

    schema_migrations.reparer_schema(moteur)
    colonnes = {c["name"] for c in inspect(moteur).get_columns("plans")}

    assert {"libelle", "libelle_en", "description"} <= colonnes
    assert "nom_fr" not in colonnes
    assert "prix_ak" in colonnes
    moteur.dispose()
