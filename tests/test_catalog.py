"""The MSF catalog: one track, the source, whose x-fec names the repair rungs. The clean track's
objects are the source's frames as CMSF chunks, in the source's groups and at its timestamps."""
import asyncio
import time
from types import SimpleNamespace

from aiomoqt.media.cmaf import chunk_decode_time

import fecmoq.media as fmedia
from fecmoq.media import (LOC_PROP_TIMESTAMP, CmafTrack, MediaBlockSchedule, catalog_dict,
                          catalog_json, unpack_loc_object)

MEDIA = SimpleNamespace(codec="av01.0.04M.08", width=640, height=360, blocks_per_gop=1)


def test_rungs_only_in_x_fec():
    cat = catalog_dict(catalog_json(MEDIA, n_objects=12, gap_s=0.4, rungs=[0.15] * 3, symbol_size=1100))
    assert [(t["name"], t["packaging"]) for t in cat["tracks"]] == [("src", "loc")]
    fec = cat["tracks"][0]["x-fec"]
    assert fec["rungs"] == ["rep1", "rep2", "rep3"]
    assert fec["rungFractions"] == [0.15, 0.15, 0.15]


N, BPG, TIMESCALE = 4, 2, 15360


class FakeGops:
    """Mp4Gops without an mp4: block i is N frames, a keyframe opening each GOP of BPG blocks."""
    blocks_per_gop = BPG
    video = SimpleNamespace(timescale=TIMESCALE)

    def __init__(self, path, n, gop):
        pass

    def block(self, i):
        return [(bytes([i, j]) * 50, j == 0 and i % BPG == 0) for j in range(N)]


class Recorder:
    lanes = ()

    def __init__(self):
        self.writes = []

    async def write(self, group_id, object_id, payload, *, extensions=None, group_start=False):
        self.writes.append((group_id, object_id, payload, group_start))


def _decode_props(props: bytes) -> dict:
    from aiomoqt.messages.base import MOQTMessage
    from aiomoqt.utils.buffer import Buffer
    return MOQTMessage._extensions_decode(Buffer(data=props, vi64=True), with_length=False,
                                          buf_end=len(props), delta=True)


def _clean_run(monkeypatch, n_blocks, gap_s, started_ago=None):
    monkeypatch.setattr(fmedia, "Mp4Gops", FakeGops)
    sch = MediaBlockSchedule(media="-", gop_frames=N * BPG, seed=7, n_blocks=n_blocks,
                             n_objects=N, gap_s=gap_s)
    if started_ago is not None:
        sch.t_start = time.monotonic() - started_ago
    out = Recorder()
    asyncio.run(CmafTrack(SimpleNamespace(), schedule=sch).produce(out))
    return sch, out.writes


def test_clean_track_is_the_source_frames_as_cmaf(monkeypatch):
    sch, writes = _clean_run(monkeypatch, n_blocks=4, gap_s=0.01)
    assert [(g, o) for g, o, _, _ in writes] == [(b // BPG, (b % BPG) * N + i)
                                                for b in range(4) for i in range(N)]
    for k, (g, o, chunk, start) in enumerate(writes):
        b, i = divmod(k, N)
        payload, key = sch.media.block(b)[i]
        assert start == key == (o == 0)
        assert chunk.endswith(payload) and len(chunk) == 108 + len(payload)
        props, loc_payload = unpack_loc_object(sch.block(b)[i])
        ts = _decode_props(props)[LOC_PROP_TIMESTAMP]
        assert loc_payload == payload
        assert chunk_decode_time(chunk) == (ts * TIMESCALE + 500_000) // 1_000_000


def test_clean_track_joins_a_running_schedule_at_the_next_gop(monkeypatch):
    _, writes = _clean_run(monkeypatch, n_blocks=6, gap_s=0.05, started_ago=0.125)
    assert writes[0][:2] == (2, 0) and writes[0][3]
    assert {g for g, *_ in writes} == {2}
