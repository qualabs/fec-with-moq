"""Golden vectors for the TypeScript block schedule (web/fec-decoder/src/schedule.ts), from fecmoq.

    python scripts/fec_schedule_vectors.py > web/fec-decoder/test/schedule-vectors.json

The three-track catalog's mapping: source symbols and repair on datagrams, global repair ids, a MoQ
group of blocks_per_group blocks. Number tables come straight from rung_slices,
BlockSchedule.address / repair_address and Mp4Gops (fed fake samples, no mp4); they need no ISA-L.
The two blocks of "objects" (the last of group 0 and the first of group 1, 10 blocks per group) are
what track_objects says the datagram source and each repair rung write, payloads as SHA-256: that
part needs ISA-L (libisal).
"""
import base64, hashlib, json, os, random, sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import aiomoqt.media.sources                                       # noqa: E402
from fecmoq.codec import default_backend                           # noqa: E402
from fecmoq.media import Mp4Gops                                   # noqa: E402
from fecmoq.moq import BlockSchedule, FetchSpec, rung_slices, track_objects  # noqa: E402

b64 = lambda b: base64.b64encode(bytes(b)).decode()               # noqa: E731
sha = lambda b: hashlib.sha256(b).hexdigest()                      # noqa: E731

FRACS = [[0.15] * 3, [0.25] * 3, [0.1, 0.2, 0.3], [0.05], [0.5, 0.5], [0], []]
slices = [{"fracs": f, "by_k": [[[r.start, r.stop] for r in rung_slices(k, f)] for k in range(1, 257)]}
          for f in FRACS]


def schedule(bpg, cls=BlockSchedule, **kw):
    sch = cls(seed=1, n_blocks=0, n_objects=12, gap_s=0.1, **kw)
    sch.blocks_per_group = bpg
    return sch


addresses = []
for bpg in (1, 10, 5):
    sch = schedule(bpg)
    for b in range(2 * bpg + 2):
        for j in (0, 1, 255):
            for n in (0, 1):
                addresses.append({"bpg": bpg, "b": b, "n": n, "j": j, "address": list(sch.address(b, j)),
                                  "repair_address": list(sch.repair_address(b, n, j))})


class FakeReader:
    """Mp4Reader stand-in: sample i's payload is str(i), key frames where `keys` says."""
    def __init__(self, keys):
        samples = [SimpleNamespace(payload=str(i).encode(), key_frame=k) for i, k in enumerate(keys)]
        self.video = SimpleNamespace(samples=lambda: samples, codec_string="avc1", width=1, height=1, fps=30)


def cut(n, gop, keys):
    aiomoqt.media.sources.Mp4Reader = lambda path: FakeReader(keys)
    case = {"n": n, "gop": gop, "keys": keys}
    try:
        g = Mp4Gops("fake.mp4", n, gop)
        case["blocks"] = [[int(p) for p, _ in blk] for blk in g.blocks]
        case["blocks_per_group"] = g.blocks_per_gop
    except ValueError as e:
        case["error"] = str(e)
    return case


every = lambda gop, count: [i % gop == 0 for i in range(count)]  # noqa: E731
cuts = [cut(12, None, every(12, 36)), cut(12, None, every(12, 40)), cut(12, 120, every(120, 250)),
        cut(4, 12, every(12, 12)), cut(5, 12, every(12, 24)), cut(12, None, every(12, 11)),
        cut(4, 12, every(4, 24)), cut(4, 12, [i % 12 == 0 and i != 12 for i in range(24)]),
        cut(3, 6, [True] * 14), cut(1, None, [True, False, True])]

if default_backend() != "isal":
    sys.exit("needs ISA-L (libisal): the repair payloads must be ISA-L's")


class SmallBlocks(BlockSchedule):
    """track_objects' blocks, 12 random objects of 300-2500 B instead of make_block's large ones."""
    def block(self, b):
        rng = random.Random(20261125 + b)
        return [bytes(rng.getrandbits(8) for _ in range(rng.randint(300, 2500))) for _ in range(12)]


sch = schedule(10, SmallBlocks)
blocks = []
for b in (9, 10):
    objs = sch.block(b)
    sizes, sl, _ = sch.repair(b)
    src = track_objects(sch, FetchSpec(kind="source", source_mapping="datagram"), b)
    rungs = []
    for r in range(1, len(sl) + 1):
        rep = track_objects(sch, FetchSpec(kind="repair", rung=r), b)
        rungs.append([[g, o, sch.repair_address(b, n, j)[2], sha(p)]
                      for (g, o, _, p, _), (n, j) in zip(rep, enumerate(sl[r - 1]))])
    blocks.append({"b": b, "bpg": 10, "fracs": sch.rung_fracs, "sizes": sizes, "objects": [b64(o) for o in objs],
                   "slices": [[x.start, x.stop] for x in sl],
                   "source": [[g, o, sch.address(b, j)[2], sha(p)] for j, (g, o, _, p, _) in enumerate(src)],
                   "repair": rungs})

json.dump({"generator": "scripts/fec_schedule_vectors.py", "object_stride": 256, "rung_slices": slices,
           "addresses": addresses, "cut_blocks": cuts, "objects": blocks}, sys.stdout, separators=(",", ":"))
