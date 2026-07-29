# IronCap — a gym rep counter built from a bottle-cap BLE toy

[![CI/CD](https://github.com/midit/triki/actions/workflows/ci.yml/badge.svg)](https://github.com/midit/triki/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-midit.github.io%2Ftriki-2fd07a)](https://midit.github.io/triki/ironcap.html)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Żabka, a Polish convenience-store chain, gave away a small BLE gadget called
**Triki** — a plastic bottle cap with a motion sensor inside, meant for playing
tilt games in their loyalty app. It contains a genuinely decent IMU.

This repo turns it into a **gym rep counter**. Glue a neodymium magnet to the
back and it sticks to a weight stack, a plate, or a barbell. Everything runs in
the browser on your phone over Web Bluetooth — no server, no account, no app
store.

| App | Link | What it does |
|---|---|---|
| **IronCap** | [`ironcap.html`](ironcap.html) | Counts reps on any exercise, tracks tempo, learns from your corrections, keeps a workout history |
| **Cadence** | [`index.html`](index.html) | Earlier experiment: cycling cadence from the same puck |

**Live:** https://midit.github.io/triki/ironcap.html

> Not affiliated with Żabka. Hardware documentation credit at the bottom.

---

## Getting started

1. **iOS:** install [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).
   Safari does not support Web Bluetooth. **Android:** Chrome works.
2. **Press the button on the cap** to wake it, then hit *Connect*. The device
   sleeps to save its CR2032 and holds only **one** connection at a time.
3. Stick it on the weight — orientation does not matter.
4. Press *Start set*, do your reps, press it again. Confirm the count.

The cap's button is the only physical control you need:

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

Each exercise stores its own detector parameters plus the raw traces of its
labelled sets. When you correct a count, a grid search looks for parameters
that reproduce the true count across **all** labelled sets of that exercise at
once. Among equally accurate candidates it picks the most **conservative** one,
because corrections only ever supply positive examples — without that
tie-break the search slides into over-sensitivity and starts counting noise.

This is parameter fitting, not a neural network, and that is deliberate: it
works from a single example, runs in about 100 ms in a phone browser, and you
can read exactly which numbers changed and why. On a real squat recording it
went from 9 to a correct 10.

Every set is also written to a research log with its raw trace and confirmed
count. Export it from the **Data** tab — that dataset is what makes the counter
better over time.

---

## Hardware

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
  "research":  [ { "ts": …, "ex": "Squat", "auto": 9, "truth": 10,
                   "corrected": true, "raw": [[dt_ms, vertical_accel_g], …] } ]
}
```

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
ironcap.html               the gym app (self-contained, no dependencies)
index.html                 cycling cadence app
manifest.webmanifest       PWA manifest
sw.js                      service worker, offline shell
sdk/ironcap.mjs            analytics SDK + reference detector (browser & Node)
test/                      unit tests (node --test)
.github/workflows/ci.yml   test + deploy pipeline
triki_logger.py            desktop BLE logger (bleak) for capturing raw data
```

## Status and honest limitations

- Detector defaults are fitted on **one** labelled exercise (squats). Other
  exercises will need a few corrections before they are accurate.
- Accuracy on presses, rows and machine work is **not yet measured**.
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
