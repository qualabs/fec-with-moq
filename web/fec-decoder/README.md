# fec-decoder

A small TypeScript decoder for FEC repair objects, for a browser player, and the matching encoder,
for a publisher: a systematic Cauchy Reed-Solomon code over GF(2^8), byte for byte with ISA-L's. It
also parses and packs the repair-object wire format, and holds the three-track catalog's block
schedule and catalog. No runtime dependencies; the TypeScript toolchain only for type-checking and
building.

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
  big-endian; codec 2 = ISA-L (`src/wire.ts`). zfec objects (codec 1) are refused: the two codes
  produce different repair bytes.
- Decoding solves only for the e erased source symbols with the e lowest-indexed repair symbols
  received: syndrome = repair + C[R, known]·known, then missing = C[R, missing]⁻¹·syndrome. Fewer
  repair symbols than erasures → `{ok: false, reason}`, no throw.

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

The encoder (`src/encoder.ts`) gives raw repair symbols, no layout or wire header, so it doesn't
depend on how they are sent:

```ts
import { encode, IncrementalEncoder } from "./src/encoder.ts";
import { layoutBlock, toSymbols } from "./src/layout.ts";

const lay = layoutBlock(objects.map((o) => o.length));
const repair = encode(toSymbols(lay, objects), m);   // repair[j] = global repair index j, for any m

const enc = new IncrementalEncoder(k, m, 1100);      // parity as each source symbol is produced
enc.add(i, symbol);                                  // any order; then enc.repair()
```

`packRepairObject(sizes, symbol, codec = CODEC_ISAL, index = null)` (`src/wire.ts`) is the inverse of `parseRepairObject`: an `index` gives the INDEXED form; bad sizes, index or codec, or more than 1152 B, throw `RangeError`.

`src/schedule.ts` is the three-track catalog's block schedule: `rungSlices` (each rung's slice of the global repair indices, round(k × fraction) half to even, at least one), `address` and `repairAddress` (a symbol's group and object, `blocksPerGroup` blocks per group, object q × 256 + j), and the GOP cut as `cutBlocks`. `sourceObjects(b, objects, bpg)` and `repairObjects(b, slice, sizes, repair, bpg)` give each datagram's group, object, group start and payload. Checked against `test/schedule-vectors.json` and Playa's `locate()`.

`src/catalog.ts` is the MSF draft-02 three-track catalog (plain LOC track, `x-fec-source`, `x-fec-repair` rungs, the FEC parameters in `packagingMetadata`): `catalog(media, opts)` gives the object and `catalogJson(media, opts)` the exact bytes the publisher sends. Those bytes use `", "` and `": "` separators, escape non-ASCII as `\uXXXX`, and write `framerate`, `blockSeconds` and `rungFractions` as floats (`60.0`); the frame rate is rounded to 3 decimals half to even (`roundHalfEvenTo`) and `packagingMetadata`'s numbers use `%g` (`formatG`). Checked byte for byte against `test/catalog-vectors.json` and with Playa's `fecInfoFromCatalog`.

## Tests

```sh
npm install                        # typescript, @types/node
npm run typecheck
npm test                           # node --test (Node >= 23.6 runs .ts directly)
```

The tests run against reference vectors in `test/`:

- `vectors.json`: blocks k = 5, 20 and two larger blocks (k = 125 and 129, 57 repair symbols = three
  rungs of 19), each with: no loss, random erasures, maximum erasure (e = m), too many erasures
  (e = m + 1), too few repair symbols, lost whole objects (with rung 1 only and with all rungs), plus
  a plain (1126 B) and an INDEXED (1128 B) repair object for exact wire parsing. Every decodable case
  must come back byte-identical to the original objects, and every undecodable case must fail cleanly.
- `media-vectors.json`, `media-vectors-gop120.json`: real AV1 frames as LOC objects, in blocks that
  are whole GOPs and in 12-frame blocks of a 120-frame GOP, rebuilt after erasures
  (`test/media.test.ts`).
- `encoder-vectors.json`: the encoder's edges: k = 1, m = 0, k + m = 256, 1-byte and 1099-byte
  symbols, a padded last symbol, 255 objects, a 65535 B object.

`test/encoder.test.ts` re-encodes every block of those vectors and compares each repair symbol byte
for byte with ISA-L's, then round-trips encoded blocks through the decoder with up to m symbols lost.
`test/wire.test.ts` compares `packRepairObject` with the reference objects, plain and INDEXED, byte
for byte, and takes a block from objects to repair objects and back. `test/schedule.test.ts` and
`test/catalog.test.ts` check the schedule and the catalog against `schedule-vectors.json` and
`catalog-vectors.json`.

## Timing

`npm run bench` (Node) and `bench/bench.html` + `bench/bench_browser.py` (headless browser via
Playwright; serve this directory, after `tsc`). Both time `recoverSymbols` on the first k = 125 block
with e erased source symbols, 30 repetitions, after checking the result byte for byte.

Cost grows roughly as e × k × 1100 byte operations (syndrome) plus e² × 1100 (solve); plain JS with a 256-entry multiplication row per coefficient, no SIMD.
