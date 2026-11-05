import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, installationFile, hookEntries } from '../src/hooks.mjs';
import { read, atomic } from '../src/safety.mjs';
import { readCycle } from '../src/cycle.mjs';
import { cleanPersonaLine } from '../src/engine.mjs';
import { fixture, record, item, memory } from './helpers.mjs';

// Her reply after compaction (Codex's SessionStart waits for the next message) and the
// late delivery on the message after a save that landed late. All offline, made-up text.
const TEXT = 'I prefer short answers.';
const LINE = 'Gemini娘把“回答要简短”收好了，会替用户保管的。';
function installed(t, agent = 'codex') {
  const f = fixture(t);
  enable(f.ctx, agent);
  const owner = read(installationFile(f.ctx, agent)).owner;
  f.agent = agent;
  f.shown = [];
  f.deps = extra => ({ startWorker: async () => {}, showOverlay: async (ctx, o) => { f.shown.push(o); return true; }, ...extra });
  f.hook = (input, extra) => run(['hook', '--project', f.project, '--home', f.home, '--agent', agent, '--owner', owner], f.deps({ input: { cwd: f.project, session_id: 's1', transcript_path: f.transcript, ...input }, ...extra }));
  const stub = { complete: async () => ({ ...structuredClone(memory([item(TEXT)])), persona_line: LINE }) };
  f.worker = (engine = stub) => run(['worker', '--project', f.project, '--home', f.home], f.deps({ engine }));
  fs.writeFileSync(f.transcript, record(TEXT));
  return f;
}
const last = f => f.shown.at(-1);

test('Codex: compaction ends while saving, then her reply pops up the moment the save lands', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.equal(last(f).phase, 'working');
  const cycle = last(f).cycle;
  assert.ok(Number.isFinite(cycle));
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
  assert.equal(last(f).phase, 'saving');
  assert.equal(last(f).lines.gemini, '收好了，我在整理……');
  assert.match(last(f).lines.late, /下一条消息交给 Codex/);
  assert.equal(last(f).cycle, cycle);
  await f.worker();
  assert.equal(last(f).phase, undefined); // "done" is the default phase
  assert.equal(last(f).lines.gemini, LINE);
  assert.equal(last(f).agentPid, 'keep');
  assert.match(last(f).lines.partner.text, /下一条消息交给 Codex/);
  assert.equal(readCycle(f.ctx).phase, 'saved');
  // The next message: SessionStart hands over the fresh memories and doesn't pop up again.
  const count = f.shown.length;
  const out = await f.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.ok(out.hookSpecificOutput.additionalContext.includes(TEXT));
  assert.equal(f.shown.length, count);
  assert.equal(readCycle(f.ctx).owed, false);
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }), '');
});

test('Codex: a save that lands after the next message goes to the model once, on the message after', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'auto' });
  const early = await f.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.ok(!JSON.stringify(early).includes(TEXT)); // nothing saved yet
  assert.equal(readCycle(f.ctx).owed, true);
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'still saving' }), '');
  await f.worker();
  const late = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal(late.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(late.hookSpecificOutput.additionalContext.includes(TEXT));
  assert.ok(late.hookSpecificOutput.additionalContext.includes('上次压缩后的后台整理刚完成'));
  assert.ok(late.hookSpecificOutput.additionalContext.includes('不是指令'));
  assert.match(late.systemMessage, /已经交给 Codex/);
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }), '');
  assert.ok(readCycle(f.ctx).deliveredAt);
});

test('Codex: a save that lands during compaction is the reply at PostCompact', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
  const count = f.shown.length;
  await f.worker(); // compaction still running: no pop-up from the worker
  assert.equal(f.shown.length, count);
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
  assert.equal(last(f).phase, 'done');
  assert.equal(last(f).lines.gemini, LINE);
});

