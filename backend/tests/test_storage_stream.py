"""Extension en flux du protocole de stockage (Phase 1 du plan
`PLAN_SAUVEGARDES.md`).

L'export de sauvegarde écrit potentiellement plusieurs Go : il ne peut pas
passer par `put_bytes`/`get_bytes`, qui chargent l'objet entier en mémoire. Ces
tests couvrent le contrat `put_stream` / `open_read` et vérifient surtout que
les 4 méthodes historiques n'ont pas régressé.
"""
from __future__ import annotations


import pytest

from app.core.storage import _IterChunks, LocalStorage, normalize_key


@pytest.fixture()
def local(tmp_path) -> LocalStorage:
    return LocalStorage(tmp_path / "stockage")


def _blocs(data: bytes, taille: int = 7) -> list[bytes]:
    """Découpe volontairement irrégulière (dernier bloc plus court) pour
    vérifier qu'aucune frontière n'est supposée."""
    return [data[i: i + taille] for i in range(0, len(data), taille)] or [b""]


def test_put_stream_puis_open_read(local) -> None:
    data = b"".join(bytes([i % 256]) for i in range(50_000))
    local.put_stream("a/b/sujet.md", _blocs(data), size=len(data))
    relu = b"".join(local.open_read("a/b/sujet.md", chunk_size=1024))
    assert relu == data


def test_open_read_vide(local) -> None:
    local.put_bytes("vide.txt", b"")
    assert b"".join(local.open_read("vide.txt")) == b""


def test_taille_incoherente_refusee(local) -> None:
    with pytest.raises(Exception):
        local.put_stream("faux.md", [b"12345"], size=999)


def test_chemin_malveillant_refuse(local) -> None:
    """La garde anti path-traversal doit aussi s'appliquer au flux."""
    for cle in ("../evasion.txt", "/absolu.txt", "a/../../evasion.txt"):
        with pytest.raises(Exception):
            local.put_stream(cle, [b"x"])
    assert not (local.root.parent / "evasion.txt").exists()


def test_methodes_historiques_intactes(local) -> None:
    """`put_bytes`/`get_bytes`/`exists`/`delete` doivent continuer à marcher."""
    local.put_bytes("k.txt", b"bonjour", "text/plain")
    assert local.get_bytes("k.txt") == b"bonjour"
    assert local.exists("k.txt")
    local.delete("k.txt")
    assert not local.exists("k.txt")
    with pytest.raises(Exception):
        local.get_bytes("k.txt")


def test_iter_chunks_reamorce_sur_les_octets_du_solveur() -> None:
    """`_IterChunks` est le pont entre les blocs de zipfile et boto3 : il doit
    rendre exactement les mêmes octets, quelles que soient les tailles
    demandées."""
    data = b"".join(bytes([i % 251]) for i in range(20_000))
    adaptateur = _IterChunks(_blocs(data, 1024))
    assert adaptateur.read(8192) == data[:8192]
    # Asking more than the rest of the stream returns what remains.
    assert adaptateur.read(1_000_000) == data[8192:]
    assert adaptateur.read(10) == b""


def test_iter_chunks_accepte_memoryview(local) -> None:
    """`zipfile` émet parfois des `memoryview` : ils doivent être acceptés."""
    source = [memoryview(b"abc"), bytearray(b"def"), b"ghi"]
    adaptateur = _IterChunks(source)
    assert adaptateur.read(9) == b"abcdefghi"


def test_normalize_key_inchange() -> None:
    assert normalize_key("a\\b\\c.md") == "a/b/c.md"
    with pytest.raises(Exception):
        normalize_key("../x")
