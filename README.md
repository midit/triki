# IronCap — hands-free rep counter for the gym

[![CI/CD](https://github.com/midit/triki/actions/workflows/ci.yml/badge.svg)](https://github.com/midit/triki/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-midit.github.io%2Ftriki-2fd07a)](https://midit.github.io/triki/ironcap.html)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Stick a small motion sensor on the weight, lift, and the reps count themselves.
No buttons to press mid-set, no phone in your hand. Everything runs in the
browser on your phone over Web Bluetooth — no server, no account, no app store,
and your data never leaves the device.

**Live:** https://midit.github.io/triki/ironcap.html

## Supported sensors

IronCap is **hardware-agnostic**: it speaks the open **Nordic UART Service
(NUS)** and reads any beacon that streams accelerometer + gyroscope over it.
You connect your own device; the app just reads its motion stream.

Known-working:

| Sensor | Notes |
|---|---|
| **nRF52 + LSM6DSL beacons** (Holyiot, MINEW and similar) | Off-the-shelf, purchasable, magnet-friendly round cases |
| **Żabka "Triki" bottle-cap puck** | The dev board this was built and validated on — cheap and widely available in Poland |

Any sensor works as long as it exposes the NUS service, streams 14-byte IMU
frames, and you know its scaling factors — see [Frame format](#frame-format--14-bytes).

| App | Link | What it does |
|---|---|---|
| **IronCap** | [`ironcap.html`](ironcap.html) | Counts reps on any exercise, recognises the exercise, tracks tempo and PRs, learns from your corrections, keeps a workout history |
| **Cadence** | [`cadence.html`](cadence.html) | Earlier experiment: cycling cadence from the same kind of sensor |

> Independent open-source project. Not affiliated with, endorsed by, or
> connected to Żabka, Holyiot, MINEW or Nordic Semiconductor. Device names are
> used only to describe compatibility. Protocol details were documented by the
> community for interoperability — credits at the bottom.

---

## Getting started

1. **iOS:** install [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).
   Safari does not support Web Bluetooth. **Android:** Chrome works.
2. **Wake the sensor** (most sleep to save the cell — press its button), then hit
   *Connect*. Coin-cell beacons usually hold only **one** connection at a time.
3. Stick it on the weight — orientation does not matter, the app finds vertical
   from the gravity direction.
4. Press *Start set*, do your reps, press it again. Confirm the count. Or just
   start lifting: a steady rhythm auto-starts the set and back-fills the reps you
   already did.

If your sensor has a button, that is the only physical control you need:

| Action | Result |
|---|---|
| 1 click | start / finish a set |
| 2 clicks | cancel the set |
| hold ~1.2 s | finish the workout |

---

## Why the counting works the way it does

The naive approach — integrate acceleration into velocity, then look for
movement cycles — **does not survive contact with real data**. In an
888-second capture that integrator reached **15.4 m/s** where a real barbell
peaks near 2, because inter-frame gaps hit 423 ms while acceleration hit
10.7 g. The result was reps counted in bursts, several per second.

What works instead:

```
vertical acceleration
   -> band-pass (0.12 s vs 1.2 s)      remove noise and drift
   -> integrate                        -> pseudo-velocity
   -> band-pass again                  kill integrator drift
   -> count zero-crossing cycles       one cycle == one rep
```

Integrating is essential for a subtle reason: **vertical acceleration has two
positive lobes per squat** (you accelerate and then decelerate in each
direction), so counting cycles directly on acceleration double-counts every
rep. After integration there is exactly one cycle per rep.

Measured on labelled recordings, this cut total error from 26 to 10 and false
positives during walking from 18 to 2.

Other things the data forced us to fix:

- **Instantaneous acceleration is zero at peak velocity**, twice per rep. A
  naive "is the device still?" check therefore fires mid-rep and destroys the
  filters. Stillness must be judged over a window.
- **Gravity estimation must be adaptive** — fast while still so a new mounting
  orientation locks in instantly, slow while moving so the filter does not
  track the rep itself and eat its amplitude. This is what makes the mount
  orientation-free.
- **Off-by-one:** the first upward crossing used to only *open* a cycle, so ten
  reps always reported nine.
- **Frame timing is ragged** (~60 Hz with occasional 400 ms gaps), so `dt` is
  clamped and the filters reset across a gap rather than integrating nonsense.

## Sets are explicit, on purpose

Counting only runs between *start* and *finish*. Walking between machines,
picking the weight up, and sitting back down cannot be counted — by
construction rather than by threshold tuning. In the labelled captures those
transitions were the source of **every single** false positive.

## Learning from corrections

Every set is written to a research log with its raw trace, the automatic count
and the count you confirmed. Export it from the **Data** tab — that dataset is
the asset.

Each exercise can also fit its own detector parameters from those labelled
sets (grid search, conservative tie-break). But this is **gated on evidence**,
and the gate exists because of a measurement: a leave-one-out evaluation over
17 labelled sets showed that fitting three parameters to 2–3 noisy sets made
held-out accuracy *worse* than plain defaults — 80.9 % versus 87.0 %. So tuned
parameters only replace the defaults after **≥ 4 labelled sets** and a clear
in-sample margin. Corrections are always collected; they are just not trusted
early.

Six ideas were tested against that dataset and **all lost to plain defaults** —
rotation-aware thresholds, impact rejection, autocorrelation re-count,
median-cadence rhythm repair, a per-exercise calibration ratio, and ungated
parameter fitting. They are documented here so nobody re-tries them blind. The
bottleneck is labelled sets per exercise, not cleverness.

### Exercise recognition

Each set's motion signature — rep cadence, rotation peak/mean, acceleration
RMS and peak — identifies the exercise by nearest centroid. Leave-one-out over
the 17 labelled sets: **82 % top-1, 100 % top-2**, against a 17 % chance
baseline across 6 exercises. It pre-picks the exercise after a set; your choice
always wins and updates the centroid.

---

## Reference hardware

The protocol notes below describe the puck used for development. Any
NUS-compatible IMU beacon follows the same pattern with its own scaling.

| Part | Component |
|---|---|
| MCU | Nordic nRF52810 |
| IMU | ST LSM6DSL (accelerometer + gyroscope) |
| Flash | Macronix MX25R8035F, 1 MB |
| Power | CR2032 |

SWD pads are exposed on the PCB but Nordic APPROTECT is engaged, so firmware
readout requires a full chip erase.

### BLE protocol — Nordic UART Service

| Role | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| Write / RX | `6e400002-…` |
| Notify / TX | `6e400003-…` |
| LED (bit 0) | `6e400004-…` |

Subscribe to notifications, then write this to RX to start the IMU stream:

```
20 10 00 D0 07 68 00 03
```

Byte 5 is the output data rate: `0x68` = 104 Hz, `0x34` = 52 Hz.

### Frame format — 14 bytes

```
[0]      0x22                       header
[1]      button: 0x00 up, 0x01 down
[2..7]   gyro  X, Y, Z   int16 LE   -> divide by 131.0   = deg/s
[8..13]  accel X, Y, Z   int16 LE   -> divide by 2048.0  = g   (±16 g)
```

**Two mistakes that are easy to make** (we made both):

1. *Assuming the accelerometer comes first.* It does not. Verification from a
   real capture: the bytes 8–13 channels read `-1186, -191, +1494` at rest,
   whose magnitude is 1917 ≈ 2048 — that is gravity.
2. *Matching only the `22 00` header.* Byte 1 is the button, so **every frame
   is `22 01` while the button is held** and a strict match silently discards
   them all.

Notifications arrive as **bursts of several frames at arbitrary offsets**, so
scan for the header inside each notification instead of reading fixed offsets.
Reading fixed offsets is what produced a ~33 % valid-frame rate on iOS in an
earlier version of the cadence app.

Reading motion data needs no authentication. (Uploading game scores in the
official app is gated by a challenge–response using a key behind APPROTECT —
irrelevant here, and out of scope.)

---

## Analytics SDK

[`sdk/ironcap.mjs`](sdk/ironcap.mjs) is a dependency-free ES module (browser and
Node) that parses an export and computes analytics. It also ships the **reference
rep-counting detector**, so the exact algorithm the phone runs can be replayed
and unit-tested off-device.

```js
import * as IronCap from './sdk/ironcap.mjs';

const data   = IronCap.parse(exportedJson);   // tolerant of every export version
const report = IronCap.analyze(data);

report.totals;      // { workouts, sets, reps, volumeKg, durationMin }
report.byExercise;  // per-exercise volume, bestE1RM, PRs, session progression
report.counter;     // how well the auto-counter did vs your confirmed counts

IronCap.epley1RM(100, 10);            // → 133.3  (estimated 1RM)
IronCap.countTrace(rawTrace).count;  // replay the detector on a raw signal
IronCap.recount(researchSet, { sens: 1.1 });   // re-count with different params
```

## Training partners — one sensor, several people

Add partners in Settings and the app takes turns for you: whoever is up is
tagged on the set, the turn passes automatically once a set is saved, and a bar
at the top shows each person's sets, reps and volume for the session — which is
the whole point when two people alternate on the same bar.

Records and last-used weights are kept **per person**, so a partner's heavier
set never wipes your PR or prefills your weight. Names stay on the phone;
uploads carry only each person's anonymous id, and a session with two lifters
arrives as one file with the sets tagged individually.

## Coach sync — collecting datasets from testers

Two ways to get a finished workout off a tester's phone. Neither puts a
credential on the device.

**1. Share sheet — nothing to set up.** Settings → *Share last workout* hands
the file to Telegram, mail or anything else installed. One tap, no accounts,
no configuration. Good enough for a handful of friends.

**2. Collector URL — fully automatic.** Paste one address into Settings and
finished workouts upload themselves, queued in local storage and retried
because gym signal is bad. The address is **not a secret**: the worst a leak
allows is someone posting junk to your own collector, which you fix by
rotating the URL. Any real token stays server-side.

[`worker/ironcap-upload.js`](worker/ironcap-upload.js) is a ~30-line Cloudflare
Worker (free tier) that accepts an upload and forwards it to Telegram as a
file:

```bash
npm i -g wrangler && wrangler login
wrangler deploy      -c worker/wrangler.toml
wrangler secret put BOT_TOKEN  -c worker/wrangler.toml   # from @BotFather
wrangler secret put CHAT_ID    -c worker/wrangler.toml   # your numeric chat id
wrangler secret put UPLOAD_KEY -c worker/wrangler.toml   # optional, adds ?k=...
```

**No Node installed?** Skip Wrangler entirely and use the Cloudflare
dashboard — the whole thing is copy-paste:

1. **Workers & Pages → Create → Start with Hello World → Deploy.**
   Name it `ironcap-upload`.
2. **Edit code**, select everything in the editor, paste
   [`worker/ironcap-upload.js`](worker/ironcap-upload.js), **Deploy**.
3. **Settings → Variables and Secrets → Add**, type **Secret**:
   `BOT_TOKEN` (from @BotFather) and `CHAT_ID` (your numeric chat id).
   Deploy again so the secrets take effect.
4. **Settings → Domains & Routes → Add → Custom domain**, enter
   `ironcap.yourdomain.com`. Cloudflare adds the DNS record and certificate.
5. Paste `https://ironcap.yourdomain.com/upload` into the app and press
   **Test**.

**With Wrangler, on your own domain.** If the zone is in the same Cloudflare
account, set the subdomain in [`worker/wrangler.toml`](worker/wrangler.toml)
and Wrangler creates the DNS record and certificate for you:

```toml
routes = [{ pattern = "ironcap.example.com", custom_domain = true }]
```

The collector URL is then `https://ironcap.example.com/upload`. Comment the
block out to stay on the free `*.workers.dev` address instead. Either way you
paste that one URL into each tester's phone once. Any endpoint works — the app
POSTs `text/plain`, so the request stays "simple" and no CORS preflight is
involved.

> An earlier version called the Telegram Bot API straight from the page. That
> worked, but a bot token had to be typed into each tester's phone, which is
> both awkward to set up and a secret living in someone else's browser. The
> URL indirection removes it.

### What is actually sent

Both routes send the same document, built by **allow-list** so a field added
elsewhere in the app can never leak into an upload by accident. Settings has a
**See exactly what gets sent** button that prints the real JSON.

| Sent | Not sent |
|---|---|
| Anonymous participant id (`p_7f3a91`) | Any name or partner label |
| Exercise names, reps, weight, tempo | The BLE device name or id |
| Raw motion traces, auto vs confirmed counts, how the set started | Wall-clock timestamps — times are seconds from the start of the workout, plus the calendar date |
| Detector parameters and motion signatures | Personal records or last-used weights |

The participant id is generated on the device, groups that person's sets so
per-athlete tuning is possible without knowing who they are, and can be
re-rolled from Settings. A session with two lifters arrives as one file with
each set tagged by id.

## Integration API

The app exposes a **read-only** surface for other tools.

**Same page / console:**

```js
IronCap.snapshot()    // the full export object — feed straight into the SDK
IronCap.workouts()    // finished + in-progress workouts
IronCap.exercises()   // exercise library with PRs and tuned detector params
IronCap.on('set',     s => …)   // fires on every logged set (incl. PRs)
IronCap.on('workout', w => …)   // fires when a workout is finished
```

**Embedded in an iframe** — request/response and live events over `postMessage`:

```js
const app = document.querySelector('iframe').contentWindow;
app.postMessage({ source: 'host', type: 'snapshot', id: 1 }, '*');

window.addEventListener('message', e => {
  if (e.data?.source !== 'ironcap') return;
  // replies: { source:'ironcap', type, id, data }
  // live events: { source:'ironcap', type:'set'|'workout', payload }
});
```

Request types: `snapshot`, `workouts`, `exercises`, `version`.

### Export schema

`IronCap.snapshot()` and the **Data → Export dataset** button produce:

```jsonc
{
  "app": "IronCap", "version": "5.0", "build": "abc1234",
  "exercises": { "Squat": { "params": {…}, "pr": {…}, "used": 4, "labels": 2 } },
  "workouts":  [ { "start": …, "end": …,
                   "sets": [ { "ex": "Squat", "reps": 10, "w": 100, "e1": 133.3,
                               "pr": ["1RM"], "ecc": 1.4, "ts": … } ] } ],
  "research":  [ { "ts": …, "ex": "Squat", "auto": 9, "truth": 10, "corrected": true,
                   "gyroPeak": 22, "gyroMean": 9,
                   "raw": [[dt_ms, vertical_accel_g, rotation_dps], …] } ]
}
```

## Putting it on your own domain

One hostname serves one origin, so the app and the collector need **different**
subdomains — the app is on GitHub Pages, the collector is a Cloudflare Worker.
Give the memorable one to the app, since that is the link testers open:

| Host | Serves |
|---|---|
| `ironcap.yourdomain.com` | the app (GitHub Pages) |
| `collect.yourdomain.com` | the collector (Cloudflare Worker) |

**App on GitHub Pages, DNS on Cloudflare:**

1. Cloudflare DNS → add `CNAME` `ironcap` → `<user>.github.io`, and set it to
   **DNS only** (grey cloud). Proxying it before GitHub issues its certificate
   causes a redirect loop.
2. Repo → **Settings → Pages → Custom domain** → `ironcap.yourdomain.com`,
   then wait for the certificate and tick **Enforce HTTPS**.
3. Repo → **Settings → Secrets and variables → Actions → Variables** → add
   `PAGES_DOMAIN` = `ironcap.yourdomain.com`.

The workflow writes a `CNAME` file only when `PAGES_DOMAIN` is set, so nothing
changes until step 3 — set the DNS up first and the site is never offline.

**Collector on the Worker:** attach `collect.yourdomain.com` to it (dashboard →
Worker → *Settings → Domains & Routes → Add → Custom domain*, or the `routes`
block in [`worker/wrangler.toml`](worker/wrangler.toml)), then paste
`https://collect.yourdomain.com/upload` into the app.

## DevOps — CI/CD

Everything ships through a [GitHub Actions pipeline](.github/workflows/ci.yml);
no external infrastructure.

- **Test** — Node's built-in runner unit-tests the rep-counting detector and the
  analytics SDK ([`test/`](test/)). Deterministic synthetic signals with known
  rep counts assert the counter's accuracy, and a guard step fails the build if
  the app's detector constants ever drift from the SDK's.
- **Deploy** — on `main`, the site is staged and published to GitHub Pages with
  the official `deploy-pages` action (Pages source = *GitHub Actions*, not a
  branch).
- **Build manifest** — the pipeline writes [`build-info.json`](https://midit.github.io/triki/build-info.json)
  (commit, build time, run number). The app fetches it at runtime and shows the
  build in Settings — a tiny always-current health/version endpoint.

```bash
node --test test/     # run the suite locally
```

## Running locally

```bash
python -m http.server 8765
```

Then open `http://localhost:8765/ironcap.html`. Web Bluetooth requires a secure
context: `localhost` and `https` qualify, plain `http` over the LAN does not.

## Repository layout

```
ironcap.html               the gym app (deployed as the site root too)
cadence.html               cycling cadence app
manifest.webmanifest       PWA manifest
sw.js                      service worker, offline shell
worker/                    optional Cloudflare Worker that collects uploads
sdk/ironcap.mjs            analytics SDK + reference detector (browser & Node)
test/                      unit tests (node --test)
.github/workflows/ci.yml   test + deploy pipeline
triki_logger.py            desktop BLE logger (bleak) for capturing raw data
```

## Status and honest limitations

- **Guided motion counts far better than free weights.** On a real leg day,
  puck on the **weight stack** was 100 % accurate (7/7 sets exact); puck on a
  **barbell** was ~83 % (0/9 exact) — the bar tilts, whips and bounces, so its
  vertical signal is genuinely noisier. The mount is fine; the movement is the
  hard part. The rotation rate (gyroscope) is now captured per set so a
  bar-aware counter can be built and verified on real data.
- **Overall measured accuracy is ~87 % of reps** (34 labelled sets across two
  sessions, every label cross-checked against a manual log). Good enough to be
  genuinely useful; not yet good enough to be relied on blindly, which is why
  the app always asks you to confirm.
- Failure modes differ per exercise and point in *opposite* directions — a
  lying triceps extension roughly doubles, a hammer curl undercounts — so no
  single global rule fixes both.
- Detector defaults are fitted on labelled squat data. Each new exercise needs
  a few corrections before it settles.
- **iOS needs the Bluefy browser**; Safari has no Web Bluetooth and Apple shows
  no sign of adding it. Android Chrome works normally.
- The rep counter is the maintained part; the cadence app is an earlier
  experiment kept for reference.

Contributions and captured datasets are welcome — especially labelled
recordings from exercises other than squats.

## Credits

Frame layout, the button byte and the scaling factors were worked out by the
community in [TrikiScope](https://github.com/Maku-hub/TrikiScope) and
[zabka-triki-hardware](https://github.com/Piwencjusz/zabka-triki-hardware).

## License

MIT
