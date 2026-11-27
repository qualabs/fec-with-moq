# The TypeScript packages and the Python reference

`web/fec-decoder` and `web/fec-publisher` are ports of parts of this repository's Python
implementation (`src/fecmoq/`, `scripts/relay_fec.py`, aiomoqt). They are meant for a PR to Playa
(openmoq/moq-playa), so their code and READMEs describe the protocol, the format and the behaviour,
not the Python they came from. This note keeps that provenance and the comparison with the Python
publisher. Nothing in the two packages links here.

## What each TypeScript module ports

| TypeScript | Python |
|---|---|
| `fec-decoder/src/encoder.ts` | the ISA-L backend of `src/fecmoq/codec.py`: `encode` is `codec.Coder(k, m, "isal").encode`, `IncrementalEncoder` is `codec.IsalIncrementalEncoder` |
| `fec-decoder/src/decoder.ts` | the ISA-L decoder of `codec.py`: it solves only for the e erased source symbols with the e lowest-indexed repair symbols, the same steps |
| `fec-decoder/src/layout.ts` | `src/fecmoq/symbols.py` (SPAN layout) |
| `fec-decoder/src/wire.ts` | `src/fecmoq/wire.py`: `packRepairObject` is `wire.pack_repair`, `DATAGRAM_MAX_PAYLOAD` is `wire.DATAGRAM_MAX_PAYLOAD`; zfec objects are refused as `unpack_repair` refuses a codec mismatch |
| `fec-decoder/src/schedule.ts` | `src/fecmoq/moq.py`: `rungSlices` is `moq.rung_slices`, `address` and `repairAddress` are `BlockSchedule.address` and `repair_address`, `OBJECT_STRIDE` is `moq.OBJECT_STRIDE`; `cutBlocks` is `media.py`'s `Mp4Gops` GOP cut; `roundHalfEven` is Python 3's `round()` on a float |
| `fec-decoder/src/catalog.ts` | `media.py`'s `catalog_json`; `peakBitrate` is `Mp4Gops.peak_bitrate` |
| `fec-publisher/src/mp4.ts` | the part of aiomoqt's `Mp4Reader` that `Mp4Gops` reads |
| `fec-publisher/src/media.ts` | `media.py`'s `MediaBlockSchedule` for the datagram tracks; `catalogMedia().sizes` is `Mp4Gops.sizes` |
| `fec-publisher/src/plain.ts` | `media.py`'s `PlainTrack` |
| `fec-publisher/src/producer.ts` | `moq.py`'s `DatagramSourceTrack` and repair rungs |
| `fec-publisher/src/filter.ts` | aiomoqt's `_filter_window` |
| `fec-publisher/src/collector.ts` | the inverse of `BlockSchedule.address` |
| the publisher as a whole | `relay_fec.py pub --media CLIP --source-mapping datagram` |

The catalog's exact bytes are those of Python's `json.dumps` with its default separators and
`ensure_ascii`. The helpers in `catalog.ts` reproduce Python's number formatting:

| TypeScript | Python |
|---|---|
| `roundHalfEvenTo(x, nd)` | `round(x, nd)` |
| `formatJsonFloat(x)` | `repr(float)` |
| `formatG(x)` | `f"{x:g}"` |
| `toCatalogJson(v)` | `json.dumps(v)`, with the keys Python holds as floats (`framerate`, `blockSeconds`, `rungFractions`) written as floats |

## Reference vectors

The tests call them "reference vectors". Each comes from a generator script at the repository root
(`scripts/`, not part of what goes to Playa), run on the Python implementation:

| Vectors | Generator | Needs |
|---|---|---|
| `fec-decoder/test/vectors.json` | `scripts/fec_vectors.py`, from the Python ISA-L encoder; it checks every case's expected outcome against the Python decoder | libisal |
| `fec-decoder/test/media-vectors.json`, `media-vectors-gop120.json` | `scripts/fec_media_vectors.py`, from `MediaBlockSchedule` and `moq.py`'s `rung_slices` / `pack_repair` | libisal |
| `fec-decoder/test/encoder-vectors.json` | `python scripts/fec_encoder_vectors.py > web/fec-decoder/test/encoder-vectors.json` | libisal |
| `fec-decoder/test/schedule-vectors.json` | `scripts/fec_schedule_vectors.py` (`rung_slices`, `BlockSchedule`, the `Mp4Gops` cut, `track_objects`) | libisal |
| `fec-decoder/test/catalog-vectors.json` | `scripts/fec_catalog_vectors.py` (`catalog_json`) | no ISA-L |
| `fec-publisher/test/plain-vectors.json`, `plain-vectors-gop24.json` | `scripts/fec_plain_vectors.py`, from `PlainTrack.produce()` | |

