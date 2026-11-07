import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { context, enqueue, drain, recall, status, loadMemory, rememberSummary } from '../src/store.mjs';
import { atomic, read } from '../src/safety.mjs';
import { fixture, record, memory, item, engine } from './helpers.mjs';

test('incremental JSONL snapshot, incomplete tail, dedupe, and deletion of successful raw jobs', async t => {
  const f = fixture(t);
  const line = record('I prefer short answers.');
  fs.writeFileSync(f.transcript, line);
  const first = enqueue(f.ctx, f.transcript, 'session');
  assert.equal(first.bytes, Buffer.byteLength(line));
  assert.equal(enqueue(f.ctx, f.transcript, 'session').queued, false);
  await drain(f.ctx, { engine: engine() });
  assert.equal(status(f.ctx).queued, 0);
  assert.equal(fs.readdirSync(path.join(f.ctx.dir, 'jobs')).length, 0);
  fs.appendFileSync(f.transcript, record('Use Node.').trimEnd());
  assert.equal(enqueue(f.ctx, f.transcript, 'session').queued, false);
  fs.appendFileSync(f.transcript, '\n');
  const second = enqueue(f.ctx, f.transcript, 'session');
  const job = read(path.join(f.ctx.dir, 'jobs', second.id + '.json'));
  assert.equal(job.raw, record('Use Node.')); assert.equal(job.start, first.bytes);
  await drain(f.ctx, { engine: engine(memory([item('Use Node.', { key: 'runtime' })])) });
  assert.equal(loadMemory(f.ctx).memory.items.length, 2);
  assert.equal(fs.readdirSync(path.join(f.ctx.dir, 'backups')).length, 1);
});
test('same optional name across projects does not mix memories; profiles also isolate', t => {
  const f = fixture(t); const p2 = path.join(f.dir, 'second'); fs.mkdirSync(p2);
  const a = context({ project: f.project, home: f.home, name: 'same' });
  const b = context({ project: p2, home: f.home, name: 'same' });
  const c = context({ project: f.project, home: f.home, profile: 'companion', name: 'same' });
  assert.notEqual(a.dir, b.dir); assert.notEqual(a.dir, c.dir);
  assert.throws(() => context({ project: f.project, home: f.home, name: '../../escape' }));
});
test('rewrite/truncation fails closed instead of skipping or reusing the wrong offset', t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('before'));
  enqueue(f.ctx, f.transcript);
  fs.writeFileSync(f.transcript, record('after!'));
  assert.throws(() => enqueue(f.ctx, f.transcript), /transcript_rewritten/);
  fs.writeFileSync(f.transcript, '');
  assert.throws(() => enqueue(f.ctx, f.transcript), /transcript_rewritten/);
});
test('network, timeout, invalid response preserve old bytes and raw queue for explicit retry', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  enqueue(f.ctx, f.transcript); await drain(f.ctx, { engine: engine() });
  const file = path.join(f.ctx.dir, 'memory.json'); const before = fs.readFileSync(file);
  fs.appendFileSync(f.transcript, record('Use Node.')); enqueue(f.ctx, f.transcript);
  for (const bad of [{ complete: async () => { throw new Error('secret transcript leak'); } }, engine({}), { complete: async () => new Promise(() => {}) }]) {
    await assert.rejects(drain(f.ctx, { engine: bad, timeoutMs: 20 }));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(status(f.ctx).queued, 1);
    assert.ok(!JSON.stringify(status(f.ctx)).includes('secret transcript leak'));
    assert.ok(recall(f.ctx).includes('I prefer short answers.'));
  }
  await drain(f.ctx, { engine: engine(memory([item('Use Node.', { key: 'runtime' })])) });
  assert.equal(status(f.ctx).lastError, null);
  assert.equal(status(f.ctx).queued, 0);
});
test('pin edited during a save is never overwritten', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  enqueue(f.ctx, f.transcript); await drain(f.ctx, { engine: engine() });
  fs.appendFileSync(f.transcript, record('Use Node.')); enqueue(f.ctx, f.transcript);
  const adapter = { complete: async () => {
    const doc = loadMemory(f.ctx); doc.memory.items[0].pinned = true;
    atomic(path.join(f.ctx.dir, 'memory.json'), doc);
    return memory([item('Use Node.', { key: 'runtime' })]);
  } };
  await assert.rejects(drain(f.ctx, { engine: adapter }), /memory_changed_during_save/);
  assert.equal(loadMemory(f.ctx).memory.items[0].pinned, true);
});
test('crash after commit before queue acknowledgement never calls Gemini twice', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  const capture = enqueue(f.ctx, f.transcript);
  const doc = loadMemory(f.ctx); doc.completed.push(capture.id); doc.savedAt = new Date().toISOString(); doc.memory = memory();
  atomic(path.join(f.ctx.dir, 'memory.json'), doc);
  let calls = 0;
  await drain(f.ctx, { engine: { complete: async () => { calls++; throw Error('never'); } } });
  assert.equal(calls, 0); assert.equal(status(f.ctx).queued, 0);
});
test('background worker drains another session queued while the first request is in flight', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  enqueue(f.ctx, f.transcript, 'one');
  let calls = 0;
  await drain(f.ctx, { engine: { complete: async () => {
    calls++;
    if (calls === 1) {
      const second = path.join(f.dir, 'other.jsonl'); fs.writeFileSync(second, record('Use Node.'));
      enqueue(f.ctx, second, 'two'); return memory();
    }
    return memory([item('Use Node.', { key: 'runtime' })]);
  } } });
  assert.equal(calls, 2); assert.equal(loadMemory(f.ctx).memory.items.length, 2);
});
test('recall uses summary locally and returns last good only; malformed memory fails closed', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  enqueue(f.ctx, f.transcript); await drain(f.ctx, { engine: engine() });
  rememberSummary(f.ctx, { session_id: 'one', compact_summary: 'I prefer short answers.' });
  const text = recall(f.ctx, { session: 'one' });
  assert.ok(!text.includes('"text":"I prefer short answers."'));
  assert.ok(status(f.ctx).lastRecall);
  fs.writeFileSync(path.join(f.ctx.dir, 'memory.json'), '{bad');
  assert.throws(() => recall(f.ctx));
});
test('linked/junction storage and transcript targets are refused', t => {
  const f = fixture(t); const target = path.join(f.dir, 'target'); const link = path.join(f.dir, 'link'); fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => context({ project: f.project, home: link }), /linked_path/);
  fs.writeFileSync(path.join(target, 'file.jsonl'), record('not touched'));
  assert.throws(() => enqueue(f.ctx, path.join(link, 'file.jsonl')), /linked_path/);
});
