import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { run } from '../src/cli.mjs';
import { keyStatus, saveKey, storedKey, resolveKey, clearKey, keyFile, promptKey, keyWindowCommand } from '../src/key.mjs';
import { doctor, detectAgent, SKILL } from '../src/doctor.mjs';
import { fixture } from './helpers.mjs';

const FAKE = 'AIzaFAKEtestKEYnotREAL0123456789abcdef'; // made up; never a real key
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package: amk and ai-memory-keeper commands, never publishable to npm, no Gemini in the name', () => {
  assert.deepEqual(pkg.bin, { amk: 'src/cli.mjs', 'ai-memory-keeper': 'src/cli.mjs' });
  assert.equal(pkg.private, true); assert.equal(pkg.license, 'MIT');
  assert.ok(!/gemini/i.test(pkg.name));
  assert.ok(fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8').startsWith('#!/usr/bin/env node'));
  for (const f of pkg.files) assert.ok(fs.existsSync(new URL('../' + f, import.meta.url)), f);
});
test('skill file: Agent Skills front matter, and it names the one Codex step that cannot be skipped', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'front matter');
  assert.match(front[1], /^name: ai-memory-keeper$/m);
  const desc = front[1].match(/^description: (.+)$/m)?.[1] || '';
  assert.ok(desc.length > 40 && desc.length < 1024);
  assert.ok(text.includes('/hooks') && text.includes('Review hooks') && text.includes('amk key') && text.includes('never into this chat'));
});
test('key: stored only on this computer, GEMINI_API_KEY wins, never printed by doctor or status', async t => {
  const f = fixture(t);
  assert.deepEqual(keyStatus(f.ctx, {}), { set: false, from: null, cloud: { set: false, from: null }, route: 'auto' });
  // The non-Windows route: a file only this user can read.
  saveKey(f.ctx, FAKE, 'linux');
  assert.equal(keyStatus(f.ctx, {}, 'linux').set, true);
  assert.equal(await storedKey(f.ctx, 'linux'), FAKE);
  assert.deepEqual(keyStatus(f.ctx, { GEMINI_API_KEY: 'from-env' }, 'linux'), { set: true, from: 'GEMINI_API_KEY', cloud: { set: false, from: null }, route: 'auto' });
  assert.equal(await resolveKey(f.ctx, { GEMINI_API_KEY: 'from-env' }), 'from-env');
  assert.throws(() => saveKey(f.ctx, 'short', 'linux'), /invalid_key_format/);
  assert.throws(() => saveKey(f.ctx, 'has spaces in it but is long enough', 'linux'), /invalid_key_format/);
  assert.deepEqual(clearKey(f.ctx, 'linux'), { cleared: true });
  assert.equal(fs.existsSync(keyFile(f.ctx, 'linux')), false);
});
test('key on Windows: DPAPI-encrypted file, read back through a pipe; the key never sits in the file in plain text', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const f = fixture(t);
  saveKey(f.ctx, FAKE);
  const raw = fs.readFileSync(keyFile(f.ctx));
  assert.ok(!raw.includes(Buffer.from(FAKE)) && !raw.includes(Buffer.from(FAKE, 'utf16le')));
  assert.equal(await storedKey(f.ctx), FAKE);
  assert.equal(await resolveKey(f.ctx, {}), FAKE);
  const out = JSON.stringify([doctor(f.ctx, {}), await run(['status', '--project', f.project, '--home', f.home])]);
  assert.ok(!out.includes(FAKE) && out.includes('encrypted for this Windows user'));
  // The window's command carries paths and labels, never a key.
  await run(['key', '--project', f.project, '--home', f.home], { openKeyWindow: async () => ({ window: 'opened' }) });
  fs.writeFileSync(path.join(f.home, 'key-window.json'), JSON.stringify({ keyFile: keyFile(f.ctx), resultFile: path.join(f.home, 'r') }));
  const script = Buffer.from(keyWindowCommand(path.join(f.home, 'key-window.json')).at(-1), 'base64').toString('utf16le');
  assert.ok(!script.includes(FAKE) && script.includes('ProtectedData'));
  clearKey(f.ctx);
});
test('amk key --terminal reads the key without echoing it (stdin when not a terminal)', async t => {
  const f = fixture(t);
  assert.equal(await promptKey('x', Readable.from([FAKE + '\n'])), FAKE);
  let saved = null;
  const out = await run(['key', '--terminal', '--project', f.project, '--home', f.home], { promptKey: async () => FAKE });
  saved = await storedKey(f.ctx);
  assert.equal(out.saved, true); assert.equal(saved, FAKE); assert.ok(!JSON.stringify(out).includes(FAKE));
  clearKey(f.ctx);
});
test('doctor: Node, key, agent hint, enabled hooks and the skill file to read', async t => {
  const f = fixture(t);
  const d = doctor(f.ctx, {});
  assert.equal(d.node.ok, Number(process.versions.node.split('.')[0]) >= 22);
  assert.equal(d.key.set, false); assert.equal(d.project, f.ctx.project);
  assert.ok(fs.existsSync(d.skill) && d.next.includes(d.skill));
  assert.deepEqual(d.enabled, { claude: false, codex: false, workbuddy: false });
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude');
  assert.equal(detectAgent({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(detectAgent({ CODEX_HOME: 'x' }), 'unknown'); // a setting, not a sign of running inside Codex
  assert.equal(doctor(f.ctx, { GEMINI_API_KEY: FAKE }).key.from, 'GEMINI_API_KEY');
  assert.ok(!JSON.stringify(doctor(f.ctx, { GEMINI_API_KEY: FAKE })).includes(FAKE));
});

test('key check: plain answers; only a key Google rejects is removed', async t => {
  const { keyCheckAnswer } = await import('../src/key.mjs');
  assert.deepEqual(keyCheckAnswer({ ok: true }, 'en').ok, true);
  for (const [result, keep] of [
    [{ ok: false, code: 'gemini_http', httpStatus: 400 }, false], [{ ok: false, code: 'gemini_http', httpStatus: 403 }, false],
    [{ ok: false, code: 'gemini_region', httpStatus: 400 }, true], [{ ok: false, code: 'gemini_ratelimit', httpStatus: 429 }, true],
    [{ ok: false, code: 'gemini_busy', httpStatus: 503 }, true], [{ ok: false, code: 'gemini_network' }, true], [{ ok: false, code: 'timeout' }, true],
    [{ ok: false, code: 'gemini_http', httpStatus: 404 }, true], [{ ok: false, code: 'missing_gemini_key' }, false],
  ]) {
    const a = keyCheckAnswer(result, 'zh');
    assert.equal(a.keep, keep, JSON.stringify(result)); assert.equal(a.ok, false); assert.ok(a.reason.length > 5);
  }
  // Through the command, with a stubbed engine: a rejected key is cleared, an OK one kept.
  const f = fixture(t);
  saveKey(f.ctx, FAKE, process.platform);
  const rejected = Object.assign(new Error('API key not valid'), { kind: 'http', httpStatus: 400 });
  let out = await run(['key-check', '--project', f.project, '--home', f.home, '--lang', 'en'], { engine: { complete: async () => { throw rejected; } } });
  assert.equal(out.ok, false); assert.equal(out.kept, false); assert.match(out.reason, /didn't accept/);
  assert.equal(keyStatus(f.ctx, {}).set, false);
  saveKey(f.ctx, FAKE, process.platform);
  out = await run(['key-check', '--project', f.project, '--home', f.home, '--lang', 'zh'], { engine: { complete: async () => ({ wake_up_note: 'x', items: [] }) } });
  assert.equal(out.ok, true); assert.equal(out.kept, true); assert.equal(keyStatus(f.ctx, {}).set, true);
  assert.ok(!JSON.stringify(out).includes(FAKE));
  clearKey(f.ctx);
});
test('key window: links only to Google AI Studio, with the 18+ and region line', async t => {
  const { KEY_PAGE, REGIONS_PAGE } = await import('../src/key.mjs');
  assert.equal(KEY_PAGE, 'https://aistudio.google.com/apikey');
  assert.equal(REGIONS_PAGE, 'https://aistudio.google.com/docs/available-regions');
  const script = fs.readFileSync(new URL('../src/key-window.ps1', import.meta.url), 'utf8');
  assert.ok(/^[\x00-\x7f]*$/.test(script) && script.includes("-like 'https://aistudio.google.com/*'") && script.includes('key-check'));
  const f = fixture(t);
  await run(['key', '--project', f.project, '--home', f.home], { openKeyWindow: async () => ({ window: 'opened' }) });
});

test('enable is only reported when the hook file is really on disk; status follows the file', async t => {
  const { enable, enabled } = await import('../src/hooks.mjs');
  const f = fixture(t);
  const r = enable(f.ctx, 'codex');
  assert.ok(fs.existsSync(r.config) && enabled(f.ctx, 'codex'));
  fs.rmSync(r.config); // e.g. a sandbox that never let the file land
  assert.equal(enabled(f.ctx, 'codex'), false);
  assert.equal((await run(['status', '--project', f.project, '--home', f.home])).enabled.codex, false);
  assert.equal(doctor(f.ctx, {}).enabled.codex, false);
});
test('the preview never follows the process that started it (a runner that exits must not close her)', async t => {
  const f = fixture(t); const calls = [];
  await run(['overlay', '--set', 'preview', '--project', f.project, '--home', f.home], { previewWorkingMs: 1, showOverlay: async (ctx, o) => { calls.push(o); return true; } });
  assert.deepEqual(calls.map(c => c.agentPid), [null, null]);
});
test('Codex: SessionStart takes the summary from the rollout when PostCompact had none; errors say where', async t => {
  const { enable, installationFile } = await import('../src/hooks.mjs');
  const { read } = await import('../src/safety.mjs');
  const f = fixture(t); enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  fs.writeFileSync(f.transcript, row('compacted', { message: 'Database: Postgres.' }));
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { startWorker: async () => {}, showOverlay: async () => true, input: { session_id: 'cx2', transcript_path: f.transcript, cwd: f.project, ...input } });
  await hook({ hook_event_name: 'SessionStart', source: 'compact' }); // no PostCompact first
  const sums = fs.readdirSync(path.join(f.ctx.dir, 'summaries'));
  assert.equal(sums.length, 1);
  const hooks = JSON.parse(fs.readFileSync(path.join(f.project, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(hooks.SessionStart[0].hooks[0].statusMessage)); // no UUID on screen
  assert.equal(hooks.SessionStart[0].hooks[0].statusMessage, 'AI Memory Keeper · 带回记忆');
  const { recordError } = await import('../src/store.mjs');
  const boom = Object.assign(new Error('x'), { code: 'EBUSY' });
  recordError(f.ctx, boom, { event: 'PostCompact' });
  const err = JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'operation_failed'); assert.equal(err.event, 'PostCompact'); assert.equal(err.errno, 'EBUSY');
  assert.equal(err.where, undefined); // only places in our own src/vendor code are recorded
  assert.ok(!JSON.stringify(err).includes('x"'));
});
