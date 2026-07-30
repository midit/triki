/**
 * IronCap SDK — parse and analyse workout data exported from the IronCap app.
 *
 * Runs in the browser and in Node with no dependencies:
 *
 *   import * as IronCap from './sdk/ironcap.mjs';
 *   const data = IronCap.parse(exportedJson);
 *   const report = IronCap.analyze(data);
 *
 * It also ships the reference rep-counting detector, so the exact algorithm
 * the phone runs can be replayed and unit-tested off-device.
 *
 * @license MIT
 */

export const VERSION = '1.0.0';

/* ── reference rep detector ─────────────────────────────────────────────
   Mirrors the in-app counter. A rep is one oscillation cycle of a
   pseudo-velocity signal: band-pass(acceleration) → integrate → band-pass.
   See the project README for why integration (not raw acceleration) is
   used and why sets are counted on the upward crossing after a descent. */
export const DEFAULTS = Object.freeze({ sens: 0.90, perMin: 0.70, floor: 0.048 });
const PER_MAX = 9.0, DT_MIN = 0.004, DT_MAX = 0.20, GAP = 0.35, G = 9.80665;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Count reps in a vertical-acceleration trace.
 * @param {number[][]} rec  frames as [dt_ms, vertical_acceleration_g] or
 *                          [dt_ms, vertical_acceleration_g, rotation_dps].
 *                          A 3rd rotation column is ignored by the counter.
 * @param {object} [params] {sens, perMin, floor}
 * @returns {{count:number, reps:{t:number,period:number,eccentric:number}[]}}
 */
export function countTrace(rec, params = {}) {
  const P = { ...DEFAULTS, ...params };
  let fast = 0, slow = 0, pv = 0, pvHi = 0, pvLo = 0, rms = 0;
  let st = 0, tFlip = 0, tCycle = 0, tDown = 0, last = -99, halfUp = 0, halfDn = 0;
  let t = 0; const reps = [];
  for (let i = 0; i < rec.length; i++) {
    const dtRaw = rec[i][0] / 1000, aV = rec[i][1];
    t += dtRaw;
    const gap = dtRaw > GAP, dt = clamp(dtRaw, DT_MIN, DT_MAX);
    if (gap) { fast = slow = pv = pvHi = pvLo = 0; st = 0; tCycle = 0; tDown = 0; }
    fast += (1 - Math.exp(-dt / 0.12)) * (aV - fast);
    slow += (1 - Math.exp(-dt / 1.2)) * (aV - slow);
    const acc = fast - slow;
    pv += acc * G * dt;
    pvHi += (1 - Math.exp(-dt / 1.0)) * (pv - pvHi);
    pvLo += (1 - Math.exp(-dt / 0.10)) * (pv - pvLo);
    const sig = pvLo - pvHi;
    rms += (1 - Math.exp(-dt / 3.0)) * (sig * sig - rms);
    const thr = Math.max(P.floor, Math.sqrt(Math.max(rms, 1e-9)) * P.sens);
    if (st <= 0 && sig > thr) {
      if (st === -1) {
        halfDn = t - tFlip;
        const period = tCycle > 0 ? t - tCycle : (t - tDown) * 2;
        if (period >= P.perMin && period <= PER_MAX && t - last >= P.perMin) {
          last = t; reps.push({ t, period, eccentric: Math.max(halfUp, halfDn) });
        }
        tCycle = t;
      }
      st = 1; tFlip = t;
    } else if (st >= 0 && sig < -thr) {
      if (st === 1) halfUp = t - tFlip;
      tDown = t; st = -1; tFlip = t;
    }
    if (st !== 0 && t - tFlip > PER_MAX) { st = 0; tCycle = 0; }
  }
  return { count: reps.length, reps };
}

/* ── strength math ──────────────────────────────────────────────────── */

/** Estimated one-rep max (Epley). Returns 0 for bodyweight sets. */
export const epley1RM = (weight, reps) =>
  weight > 0 && reps > 0 ? +(weight * (1 + reps / 30)).toFixed(1) : 0;

/** Volume load of a single set. */
export const setVolume = (weight, reps) => (weight > 0 ? weight * reps : 0);

/* ── parsing ────────────────────────────────────────────────────────── */

/**
 * Normalise an IronCap export (any version) into a stable shape.
 * Accepts the object or a JSON string.
 */
