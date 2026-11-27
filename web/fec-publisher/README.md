# fec-publisher (spike)

A TypeScript publisher for the three-track catalog's FEC tracks, in Node, over Playa's MoQT
(`@openmoq/webtransport` 0.7.0 from npm, draft 18 over WebTransport with the FAILS client). It
publishes a clip for a FEC player and for a player without FEC:

| Track | What | How |
|---|---|---|
| `catalog` | `catalogJson` of `web/fec-decoder` (MSF draft-02: `video`, `src`, `rep1..N`) | a subgroup stream per group, a new group every 2 s and at each SUBSCRIBE |
| `video` | the clip's frames as LOC objects, for a player without FEC (`plainObjects`) | a subgroup stream per group (GOP) |
| `src` | one plain repair-format object per source symbol (`sourceObjects`) | OBJECT_DATAGRAM |
| `rep1..N` | each rung's slice of the global repair symbols (`encode`, `repairObjects`) | OBJECT_DATAGRAM, after the block's source |

The source objects are the clip's frames as `props_len:u16 | LOC properties | payload`, the LOC
timestamp in the draft-18 encoding, a block of `--objects` frames every `--gap` seconds, frame i of
block b stamped t0 + b × gap + i × gap / n. The `video` track carries the same frames and timestamps,
one frame per object: the timestamp as the object's LOC property, the frame as its payload, group = the
source's group, object q * n + i for frame i of the group's q-th block (0 .. GOP - 1). From the LOC
objects on, the bytes are checked against reference vectors: `test/producer.test.ts` against
`web/fec-decoder`'s `media-vectors.json` (`src`, `rep1..3`), `test/plain.test.ts` against
`plain-vectors.json` and `plain-vectors-gop24.json` (`video`'s addresses, properties and payloads).

How it sends:

- **Source before repair, and before encoding.** A block's `src` datagrams are all sent before its
  repair is encoded (`blockDatagrams` is a generator), then each rung's repair follows as a task of
  its own: the next block's source starts at its slot whatever a rung still has to send of the block
  before. A rung sends its blocks in order; unpaced, the rungs share one queue, in rung order. The
  datagram writes themselves go one at a time, in the order they are asked for: the session's
  datagram stream takes one writer at a time.
- **Pacing, on by default.** `--pace-source F` spreads a block's source over F of the block period and
  `--pace-repair F` each rung's repair over F of it, from when the rung starts the block (after its
  source). The defaults are 0.5 and 0.4; `--pace-source 0 --pace-repair 0` sends back to back. The two
  must add up to less than 1, so that a block's source and repair fit in one block period; the
  publisher refuses to start otherwise (exit 2). A block whose source starts more than 50 ms after its
  slot is logged as `LATE block B: source starts N ms after its slot`, and the STATS and DONE lines
  count them (`blocks N late N (max N ms after the slot)`): the LOC timestamps follow the slot, so a
  publisher that falls behind adds that much latency at the player. Pacing is on by default because back to back
  loses datagrams at a realistic bitrate: the datagrams queue in the publisher's QUIC stack and expire
  there or are dropped unsent, with no error to the publisher. On a 1080p60 AV1 clip at 4.5 Mbps, at 0 %
  loss through a local moqx, about 40 % of the datagrams didn't arrive without pacing. With 0.5 / 0.4
  all of them arrived in two runs out of four; the other two each lost a burst in one episode on a
  loaded machine (23 and 691 datagrams, up to 7 %). Pacing is not a guarantee. The STATS and DONE log
  lines carry the session's QUIC counters (`quic datagrams expired N lost N`), which show such losses on
  the publisher's side. Two more paced 1080p runs, with the player and a Node subscriber (2026-11-27,
  1-minute load 2.3 at the start, 4.7 and 11.1 at the end), expired 38 and 198 datagrams, and the
  second lost 9 more. Both publishers also drifted, about 2 s and 3 s behind the slot clock after 37 s,
  because each block's paced repair held up the next block's source. With the repair on per-rung
  tasks, a 1080p run at a load of 2.2 to 9.7 started every block within 126 ms of its slot (3 LATE)
  and expired 47 datagrams (2026-11-28). In another run the load rose from 2.5 to 19.9; the publisher
  didn't get the CPU for a block's source and encoding within the period, fell up to 20 s behind
  (LATE on every block from 15 s on) and expired 3515. The lag is bounded only while the machine has
  the CPU for it.
