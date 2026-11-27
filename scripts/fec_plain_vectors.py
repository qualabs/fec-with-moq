"""Plain-track vectors for web/fec-publisher: what media.py's PlainTrack writes for the first blocks of
an mp4 (its produce() run against a recording stand-in for the delivery, the schedule's slots not
waited for), with the frames and the timeline origin they came from, so the TS publisher can rebuild
the same objects from the same frames.

    python scripts/fec_plain_vectors.py CLIP.mp4 [GOP] [BLOCKS] > web/fec-publisher/test/plain-vectors.json
"""
import asyncio, base64, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from fecmoq.media import LOC_PROP_TIMESTAMP, MediaBlockSchedule, PlainTrack, encode_properties_d18  # noqa: E402

b64 = lambda b: base64.b64encode(bytes(b)).decode()               # noqa: E731
gop = int(sys.argv[2]) if len(sys.argv) > 2 else None
n_blocks = int(sys.argv[3]) if len(sys.argv) > 3 else 4
sch = MediaBlockSchedule(media=sys.argv[1], gop_frames=gop, seed=7, n_blocks=n_blocks, n_objects=12, gap_s=0.2)


async def no_wait(b):
    pass


sch.slot = no_wait


class Recorder:
    def __init__(self):
        self.objects = []

    async def write(self, group_id, object_id, payload, *, extensions=None, group_start=False):
        self.objects.append({"group": group_id, "object": object_id, "groupStart": group_start,
                             "properties": b64(encode_properties_d18(extensions or {})),
                             "timestamp": (extensions or {}).get(LOC_PROP_TIMESTAMP),
                             "payload": b64(payload)})


track = PlainTrack.__new__(PlainTrack)          # produce() needs only the schedule and n_blocks
track.schedule, track.n_blocks = sch, n_blocks
out = Recorder()
asyncio.run(track.produce(out))
json.dump({"clip": os.path.basename(sys.argv[1]),
           "blockObjects": sch.n_objects, "gapS": sch.gap_s, "blocksPerGroup": sch.blocks_per_group,
           "t0Us": sch._t0_us,
           "frames": [{"payload": b64(p), "key": k} for b in range(n_blocks) for p, k in sch.media.block(b)],
           "objects": out.objects}, sys.stdout, separators=(",", ":"))
