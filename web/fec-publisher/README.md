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

How it sends:

- **Source before repair, and before encoding.** A block's `src` datagrams are all sent before its
  repair is encoded (`blockDatagrams` is a generator), then each rung's repair follows.
- **Pacing, on by default.** `--pace-source F` spreads a block's source over F of the block period
  and `--pace-repair F` each rung's repair over F of it after the source, as `relay_fec.py`'s options
  of the same name. The defaults are 0.5 and 0.4; `relay_fec.py`'s are 0 (back to back), which stays
  selectable with `--pace-source 0 --pace-repair 0`. The defaults differ because back to back loses
  datagrams at a realistic bitrate: the datagrams queue in the publisher's QUIC stack and expire there
  or are dropped unsent, with no error to the publisher. On a 1080p60 AV1 clip at 4.5 Mbps, at 0 % loss
  through a local moqx, about 40 % of the datagrams didn't arrive without pacing. With 0.5 / 0.4 all of
  them arrived in two runs out of four; the other two each lost a burst in one episode on a loaded
  machine (23 and 691 datagrams, up to 7 %). Pacing is not a guarantee. The STATS and DONE log lines
  carry the session's QUIC counters (`quic datagrams expired N lost N`), which show such losses on the
  publisher's side.
- **Checks before sending.** Every block of the clip is checked at startup (an object over 65535 B, a
  payload over the 1152 B datagram ceiling, k + m over 256), and so is the largest datagram against
  the session's `maxDatagramSize`; the publisher refuses to start (exit 2, or 1 after connecting) with
  a message instead of failing mid-run.
- **Subscription filters.** A SUBSCRIBE's filter (draft 18 §5.1.2: none, NextGroupStart,
  LargestObject, AbsoluteStart, AbsoluteRange) is applied as aiomoqt does: when the subscription is
  accepted, the track's Largest Object (the largest group and object it has sent, a datagram dropped
  by `--drop-src` included) fixes the window, SUBSCRIBE_OK carries it as LARGEST_OBJECT, and the
  subscriber gets only the objects inside the window. A NextGroupStart subscription to a rung therefore
  starts at the next group, which with `--gop-frames` is the next GOP, not the next block. A catalog
  SUBSCRIBE gets a new catalog group, after the Largest Object. Objects sent while SUBSCRIBE_OK is
  being written are not sent to the new subscription. An AbsoluteRange's end stops the objects, but no
  PUBLISH_DONE follows it, and a REQUEST_UPDATE doesn't change the window.
- **Session lifecycle.** A subscription is registered before its SUBSCRIBE_OK is written, and gets
  datagrams once it is accepted. Send failures are logged at the first one and then at most every 5 s
  per track. If the session closes before `stop()`, the publisher logs `SESSION-DEAD` and exits with
  status 4, like `relay_fec.py`. `stop()` sends PUBLISH_DONE (TRACK_ENDED) to each subscription.
- **Catalog by Joining FETCH.** Playa's default `catalogBootstrap` (`auto`, SUBSCRIBE plus a Joining
  FETCH) works through moqx without serving FETCH: in the runs of 2026-11-26 the FETCH never reached
  the publisher. moqx answered it itself, with REQUEST_ERROR "No objects published for track" when it
  held no catalog group yet, and Playa took the catalog from the subscription.

**Not here (yet):**

- the plain `video` track: it is in the catalog, but a SUBSCRIBE to it is refused, so a player
  without FEC can't play;
- FETCH: refused with NOT_SUPPORTED, the catalog's Joining FETCH included (see above);
- END_OF_GROUP datagrams (`--repair-eog`);
- the "repair after the source left the send buffer" policy: repair is only queued after its block's
  source, in one datagram queue;
- H.264 input: AV1 only, since its sequence header travels in band and a LOC frame needs no decoder
  description;
- still open from the expert review of 2026-11-26 (findings by number):
  - 6: `--drop-src` is i.i.d. loss on the source before the wire. It is a functional test, not a
    measure of what FEC gains; a number needs netem or a burst model, stated with the result;
  - 12: the bytes match Python's from the LOC objects onward only. The two publishers never read the
    same clip;
  - 13: no ADR yet scopes this TS publisher against the umbrella ADR 0001;
  - 14: the publisher runs npm `@openmoq/webtransport` 0.7.0 and the player the fork at `60d877a`.
    Both are draft 18, and the run evidence records both.

## Files

| Path | What |
|---|---|
| `src/mp4.ts` | the first video track of an mp4: sample bytes, key flags, AV1 codec string, size, frame rate |
| `src/media.ts` | blocks of frames (`cutBlocks`), LOC objects and their timestamps |
| `src/producer.ts` | one block's `src` and `rep<r>` datagrams, source before encoding; the startup limit checks; simulated loss on `src` |
| `src/publisher.ts` | announce, answer SUBSCRIBE/FETCH, send the catalog and the blocks |
| `src/filter.ts` | a SUBSCRIBE's filter, its window from the Largest Object, SUBSCRIBE_OK's LARGEST_OBJECT |
| `src/collector.ts` | the other end, for checks: datagrams back into blocks, decoded with `web/fec-decoder` |
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

Only blocks after every block that had a datagram before the last rung's SUBSCRIBE_OK, and before the
last block seen, are counted. It exits 1 if no `src` datagram arrived, a frame differs from the clip's,
or a check it was asked for fails: `--expect-all` (every datagram sent arrived; at `--drop-src 0`),
`--expect-recovered MIN` (at least MIN blocks recovered and none lost).

```sh
node scripts/subscribe-check.ts --url https://127.0.0.1:4473/moq-relay --hash $HASH --ns NS --media $RUN/clip.mp4 \
  --take 3 --secs 10 [--expect-all | --expect-recovered 1]
```

**Check with the Playa FEC player.** Build the examples of moq-playa `fec-with-moq-v2` (its
`FEC-WITH-MOQ.md`, "Build"; `FEC_DECODER_SRC` points at this repository's `web/fec-decoder/src`),
serve `examples/dist` on 127.0.0.1, then:

```sh
PLAYA=/path/to/moq-playa node scripts/player-check.mjs --page http://127.0.0.1:PAGE_PORT \
  --url https://127.0.0.1:4473/moq-relay --ns NS --hash $HASH --fec 3 [--cb subscribe|auto | --demo] \
  [--drop-src 0.05 [--max-abandoned 0]] --secs 30
```

`--fec N` is the number of repair rungs the player takes (`0`: FEC stage on, no repair). The output is
the page's record: state, frames decoded, gaps between drawn frames, and the FEC stage's counters
(`blocksWhole`, `blocksRecovered`, `blocksAbandoned`, `sourceLost`, `repairSymbols`), with `ok` and the
checks that `failed`; it exits 1 if one fails. Frames must be decoded; with `--drop-src P` (the loss the
publisher was started with) the FEC stage must also have lost source, recovered blocks and abandoned at
most `--max-abandoned` (0). `--demo` opens `demo.html` instead, which uses Playa's default
`catalogBootstrap`. To watch it, open
`examples/fec-with-moq/demo.html?url=…&ns=…&ver=draft-18&fec=1&rungs=3&overlay=1&certHash=$HASH`.

Stop with Ctrl-C (or `--secs`), then `docker rm -f moqx-fec; rm -rf $RUN`.
