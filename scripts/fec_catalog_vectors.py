"""Golden vectors for the TypeScript three-track catalog (web/fec-decoder/src/catalog.ts), from
fecmoq.media.catalog_json: the exact bytes the publisher sends, for a fake media (codec, size,
frame sizes, blocks per GOP; no mp4) and each parameter set. No ISA-L needed.

    python scripts/fec_catalog_vectors.py > web/fec-decoder/test/catalog-vectors.json
"""
import json, os, random, sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from fecmoq import media                                           # noqa: E402

media.time = SimpleNamespace(time=lambda: 1764072000.5)


def fake_media(codec, width, height, bpg, n_frames, seed):
    rng = random.Random(seed)
    sizes = [rng.randint(200, 60000) if i % 30 == 0 else rng.randint(200, 9000) for i in range(n_frames)]
    m = SimpleNamespace(codec=codec, width=width, height=height, blocks_per_gop=bpg, sizes=sizes)
    m.peak_bitrate = lambda fps: media.Mp4Gops.peak_bitrate(m, fps)
    return m


AV1, AVC = ("av01.0.04M.08", 640, 360), ("avc1.64001f", 1280, 720)
CASES = [  # media, bpg, frames, n_objects, gap_s, rungs, symbol_size, source, stride, plain
    (AV1, 10, 240, 12, 0.2, [0.15, 0.15, 0.15], 1100, "src", 256, "video"),
    (AV1, 1, 120, 12, 0.2, [0.15], 1100, "src", 256, "video"),
    (AVC, 10, 300, 12, 0.4, [0.1, 0.2], 1100, "src", 256, None),
    (AVC, 1, 90, 30, 1.0, [0.05, 0.25, 0.5], 1000, "fec-src", 64, "cam-1"),
    (AV1, 4, 100, 6, 0.1, [0.3333333333], 1100, "src", 256, "video"),
    (AV1, 10, 50, 1, 16.0, [0.25, 0.25], 1100, "src", 256, "video"),           # fps 0.0625: a tie
    (AV1, 1, 40, 7, 0.123456789, [0.15, 0.15, 0.15], 1100, "src", 256, "vídeo"),
    (AV1, 1, 40, 12, 1e-05, [1e-05, 0.5], 1100, "src", 256, None),
    (AV1, 1, 40, 255, 1e-14, [0.15], 1100, "src", 256, "video"),               # fps >= 1e16
    (AV1, 1, 40, 12, 1234565.0, [0.15, 0.15, 0.15], 1100, "src", 256, "video"),  # :g tie
    (AVC, 2, 60, 12, 0.2, [], 1100, "src", 256, "video"),
]

cases = []
for (codec, w, h), bpg, frames, n, gap, rungs, sym, source, stride, plain in CASES:
    m = fake_media(codec, w, h, bpg, frames, len(cases))
    out = media.catalog_json(m, n_objects=n, gap_s=gap, rungs=rungs, symbol_size=sym, source=source,
                             object_stride=stride, plain=plain)
    cases.append({"media": {"codec": codec, "width": w, "height": h, "blocksPerGop": bpg, "sizes": m.sizes},
                  "nObjects": n, "gapS": gap, "rungs": rungs, "symbolSize": sym, "source": source,
                  "objectStride": stride, "plain": plain, "generatedAt": json.loads(out)["generatedAt"],
                  "json": out.decode("ascii")})

json.dump({"cases": cases}, sys.stdout, separators=(",", ":"))