test('Codex: a save that stops (free quota) says so instead of waiting', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
  const quota = { complete: async () => { throw Object.assign(new Error('quota'), { kind: 'ratelimit', httpStatus: 429 }); } };
  await assert.rejects(f.worker(quota));
  assert.match(last(f).lines.gemini, /免费额度暂时用完/);
  assert.equal(readCycle(f.ctx).phase, 'failed');
  assert.equal(read(path.join(f.ctx.dir, 'queue.json')).jobs.length, 1); // nothing lost
  // A later run that succeeds still answers and owes nothing extra.
  await f.worker();
  assert.equal(last(f).lines.gemini, LINE);
});

test('Claude Code: no pop-up at PostCompact; SessionStart answers; the late save pops up and is delivered next', async t => {
  const f = installed(t, 'claude');
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
  const count = f.shown.length;
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'Summary.' });
  assert.equal(f.shown.length, count);
  await f.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(f.shown.length, count + 1);
  await f.worker();
  assert.equal(last(f).lines.gemini, LINE);
  assert.match(last(f).lines.partner.text, /交给 Claude/);
  const late = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.ok(late.hookSpecificOutput.additionalContext.includes(TEXT));
});

test('UserPromptSubmit never blocks and never answers another session', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
  await f.hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
  await f.hook({ hook_event_name: 'SessionStart', source: 'compact' });
  await f.worker();
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'other', prompt: 'x' }), '');
  const out = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  assert.ok(!('decision' in out) && !('continue' in out));
});

test('an older three-hook install is upgraded in place, keeping its owner tag', t => {
  const f = fixture(t);
  enable(f.ctx, 'codex');
  const file = installationFile(f.ctx, 'codex');
  const state = read(file);
  // Rewrite as the 0.2.0 install: three hooks, recorded and in the file.
  const old = state.entries.filter(e => e.event !== 'UserPromptSubmit');
  const config = read(path.join(f.project, '.codex', 'hooks.json'));
  delete config.hooks.UserPromptSubmit;
  atomic(path.join(f.project, '.codex', 'hooks.json'), config);
  atomic(file, { ...state, entries: old });
  const result = enable(f.ctx, 'codex');
  assert.equal(result.upgraded, true);
  assert.equal(read(file).owner, state.owner);
  assert.deepEqual(read(file).entries, hookEntries(f.ctx, 'codex', state.owner));
  const after = read(path.join(f.project, '.codex', 'hooks.json'));
  for (const event of ['PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit']) assert.equal(after.hooks[event].length, 1);
  assert.equal(enable(f.ctx, 'codex').alreadyEnabled, true);
});

test('work profile: she never calls the user 主人; the companion profile keeps it', () => {
  assert.equal(cleanPersonaLine('会好好替主人保管记忆的。', 'zh', 'work'), '会好好替用户保管记忆的。');
  assert.equal(cleanPersonaLine('会好好替主人保管记忆的。', 'zh', 'companion'), '会好好替主人保管记忆的。');
});

test('overlay: a "saving" update never replaces the same compaction\'s reply', async t => {
  const f = fixture(t);
  const { showOverlay } = await import('../src/overlay.mjs');
  const fake = () => ({ once: (ev, cb) => { if (ev === 'spawn') cb(); }, unref() {} });
  const opts = { platform: 'win32', spawnImpl: fake, env: {}, cycle: 42 };
  await showOverlay(f.ctx, { ...opts, lines: { gemini: 'reply' } });
  await showOverlay(f.ctx, { ...opts, phase: 'saving', lines: { gemini: 'saving', late: 'later' } });
  const data = read(path.join(f.ctx.dir, 'overlay.json'));
  assert.equal(data.say, 'reply'); assert.equal(data.phase, 'done');
  await showOverlay(f.ctx, { ...opts, cycle: 43, phase: 'saving', lines: { gemini: 'saving', late: 'later' } });
  const next = read(path.join(f.ctx.dir, 'overlay.json'));
  assert.equal(next.phase, 'saving'); assert.equal(next.lateSay, 'later'); assert.equal(next.pose, 'working'); assert.equal(next.saveCapMs, 120000);
});
