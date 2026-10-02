'use strict';

/**
 * The god seat in lab mode lives in a React effect (useHive.ts), which node:test cannot run. These are source-contract
 * checks on the one branch that matters, in the same spirit as the repo's other source-reading tests: in lab mode the seat is
 * created WITHOUT a process and WITHOUT any terminal typing, and the Claude path below it is untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');

function labBranch() {
  const start = src.indexOf('if (lab?.enabled) {');
  assert.ok(start > 0, 'the lab branch exists');
  const end = src.indexOf('\n      }\n', start);
  assert.ok(end > start);
  return src.slice(start, end);
}

test('lab mode seats the god without spawning a process or typing into a terminal', () => {
  const branch = labBranch();
  for (const forbidden of ['spawnPty', 'submitToPty', 'remoteControlCommandForProvider', 'INITIAL_GOD_PROMPT', 'ptyId', 'buildSpawnCommand']) {
    assert.ok(!branch.includes(forbidden), `the lab branch must not touch ${forbidden}`);
  }
  assert.match(branch, /provider: 'lab'/);
  assert.match(branch, /isGod: true/);
  assert.match(branch, /lab\.godName/, 'the seat is named from the lab config');
  assert.match(branch, /setGodStatus\('ready'\)/);
  assert.match(branch, /return;/, 'it never falls through to the Claude spawn');
});

test('the lab branch comes BEFORE the Claude spawn, and the Claude spawn path is still there for non-lab mode', () => {
  const lab = src.indexOf('if (lab?.enabled) {');
  const spawn = src.indexOf('await window.cth.spawnPty({\n        id: GOD_PTY');
  assert.ok(lab > 0 && spawn > lab, 'lab branch precedes the god spawn');
  assert.ok(src.includes("const godName = resolveGodName(reg?.agents?.[GOD_ID]?.name);"), 'non-lab: the persisted god name still wins');
  assert.ok(src.includes('remoteControlCommandForProvider(godProvider, godName)'), 'non-lab: /remote-control still typed');
  assert.ok(src.includes('INITIAL_GOD_PROMPT'), 'non-lab: the orientation prompt is still sent');
});

test('lab agents are carded without a PTY and never steal the selection', () => {
  const start = src.indexOf('function addLabAgentCard');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(!body.includes('ptyId'));
  assert.match(body, /provider: 'lab'/);
  assert.match(body, /select\(before\)/);
  assert.match(src, /if \(rec\.ptyless \|\| rec\.provider === 'lab'\) \{ addLabAgentCard\(rec\); return; \}/);
});

test('the inbox-wake and queue loops only visit agents that own a PTY (so a lab agent is never typed into)', () => {
  assert.match(src, /useStore\.getState\(\)\.agents\.filter\(\(a\) => a\.ptyId\)/, 'wake loop filters on ptyId');
  assert.match(src, /for \(const a of agents\) \{\n\s+if \(!a\.ptyId\) continue;/, 'context trigger loop skips PTY-less agents');
});

test('the synthetic demo loop never animates a lab floor: a lab agent counts as live', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/App.tsx'), 'utf8');
  assert.match(app, /const hasLive = useStore\.getState\(\)\.agents\.some\(\(a\) => a\.ptyId \|\| a\.provider === 'lab'\);/);
  assert.match(app, /if \(DEMO \|\| !hasLive\) startMockLoop\(\);/, 'the demo and empty-floor paths are as before');
});

test('the monitor tab offers no engine, model or restart control for a PTY-less agent (it could only spawn a CLI into a lab seat)', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/CommandCenterPanel.tsx'), 'utf8');
  assert.match(panel, /\{!a\.isGod && !isPtylessProvider\(a\.provider\) && \(/, 'the per-agent model/restart row is hidden');
  assert.match(panel, /\{a\.isGod && !isPtylessProvider\(a\.provider\) && \(/, 'the god engine row (apply / restart & continue) is hidden');
});
