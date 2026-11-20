"""The MSF catalog: one track, the source, whose x-fec names the repair rungs."""
from types import SimpleNamespace

from fecmoq.media import catalog_dict, catalog_json

MEDIA = SimpleNamespace(codec="av01.0.04M.08", width=640, height=360, blocks_per_gop=1)


def test_rungs_only_in_x_fec():
    cat = catalog_dict(catalog_json(MEDIA, n_objects=12, gap_s=0.4, rungs=[0.15] * 3, symbol_size=1100))
    assert [(t["name"], t["packaging"]) for t in cat["tracks"]] == [("src", "loc")]
    fec = cat["tracks"][0]["x-fec"]
    assert fec["rungs"] == ["rep1", "rep2", "rep3"]
    assert fec["rungFractions"] == [0.15, 0.15, 0.15]
