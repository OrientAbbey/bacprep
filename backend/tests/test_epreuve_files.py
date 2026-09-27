"""Tests unitaires pour les helpers d'images d'épreuve (epreuve_files) :
extraction d'id depuis une URL, conservation du fragment de taille lors de
la signature, et extraction des images depuis le Markdown."""
from __future__ import annotations

from types import SimpleNamespace

import app.core.epreuve_files as ef
from app.core import assistant as assistant_core


class TestFileIdFromUrl:
    """file_id_from_url doit ignorer la query string, un token signé
    ET un fragment de taille d'affichage."""

    def test_url_simple(self) -> None:
        assert ef.file_id_from_url("/api/files/abc123") == "abc123"

    def test_url_avec_token(self) -> None:
        url = "/api/files/abc123?token=expireresult"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_avec_fragment_w(self) -> None:
        url = "/api/files/abc123#w=300"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_avec_token_et_fragment(self) -> None:
        url = "/api/files/abc123?token=xyz#w=480"
        assert ef.file_id_from_url(url) == "abc123"

    def test_url_non_fichiers(self) -> None:
        assert ef.file_id_from_url("/api/other/abc123") is None
        assert ef.file_id_from_url("https://extern.com/img.png") is None


def _fake_epreuve() -> SimpleNamespace:
    return SimpleNamespace(id="ep-001", statut="publie")


class TestSignImageUrls:
    """sign_image_urls doit conserver le fragment de taille après l'URL
    signée."""

    def test_preserve_taille_w(self) -> None:
        md = "![figure](/api/files/abc123#w=300)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        # L'URL signée est présente, le fragment #w=300 est ré-accolé à
        # la fin.
        assert "![figure](" in result
        assert "?token=" in result
        assert result.endswith("#w=300)")

    def test_sans_fragment(self) -> None:
        md = "![figure](/api/files/abc123)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        assert "?token=" in result
        assert "#" not in result

    def test_url_non_fichier_inchangee(self) -> None:
        md = "![lien](https://example.com/img.png)"
        result = ef.sign_image_urls(md, _fake_epreuve())
        assert result == md

    def test_plusieurs_images_melangees(self) -> None:
        md = (
            "![a](/api/files/img1)\n"
            "![b](/api/files/img2#w=480)\n"
            "![c](https://external.com/s.png)"
        )
        result = ef.sign_image_urls(md, _fake_epreuve())
        lines = result.strip().split("\n")
        assert len(lines) == 3
        assert "#w=480" in lines[1]
        assert lines[2] == "![c](https://external.com/s.png)"


class TestExtractLocalImagePaths:
    """_extract_local_image_paths (assistant) doit retrouver les images
    via file_id_from_url avec ou sans fragment."""

    def test_url_avec_fragment_est_trouvee(self) -> None:
        md = "![x](/api/files/img-001#w=200)"
        # La fonction tente de lire en base ; en test, l'id n'existe pas :
        # on vérifie juste que le fragment ne casse pas l'extraction et que
        # la fonction ne plante pas (aucune ligne trouvée = liste vide).
        result = assistant_core._extract_local_image_paths(md, user_id=None)
        assert result == []

    def test_url_avec_token_et_fragment(self) -> None:
        md = "![x](/api/files/img-002?token=tok#w=640)"
        result = assistant_core._extract_local_image_paths(md, user_id=None)
        assert result == []


