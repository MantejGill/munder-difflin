'use strict';

/** The lab panel's data reducers, fed with REAL lab-v4-progress/1 snapshots recorded from the $0 lab-v4 dry run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const fixture = require('./fixtures/lab-v4-progress.json');

const P = loadTs('src/shared/labProgress.ts');
const { validateProgress } = loadTs('src/shared/labControlProtocol.ts');
const [first, escalated, last] = fixture.snapshots;

test('the recorded snapshots are valid lab-v4-progress/1 documents for the control server', () => {
  for (const s of fixture.snapshots) {
    assert.equal(s.schema, 'lab-v4-progress/1');
    const v = validateProgress(s);
    assert.equal(v.ok, true, v.error);
  }
});

test('no snapshot yet (null, junk, arrays) gives the empty model, never a throw', () => {
  for (const bad of [null, undefined, 3, 'x', [], {}.constructor]) {
    const m = P.buildLabModel(bad);
    assert.equal(m.hasData, false);
    assert.deepEqual(m.curve, []);
    assert.equal(m.rung, null);
  }
  const m = P.buildLabModel({ schema: 'lab-v4-progress/1' });
  assert.equal(m.hasData, true, 'a bare snapshot still renders (a first round)');
  assert.deepEqual([m.curve, m.reframes, m.ruledOut, m.violations], [[], [], [], []]);
  assert.equal(m.budget, null);
});

test('progress curve: best-so-far over trials, with the improving trials marked', () => {
  const m = P.buildLabModel(last);
  assert.equal(m.round, 9);
  assert.equal(m.curve.length, 3);
  assert.deepEqual(m.curve.map((p) => p.trial), [1, 2, 3]);
  assert.deepEqual(m.curve.map((p) => p.improved), [true, true, true]);
  assert.ok(m.curve[0].bestGain < m.curve[1].bestGain && m.curve[1].bestGain < m.curve[2].bestGain);
  assert.equal(m.curve[2].label, 'placement (density=higher, timingDriven=true)');
  assert.equal(m.curveMax, last.best.gain);
  assert.equal(P.formatGain(m.curve[2].bestGain), '+24.7%');
  assert.deepEqual(m.best && [m.best.label, m.best.round, m.best.evidenceRef], ['placement (density=higher, timingDriven=true)', 6, 'sha256:v4-5']);
  assert.equal(m.objective.metricId, 'setup_tns_ns');
  assert.equal(m.objective.barGain, 0.05);
});

test('a trial that does not beat the best is not marked as an improvement; best-so-far never decreases', () => {
  const snap = { schema: 'lab-v4-progress/1', curve: [
    { trial: 1, round: 1, key: 'a::{}', gain: 0.1, bestGain: 0.1 },
    { trial: 2, round: 2, key: 'b::{}', gain: 0.02, bestGain: 0.1 },
    { trial: 3, round: 3, key: 'c::{}', gain: null, bestGain: 0.1 }
  ] };
  const m = P.buildLabModel(snap);
  assert.deepEqual(m.curve.map((p) => p.improved), [true, false, false]);
  assert.deepEqual(m.curve.map((p) => p.bestGain), [0.1, 0.1, 0.1]);
  assert.equal(m.curve[2].gain, null);
});

test('current ladder rung and the escalation history', () => {
  const before = P.buildLabModel(first);
  assert.equal(before.rung.id, 'tune-parameters');
  assert.deepEqual(before.rungHistory, []);
  const m = P.buildLabModel(last);
  assert.equal(m.rung.id, 'change-structure');
  assert.equal(m.rung.label, 'change the method structure');
  assert.deepEqual([m.rung.index, m.rung.total, m.rung.exhausted], [1, 2, false]);
  assert.deepEqual(m.rung.available, ['tune-parameters', 'change-structure']);
  assert.equal(m.rungHistory.length, 1);
  const h = m.rungHistory[0];
  assert.deepEqual([h.round, h.from, h.to, h.reason], [5, 'tune parameters of the current method', 'change the method structure', 'plateau']);
  assert.match(h.detail, /last 2 trials \+3\.4%, threshold \+5\.0%/);
  assert.equal(P.buildLabModel(escalated).rungHistory.length, 1, 'the escalation round already shows it');
});

test('reframe proposals: predicted versus measured, pending ones, and in-flight ones read "running"', () => {
  const m = P.buildLabModel(last);
  assert.deepEqual(m.reframes.map((r) => r.id), ['rf-1', 'rf-2', 'rf-3', 'rf-4']);
  assert.deepEqual(m.reframes.map((r) => r.state), ['tested', 'pending', 'pending', 'pending']);
  const rf1 = m.reframes[0];
  assert.equal(rf1.predicted, 0.15);
  assert.ok(Math.abs(rf1.measured - 0.2471618043474414) < 1e-12);
  assert.ok(Math.abs(rf1.error - 0.0971618043474414) < 1e-12);
  assert.equal(rf1.summary, 'predicted +15.0%, measured +24.7%');
  assert.equal(rf1.assumption, 'local-eco-fixes-suffice');
  assert.equal(m.reframes[1].measured, null);
  assert.match(m.reframes[1].summary, /^predicts \+15\.0% \(confidence 0\.4\)$/);
  const running = P.buildLabModel(last, [last.reframes[1].trialKey]);
  assert.deepEqual(running.reframes.map((r) => r.state), ['tested', 'running', 'pending', 'pending']);
});

test('dropped and tainted reframes are labelled honestly', () => {
  const snap = { schema: 'lab-v4-progress/1', reframes: [
    { id: 'rf-9', name: 'x', assumption: 'a', status: 'dropped', trialKey: 'k::{}', predictedEffect: { magnitude: 0.2, confidence: 0.5 }, measured: null, drop: { reason: 'budget reserved elsewhere' } },
    { id: 'rf-8', name: 'y', assumption: 'a', status: 'tested', trialKey: 'j::{}', predictedEffect: { magnitude: 0.2 }, measured: { gain: 0.3, predictedGain: 0.2, error: 0.1, tainted: true } }
  ] };
  const [dropped, tainted] = P.buildLabModel(snap).reframes;
  assert.equal(dropped.state, 'dropped');
  assert.equal(dropped.summary, 'dropped: budget reserved elsewhere');
  assert.equal(tainted.tainted, true);
  assert.match(tainted.summary, /tainted, does not count/);
});

test('ruled-out list carries the reason, the gain and the evidence', () => {
  const m = P.buildLabModel(last);
  assert.equal(m.ruledOut.length, 1);
  assert.equal(m.ruledOut[0].label, 'repair-timing (sequence=sizing-only, setupMarginNs=0)');
  assert.match(m.ruledOut[0].reason, /below the 2\.0% meaningful threshold/);
  assert.equal(m.ruledOut[0].evidenceRef, 'sha256:v4-3');
});

test('budget: used, remaining, reserved confirmation and the reframe budget owed/tested', () => {
  const b = P.buildLabModel(last).budget;
  assert.deepEqual([b.total, b.used, b.confirmations, b.remaining], [4, 3, 1, 0]);
  assert.equal(b.usedFraction, 1);
  assert.deepEqual(b.reframe, { required: 1, tested: 1, owed: 0, pending: 3 });
  const early = P.buildLabModel(first).budget;
  assert.deepEqual([early.used, early.usedFraction], [0, 0]);
  assert.equal(early.reframe.owed, early.reframe.required - early.reframe.tested);
  const noTotal = P.buildLabModel({ schema: 'lab-v4-progress/1', budget: { total: null, experimentsUsed: 2 } }).budget;
  assert.equal(noTotal.usedFraction, null);
});

test('held-out lesson gate: counts per status and the listed lessons', () => {
  assert.equal(P.buildLabModel(last).lessons, null, 'no lesson store in the dry run');
  const snap = { schema: 'lab-v4-progress/1', lessons: { candidate: 2, validated: 1, rejected: 3, items: [
    { id: 'lesson-1', status: 'validated', problemType: 'pd-timing', approach: 'placement {"density":"higher"}', heldOutCases: 3, improved: 2 },
    { id: 'lesson-2', status: 'rejected', problemType: 'pd-timing', approach: 'cts', heldOutCases: 2, improved: 0 }
  ] } };
  const l = P.buildLabModel(snap).lessons;
  assert.deepEqual([l.candidate, l.validated, l.rejected], [2, 1, 3]);
  assert.deepEqual(l.items.map((i) => i.status), ['validated', 'rejected']);
  assert.equal(l.items[0].detail, 'pd-timing, held-out 2/3 improved');
  assert.deepEqual(P.buildLabModel({ schema: 'lab-v4-progress/1', lessons: { candidate: 1 } }).lessons.items, []);
});

test('violations are shown as text whether the loop sends strings or objects', () => {
  const m = P.buildLabModel({ schema: 'lab-v4-progress/1', violations: ['sealed term in prompt', { rule: 'tweak-refused', n: 2 }] });
  assert.deepEqual(m.violations, ['sealed term in prompt', '{"rule":"tweak-refused","n":2}']);
});

test('trial keys and gains format for display', () => {
  assert.equal(P.describeTrialKey('placement::{"density":"higher"}'), 'placement (density=higher)');
  assert.equal(P.describeTrialKey('plain'), 'plain');
  assert.equal(P.describeTrialKey('x::{not json'), 'x');
  assert.equal(P.describeTrialKey(undefined), 'n/a');
  assert.equal(P.formatGain(-0.05), '-5.0%');
  assert.equal(P.formatGain(null), 'n/a');
  assert.equal(P.formatGain(0.1234, 2), '+12.34%');
});

test('gates sort open first, newest first', () => {
  const g = (id, status, raisedAt) => ({ id, kind: 'other', title: id, question: 'q', cardId: id, status, raisedAt });
  const out = P.sortGates([g('old-open', 'pending', '2026-01-01'), g('done', 'approved', '2026-03-01'), g('new-open', 'pending', '2026-02-01')]);
  assert.deepEqual(out.map((x) => x.id), ['new-open', 'old-open', 'done']);
});

test('the reducer does not mutate the snapshot it is given', () => {
  const copy = structuredClone(last);
  P.buildLabModel(copy, ['x']);
  assert.deepEqual(copy, last);
});
