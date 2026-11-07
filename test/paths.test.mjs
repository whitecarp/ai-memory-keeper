import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, installationFile } from '../src/hooks.mjs';
import { read, plainPath, noLinks } from '../src/safety.mjs';
import { fixture, record } from './helpers.mjs';

// The 塔罗牌 bug (11-05 19:38): Codex passed the rollout as \\?\C:\…, and Node's lstat fails
// on the root of such a path with EISDIR, so PreCompact queued nothing and she never showed.
const win = process.platform === 'win32';

test('extended-length Windows paths become plain ones', () => {
  assert.equal(plainPath('\\\\?\\C:\\Users\\a\\b.jsonl', 'win32'), 'C:\\Users\\a\\b.jsonl');
  assert.equal(plainPath('\\\\?\\UNC\\server\\share\\b.jsonl', 'win32'), '\\\\server\\share\\b.jsonl');
  assert.equal(plainPath('C:\\Users\\a\\b.jsonl', 'win32'), 'C:\\Users\\a\\b.jsonl');
  assert.equal(plainPath('\\\\?\\C:\\x', 'linux'), '\\\\?\\C:\\x');
  assert.equal(plainPath(null, 'win32'), null);
});

test('Codex hands over \\\\?\\C:\\…\\rollout.jsonl: queued, summary read, and noted as such (metadata only)', { skip: !win && 'Windows paths' }, async t => {
  const f = fixture(t);
  enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  assert.doesNotThrow(() => noLinks('\\\\?\\' + f.transcript));
  const shown = [];
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { startWorker: async () => {}, showOverlay: async (ctx, o) => { shown.push(o); return true; }, input: { cwd: '\\\\?\\' + f.project, session_id: 'old-tarot', transcript_path: '\\\\?\\' + f.transcript, ...input } });
  assert.equal(await hook({ hook_event_name: 'PreCompact', trigger: 'manual' }), '');
  const s = await run(['status', '--project', f.project, '--home', f.home]);
  assert.equal(s.lastError, null);
  assert.equal(s.queued, 1);
  assert.equal(s.lastHook.extendedPath, true);
  assert.equal(s.lastHook.transcript.kind, 'file');
  assert.equal(s.lastHook.transcript.ext, '.jsonl');
  assert.ok(s.lastHook.transcript.bytes > 0 && s.lastHook.transcript.created);
  assert.ok(!JSON.stringify(s.lastHook).includes(f.transcript) && !JSON.stringify(s.lastHook).includes('short answers'));
  assert.equal(shown[0].phase, 'working');
  assert.equal(shown[0].transcript, f.transcript); // the pop-up watches the plain path
});

test('she shows up before anything can fail, then says the save didn\'t work; the error says where', async t => {
  const f = fixture(t);
  enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const shown = [];
  const missing = path.join(f.dir, 'gone.jsonl');
  const out = await run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { startWorker: async () => {}, showOverlay: async (ctx, o) => { shown.push(o); return true; }, input: { cwd: f.project, session_id: 's', transcript_path: missing, hook_event_name: 'PreCompact', trigger: 'auto' } });
  assert.equal(out, '');
  assert.equal(shown.length, 2);
  assert.equal(shown[0].phase, 'working');
  assert.match(shown[1].lines.gemini, /这次没能把对话收进星星瓶（operation_failed）/);
  assert.equal(shown[1].agentPid, 'keep');
  const e = read(path.join(f.ctx.dir, 'error.json'));
  assert.equal(e.code, 'operation_failed'); assert.equal(e.errno, 'ENOENT'); assert.equal(e.event, 'PreCompact');
  assert.match(e.where, /^store\.mjs:\d+$/);
  assert.equal(e.syscall, 'lstat');
  assert.equal(read(path.join(f.ctx.dir, 'hook.json')).transcript.kind, 'unreadable');
});