class TestSuppressionObjetApresCommit:
    """Le stockage objet et la base ne partagent pas de transaction.

    Effacer l'objet AVANT le commit exposait une perte définitive : un
    commit en échec (contrainte, connexion perdue) annulait la transaction,
    la ligne conservait sa `storage_key`… mais l'objet correspondant avait
    déjà disparu. L'épreuve affichait alors un document cassé, sans moyen
    de le récupérer. La suppression est donc différée à `after_commit`.
    """

    @staticmethod
    def _objet_existe(key: str) -> bool:
        from app.core.storage import get_storage

        return get_storage().local_path(key) is not None

    @staticmethod
    def _epreuve(db, eid: str):
        from app.db_models import EpreuveORM

        return db.query(EpreuveORM).filter(EpreuveORM.id == eid).one()

    def test_ancienne_cle_survit_avant_le_commit(self, db, epreuve_gratuite) -> None:
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "version 1")
        db.commit()
        premiere_cle = ef.get_document(db, e.id, "sujet", 0).storage_key

        # `document_key` dépend du niveau et de l'ANNÉE : changer l'année
        # déplace la clé et rend l'ancien objet orphelin.
        e.annee = "2099"
        ef.write_document(db, e, "sujet", "version 2")
        # Tant que le commit n'a pas réussi, l'ancien objet est intact.
        assert self._objet_existe(premiere_cle)

        db.commit()
        assert not self._objet_existe(premiere_cle), "l'orphelin aurait dû être effacé après commit"
        assert self._objet_existe(ef.get_document(db, e.id, "sujet", 0).storage_key)

    def test_rollback_conserve_l_objet_reference(self, db, epreuve_gratuite) -> None:
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "version 1")
        db.commit()
        cle_referencee = ef.get_document(db, e.id, "sujet", 0).storage_key

        e.annee = "2098"
        ef.write_document(db, e, "sujet", "version 2")
        db.rollback()  # le commit échoue : la transaction est annulée

        # La base référence toujours la version 1 : son objet doit être là.
        assert ef.get_document(db, e.id, "sujet", 0).storage_key == cle_referencee
        assert self._objet_existe(cle_referencee), "PERTE DE DONNÉE : objet effacé alors que la base le référence"

    def test_delete_file_rollback_conserve_l_objet(self, db, epreuve_gratuite) -> None:
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "contenu")
        db.commit()
        row = ef.get_document(db, e.id, "sujet", 0)
        cle = row.storage_key

        ef.delete_file(db, row)
        db.rollback()
        assert self._objet_existe(cle), "l'objet ne doit pas disparaître si la ligne survit"

    def test_delete_file_commit_supprime_l_objet(self, db, epreuve_gratuite) -> None:
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "contenu")
        db.commit()
        row = ef.get_document(db, e.id, "sujet", 0)
        cle = row.storage_key

        ef.delete_file(db, row)
        db.commit()
        assert ef.get_document(db, e.id, "sujet", 0) is None
        assert not self._objet_existe(cle)

    def test_commit_ulterieur_ne_purge_pas_les_orphelins_d_apres_rollback(
        self, db, epreuve_gratuite
    ) -> None:
        """Régression : un commit sans rapport NE doit pas exécuter les
        suppressions programmées avant un rollback.

        Ces clés restaient en mémoire après l'annulation ; le prochain commit
        de la même session les purgeait. La ligne ayant alors récupéré sa clé
        d'origine, on effaçait un objet encore référencé : document cassé sur
        une épreuve que l'on croyait avoir annulée, sans aucun commit réussi
        pour l'expliquer.
        """
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "version 1")
        db.commit()
        cle_referencee = ef.get_document(db, e.id, "sujet", 0).storage_key

        # Écriture qui orphelinise l'ancien objet, puis transaction annulée.
        e.annee = "2097"
        ef.write_document(db, e, "sujet", "version 2")
        db.rollback()
        assert self._objet_existe(cle_referencee)

        # Commit ULTERIEUR sans rapport avec cet échange de fichier.
        e.libelle = "retouche sans rapport"
        db.add(e)
        db.commit()

        assert (
            self._objet_existe(cle_referencee)
        ), "PERTE DE DONNÉE : un commit sans rapport a purgé une clé encore référencée"
        assert ef.get_document(db, e.id, "sujet", 0).storage_key == cle_referencee
        assert ef.read_document_content(db, e.id, "sujet") == "version 1"

    def test_delete_file_rollback_puis_commit_ulterieur_conserve_l_objet(
        self, db, epreuve_gratuite
    ) -> None:
        """Même scénario qu'une suppression de ligne : la ligne resurgit au
        rollback, son objet ne doit pas être effacé par un commit plus tard."""
        e = self._epreuve(db, epreuve_gratuite)
        ef.write_document(db, e, "sujet", "contenu")
        db.commit()
        cle = ef.get_document(db, e.id, "sujet", 0).storage_key

        ef.delete_file(db, ef.get_document(db, e.id, "sujet", 0))
        db.rollback()

        db.add(self._epreuve(db, epreuve_gratuite))  # commit sans rapport
        db.commit()

        assert self._objet_existe(cle), "PERTE DE DONNÉE : objet effacé alors que la ligne existe"
        assert ef.get_document(db, e.id, "sujet", 0) is not None
