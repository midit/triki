import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, analyze, epley1RM, setVolume, byExercise, counterAccuracy } from '../sdk/ironcap.mjs';

const sample = {
  app: 'IronCap', version: '5.0',
  exercises: { Squat: { used: 2 }, 'Leg press': { used: 1 } },
  workouts: [{
    start: Date.UTC(2026, 6, 29, 18, 0, 0),
    end: Date.UTC(2026, 6, 29, 19, 0, 0),
    sets: [
      { ex: 'Squat', reps: 10, w: 100, man: true, ts: 1 },
      { ex: 'Squat', reps: 8, w: 110, man: false, ts: 2 },
      { ex: 'Leg press', reps: 15, w: 127, man: false, ts: 3 },
    ],
  }],
  research: [
    { ts: 1, ex: 'Squat', auto: 9, truth: 10, corrected: true, conf: 0.6 },
    { ts: 2, ex: 'Squat', auto: 8, truth: 8, corrected: false, conf: 0.9 },
    { ts: 3, ex: 'Leg press', auto: 15, truth: 15, corrected: false, conf: 0.8 },
  ],
};

test('epley 1RM and set volume', () => {
  assert.equal(epley1RM(100, 10), 133.3);
  assert.equal(epley1RM(0, 10), 0);          // bodyweight -> no 1RM
  assert.equal(setVolume(100, 10), 1000);
  assert.equal(setVolume(0, 12), 0);
});

test('parse is tolerant of raw and normalised keys, and idempotent', () => {
  const p = parse(sample);
  assert.equal(p.workouts[0].sets[0].exercise, 'Squat');
  assert.equal(p.workouts[0].sets[0].weight, 100);
  assert.equal(p.workouts[0].sets[0].volume, 1000);
  assert.deepEqual(parse(p), p);             // parsing a parsed object is a no-op
  const fromString = parse(JSON.stringify(sample));
  assert.equal(fromString.totals ?? 'ok', 'ok');
  assert.equal(fromString.workouts.length, 1);
});

test('totals aggregate volume, reps and duration', () => {
  const { totals } = analyze(sample);
  assert.equal(totals.workouts, 1);
  assert.equal(totals.sets, 3);
  assert.equal(totals.reps, 33);
  assert.equal(totals.volumeKg, 1000 + 880 + 1905);   // 3785
  assert.equal(totals.durationMin, 60);
});

test('per-exercise best 1RM and progression', () => {
  const ex = byExercise(parse(sample));
  assert.equal(ex.Squat.bestReps, 10);
  assert.equal(ex.Squat.bestSetVolume, 1000);
  assert.equal(ex.Squat.bestE1RM, epley1RM(110, 8));  // heavier set wins
  assert.equal(ex.Squat.progression.length, 1);
  assert.equal(ex.Squat.progression[0].date, '2026-07-29');
});

test('counter accuracy scores auto vs confirmed truth', () => {
  const acc = counterAccuracy(parse(sample));
  assert.equal(acc.scoredSets, 3);
  assert.equal(acc.totalReps, 33);
  assert.equal(acc.meanAbsError, +(1 / 3).toFixed(2));   // one set off by 1
  assert.equal(acc.exactRate, +(2 / 3).toFixed(3));
  assert.equal(acc.withinOneRate, 1);
  assert.equal(acc.underCount, 1);
  assert.equal(acc.overCount, 0);
});

test('empty data does not throw', () => {
  const r = analyze({ exercises: {}, workouts: [], research: [] });
  assert.equal(r.totals.sets, 0);
  assert.equal(r.counter.scoredSets, 0);
});
