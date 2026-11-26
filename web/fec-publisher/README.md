# fec-publisher (spike)

A TypeScript publisher for the three-track catalog's FEC tracks, in Node, over Playa's MoQT
(`@openmoq/webtransport` 0.7.0 from npm, draft 18 over WebTransport with the FAILS client). It
publishes what `relay_fec.py pub --media CLIP --source-mapping datagram` publishes for a FEC player:

| Track | What | How |
|---|---|---|
| `catalog` | `catalogJson` of `web/fec-decoder` (MSF draft-02: `video`, `src`, `rep1..N`) | a subgroup stream per group, a new group every 2 s and at each SUBSCRIBE |
| `src` | one plain repair-format object per source symbol (`sourceObjects`) | OBJECT_DATAGRAM |
| `rep1..N` | each rung's slice of the global repair symbols (`encode`, `repairObjects`) | OBJECT_DATAGRAM, after the block's source |

The source objects are the clip's frames as `props_len:u16 | LOC properties | payload`, the LOC
timestamp in the draft-18 encoding, a block of `--objects` frames every `--gap` seconds, as
`media.py`'s `MediaBlockSchedule`. The bytes match the Python publisher's (`test/producer.test.ts`
against `media-vectors.json`).

**Not here (yet):** the plain `video` track (it is in the catalog, but a SUBSCRIBE to it is refused,
so a player without FEC can't play), FETCH (refused with NOT_SUPPORTED), END_OF_GROUP datagrams
(`--repair-eog`), the "repair after the source left the send buffer" policy (repair is only queued
after its block's source, in one datagram queue) and H.264 input (AV1 only: its sequence header travels
in band, so a LOC frame needs no decoder description).

## Files

| Path | What |
|---|---|
| `src/mp4.ts` | the first video track of an mp4: sample bytes, key flags, AV1 codec string, size, frame rate |
| `src/media.ts` | blocks of frames (`cutBlocks`), LOC objects and their timestamps |
| `src/producer.ts` | one block's `src` and `rep<r>` datagrams; simulated loss on `src` |
| `src/publisher.ts` | announce, answer SUBSCRIBE/FETCH, send the catalog and the blocks |
| `src/collector.ts` | the other end, for checks: datagrams back into blocks, decoded with `web/fec-decoder` |
| `src/cli.ts` | the publisher's command line |
| `scripts/subscribe-check.ts` | a Node subscriber through the relay: counts objects per track, rebuilds each block and compares its frames with the clip |
| `scripts/player-check.mjs` | the Playa FEC test page (moq-playa `fec-with-moq-v2`), headless in the system Chrome |

## Tests

```sh
npm install        # Playa 0.7.0, FAILS WebTransport (prebuilt addon), fec-decoder as file:../fec-decoder
npm run typecheck
npm test           # node --test; the mp4 test needs ffmpeg with libsvtav1, else it is skipped
```

## Run it against a local moqx

Node 24 runs the `.ts` files directly. One terminal per long-running command.

```sh
RUN=$XDG_RUNTIME_DIR/fec-publisher-$(date +%s); mkdir -p $RUN/certs; cd $RUN
# 1. a certificate (ECDSA P-256, at most 14 days) and its hash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 10 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout certs/key.pem -out certs/cert.pem && chmod 644 certs/key.pem
HASH=$(openssl x509 -in certs/cert.pem -outform der | sha256sum | cut -d' ' -f1)
# 2. moqx (0.3.8+: older ones end a datagram-only session after 60 s)
docker run -d --rm --name moqx-fec -p 127.0.0.1:4473:4433/udp -v $RUN/certs:/certs:ro \
  -e MOQX_CERT=/certs/cert.pem -e MOQX_KEY=/certs/key.pem -e MOQX_PICO_ENABLE=false ghcr.io/openmoq/moqx:latest
# 3. a clip: AV1, 360p60, a key frame every 12 frames (a GOP is a block of 12)
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=60 -t 10 -c:v libsvtav1 -preset 10 -g 12 -crf 50 \
  -svtav1-params irefresh-type=2:pred-struct=1 -pix_fmt yuv420p clip.mp4
# 4. the publisher (in web/fec-publisher); --drop-src 0.05 drops 5% of the src datagrams before sending
node src/cli.ts --url https://127.0.0.1:4473/moq-relay --hash $HASH --ns fec-$RANDOM --media $RUN/clip.mp4 \
  [--rungs 0.15,0.15,0.15 | --rungs ''] [--drop-src 0.05] [--secs 60]
```

**Check with the Node subscriber** (same namespace, while the publisher runs): it subscribes to the
catalog, `src` and the first `--take` rungs, then prints the objects per track and how many blocks
arrived intact, were recovered or were lost; it exits 1 if no `src` datagram arrived or a frame differs
from the clip's.

```sh
node scripts/subscribe-check.ts --url https://127.0.0.1:4473/moq-relay --hash $HASH --ns NS --media $RUN/clip.mp4 --take 3 --secs 10
```

**Check with the Playa FEC player.** Build the examples of moq-playa `fec-with-moq-v2` (its
`FEC-WITH-MOQ.md`, "Build"; `FEC_DECODER_SRC` points at this repository's `web/fec-decoder/src`),
serve `examples/dist` on 127.0.0.1, then:

```sh
PLAYA=/path/to/moq-playa node scripts/player-check.mjs --page http://127.0.0.1:PAGE_PORT \
  --url https://127.0.0.1:4473/moq-relay --ns NS --hash $HASH --fec 3 [--cb subscribe|auto] --secs 30
```

`--fec N` is the number of repair rungs the player takes (`0`: FEC stage on, no repair). The output is
the page's record: state, frames decoded, gaps between drawn frames, and the FEC stage's counters
(`blocksWhole`, `blocksRecovered`, `blocksAbandoned`, `sourceLost`, `repairSymbols`). To watch it,
open `examples/fec-with-moq/demo.html?url=…&ns=…&ver=draft-18&fec=1&rungs=3&overlay=1&certHash=$HASH`.

Stop with Ctrl-C (or `--secs`), then `docker rm -f moqx-fec; rm -rf $RUN`.
