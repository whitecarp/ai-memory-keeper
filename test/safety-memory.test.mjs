import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { redact, redactObject, atomic, safeCode, SafeError, withLock, hash } from '../src/safety.mjs';
import { validateMemory, mergeLocal, gapRecall, transcriptText, latestSummary } from '../src/memory.mjs';
import { fixture, memory, item, record } from './helpers.mjs';

// The web app sits next to the CLI only in the original workspace, not in the published repo.
const appCore = new URL('../../app/public/core.js', import.meta.url);
test('vendor is the unchanged app core, not a second implementation', { skip: !fs.existsSync(appCore) && 'the web app is not next to the CLI here' }, () => {
  assert.equal(hash(fs.readFileSync(new URL('../vendor/core.js', import.meta.url))), hash(fs.readFileSync(appCore)));
});
test('redacts the required key families, assignments, bearer and random tokens', () => {
  const secrets = ['AIzaSy1234567890abcdefghijklmnop', 'sk-proj-secret123456789', 'ghp_abcdefghijk12345678', 'AKIA1234567890123456', 'x8QpY2aV7bN9mC5kL1tR6uF3dS0jH4eZ'];
  const text = `${secrets.join(' ')} password="open sesame" token=abc123 \"api_key\": \"qwerty\" Authorization: Bearer xyz321\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`;
  const clean = redact(text);
  for (const secret of [...secrets, 'open sesame', 'abc123', 'qwerty', 'xyz321', '\nabc\n']) assert.ok(!clean.includes(secret), secret);
  assert.ok(clean.includes('REDACTED'));
  assert.equal(redact('The owner prefers tea. Do not guess their gender.'), 'The owner prefers tea. Do not guess their gender.');
});
test('structured redaction keeps valid JSON while cleaning string values', () => {
  const out = redactObject({ input: 'password="secret value"', nested: ['token=secret'] });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  assert.ok(!JSON.stringify(out).includes('secret'));
});
test('unfinished private key blocks are also removed', () => {
  assert.equal(redact('prefix\n-----BEGIN PRIVATE KEY-----\nsecret'), 'prefix\n[REDACTED_PRIVATE_KEY]');
});
test('reject malformed model output, unsupported categories and fabricated quotes', () => {
  for (const bad of [{}, { items: [] }, memory([item('', {})]), memory([item('a', { category: 'invented' })]), memory([item('a', { date: '2026-02-31' })]), memory([item('a', { rank: 0 })]), memory([item('a', { status: 'done' })]), memory([item('a'), item('b')])]) assert.throws(() => validateMemory(bad, 'work'));
  assert.throws(() => validateMemory(memory(), 'work', 'unrelated input'), /ungrounded_evidence/);
  assert.doesNotThrow(() => validateMemory(memory(), 'work', item().evidence));
});
test('latest dated correction wins and manual pin survives; lower priority drops first', () => {
  const old = memory([item('Old', { date: '2026-11-02', pinned: true }), item('one-off', { key: 'oneoff', rank: 4 })]);
  const merged = mergeLocal(old, memory([item('New'), item('explicit', { key: 'explicit', rank: 1 })]));
  assert.equal(merged.items[0].text, 'New'); assert.equal(merged.items[0].pinned, true);
  assert.equal(mergeLocal(merged, memory([item('stale', { date: '2025-01-01' })])).items[0].text, 'New');
  const cap = Buffer.byteLength(JSON.stringify({ ...merged, items: merged.items.slice(0, 2) }, null, 2) + '\n');
  const trimmed = mergeLocal(old, memory([item('New'), item('explicit', { key: 'explicit', rank: 1 })]), cap);
  assert.deepEqual(trimmed.items.map(i => i.key), ['answer-style', 'explicit']);
  assert.throws(() => mergeLocal(old, memory(), 20), /pinned_memory_exceeds_cap/);
});
test('promise updates are dated and retain the final status', () => {
  const old = memory([item('Meet tomorrow.', { category: 'promise', status: 'pending' })]);
  const next = memory([item('Met today.', { category: 'promise', date: '2026-11-05', status: 'kept' })]);
  const result = mergeLocal(old, next); validateMemory(result, 'companion');
  assert.equal(result.items[0].status, 'kept');
});
test('gap recall ignores case/spacing/punctuation but does not guess semantic matches', () => {
  const data = memory([item(), item('Use Node.', { key: 'runtime' })]);
  const text = gapRecall(data, 'I PREFER SHORT ANSWERS!');
  assert.ok(!text.includes('"text":"I prefer short answers."'));
  assert.ok(text.includes('Use Node.'));
  assert.ok(gapRecall(data, 'Be concise.').includes('I prefer short answers.'));
});
test('raw extraction ignores summaries and tool results in both supported formats', () => {
  const raw = record('Real words') + JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary words' } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex words' }] } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'tool secret' } }) + '\n';
  const text = transcriptText(raw, 'jsonl');
  assert.ok(text.includes('Real words') && text.includes('Codex words'));
  assert.ok(!text.includes('Summary words') && !text.includes('tool secret'));
  assert.equal(latestSummary(raw), 'Summary words');
  assert.equal(latestSummary('{"type":"summary","summary":"title only"}\n'), '');
  assert.equal(latestSummary('{"type":"compacted","payload":{"message":"new summary"}}\n'), 'new summary');
  assert.throws(() => transcriptText('{bad}\n', 'jsonl'), /invalid_transcript/);
});
test('atomic file writes and lock exclusion', async t => {
  const f = fixture(t); const file = path.join(f.ctx.dir, 'test.json');
  atomic(file, { old: true }); atomic(file, { new: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { new: true });
  let release;
  const p = withLock(f.ctx.dir, 'test', () => new Promise(r => { release = r; }));
  assert.throws(() => withLock(f.ctx.dir, 'test', () => {}), /busy/);
  release(); await p;
  assert.ok(!fs.existsSync(path.join(f.ctx.dir, 'test.lock')));
});
test('safe errors never echo server messages, keys or transcript excerpts', () => {
  assert.equal(safeCode(new Error('sk-SECRET transcript')), 'operation_failed');
  assert.equal(safeCode({ kind: 'badjson', message: 'private text' }), 'gemini_badjson');
  assert.equal(safeCode(new SafeError('invalid_memory')), 'invalid_memory');
});