- **Checks before sending.** Every block of the clip is checked at startup (an object over 65535 B, a
  payload over the 1152 B datagram ceiling, k + m over 256), and so is the largest datagram against the
  session's `maxDatagramSize`; the publisher refuses to start (exit 2, or 1 after connecting) with a
  message instead of failing mid-run.
- **Subscription filters.** A SUBSCRIBE's filter (draft 18 §5.1.2: none, NextGroupStart, LargestObject,
  AbsoluteStart, AbsoluteRange) is applied when the subscription is accepted: the track's Largest Object
  (the largest group and object it has sent, a datagram dropped by `--drop-src` included) fixes the
  window, SUBSCRIBE_OK carries it as LARGEST_OBJECT, and the subscriber gets only the objects inside the
  window. A NextGroupStart subscription to a rung therefore starts at the next group, which with
  `--gop-frames` is the next GOP, not the next block. A subscription to `src` or a rung whose filter
  names no start Location (none, LargestObject, NextGroupStart) also starts at a block start: the
  next block whose source hadn't started when the subscription was accepted, the same block on `src`
  and on every rung. A player subscribed to several of them gets each block's source and repair whole
  from its first block, never a block's repair with too little of its source; a rung accepted between
  a block's source and its repair skips that block's repair. A catalog SUBSCRIBE gets a new catalog group,
  after the Largest Object. Objects sent while SUBSCRIBE_OK is being written are not sent to the new
  subscription. An AbsoluteRange's end stops the objects, but no PUBLISH_DONE follows it, and a
  REQUEST_UPDATE doesn't change the window.
- **The plain track's streams.** Block b's `video` objects go out at the block's slot, on a queue of
  their own so a slow stream doesn't hold up the datagrams. Each subscriber gets a subgroup stream per
  group, opened at the group's first object with FIRST_OBJECT and ended with FIN after its last, the
  header's END_OF_GROUP bit set. A new subscriber to `video` starts at the next group start, also under
  LargestObject, whose window would otherwise open mid-group: a decision (Ismael, 2026-11-27), so that a
  player without FEC starts at a key frame. moqx subscribes with LargestObject, so through moqx a player
  starts at the next GOP. Only a filter that names a start Location (AbsoluteStart, AbsoluteRange) can
  open a stream mid-group. A stream cut by `stop()` mid-group is reset, not ended with FIN.
- **Session lifecycle.** A subscription is registered before its SUBSCRIBE_OK is written, and gets
  datagrams once it is accepted. Send failures are logged at the first one and then at most every 5 s
  per track. If the session closes before `stop()`, the publisher logs `SESSION-DEAD` and exits with
  status 4. `stop()` waits up to 2 s for the block being sent, its repair and the plain track's
  queue, then resets the plain track's open streams and sends PUBLISH_DONE (TRACK_ENDED) to each
  subscription. A subscription closed while a datagram is written or a stream is opened doesn't
  affect the others; a stream opened for one that closed meanwhile is reset.
- **Catalog by Joining FETCH.** Playa's default `catalogBootstrap` (`auto`, SUBSCRIBE plus a Joining
  FETCH) works through moqx without serving FETCH: in the runs of 2026-11-26 the FETCH never reached the
  publisher. moqx answered it itself, with REQUEST_ERROR "No objects published for track" when it held
  no catalog group yet, and Playa took the catalog from the subscription.

**Not here (yet):**

- FETCH: refused with NOT_SUPPORTED, the catalog's Joining FETCH included (see above);
- END_OF_GROUP datagrams (`--repair-eog`);
- the "repair after the source left the send buffer" policy: repair is only queued after its block's
  source, in one datagram queue;
- H.264 input: AV1 only, since its sequence header travels in band and a LOC frame needs no decoder
  description;
- still open from the expert review of 2026-11-26 (findings by number):
  - 6: `--drop-src` is i.i.d. loss on the source before the wire. It is a functional test, not a
    measure of what FEC gains; a number needs netem or a burst model, stated with the result;
  - 13: no ADR yet scopes this TS publisher against the umbrella ADR 0001;
  - 14: the publisher runs npm `@openmoq/webtransport` 0.7.0 and the player the fork at `60d877a`.
    Both are draft 18, and the run evidence records both.

## Publisher options

