'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const ap = loadTs('src/shared/agentProvider.ts');
const { selectOrphansToArchive } = loadTs('src/shared/orphanedAgents.ts');
const { contextCommandsForProvider } = loadTs('src/shared/providerAutomation.ts');

test('lab is a recognized provider with a PTY-less preset that can receive inbox mail', () => {
  assert.equal(ap.isAgentProvider('lab'), true);
  assert.equal(ap.normalizeAgentProvider('lab'), 'lab');
  assert.equal(ap.isPtylessProvider('lab'), true);
  assert.equal(ap.isPtylessProvider('claude'), false);
  assert.equal(ap.isPtylessProvider(undefined), false);
  const preset = ap.providerPreset('lab');
  assert.equal(preset.id, 'lab');
  assert.equal(preset.defaultCommand, '');
  assert.equal(preset.hiveAware, false, 'no Claude-only identity injection');
  assert.equal(ap.canReceiveInbox('lab'), true, 'the router writes into inbox/ (no terminal handoff)');
  assert.equal(ap.bridgeOf('lab'), undefined, 'no hook shim or proxy sidecar');
});

test('lab is not offered by the hire pickers (not a member of AGENT_PROVIDER_PRESETS)', () => {
  assert.ok(!ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'lab'));
});

test('an explicit lab provider survives inference; the other providers are unchanged', () => {
  assert.equal(ap.inferAgentProvider('', 'lab'), 'lab');
  assert.equal(ap.inferAgentProvider('claude'), 'claude');
  assert.equal(ap.inferAgentProvider('codex --x'), 'codex');
  assert.equal(ap.inferAgentProvider('mystery-bin'), 'custom');
});

test('lab has no context commands to type', () => {
  const c = contextCommandsForProvider('lab');
  assert.equal(c.compact, null);
  assert.equal(c.clear, null);
});

test('archiveOrphanedAgents keeps lab agents, still archives a stale PTY-less non-lab agent', () => {
  const agents = {
    god: { provider: 'claude' },
    'lab-exec': { provider: 'lab' },
    'lab-reframer': { provider: 'lab' },
    'stale-claude': { provider: 'claude' },
    'stale-nodecl': {},
    'live-claude': { provider: 'claude' },
    'already-archived': { provider: 'claude', archived: true }
  };
  const live = new Set(['live-claude']);
  const out = selectOrphansToArchive(agents, 'god', (id) => live.has(id));
  assert.deepEqual(out.sort(), ['stale-claude', 'stale-nodecl']);
});

test('a lab god is never archived, and a non-lab registry behaves exactly as before', () => {
  const agents = { god: { provider: 'lab' }, a: { provider: 'claude' }, b: { provider: 'codex', archived: false } };
  assert.deepEqual(selectOrphansToArchive(agents, 'god', () => false).sort(), ['a', 'b']);
  assert.deepEqual(selectOrphansToArchive(agents, null, () => true), []);
});
