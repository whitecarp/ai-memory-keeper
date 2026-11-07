import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enqueue, drain, status, loadMemory } from '../src/store.mjs';
import { beginCycle, updateCycle } from '../src/cycle.mjs';
import { read } from '../src/safety.mjs';
import { fixture, item, memory } from './helpers.mjs';

// The 塔罗牌 chat, 11-05 20:02: a second /compact right after the first left a batch of
// nothing but Codex `token_usage_record` lines ({ordinal, payload, timestamp, type}). The
// strict format check failed it, and it blocked the batch behind it. Made-up lines only.
const usage = i => JSON.stringify({ ordinal: i, timestamp: '2026-11-05T12:02:10.000Z', type: 'token_usage_record', payload: { input_tokens: 10, output_tokens: 2 } }) + '\n';
const said = text => JSON.stringify({ timestamp: '2026-11-05T12:03:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
const TEXT = 'Remember: the Tower card means sudden change.';

test('a Codex batch of only token_usage_record lines is an empty save, and the batch behind it goes through', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, usage(1) + usage(2) + usage(3));
  enqueue(f.ctx, f.transcript, 'tarot', { agent: 'codex' });
  fs.appendFileSync(f.transcript, said(TEXT));
  enqueue(f.ctx, f.transcript, 'tarot', { agent: 'codex' });
  assert.equal(status(f.ctx).queued, 2);
  let calls = 0;
  const engine = { complete: async () => { calls++; return structuredClone(memory([item(TEXT, { key: 'tower' })])); } };
  const out = await drain(f.ctx, { engine, env: {} });
  assert.equal(out.processed, 2);
  assert.equal(calls, 1); // nothing was sent for the metadata-only batch
  assert.equal(status(f.ctx).queued, 0);
  assert.equal(status(f.ctx).lastError, null);
  assert.deepEqual(loadMemory(f.ctx).memory.items.map(i => i.key), ['tower']);
});

test('a Codex metadata type this tool has never seen is still nothing to read, not a stuck queue', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, JSON.stringify({ ordinal: 1, timestamp: '2026-11-05T12:02:10.000Z', type: 'some_future_record', payload: { x: 1 } }) + '\n');
  enqueue(f.ctx, f.transcript, 'tarot', { agent: 'codex' });
  assert.equal((await drain(f.ctx, { engine: { complete: async () => assert.fail('no request') }, env: {} })).processed, 1);
  // Not Codex (or a job from before agents were recorded): an unknown format still stays queued.
  const g = fixture(t);
  fs.writeFileSync(g.transcript, JSON.stringify({ ordinal: 1, timestamp: '2026-11-05T12:02:10.000Z', type: 'some_future_record', payload: { x: 1 } }) + '\n');
  enqueue(g.ctx, g.transcript, 'other');
  await assert.rejects(drain(g.ctx, { engine: { complete: async () => assert.fail('no request') }, env: {} }), /unsupported_transcript_record/);
  assert.equal(status(g.ctx).queued, 1);
});

test('PreCompact records which agent a batch came from', async t => {
  const f = fixture(t);
  const { enable, installationFile } = await import('../src/hooks.mjs');
  enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  fs.writeFileSync(f.transcript, usage(1));
  await run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { startWorker: async () => {}, showOverlay: async () => true, input: { cwd: f.project, session_id: 's', transcript_path: f.transcript, hook_event_name: 'PreCompact', trigger: 'manual' } });
  const id = read(path.join(f.ctx.dir, 'queue.json')).jobs[0];
  assert.equal(read(path.join(f.ctx.dir, 'jobs', id + '.json'), null, 1e8).agent, 'codex');
});

test('a save with nothing new says so, instead of passing an old line off as new', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, usage(1));
  enqueue(f.ctx, f.transcript, 'tarot', { agent: 'codex' });
  fs.mkdirSync(f.ctx.dir, { recursive: true });
  fs.writeFileSync(path.join(f.ctx.dir, 'persona.json'), JSON.stringify({ line: 'Gemini娘记下了上次的塔罗笔记。', time: '2026-11-05T11:58:56.000Z' }));
  beginCycle(f.ctx, { session: 'tarot', agent: 'codex' });
  updateCycle(f.ctx, c => ({ next: { ...c, phase: 'finished', finishedAt: Date.now() } }));
  const shown = [];
  await run(['worker', '--project', f.project, '--home', f.home], { engine: { complete: async () => assert.fail('no request') }, showOverlay: async (ctx, o) => { shown.push(o); return true; } });
  assert.equal(shown.length, 1);
  assert.match(shown[0].lines.gemini, /这次没有新的聊天内容/);
  assert.ok(!shown[0].lines.gemini.includes('塔罗笔记'));
});
