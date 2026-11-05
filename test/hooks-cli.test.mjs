import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, parse } from '../src/cli.mjs';
import { enable, disable, enabled, installationFile, authorizeHook, cliPath } from '../src/hooks.mjs';
import { context, status, drain } from '../src/store.mjs';
import { read, atomic } from '../src/safety.mjs';
import { fixture, record, engine } from './helpers.mjs';

const args = (f, cmd, extra = []) => [cmd, '--project', f.project, '--home', f.home, ...extra];
for (const agent of ['claude', 'codex']) {
  test(`${agent}: enable/disable idempotently preserve unrelated config and appended hooks`, t => {
    const f = fixture(t);
    const file = path.join(f.project, agent === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json');
    const original = { custom: { language: 'en' }, hooks: { Stop: [{ hooks: [] }], PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'other-hook' }] }, { matcher: 'auto', hooks: [] }] } };
    atomic(file, original);
    const result = enable(f.ctx, agent);
    assert.equal(result.added.length, 4);
    assert.equal(enabled(f.ctx, agent), true);
    const first = fs.readFileSync(file);
    assert.equal(enable(f.ctx, agent).alreadyEnabled, true);
    assert.deepEqual(fs.readFileSync(file), first);
    const updated = read(file); updated.hooks.PreCompact.at(-1).hooks.push({ type: 'command', command: 'new-foreign-hook' }); atomic(file, updated);
    const removed = disable(f.ctx, agent);
    assert.equal(removed.removed, result.added.length);
    const remaining = read(file);
    assert.deepEqual(remaining.custom, original.custom);
    assert.deepEqual(remaining.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(remaining.hooks.PreCompact.slice(0, 2), original.hooks.PreCompact);
    assert.equal(remaining.hooks.PreCompact.at(-1).hooks[0].command, 'new-foreign-hook');
    assert.equal(disable(f.ctx, agent).removed, 0);
    assert.equal(enabled(f.ctx, agent), false);
  });
  test(`${agent}: fresh config removed after disable; hooks never use a secret`, t => {
    const f = fixture(t); const result = enable(f.ctx, agent);
    assert.ok(!JSON.stringify(result).includes('GEMINI_API_KEY'));
    const state = read(installationFile(f.ctx, agent));
    authorizeHook(f.ctx, agent, state.owner, { cwd: f.project, session_id: 'abc123', hook_event_name: 'PreCompact', trigger: 'auto' });
    assert.throws(() => authorizeHook(f.ctx, agent, 'wrong', { cwd: f.project }), /hook_not_enabled/);
    const other = path.join(f.dir, 'other'); fs.mkdirSync(other);
    assert.throws(() => authorizeHook(f.ctx, agent, state.owner, { cwd: other, session_id: 'abc123', hook_event_name: 'PreCompact', trigger: 'auto' }), /hook_project_mismatch/);
    disable(f.ctx, agent); assert.ok(!fs.existsSync(result.config));
  });
}
test('different profile requires disabling the existing install first', t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  const other = context({ project: f.project, home: f.home, profile: 'companion' });
  assert.throws(() => enable(other, 'claude'), /disable_other_profile_first/);
  disable(f.ctx, 'claude');
});
test('unsupported agents do not get invented hooks', t => {
  const f = fixture(t);
  for (const agent of ['opencode', 'deepseek', 'unknown']) assert.throws(() => enable(f.ctx, agent), /agent_manual_only/);
  assert.equal(fs.readdirSync(f.project).length, 0);
});
test('invalid existing config is not overwritten', t => {
  const f = fixture(t); const file = path.join(f.project, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '{invalid');
  assert.throws(() => enable(f.ctx, 'claude'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});
test('hook queues raw new bytes without calling engine, then recalls locally', async t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  const state = read(installationFile(f.ctx, 'claude'));
  const hookArgs = args(f, 'hook', ['--agent', 'claude', '--owner', state.owner]);
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  let launches = 0;
  const common = { session_id: 'abc123', transcript_path: f.transcript, cwd: f.project };
  const out = await run(hookArgs, { input: { ...common, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }, startWorker: async () => { launches++; } });
  assert.equal(out, ''); assert.equal(launches, 1); assert.equal(status(f.ctx).queued, 1);
  await drain(f.ctx, { engine: engine() });
  await run(hookArgs, { input: { ...common, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'I prefer short answers.' } });
  const recalled = await run(hookArgs, { input: { ...common, hook_event_name: 'SessionStart', source: 'compact' } });
  assert.equal(recalled.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(!recalled.hookSpecificOutput.additionalContext.includes('"text":"I prefer short answers."'));
  disable(f.ctx, 'claude');
});
test('bad hook input and unavailable transcripts do not block compaction or print secrets', async t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  const state = read(installationFile(f.ctx, 'claude'));
  const result = await run(args(f, 'hook', ['--agent', 'claude', '--owner', state.owner]), { input: { session_id: 's', cwd: f.project, hook_event_name: 'PreCompact', trigger: 'manual', transcript_path: path.join(f.dir, 'missing-secret.txt') } });
  assert.equal(result, ''); assert.ok(!JSON.stringify(status(f.ctx)).includes('missing-secret'));
  const proc = spawnSync(process.execPath, [cliPath, ...args(f, 'hook')], { cwd: f.project, input: '{invalid-secret', encoding: 'utf8', windowsHide: true, env: { ...process.env, GEMINI_API_KEY: '', HOME: path.join(f.dir, 'fake-home'), USERPROFILE: path.join(f.dir, 'fake-home'), NODE_OPTIONS: '' } });
  assert.equal(proc.status, 0); assert.equal(proc.stdout, ''); assert.equal(proc.stderr, '');
  disable(f.ctx, 'claude');
});
test('manual contract works without install and rejects ambiguous CLI flags', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  const result = await run(args(f, 'save', ['--transcript', f.transcript]), { engine: engine() });
  assert.equal(result.processed, 1);
  assert.ok((await run(args(f, 'recall'))).includes('I prefer short answers.'));
  const s = await run(args(f, 'status')); assert.deepEqual(s.enabled, { claude: false, codex: false, workbuddy: false });
  assert.throws(() => parse(['save', '--profile', 'work', '--profile', 'companion']), /duplicate_argument/);
  assert.throws(() => parse(['save', '--unexpected']), /invalid_arguments/);
});
