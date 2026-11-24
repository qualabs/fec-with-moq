// Encoder for the ISA-L backend of src/fecmoq/codec.py, byte for byte: repair symbol j of a block
// of k source symbols is the sum over source columns c of cauchy(k, j, c) * source[c], i.e. rows
// k..k+m-1 of gf_gen_cauchy1_matrix(k + m, k) applied as ec_init_tables + ec_encode_data do.
// The code is systematic: source symbols are sent as they are and only the repair is computed here.

import { cauchy } from "./decoder.ts";
import { mulAddInto } from "./gf256.ts";

/** GF(2^8) caps a block, source plus repair, at 256 symbols. */
export const MAX_N = 256;

function checkParams(k: number, m: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > MAX_N) {
    throw new RangeError(`need 1 <= k and k + m <= ${MAX_N}; got k=${k}, m=${m}`);
  }
}

/**
 * Parity updated as each source symbol is produced, in any order (codec.IsalIncrementalEncoder):
 * once all k are added, repair() equals encode() of the same symbols.
 */
export class IncrementalEncoder {
  readonly k: number;
  readonly m: number;
  readonly symbolSize: number;
  private readonly out: Uint8Array[];
  private readonly seen = new Set<number>();

  constructor(k: number, m: number, symbolSize: number) {
    checkParams(k, m);
    if (!Number.isInteger(symbolSize) || symbolSize < 1) throw new RangeError(`bad symbol size ${symbolSize}`);
    this.k = k;
    this.m = m;
    this.symbolSize = symbolSize;
    this.out = Array.from({ length: m }, () => new Uint8Array(symbolSize));
  }

  add(i: number, symbol: Uint8Array): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.k || this.seen.has(i)) {
      throw new RangeError(`source index ${i} out of range or already added`);
    }
    if (symbol.length !== this.symbolSize) {
      throw new RangeError(`symbol ${symbol.length} B, expected ${this.symbolSize} B`);
    }
    for (let j = 0; j < this.m; j++) mulAddInto(this.out[j], symbol, cauchy(this.k, j, i));
    this.seen.add(i);
  }

  /** The m repair symbols; repair symbol j is global repair index j. */
  repair(): Uint8Array[] {
    if (this.seen.size !== this.k) throw new RangeError(`only ${this.seen.size} of ${this.k} source symbols added`);
    return this.out;
  }
}

/**
 * The m repair symbols of a block of k = source.length equal-length source symbols
 * (codec.Coder(k, m, "isal").encode). Repair symbol j doesn't depend on m.
 */
export function encode(source: Uint8Array[], m: number): Uint8Array[] {
  checkParams(source.length, m);
  const enc = new IncrementalEncoder(source.length, m, source[0].length);
  source.forEach((s, i) => enc.add(i, s));
  return enc.repair();
}
