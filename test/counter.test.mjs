import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTrace, DEFAULTS, recount } from '../sdk/ironcap.mjs';

/* A clean, deterministic vertical-acceleration trace of `reps` cosine cycles
   at `freq` Hz, sampled at 60 Hz with a 1 s lead-in. No randomness, so the
   counts are stable across machines and Node versions. */
function cleanTrace(freq, reps, amp = 0.4) {
  const dt = 1 / 60, work = reps / freq, rec = [];
  const total = Math.round((work + 2) * 60);
  for (let i = 0; i < total; i++) {
    const s = i * dt, p = s - 1;
    const on = s > 1 && p < work;
    rec.push([Math.round(dt * 1000), +(on ? amp * Math.cos(2 * Math.PI * freq * p) : 0).toFixed(4)]);
  }
  return rec;
}

test('detector defaults have not drifted', () => {
  assert.deepEqual(DEFAULTS, { sens: 0.90, perMin: 0.70, floor: 0.048 });
});

test('counts clean signals within one rep of truth', () => {
  for (const freq of [0.35, 0.45, 0.6, 0.8]) {
    for (const reps of [5, 8, 10, 12]) {
      const got = countTrace(cleanTrace(freq, reps)).count;
      assert.ok(Math.abs(got - reps) <= 1,
        `freq ${freq}, reps ${reps}: got ${got}`);
    }
  }
});

test('flat / still signal counts zero', () => {
  const flat = Array.from({ length: 60 * 20 }, () => [17, 0]);
  assert.equal(countTrace(flat).count, 0);
});

test('a gap in the stream resets the detector cleanly', () => {
  const a = cleanTrace(0.45, 6);
  const b = cleanTrace(0.45, 6);
  a.push([500, 0]);                    // 500 ms gap between two bouts
  const joined = countTrace(a.concat(b)).count;
  assert.ok(joined >= 10 && joined <= 13, `joined bouts: ${joined}`);
});

test('count is monotonic in rep count', () => {
  let prev = -1;
  for (const reps of [4, 6, 8, 10, 12, 14]) {
    const got = countTrace(cleanTrace(0.45, reps)).count;
    assert.ok(got >= prev, `not monotonic at ${reps}: ${got} < ${prev}`);
    prev = got;
  }
});

test('recount reproduces the count from a stored trace', () => {
  const raw = cleanTrace(0.5, 9);
  const direct = countTrace(raw).count;
  assert.equal(recount({ raw }, DEFAULTS), direct);
});

test('sensitivity parameter changes the count', () => {
  const raw = cleanTrace(0.45, 10, 0.12);         // low amplitude
  const strict = countTrace(raw, { sens: 1.4 }).count;
  const loose = countTrace(raw, { sens: 0.5 }).count;
  assert.ok(loose >= strict, `loose ${loose} < strict ${strict}`);
});
