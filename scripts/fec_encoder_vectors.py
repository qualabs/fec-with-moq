"""Golden vectors for the TypeScript encoder (web/fec-decoder/src/encoder.ts), from our Python ISA-L encoder.

    python scripts/fec_encoder_vectors.py > web/fec-decoder/test/encoder-vectors.json

Needs ISA-L (libisal). Each case is a block of objects laid out SPAN with its symbol size, and the
m repair symbols codec.Coder(k, m, "isal") makes of it (raw symbols, no wire header). Cases cover the
prototype's defaults (1100 B symbols, 12-object blocks, rungs 0.15 x 3) and the edges: k = 1, m = 0,
k + m = 256, 1-byte symbols, and blocks whose last symbol is zero-padded.
"""
import base64, json, os, random, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from fecmoq.codec import Coder                                     # noqa: E402
from fecmoq.moq import make_block, rung_slices                     # noqa: E402
from fecmoq.symbols import SPAN, layout_block, to_symbols          # noqa: E402

b64 = lambda b: base64.b64encode(bytes(b)).decode()               # noqa: E731
rng = random.Random(20261124)


def objects(sizes):
    return [bytes(rng.getrandbits(8) for _ in range(s)) for s in sizes]


def case(name, objs, m, symbol_size=1100):
    sizes = [len(o) for o in objs]
    lay = layout_block(sizes, SPAN, symbol_size)
    repair = Coder(lay.k, m, "isal").encode(to_symbols(lay, objs))
    return {"name": name, "k": lay.k, "m": m, "symbol_size": symbol_size, "sizes": sizes,
            "padding": lay.padding_bytes, "objects": [b64(o) for o in objs], "repair": [b64(r) for r in repair]}


cases = []
objs = make_block(7, 0, 12)
k = layout_block([len(o) for o in objs], SPAN).k
cases.append(case("defaults: make_block seed 7, 12 objects, rungs 0.15x3", objs, rung_slices(k, [0.15] * 3)[-1].stop))
objs = objects([rng.randint(300, 2500) for _ in range(12)])
k = layout_block([len(o) for o in objs], SPAN).k
cases.append(case("12 random objects, rungs 0.15x3", objs, rung_slices(k, [0.15] * 3)[-1].stop))
cases.append(case("k=1 m=0", objects([1100]), 0))
cases.append(case("k=1 m=1 (one short object, padded)", objects([17]), 1))
cases.append(case("k=1 m=5", objects([1100]), 5))
cases.append(case("k=3 m=2, last symbol padded", objects([1100, 900, 1]), 2))
cases.append(case("k=4 m=4, symbol size 1", objects([1, 2, 1]), 4, 1))
cases.append(case("k=8 m=3, symbol size 1099", objects([1099 * 8]), 3, 1099))
cases.append(case("k=200 m=56 (k+m=256), symbol size 64", objects([64 * 200 - 5]), 56, 64))
cases.append(case("k=255 m=1, symbol size 16", objects([16 * 255]), 1, 16))

json.dump({"generator": "scripts/fec_encoder_vectors.py", "codec": "isal", "cases": cases}, sys.stdout,
          separators=(",", ":"))