| Option | Default | What |
|---|---|---|
| `--url` | | the relay's WebTransport URL |
| `--hash` | | SHA-256 of the relay's self-signed certificate (hex) |
| `--ns` | | the namespace to announce |
| `--media` | | the AV1 mp4 to publish, looped |
| `--objects` | 12 | frames per block |
| `--gap` | 0.2 | block period, in seconds |
| `--gop-frames` | `--objects` | frames per GOP, i.e. per MoQ group (a multiple of `--objects`) |
| `--rungs` | 0.15,0.15,0.15 | each repair rung's fraction of a block's source symbols; `''` for no repair |
| `--drop-src` | 0 | fraction of `src` datagrams dropped before sending (simulated loss) |
| `--seed` | 7 | seed of the `--drop-src` draw |
| `--pace-source` | 0.5 | fraction of the block period a block's source is spread over |
| `--pace-repair` | 0.4 | fraction of the block period each rung's repair is spread over, after the source |
| `--catalog-interval` | 2 | seconds between catalog groups |
| `--plain-track` | video | the plain track's name in the catalog; `''` for no plain track |
| `--secs` | | stop after this many seconds (default: run until Ctrl-C) |

## Files

| Path | What |
|---|---|
| `src/mp4.ts` | the first video track of an mp4: sample bytes, key flags, AV1 codec string, size, frame rate |
| `src/media.ts` | blocks of frames (`cutBlocks`), LOC objects and their timestamps |
| `src/plain.ts` | one block's `video` objects: address, LOC property, frame |
| `src/producer.ts` | one block's `src` and `rep<r>` datagrams, source before encoding; the startup limit checks; simulated loss on `src` |
| `src/publisher.ts` | announce, answer SUBSCRIBE/FETCH, send the catalog and the blocks |
| `src/filter.ts` | a SUBSCRIBE's filter, its window from the Largest Object, SUBSCRIBE_OK's LARGEST_OBJECT |
| `src/collector.ts` | the other end, for checks: datagrams back into blocks, decoded with `web/fec-decoder` |
| `src/connect.ts` | the draft-18 `MoqtConnection` over the FAILS WebTransport client, pinned to the relay's certificate hash; the session's datagram ceiling and QUIC datagram counters |
| `src/cli.ts`, `src/options.ts` | the publisher's command line and its options and defaults |
| `scripts/subscribe-check.ts` | a Node subscriber through the relay: counts objects per track, compares each block's datagrams with what was sent, rebuilds each block and compares its frames with the clip |
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
MOQX=moqx-fec-$$   # a container name of your own; others may run moqx on the same machine
# 1. a certificate (ECDSA P-256, at most 14 days) and its hash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 10 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout certs/key.pem -out certs/cert.pem && chmod 644 certs/key.pem
HASH=$(openssl x509 -in certs/cert.pem -outform der | sha256sum | cut -d' ' -f1)
# 2. moqx (0.3.8+: older ones end a datagram-only session after 60 s)
docker run -d --rm --name $MOQX -p 127.0.0.1:4473:4433/udp -v $RUN/certs:/certs:ro \
  -e MOQX_CERT=/certs/cert.pem -e MOQX_KEY=/certs/key.pem -e MOQX_PICO_ENABLE=false ghcr.io/openmoq/moqx:latest
# 3. a clip: AV1, 360p60, a key frame every 12 frames (a GOP is a block of 12)
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=60 -t 10 -c:v libsvtav1 -preset 10 -g 12 -crf 50 \
  -svtav1-params irefresh-type=2:pred-struct=1 -pix_fmt yuv420p clip.mp4
# 4. the publisher (in web/fec-publisher); --drop-src 0.05 drops 5% of the src datagrams before sending
node src/cli.ts --url https://127.0.0.1:4473/moq-relay --hash $HASH --ns fec-$RANDOM --media $RUN/clip.mp4 \
  [--rungs 0.15,0.15,0.15 | --rungs ''] [--drop-src 0.05] [--gop-frames 120] \
  [--pace-source 0 --pace-repair 0] [--secs 60]
```

A realistic clip, Marc's defaults (1080p60, a 2 s GOP, so `--gop-frames 120`: ten 12-frame blocks per
group). With CBR and no hierarchy, no frame is near the 65535 B limit:

```sh
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60 -vf noise=alls=8:allf=t -t 20 -c:v libsvtav1 -preset 10 \
  -g 120 -b:v 4500k -svtav1-params rc=2:irefresh-type=2:pred-struct=1:hierarchical-levels=0 -pix_fmt yuv420p clip1080.mp4
