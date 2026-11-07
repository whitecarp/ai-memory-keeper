import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiEngine, extractMemory } from '../src/engine.mjs';
import { emptyMemory } from '../src/store.mjs';
import { memory, item, engine } from './helpers.mjs';

const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const success = data => response({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(data) }] }] });
test('actual Gemini transport wrapper redacts outbound JSON and retries 503/429, then validates', async () => {
  const requests = [];
  const fakeKey = 'unit-test-key-not-real';
  const adapter = geminiEngine({ key: fakeKey, backoff: [1, 1], fetchImpl: async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(options.headers['x-goog-api-key'], fakeKey);
    assert.equal(options.redirect, 'error');
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return response({ error: { message: 'busy' } }, 503);
    if (requests.length === 2) return response({ error: { message: 'rate limit' } }, 429);
    return success(memory());
  } });
  const result = await extractMemory({ text: 'I prefer short answers. token=private123 sk-secret123456789', old: emptyMemory(), profile: 'work', date: '2026-11-04', engine: adapter });
  assert.equal(result.items.length, 1); assert.equal(requests.length, 3);
  for (const body of requests) {
    assert.equal(body.store, false);
    assert.ok(body.system_instruction.includes("Never guess anyone's gender"));
    assert.ok(!JSON.stringify(body).includes('private123'));
    assert.ok(!JSON.stringify(body).includes('sk-secret123456789'));
    assert.ok(body.input.includes('REDACTED'));
  }
});
test('missing key refuses before any network', async () => {
  let calls = 0;
  const adapter = geminiEngine({ fetchImpl: async () => { calls++; } });
  await assert.rejects(adapter.complete({}, { signal: new AbortController().signal }), /missing_gemini_key/);
  assert.equal(calls, 0);
});
test('daily quota and 400 are not retried; exhausted transient errors stop', async () => {
  for (const [status, message, wanted] of [[429, 'daily quota_exceeded', 1], [400, 'bad request', 1], [503, 'busy', 3]]) {
    let calls = 0;
    const adapter = geminiEngine({ key: 'fake', backoff: [1, 1], fetchImpl: async () => { calls++; return response({ error: { message } }, status); } });
    await assert.rejects(adapter.complete({}, { signal: new AbortController().signal }));
    assert.equal(calls, wanted);
  }
});
test('junk JSON, empty object and incomplete output reject; an invented quote never reaches memory', async () => {
  for (const data of [{}, { status: 'incomplete', steps: [] }, { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{junk}' }] }] }, { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{}' }] }] }]) {
    const adapter = geminiEngine({ key: 'fake', fetchImpl: async () => response(data) });
    await assert.rejects(extractMemory({ text: 'I prefer short answers.', old: emptyMemory(), profile: 'work', date: '2026-11-04', engine: adapter }));
  }
  // The item with the invented quote is dropped (and counted); the rest of the save goes on.
  let dropped = 0;
  const out = await extractMemory({ text: 'I prefer short answers.', old: emptyMemory(), profile: 'work', date: '2026-11-04', engine: engine(memory([item('invented'), item('I prefer short answers.', { key: 'style' })])), onDropped: n => { dropped += n; } });
  assert.equal(dropped, 1);
  assert.deepEqual(out.items.map(i => i.evidence), ['I prefer short answers.']);
});
test('a sloppy answer is tidied, not thrown away: key spelling, rank range, date, unknown category, stray fields', async () => {
  const { tidyMemory } = await import('../src/memory.mjs');
  const pool = 'I prefer short answers. Use Postgres.';
  const { memory: m, dropped } = tidyMemory({ wake_up_note: 'x', extra: 1, items: [
    { key: '回复 风格', category: 'preference', text: 'short', date: '2026-1-5', evidence: 'I prefer short answers.', rank: 7, status: 'odd', note: 'stray' },
    { key: 'db', category: 'learning', text: 'pg', date: '2026-11-04', evidence: 'Use Postgres.', rank: 1, status: 'none' },
    { key: 'db2', category: 'decision', text: 'pg', date: '2026-11-04', evidence: 'Use MySQL.', rank: 1, status: 'none' },
  ] }, 'work', pool, '2026-11-05');
  assert.equal(dropped, 2); // unknown category; quote not in the chat
  assert.deepEqual(m.items, [{ key: '回复-风格', category: 'preference', text: 'short', date: '2026-11-05', evidence: 'I prefer short answers.', rank: 4, status: 'none' }]);
  assert.deepEqual(Object.keys(m), ['wake_up_note', 'items']);
  const { validateMemory } = await import('../src/memory.mjs');
  assert.doesNotThrow(() => validateMemory(m, 'work', pool));
  assert.throws(() => validateMemory({ wake_up_note: '', items: [{ ...m.items[0], rank: 9 }] }, 'work'), e => e.code === 'invalid_memory' && e.detail === 'rank');
});
test('whole-job deadline covers a hanging engine and aborts transport', async () => {
  let signal;
  const adapter = { complete: async (_, opts) => { signal = opts.signal; return new Promise(() => {}); } };
  await assert.rejects(extractMemory({ text: 'words', old: emptyMemory(), profile: 'work', date: '2026-11-04', engine: adapter, timeoutMs: 20 }), /timeout/);
  assert.equal(signal.aborted, true);
});
test('chunking and model merging reuse app prompts without erasing omitted old entries', async () => {
  const calls = [];
  const old = memory([item('An earlier preference.', { key: 'prior', pinned: true })]);
  const adapter = { complete: async body => { calls.push(body); return memory([item()]); } };
  const result = await extractMemory({ text: ('I prefer short answers.\n').repeat(40), old, profile: 'work', date: '2026-11-04', engine: adapter, chunkTokens: 180 });
  assert.ok(calls.length > 2);
  assert.ok(calls.some(c => c.input.startsWith('Partial memory sheets:')));
  assert.ok(result.items.some(i => i.key === 'prior' && i.pinned));
});
test('companion profile has its own categories and preserves evidence', async () => {
  const result = await extractMemory({ text: 'Call me Moon.', old: emptyMemory(), profile: 'companion', date: '2026-11-04', engine: engine(memory([item('Call me Moon.', { category: 'nickname' })])) });
  assert.equal(result.items[0].category, 'nickname');
});
