import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact, atomic, withLock, read } from '../src/safety.mjs';
import { context, enqueue, drain, recall, loadMemory, status } from '../src/store.mjs';
import { enable, disable, enabled } from '../src/hooks.mjs';
import { mergeLocal, transcriptText } from '../src/memory.mjs';
import { fixture, record, memory, engine } from './helpers.mjs';

test('review: Basic and quoted authorization credentials are removed', () => {
  for (const value of ['Authorization: Basic dXNlcjpwYXNz', 'authorization="Basic dXNlcjpwYXNz"', 'Bearer xyzzz', 'password = "with spaces"']) {
    assert.ok(!redact(value).includes('dXNlcjpwYXNz'));
    assert.ok(!redact(value).includes('xyzzz'));
    assert.ok(!redact(value).includes('with spaces'));
  }
});
test('review: dead worker lock is recovered but live and malformed locks are retained', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { cwd: f.project, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: f.dir, USERPROFILE: f.dir }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0); const dead = Number(child.stdout);
  assert.throws(() => process.kill(dead, 0));
  const lock = path.join(f.ctx.dir, 'worker.lock');
  atomic(lock, { pid: dead }); let ran = false;
  withLock(f.ctx.dir, 'worker', () => { ran = true; }); assert.ok(ran);
  atomic(lock, { pid: process.pid }); assert.throws(() => withLock(f.ctx.dir, 'worker', () => {}), /busy/);
  assert.equal(read(lock).pid, process.pid);
  fs.writeFileSync(lock, '{bad'); assert.throws(() => withLock(f.ctx.dir, 'worker', () => {}), /busy/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '{bad');
});
test('review: over-4MB history becomes complete bounded raw segments, not a permanent rejection', t => {
  const f = fixture(t); const raw = record('A line of original chat.').repeat(48000);
  assert.ok(Buffer.byteLength(raw) > 4 * 1024 * 1024);
  fs.writeFileSync(f.transcript, raw);
  const capture = enqueue(f.ctx, f.transcript);
  assert.equal(capture.bytes, Buffer.byteLength(raw)); assert.ok(capture.jobs > 1);
  const q = read(path.join(f.ctx.dir, 'queue.json'));
  const joined = q.jobs.map(id => read(path.join(f.ctx.dir, 'jobs', id + '.json')).raw).join('');
  assert.equal(joined, raw);
  assert.equal(enqueue(f.ctx, f.transcript).queued, false);
});
test('review: UTF-8 text segment boundaries preserve every character', t => {
  const f = fixture(t); const file = path.join(f.dir, 'words.txt'); const raw = '🧠记忆'.repeat(480000);
  fs.writeFileSync(file, raw); enqueue(f.ctx, file);
  const q = read(path.join(f.ctx.dir, 'queue.json'));
  assert.equal(q.jobs.map(id => read(path.join(f.ctx.dir, 'jobs', id + '.json')).raw).join(''), raw);
});
test('review: a single large JSON record is not silently truncated', t => {
  const f = fixture(t); const raw = record('a'.repeat(5 * 1024 * 1024));
  fs.writeFileSync(f.transcript, raw);
  const capture = enqueue(f.ctx, f.transcript);
  assert.equal(capture.bytes, Buffer.byteLength(raw));
  assert.equal(read(path.join(f.ctx.dir, 'jobs', capture.id + '.json'), null, 100 * 1024 * 1024).raw, raw);
});
test('review: independent keeper homes share the configuration write lock', t => {
  const f = fixture(t); const other = context({ project: f.project, home: path.join(f.dir, 'second-home') });
  withLock(path.join(f.project, '.ai-memory-keeper/config-locks'), 'claude', () => {
    assert.throws(() => enable(other, 'claude'), /busy/);
  });
  enable(f.ctx, 'claude'); enable(other, 'claude');
  assert.ok(enabled(f.ctx, 'claude')); assert.ok(enabled(other, 'claude'));
  disable(f.ctx, 'claude'); assert.ok(enabled(other, 'claude'));
  disable(other, 'claude');
});
test('review: uppercase JSONL still filters summaries and incomplete records', t => {
  const f = fixture(t); const file = path.join(f.dir, 'upper.JSONL');
  const summary = JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary not raw' } }) + '\n';
  fs.writeFileSync(file, record('Real words') + summary + '{incomplete');
  const capture = enqueue(f.ctx, file);
  const job = read(path.join(f.ctx.dir, 'jobs', capture.id + '.json'));
  assert.equal(job.format, 'jsonl'); assert.ok(!job.raw.includes('{incomplete'));
  assert.ok(!transcriptText(job.raw, job.format).includes('summary not raw'));
});
test('review: blank model note cannot erase a previous wake-up note', () => {
  const old = memory();
  assert.deepEqual(mergeLocal(old, { wake_up_note: '', items: [] }).items, old.items);
  assert.equal(mergeLocal(old, { wake_up_note: '', items: [] }).wake_up_note, old.wake_up_note);
});
test('review: unavailable/oversized summary sources still recall last good memory', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  enqueue(f.ctx, f.transcript); await drain(f.ctx, { engine: engine() });
  const before = loadMemory(f.ctx);
  assert.ok(recall(f.ctx, { transcript: path.join(f.dir, 'missing.jsonl') }).includes('I prefer short answers.'));
  assert.equal(status(f.ctx).recallWarning, 'summary_unavailable_using_last_good_memory');
  // A big transcript is read from its end: no summary there, so the whole memory comes back.
  const big = path.join(f.dir, 'big.jsonl'); const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 17 * 1024 * 1024); fs.closeSync(fd);
  assert.ok(recall(f.ctx, { transcript: big }).includes('I prefer short answers.'));
  assert.equal(status(f.ctx).recallWarning, null);
  assert.deepEqual(loadMemory(f.ctx), before);
});
test('unknown raw transcript schema is retained pending instead of discarded', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, '{"new_format":"real words"}\n');
  enqueue(f.ctx, f.transcript);
  await assert.rejects(drain(f.ctx, { engine: engine() }), /unsupported_transcript_record/);
  assert.equal(status(f.ctx).queued, 1); assert.equal(status(f.ctx).lastSave, null);
});
test('review: continuous redaction context removes secrets and multiline private keys crossing raw snapshot boundaries', async t => {
  const f = fixture(t);
  const chunk1Size = 4 * 1024 * 1024;
  const prefix = 'A'.repeat(chunk1Size - 'password='.length);
  const part1 = prefix + 'password=';
  const part2 = 'supersecretpassword123 and then more conversation after the boundary.\n' +
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAA\n' +
    'AAAAhyP4v3qZ8=\n-----END OPENSSH PRIVATE KEY-----\nDone.\n';
  const fullText = part1 + part2;
  const txtFile = path.join(f.dir, 'large.txt');
  fs.writeFileSync(txtFile, fullText);

  const capture = enqueue(f.ctx, txtFile);
  assert.ok(capture.jobs > 1);

  const capturedInputs = [];
  const trackingEngine = {
    complete: async (body) => {
      capturedInputs.push(JSON.stringify(body));
      return memory([]);
    },
  };

  await drain(f.ctx, { engine: trackingEngine });
  assert.equal(status(f.ctx).queued, 0);

  const allCaptured = capturedInputs.join('\n');
  assert.ok(!allCaptured.includes('supersecretpassword123'), 'password must be redacted');
  assert.ok(!allCaptured.includes('b3BlbnNzaC'), 'private key part 1 must be redacted');
  assert.ok(!allCaptured.includes('hyP4v3qZ8'), 'private key part 2 must be redacted');
  assert.ok(allCaptured.includes('[REDACTED_VALUE]'), 'redacted value marker must exist');
  assert.ok(allCaptured.includes('[REDACTED_PRIVATE_KEY]'), 'redacted private key marker must exist');
});
test('review: multiline private key directly cut across 4MB snapshot boundary is fully redacted', async t => {
  const f = fixture(t);
  const chunk1Size = 4 * 1024 * 1024;
  const keyHeader = '-----BEGIN RSA PRIVATE KEY-----\n';
  const keyBodyPart1 = 'MIIEowIBAAKCAQEA0'.repeat(100);
  const keyBodyPart2 = 'AAAAyP4v3qZ81234567890'.repeat(100);
  const keyFooter = '\n-----END RSA PRIVATE KEY-----\n';
  const paddingLength = chunk1Size - keyHeader.length - keyBodyPart1.length;
  const part1 = 'B'.repeat(paddingLength) + keyHeader + keyBodyPart1;
  const part2 = keyBodyPart2 + keyFooter + 'Important conversation notes.\n';
  const fullText = part1 + part2;
  const txtFile = path.join(f.dir, 'splitkey.txt');
  fs.writeFileSync(txtFile, fullText);

  const capture = enqueue(f.ctx, txtFile);
  assert.ok(capture.jobs > 1);

  const capturedInputs = [];
  const trackingEngine = {
    complete: async (body) => {
      capturedInputs.push(JSON.stringify(body));
      return memory([]);
    },
  };

  await drain(f.ctx, { engine: trackingEngine });
  assert.equal(status(f.ctx).queued, 0);

  const allCaptured = capturedInputs.join('\n');
  assert.ok(!allCaptured.includes('MIIEowIBAAKCAQEA0'), 'private key chunk 1 body must be redacted');
  assert.ok(!allCaptured.includes('AAAAyP4v3qZ81234567890'), 'private key chunk 2 body must be redacted');
  assert.ok(allCaptured.includes('[REDACTED_PRIVATE_KEY]'), 'must contain redacted marker');
});