export function parse(input) {
  const d = typeof input === 'string' ? JSON.parse(input) : input;
  if (!d || typeof d !== 'object') throw new Error('IronCap.parse: not an object');
  if (d.__ironcap) return d;                           // already normalised
  const exercises = d.exercises || {};
  const workouts = (d.workouts || []).map(w => ({
    start: w.start, end: w.end || w.start,
    durationSec: Math.max(0, Math.round(((w.end || w.start) - w.start) / 1000)),
    sets: (w.sets || []).map(s => {
      const weight = s.weight ?? s.w ?? 0;             // accept raw or normalised keys
      return {
        exercise: s.exercise ?? s.ex, reps: s.reps, weight,
        corrected: !!(s.corrected ?? s.man), eccentric: s.eccentric ?? s.ecc ?? 0, ts: s.ts,
        volume: setVolume(weight, s.reps), e1RM: epley1RM(weight, s.reps),
      };
    }),
  }));
  // research log (rep-counter analysis); older exports called it `sets`
  const research = (d.research || d.sets || []).map(s => ({
    ts: s.ts, exercise: s.exercise ?? s.ex, auto: s.auto, truth: s.truth,
    corrected: !!s.corrected, confidence: s.confidence ?? s.conf, durationSec: s.durationSec ?? s.dur,
    hz: s.hz, params: s.params, raw: s.raw,
    gyroPeak: s.gyroPeak ?? null, gyroMean: s.gyroMean ?? null,   // rotation dps (bar vs machine)
  }));
  return { __ironcap: true, app: d.app || 'IronCap', version: d.version || null, exercises, workouts, research };
}

/* ── analytics ──────────────────────────────────────────────────────── */

const round = (v, n = 1) => +v.toFixed(n);

/** Full analytics report over a parsed export. */
export function analyze(input) {
  const data = parse(input);
  return {
    totals: totals(data),
    byExercise: byExercise(data),
    counter: counterAccuracy(data),
    generatedAt: new Date().toISOString(),
  };
}

function totals(data) {
  let sets = 0, reps = 0, volume = 0, seconds = 0;
  for (const w of data.workouts) {
    seconds += w.durationSec;
    for (const s of w.sets) { sets++; reps += s.reps; volume += s.volume; }
  }
  return {
    workouts: data.workouts.length, sets, reps,
    volumeKg: round(volume, 0), durationMin: Math.round(seconds / 60),
  };
}

/** Per-exercise summary: volume, best estimated 1RM, PRs, session progression. */
export function byExercise(data) {
  const out = {};
  for (const w of data.workouts) {
    const day = new Date(w.start).toISOString().slice(0, 10);
    for (const s of w.sets) {
      const e = out[s.exercise] || (out[s.exercise] = {
        sets: 0, reps: 0, volumeKg: 0, bestE1RM: 0, bestSetVolume: 0, bestReps: 0,
        progression: {},
      });
      e.sets++; e.reps += s.reps; e.volumeKg += s.volume;
      e.bestE1RM = Math.max(e.bestE1RM, s.e1RM);
      e.bestSetVolume = Math.max(e.bestSetVolume, s.volume);
      e.bestReps = Math.max(e.bestReps, s.reps);
      const p = e.progression[day] || (e.progression[day] = { volumeKg: 0, topE1RM: 0 });
      p.volumeKg += s.volume; p.topE1RM = Math.max(p.topE1RM, s.e1RM);
    }
  }
  for (const name in out) {
    const e = out[name];
    e.volumeKg = round(e.volumeKg, 0);
    e.progression = Object.entries(e.progression)
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([date, v]) => ({ date, volumeKg: round(v.volumeKg, 0), topE1RM: v.topE1RM }));
  }
  return out;
}

/**
 * How well the automatic counter did, from the labelled research log.
 * Only sets that carry a confirmed truth count are scored.
 */
export function counterAccuracy(data) {
  const scored = data.research.filter(s => Number.isFinite(s.auto) && Number.isFinite(s.truth));
  if (!scored.length) return { scoredSets: 0 };
  let absErr = 0, exact = 0, within1 = 0, over = 0, under = 0, reps = 0;
  for (const s of scored) {
    const e = s.auto - s.truth;
    absErr += Math.abs(e); reps += s.truth;
    if (e === 0) exact++; if (Math.abs(e) <= 1) within1++;
    if (e > 0) over++; if (e < 0) under++;
  }
  const n = scored.length;
  return {
    scoredSets: n, totalReps: reps,
    meanAbsError: round(absErr / n, 2),
    repAccuracy: round(1 - absErr / Math.max(reps, 1), 3),
    exactRate: round(exact / n, 3),
    withinOneRate: round(within1 / n, 3),
    overCount: over, underCount: under,
  };
}

/**
 * Re-count a research set from its stored raw trace with given params —
 * useful for tuning experiments off-device.
 */
export function recount(researchSet, params) {
  if (!researchSet.raw) throw new Error('set has no raw trace');
  return countTrace(researchSet.raw, params).count;
}

export default { VERSION, DEFAULTS, countTrace, epley1RM, setVolume, parse, analyze, byExercise, counterAccuracy, recount };
