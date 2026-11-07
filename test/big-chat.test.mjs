import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, installationFile } from '../src/hooks.mjs';
import { enqueue, tailSummary, status, FIRST_CAPTURE_BYTES } from '../src/store.mjs';
import { read, hash } from '../src/safety.mjs';
import { fixture } from './helpers.mjs';

// Long chats: a Codex rollout can be over 1 GB (the user's 「学习塔罗牌」 is 1.25 GB). Recall
// reads the summary from the end, and a first capture keeps only the newest part.
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const said = (role, text) => row('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

test('tailSummary: the newest summary from the end, across block edges, within its window', t => {
  const f = fixture(t);
  const long = 'S'.repeat(300);
  fs.writeFileSync(f.transcript, row('compacted', { message: 'old summary' }) + said('user', 'x'.repeat(500)) + row('compacted', { message: long }) + said('assistant', 'after'));
  // 64-byte steps: the newest summary line spans several blocks.
  assert.equal(tailSummary(f.transcript, { step: 64 }), long);
  // Outside the scan window it is not found (and nothing else is read).
  assert.equal(tailSummary(f.transcript, { step: 64, maxBytes: 64 }), '');
  fs.writeFileSync(f.transcript, said('user', 'no summary yet'));
  assert.equal(tailSummary(f.transcript), '');
  // Claude Code's own summary record.
  fs.writeFileSync(f.transcript, JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Claude summary.' } }) + '\n');
  assert.equal(tailSummary(f.transcript, { step: 16 }), 'Claude summary.');
});

test('first capture of a long chat keeps only the newest part, says so, and never comes back for the rest', t => {
  const f = fixture(t);
  let text = '';
  for (let i = 0; i < 200; i++) text += said(i % 2 ? 'assistant' : 'user', `message ${i} ${'·'.repeat(20)}`);
  fs.writeFileSync(f.transcript, text);
  const size = fs.statSync(f.transcript).size;
  const out = enqueue(f.ctx, f.transcript, 's1', { firstCaptureBytes: 2048 });
  assert.ok(out.skippedOlderBytes > size - 2048 - 200 && out.skippedOlderBytes <= size - 2048 + 200);
  assert.equal(out.skippedOlderBytes + out.bytes, size);
  const job = read(path.join(f.ctx.dir, 'jobs', out.id + '.json'));
  assert.ok(job.raw.startsWith('{"type":"response_item"')); // starts on a whole record
  assert.ok(job.raw.includes('message 199') && !job.raw.includes('message 0 '));
  assert.equal(status(f.ctx).firstCapture.skippedOlderBytes, out.skippedOlderBytes);
  // The next capture continues from the end; the older part is never queued.
  fs.appendFileSync(f.transcript, said('user', 'message 200'));
  const next = enqueue(f.ctx, f.transcript, 's1', { firstCaptureBytes: 2048 });
  assert.equal(next.skippedOlderBytes, undefined);
  assert.ok(read(path.join(f.ctx.dir, 'jobs', next.id + '.json')).raw.includes('message 200'));
  // A short chat is captured whole, as before.
  const other = fixture(t);
  fs.writeFileSync(other.transcript, said('user', 'short'));
  assert.equal(enqueue(other.ctx, other.transcript, 's2').skippedOlderBytes, undefined);
  assert.equal(FIRST_CAPTURE_BYTES, 8 * 1024 * 1024);
});

test('a long text log is cut on a line start, never inside a character', t => {
  const f = fixture(t);
  const log = path.join(f.dir, 'chat.txt');
  fs.writeFileSync(log, '我'.repeat(3000) + '\n最新的一行：记住我喜欢简短的回答。\n');
  const out = enqueue(f.ctx, log, 'txt', { firstCaptureBytes: 100 });
  const job = read(path.join(f.ctx.dir, 'jobs', out.id + '.json'));
  assert.equal(job.raw, '最新的一行：记住我喜欢简短的回答。\n');
});

// The real size: run with AMK_BIG_TEST=1 (writes a 1 GiB file under .test-runs, then removes it).
test('a 1 GiB Codex rollout: every hook stays fast, copies at most 8 MiB and finds the summary', { skip: process.env.AMK_BIG_TEST !== '1' && 'set AMK_BIG_TEST=1 to write a 1 GiB file' }, async t => {
  const f = fixture(t);
  enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const args = ['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner];
  // 1 GiB of older history (never read), then 12 MiB of real dialogue and the summary.
  const fd = fs.openSync(f.transcript, 'w'); fs.ftruncateSync(fd, 1024 * 1024 * 1024); fs.closeSync(fd);
  let tail = '\n';
  for (let i = 0; tail.length < 12 * 1024 * 1024; i++) tail += said(i % 2 ? 'assistant' : 'user', `塔罗第 ${i} 条：${'权杖'.repeat(200)}`);
  fs.appendFileSync(f.transcript, tail);
  assert.ok(fs.statSync(f.transcript).size > 1024 * 1024 * 1024);
  const deps = input => ({ startWorker: async () => {}, showOverlay: async () => true, input: { cwd: f.project, session_id: 'tarot', transcript_path: f.transcript, ...input } });
  const timed = async input => { const t0 = Date.now(); const out = await run(args, deps(input)); return { out, ms: Date.now() - t0 }; };
  const pre = await timed({ hook_event_name: 'PreCompact', trigger: 'auto' });
  const q = read(path.join(f.ctx.dir, 'queue.json'));
  const bytes = q.jobs.reduce((n, id) => n + fs.statSync(path.join(f.ctx.dir, 'jobs', id + '.json')).size, 0);
  assert.ok(bytes < 9 * 1024 * 1024, `copied ${bytes} bytes`);
  assert.ok(status(f.ctx).firstCapture.skippedOlderBytes > 1024 * 1024 * 1024);
  fs.appendFileSync(f.transcript, row('compacted', { message: '塔罗：正在学大阿卡纳。' }));
  const post = await timed({ hook_event_name: 'PostCompact', trigger: 'auto' });
  assert.equal(read(path.join(f.ctx.dir, 'summaries', hash('tarot') + '.json')).text, '塔罗：正在学大阿卡纳。');
  const start = await timed({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(read(path.join(f.ctx.dir, 'error.json'), null)?.code ?? null, null);
  for (const [name, r] of [['PreCompact', pre], ['PostCompact', post], ['SessionStart', start]]) {
    assert.ok(r.ms < 4000, `${name} took ${r.ms} ms`);
    t.diagnostic(`${name}: ${r.ms} ms`);
  }
  t.diagnostic(`copied ${(bytes / 1024 / 1024).toFixed(1)} MiB of ${(fs.statSync(f.transcript).size / 1024 / 1024 / 1024).toFixed(2)} GiB`);
});

test('a long segment gets the per-segment time for each of its requests, within the run cap', async t => {
  const { drain, enqueue: queue } = await import('../src/store.mjs');
  const { item, memory } = await import('./helpers.mjs');
  const f = fixture(t);
  let text = '';
  for (let i = 0; i < 6; i++) text += said('user', `第 ${i} 条：${'塔罗'.repeat(30)}`);
  fs.writeFileSync(f.transcript, text);
  queue(f.ctx, f.transcript, 'long');
  // Each request takes 40 ms; one segment's limit is 150 ms, but at 80 tokens a request the
  // segment needs several (plus a merge), more than 150 ms in all: each gets its 150 ms.
  let calls = 0;
  const slow = { complete: async () => { calls++; await new Promise(r => setTimeout(r, 40)); return memory([]); } };
  const out = await drain(f.ctx, { engine: slow, timeoutMs: 150, chunkTokens: 80, env: {} });
  assert.equal(out.processed, 1);
  assert.ok(calls * 40 > 150, `only ${calls} requests`);
  assert.equal(status(f.ctx).queued, 0);
});
