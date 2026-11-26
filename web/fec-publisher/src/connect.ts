// A draft-18 MoqtConnection over WebTransport from Node (the FAILS client), pinned to the relay's
// certificate hash, as Playa's examples/node-publisher/src/client.ts. The FAILS server side doesn't
// echo an application protocol, so the draft is fixed (18) rather than negotiated.

import { WebTransport, quicheLoaded } from "@fails-components/webtransport";
import { MoqtConnection, type WebTransportLike } from "@openmoq/webtransport";

export interface Connected { conn: MoqtConnection; close(): Promise<void> }

export function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new RangeError(`not a hex string: ${hex}`);
  return new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** `prepare` sets the connection's callbacks (onSubscribe, onDatagram, ...) before SETUP. */
export async function connect(url: string, certHash: string | undefined,
                              prepare: (conn: MoqtConnection) => void = () => {}): Promise<Connected> {
  await quicheLoaded;
  const wt = new WebTransport(url, {
    ...(certHash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: hexBytes(certHash) }] } : {}),
    protocols: ["moqt-18"],
  });
  await wt.ready;
  const conn = new MoqtConnection(18);
  prepare(conn);
  // The FAILS session is W3C-shaped; only TypeScript's stream generics differ.
  await conn.connect(wt as unknown as WebTransportLike);
  return {
    conn,
    async close() {
      await conn.close().catch(() => {});   // closes the WebTransport session too
      await Promise.race([wt.closed.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    },
  };
}
