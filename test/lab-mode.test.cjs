'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const mode = loadTs('src/shared/labMode.ts');
const { upsertManagedSection, sectionMarkers } = loadTs('src/shared/managedSection.ts');
const godIdentity = loadTs('src/shared/godIdentity.ts');

test('lab mode is OFF by default and with an empty or disabled config', () => {
  assert.equal(mode.resolveLabMode(undefined, {}).enabled, false);
  assert.equal(mode.resolveLabMode({}, {}).enabled, false);
  assert.equal(mode.resolveLabMode({ enabled: false }, {}).enabled, false);
  assert.equal(mode.resolveLabMode(null, { MD_LAB_CONTROL: '0' }).enabled, false);
  assert.equal(mode.resolveLabMode(null, { MD_LAB_CONTROL: '' }).enabled, false);
});

test('MD_LAB_CONTROL=1 (or true/yes/on) or config lab.enabled turns it on', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(mode.resolveLabMode(null, { MD_LAB_CONTROL: v }).enabled, true, v);
  assert.equal(mode.resolveLabMode({ enabled: true }, {}).enabled, true);
  assert.equal(mode.resolveLabMode({ enabled: 'yes' }, {}).enabled, false, 'only a real boolean enables it');
});

test('the god seat defaults to Dwight and takes name, role and prompt from config; env wins over config', () => {
  const d = mode.resolveLabMode({ enabled: true }, {});
  assert.equal(d.godName, 'Dwight');
  assert.equal(d.godId, 'god');
  assert.match(d.godRole, /Lab orchestrator/);
  assert.match(d.godPrompt, /You are Dwight/);
  const c = mode.resolveLabMode({ enabled: true, godName: 'Angela', godRole: 'Head', godPrompt: 'Be strict.' }, {});
  assert.deepEqual([c.godName, c.godRole, c.godPrompt], ['Angela', 'Head', 'Be strict.']);
  const e = mode.resolveLabMode({ enabled: true, godName: 'Angela' }, { MD_LAB_GOD_NAME: 'Pam', MD_LAB_GOD_ROLE: 'Boss' });
  assert.deepEqual([e.godName, e.godRole], ['Pam', 'Boss']);
  assert.match(mode.resolveLabMode({ godName: 'Pam' }, {}).godPrompt, /You are Pam/, 'the default prompt follows the configured name');
});

test('names are cleaned: control characters and newlines collapse, length is capped, blank falls back', () => {
  assert.equal(mode.resolveLabMode({ godName: '  Dw\night\u0000  ' }, {}).godName, 'Dw ight');
  assert.equal(mode.resolveLabMode({ godName: 'x'.repeat(200) }, {}).godName.length, 40);
  assert.equal(mode.resolveLabMode({ godName: '   ' }, {}).godName, 'Dwight');
  assert.equal(mode.resolveLabMode({ godName: 42 }, {}).godName, 'Dwight');
  assert.ok(mode.resolveLabMode({ godPrompt: 'p'.repeat(20000) }, {}).godPrompt.length <= 8000);
});

test('god card: the cast member matching the name, else the boss sprite; accent and role come along', () => {
  const cast = ['michael', 'jim', 'dwight', 'pam'];
  const dw = mode.labGodCard({ godName: 'Dwight', godRole: 'Lab orchestrator (Opus)' }, cast);
  assert.deepEqual([dw.character, dw.description, dw.accent], ['dwight', 'Lab orchestrator (Opus)', 'lemon']);
  assert.equal(mode.labGodCard({ godName: 'PAM', godRole: 'r' }, cast).character, 'pam');
  assert.equal(mode.labGodCard({ godName: 'Rupert', godRole: 'r' }, cast).character, 'michael');
});

test('non-lab behaviour is unchanged: the default god is still Michael and a persisted rename still wins', () => {
  assert.equal(godIdentity.DEFAULT_GOD_NAME, 'Michael');
  assert.equal(godIdentity.resolveGodName(undefined), 'Michael');
  assert.equal(godIdentity.resolveGodName(' Savvas '), 'Savvas');
});

test('the god identity file carries the name, role, seat and the prompt', () => {
  const m = mode.resolveLabMode({ enabled: true }, {});
  const text = mode.labGodIdentity(m);
  assert.match(text, /^# Dwight \(god\)/);
  assert.match(text, /- Role: Lab orchestrator \(Opus\)/);
  assert.match(text, /No terminal/);
  assert.ok(text.includes(m.godPrompt));
});

test('managed sections: create, replace in place, append once, never touch the text around them', () => {
  const header = '# Hive board\n';
  const made = upsertManagedSection(null, 'lab-board', 'one', header);
  assert.ok(made.startsWith(header));
  assert.ok(made.includes(sectionMarkers('lab-board').begin));
  const human = `${made}\nHuman text below.\n`;
  const next = upsertManagedSection(human, 'lab-board', 'two');
  assert.ok(next.includes('two') && !next.includes('one'));
  assert.ok(next.endsWith('Human text below.\n'));
  assert.equal(upsertManagedSection(next, 'lab-board', 'two'), next, 'idempotent');
  const appended = upsertManagedSection('plain file\n', 'lab-board', 'x');
  assert.ok(appended.startsWith('plain file\n\n<!-- hive-bridge:lab-board:begin -->'));
  const other = upsertManagedSection(next, 'other', 'y');
  assert.ok(other.includes('two') && other.includes('y'));
});