```

**Check with the Node subscriber** (same namespace, while the publisher runs): it subscribes to the
catalog, `src` and the first `--take` rungs, then prints one JSON object:

- the objects per track;
- per block, the datagrams that arrived against those sent (k source and each taken rung's slice,
  from the catalog and the clip), in `datagrams` and `shortDetail`;
- how many blocks arrived intact, were recovered, were lost, or had no datagram at all (`missing`).

Counted are the blocks from the first one where `src` and every taken rung have each delivered a
datagram, after every block that had a datagram before the last rung's SUBSCRIBE_OK, and before the
last block seen. moqx can start a late subscriber's rungs one or more groups after its `src`; the
blocks before that are the join, not losses. It exits 1 if `src` or a taken rung delivered no
datagram, no block was counted, the last counted block falls short of what `--secs` at the catalog's
block period should reach from the first block after the last SUBSCRIBE_OK (`leastLastBlock`: 5 % and
3 blocks of slack), a frame differs from the clip's, or a check it was asked for fails: `--expect-all` (every datagram sent arrived; at `--drop-src 0`),
`--expect-recovered MIN` (at least MIN blocks recovered and none lost).

```sh
node scripts/subscribe-check.ts --url https://127.0.0.1:4473/moq-relay --hash $HASH --ns NS --media $RUN/clip.mp4 \
  --take 3 --secs 10 [--expect-all | --expect-recovered 1]
```

**Check with the Playa FEC player.** Build the examples of moq-playa `fec-with-moq-v2`. Its
`FEC-WITH-MOQ.md` expects a `fec-with-moq` checkout next to it; `FEC_DECODER_SRC` points the build at
this repository's decoder instead. pnpm comes through corepack (`corepack enable`, or prefix `corepack`):

```sh
git clone --branch fec-with-moq-v2 https://github.com/qualabs/moq-playa-fec.git moq-playa
cd moq-playa
FEC_DECODER_SRC=/path/to/fec-with-moq/web/fec-decoder/src corepack pnpm install --frozen-lockfile
FEC_DECODER_SRC=/path/to/fec-with-moq/web/fec-decoder/src corepack pnpm -r build   # also builds examples/dist/
npx --yes http-server examples/dist -a 127.0.0.1 -p PAGE_PORT                     # serve the pages
```

`player-check` loads Playwright from that checkout's `node_modules`, so `PLAYA` must be the checkout
where `pnpm install` ran:

```sh
PLAYA=/path/to/moq-playa node scripts/player-check.mjs --page http://127.0.0.1:PAGE_PORT \
  --url https://127.0.0.1:4473/moq-relay --ns NS --hash $HASH --fec 3 [--cb subscribe|auto | --demo] \
  [--drop-src 0.05] [--max-abandoned 0] [--min-frames 900] --secs 30
```

`--fec N` is the number of repair rungs the player takes (`0`: FEC stage on, no repair; `''`: FEC off,
the player plays the plain `video` track). The output is
the page's record: state, frames decoded, gaps between drawn frames, and the FEC stage's counters
(`blocksWhole`, `blocksRecovered`, `blocksAbandoned`, `sourceLost`, `repairSymbols`), with `ok` and the
checks that `failed`; it exits 1 if one fails. At least `--min-frames` frames (1) must be decoded. With
the FEC stage on, at most `--max-abandoned` blocks (0) may be abandoned or missing, at any loss; with
`--drop-src P` (the loss the publisher was started with) the FEC stage must also have lost source and
recovered blocks. The frames floor is the caller's: 30 s of a 60 fps clip is 1800 frames. On the
shared 4-CPU machine of the 2026-11-27 runs, headless Chrome decoded 1738 to 1776 of them at 360p but
only 104 and 335 at 1080p, so there a 1080p run checks the FEC stage, not playback. `--demo` opens `demo.html` instead, which uses Playa's default
`catalogBootstrap`. To watch it, open
`examples/fec-with-moq/demo.html?url=…&ns=…&ver=draft-18&fec=1&rungs=3&overlay=1&certHash=$HASH`.

Stop with Ctrl-C (or `--secs`), then `docker rm -f $MOQX; rm -rf $RUN`.
