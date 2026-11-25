# fec-decoder

A small TypeScript decoder for our repair objects, for a browser player, and the matching encoder,
for a publisher. Both match the ISA-L backend of `src/fecmoq/codec.py`; the decoder also parses the
wire format of `src/fecmoq/wire.py`. No runtime dependencies; the TypeScript toolchain only for
type-checking and building.

**What it is:** the decoder, the encoder, and their unit tests/timings. Nothing here receives MoQ objects. The FEC stage in our Playa fork ([foucast/moq-playa](https://github.com/foucast/moq-playa), branch `fec-with-moq-v2`) uses it; our Shaka Player fork's will too (not yet published).

## The code it decodes

- GF(2^8), polynomial 0x11d (`src/gf256.ts`).
- Systematic Cauchy code: repair symbol j of a block with k source symbols is matrix row k + j, with
  coefficient `gf_inv((k + j) XOR c)` for source column c, as ISA-L's `gf_gen_cauchy1_matrix`
  (`src/decoder.ts`). Row k + j depends only on (j, k), so a symbol doesn't depend on how many repair
  symbols were generated.
- SPAN layout: a block's objects back to back, cut into k = ceil(total / 1100) symbols, last one
  zero-padded; a lost object erases every symbol it touches (`src/layout.ts`).
- Repair object: `codec:u8 | n_objects:u8 | size[i]:u16 … | [index:u16 if codec & 0x80] | symbol`,
  big-endian; codec 2 = ISA-L (`src/wire.ts`). zfec objects (codec 1) are refused, as
  `unpack_repair` refuses a mismatch: the two backends produce different repair bytes.
- Decoding solves only for the e erased source symbols with the e lowest-indexed repair symbols
  received: syndrome = repair + C[R, known]·known, then missing = C[R, missing]⁻¹·syndrome — the same
  steps as `codec.py`. Fewer repair symbols than erasures → `{ok: false, reason}`, no throw.

## API

```ts
import { decodeBlock, recoverSymbols } from "./src/decoder.ts";
import { parseRepairObject } from "./src/wire.ts";

// objects: source objects received (index in block -> bytes); repair: global repair index -> repair
// object as received (the MoQ object id, or the index an INDEXED object carries).
const r = decodeBlock({ sizes, objects, repair });
if (r.ok) use(r.value);            // every object of the block
```

`sizes` comes from any repair object of the block (`parseRepairObject(p).sizes`).

The encoder (`src/encoder.ts`) is `codec.Coder(k, m, "isal").encode` and `IsalIncrementalEncoder`:
raw repair symbols, no layout or wire header, so it doesn't depend on how they are sent.

```ts
import { encode, IncrementalEncoder } from "./src/encoder.ts";
import { layoutBlock, toSymbols } from "./src/layout.ts";

const lay = layoutBlock(objects.map((o) => o.length));
const repair = encode(toSymbols(lay, objects), m);   // repair[j] = global repair index j, for any m

const enc = new IncrementalEncoder(k, m, 1100);      // parity as each source symbol is produced
enc.add(i, symbol);                                  // any order; then enc.repair()
```

`packRepairObject(sizes, symbol, codec = CODEC_ISAL, index = null)` (`src/wire.ts`) is `wire.pack_repair`, the inverse of `parseRepairObject`: an `index` gives the INDEXED form; bad sizes, index or codec, or more than 1152 B, throw `RangeError`.

`src/schedule.ts` is the three-track catalog's block schedule (`moq.py`'s `rung_slices`, `address`, `repair_address`; `media.py`'s GOP cut as `cutBlocks`): `sourceObjects(b, objects, bpg)` and `repairObjects(b, slice, sizes, repair, bpg)` give each datagram's group, object, group start and payload; checked against `test/schedule-vectors.json` (`scripts/fec_schedule_vectors.py`, needs libisal) and Playa's `locate()`.

## Tests

```sh
npm install                        # typescript, @types/node
npm run typecheck
npm test                           # node --test (Node >= 23.6 runs .ts directly)
```

Vectors: `test/vectors.json`, written by `scripts/fec_vectors.py` from our Python ISA-L encoder
(run it where libisal is, e.g. a subscriber VM). Blocks k = 5, 20 and two arm-B blocks (k = 125 and
129, 57 repair symbols = three rungs of 19), each with: no loss, random erasures, maximum erasure
(e = m), too many erasures (e = m + 1), too few repair symbols, lost whole objects (with rung 1 only
and with all rungs), plus a plain (1126 B) and an INDEXED (1128 B) repair object for exact wire
parsing. The generator checks every case's expected outcome against our Python decoder.

Every decodable case must come back byte-identical to the original objects, and every undecodable case must fail cleanly.

`test/encoder.test.ts` re-encodes every block of those vectors and of `media-vectors*.json` and
compares each repair symbol byte for byte with the one ISA-L made; `test/encoder-vectors.json`, from
`python scripts/fec_encoder_vectors.py > web/fec-decoder/test/encoder-vectors.json` (needs libisal),
adds the edges: k = 1, m = 0, k + m = 256, 1-byte and 1099-byte symbols, a padded last symbol, 255
objects, a 65535 B object. It also round-trips TS-encoded blocks through the TS decoder with up to m
symbols lost. `test/wire.test.ts` compares `packRepairObject` with `pack_repair`'s objects in the same
file, plain and INDEXED, byte for byte, and takes a block from objects to repair objects and back.

## Timing

`npm run bench` (Node) and `bench/bench.html` + `bench/bench_browser.py` (headless browser via
Playwright; serve this directory, after `tsc`). Both time `recoverSymbols` on the first arm-B block
(k = 125) with e erased source symbols, 30 repetitions, after checking the result byte for byte.

Cost grows roughly as e × k × 1100 byte operations (syndrome) plus e² × 1100 (solve); plain JS with a 256-entry multiplication row per coefficient, no SIMD.