Each vector file names its generator in a `generator` field. Run the generators where libisal is
installed, for instance a subscriber VM. Without `encoder-vectors.json`, `schedule-vectors.json` or
`catalog-vectors.json` the tests that need it are skipped; the other vector files are required.

## What matches the Python publisher byte for byte

From the LOC objects on, the TS publisher's bytes match the Python publisher's:

- the `src` and `rep1..3` datagrams of each block (`fec-publisher/test/producer.test.ts` against
  `media-vectors.json`);
- the LOC objects themselves, as `media.py` packs them;
- the `video` track's addresses, properties and payloads (`fec-publisher/test/plain.test.ts`);
- the repair symbols and repair objects, plain and INDEXED (`fec-decoder/test/encoder.test.ts`,
  `wire.test.ts`);
- the catalog (`fec-decoder/test/catalog.test.ts`).

The two publishers never read the same clip: the comparison starts at the LOC objects (expert review
of 2026-11-26, finding 12, still open).

## Same behaviour as `relay_fec.py` and aiomoqt

- `--pace-source` and `--pace-repair` mean what `relay_fec.py`'s options of the same name mean (the
  source one interval per block). Each rung's repair is a task of its own that sends its blocks in
  order, each after the block's source is out, as `moq.py`'s `RepairTrack.produce` (one task per rung,
  `wait_source_out`, the pacing from `t_rel`); the next block's source keeps its slot. The TS publisher
  also refuses `--pace-source + --pace-repair >= 1` and logs LATE blocks, which `relay_fec.py` doesn't.
- A publisher whose session is gone logs `SESSION-DEAD` and exits with status 4, as `relay_fec.py`.
- A SUBSCRIBE's filter is applied as aiomoqt's `_filter_window` does: the window is fixed when the
  subscription is accepted, from the Largest Object that SUBSCRIBE_OK reports.
- The plain track is delivered as aiomoqt's PER_GROUP delivery: a subgroup stream per group. A new
  subscriber to `video` joins at a group start, as aiomoqt's lanes do.
- A new subscription to `src` or a rung doesn't start mid-block. aiomoqt holds a joining lane to the
  next group of its track (`FanoutDelivery.add` in `delivery.py`: `lane.floor = self._group + 1`), and
  `moq.py` starts a rung first subscribed mid-run at a block (`RepairTrack.produce`, `b0`). The TS
  publisher starts a datagram subscription without a start Location at the next block whose source
  hasn't started, the same block on `src` and every rung. It differs from aiomoqt in two ways: the
  unit is the block, not the group (they differ with `--gop-frames`, where a group holds several
  blocks), and the floor is common to the tracks rather than per track, so a rung accepted between a
  block's source and its repair skips that block's repair. The runs up to `edc24ac` (2026-11-27)
  predate this: the publisher then opened a datagram track's window just after its Largest Object,
  mid-block, and a player could get a block's repair and too little of its source at the join (the
  abandoned join block of those runs). Only `video` joined as aiomoqt's lanes do.

## Differences from the Python publisher

- **Pacing default.** The TS publisher paces by default (`--pace-source 0.5 --pace-repair 0.4`);
  `relay_fec.py`'s defaults are 0 (back to back), which stays selectable with
  `--pace-source 0 --pace-repair 0`. Back to back, the FAILS client loses datagrams at a realistic
  bitrate (the numbers are in `fec-publisher/README.md`, "Pacing, on by default").
- **End of a plain-track group.** The TS publisher ends each group's stream with FIN after its last
  object, the header's END_OF_GROUP bit set. aiomoqt ends a group's stream with an END_OF_GROUP status
  object when the next group starts.
