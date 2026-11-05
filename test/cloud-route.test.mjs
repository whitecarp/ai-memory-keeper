import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../src/cli.mjs';
import { geminiEngine, routeOrder } from '../src/engine.mjs';
import { saveKey, clearKey, keyFile, keyStatus, keyCheckAnswer, routeSetting, keyWindowCommand } from '../src/key.mjs';
import { drain, status } from '../src/store.mjs';
import { fixture, record, item, memory } from './helpers.mjs';

// Both keys: AI Studio first (free tier), Agent Platform (Cloud billing) when AI Studio
// can't answer now, or the other way round with `amk route --set cloud`. Made-up keys only.
const STUDIO = 'AIzaFAKEstudioKEYnotREAL0123456789abcd';
const CLOUD = 'AQ.FAKEcloudKEYnotREAL0123456789abcdefgh';
const MEM = memory([item('I prefer short answers.')]);
const BODY = { model: 'gemini-3.8-flash', system_instruction: 'rules', input: 'I prefer short answers.', generation_config: { thinking_level: 'low' }, response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } } };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const studioAnswer = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(MEM) }] }] };
const cloudAnswer = { candidates: [{ content: { parts: [{ text: JSON.stringify(MEM) }] }, finishReason: 'STOP' }] };
function google(plan) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const via = url.includes('aiplatform.googleapis.com') ? 'cloud' : 'studio';
    calls.push({ via, key: init.headers['x-goog-api-key'], url });
    return plan[via]();
  };
  return { calls, fetchImpl };
}
const signal = () => new AbortController().signal;

test('route order: AI Studio first by default, Agent Platform first when chosen, only keys that exist', () => {
  assert.deepEqual(routeOrder({ key: 'a', cloudKey: 'b' }), ['studio', 'cloud']);
  assert.deepEqual(routeOrder({ key: 'a', cloudKey: 'b', route: 'cloud' }), ['cloud', 'studio']);
  assert.deepEqual(routeOrder({ key: 'a' }), ['studio']);
  assert.deepEqual(routeOrder({ cloudKey: 'b', route: 'auto' }), ['cloud']);
  assert.deepEqual(routeOrder({}), []);
});

test('free quota used up on AI Studio: the same save goes to Agent Platform once, with the Agent Platform key', async () => {
  const g = google({ studio: () => reply(429, { error: { code: 429, message: 'Quota exceeded per day (quota_exceeded).' } }), cloud: () => reply(200, cloudAnswer) });
  let via = null;
  const engine = geminiEngine({ key: STUDIO, cloudKey: CLOUD, fetchImpl: g.fetchImpl, onVia: v => { via = v; } });
  assert.deepEqual(await engine.complete(BODY, { signal: signal() }), MEM);
  assert.equal(via, 'cloud');
  assert.deepEqual(g.calls.map(c => [c.via, c.key]), [['studio', STUDIO], ['cloud', CLOUD]]);
  assert.ok(g.calls[1].url.endsWith('/publishers/google/models/gemini-3.8-flash:generateContent'));
});

test('a 402 (Prepay at $0) and a busy 503 also move to Agent Platform; a bad key does not', async () => {
  for (const studio of [() => reply(402, { error: { code: 402, message: 'Your prepayment credits are depleted.' } }), () => reply(503, { error: { code: 503, message: 'overloaded' } })]) {
    const g = google({ studio, cloud: () => reply(200, cloudAnswer) });
    const engine = geminiEngine({ key: STUDIO, cloudKey: CLOUD, fetchImpl: g.fetchImpl, backoff: [] });
    assert.deepEqual(await engine.complete(BODY, { signal: signal() }), MEM);
    assert.equal(g.calls.at(-1).via, 'cloud');
  }
  const bad = google({ studio: () => reply(400, { error: { code: 400, message: 'API key not valid.' } }), cloud: () => reply(200, cloudAnswer) });
  await assert.rejects(geminiEngine({ key: STUDIO, cloudKey: CLOUD, fetchImpl: bad.fetchImpl }).complete(BODY, { signal: signal() }), e => e.kind === 'http');
  assert.deepEqual(bad.calls.map(c => c.via), ['studio']);
});

test('Agent Platform first: a key it refuses falls back to AI Studio; without a second key the error stands', async () => {
  const g = google({ cloud: () => reply(401, { error: { code: 401, message: 'API keys are not supported by this API.' } }), studio: () => reply(200, studioAnswer) });
  let via = null;
  const engine = geminiEngine({ key: STUDIO, cloudKey: CLOUD, route: 'cloud', fetchImpl: g.fetchImpl, onVia: v => { via = v; } });
  assert.deepEqual(await engine.complete(BODY, { signal: signal() }), MEM);
  assert.equal(via, 'studio');
  assert.deepEqual(g.calls.map(c => c.via), ['cloud', 'studio']);
  const only = google({ studio: () => reply(429, { error: { code: 429, message: 'per day quota_exceeded' } }) });
  await assert.rejects(geminiEngine({ key: STUDIO, fetchImpl: only.fetchImpl }).complete(BODY, { signal: signal() }), e => e.kind === 'ratelimit');
  await assert.rejects(geminiEngine({}).complete(BODY, { signal: signal() }), /missing_gemini_key/);
});

test('Agent Platform request: thinking low, JSON schema in its Schema form, nothing else', async () => {
  let sent;
  const engine = geminiEngine({ cloudKey: CLOUD, route: 'cloud', fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return reply(200, cloudAnswer); } });
  await engine.complete(BODY, { signal: signal() });
  assert.deepEqual(Object.keys(sent).sort(), ['contents', 'generationConfig', 'systemInstruction']);
  assert.equal(sent.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(sent.generationConfig.responseSchema.type, 'OBJECT');
});

test('the worker uses both stored keys and records which one saved; status shows it', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  // Both keys stored the real way for this platform (DPAPI on Windows).
  saveKey(f.ctx, STUDIO, process.platform, 'studio');
  saveKey(f.ctx, CLOUD, process.platform, 'cloud');
  // Google stubbed: AI Studio is out of free quota, Agent Platform answers.
  const seen = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => {
    const cloud = String(url).includes('aiplatform');
    seen.push([cloud ? 'cloud' : 'studio', init.headers['x-goog-api-key']]);
    return cloud ? reply(200, cloudAnswer) : reply(429, { error: { code: 429, message: 'per day quota_exceeded' } });
  };
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try { await drain(f.ctx, { env: {} }); } finally { if (saved !== undefined) process.env.GEMINI_API_KEY = saved; globalThis.fetch = realFetch; }
  assert.deepEqual(seen, [['studio', STUDIO], ['cloud', CLOUD]]);
  assert.equal(status(f.ctx).lastSaveVia, 'cloud');
  assert.equal(status(f.ctx).queued, 0);
});

test('the Agent Platform key is stored apart from the AI Studio key, and the route is a setting', async t => {
  const f = fixture(t);
  saveKey(f.ctx, CLOUD, 'linux', 'cloud');
  assert.equal(fs.existsSync(keyFile(f.ctx, 'linux', 'cloud')), true);
  assert.equal(fs.existsSync(keyFile(f.ctx, 'linux')), false);
  assert.deepEqual(keyStatus(f.ctx, {}, 'linux').cloud, { set: true, from: 'stored on this computer, readable only by this user' });
  assert.equal(keyStatus(f.ctx, {}, 'linux').set, false);
  assert.ok(keyFile(f.ctx, 'win32', 'cloud').endsWith('cloud-key.dpapi'));
  assert.deepEqual(clearKey(f.ctx, 'linux', 'cloud'), { cleared: true });
  assert.equal(routeSetting(f.ctx), 'auto');
  assert.deepEqual(await run(['route', '--set', 'cloud', '--project', f.project, '--home', f.home]), { route: 'cloud' });
  assert.equal(routeSetting(f.ctx), 'cloud');
  assert.deepEqual(await run(['route', '--project', f.project, '--home', f.home]), { route: 'cloud' });
  await assert.rejects(run(['route', '--set', 'vertex', '--project', f.project, '--home', f.home]), /invalid_arguments/);
});

test('key check answers: Agent Platform refusing a key removes it; a 402 keeps the AI Studio key', () => {
  const refused = keyCheckAnswer({ ok: false, code: 'gemini_cloudkey', httpStatus: 401 }, 'zh', 'cloud');
  assert.equal(refused.keep, false); assert.match(refused.reason, /Agent Platform/);
  const prepay = keyCheckAnswer({ ok: false, code: 'gemini_prepay', httpStatus: 402 }, 'en', 'studio');
  assert.equal(prepay.keep, true); assert.match(prepay.reason, /402/); assert.match(prepay.reason, /amk key --cloud/);
  assert.equal(keyCheckAnswer({ ok: true }, 'zh', 'cloud').ok, true);
});

test('the Agent Platform key window: its own file and entropy, Google Cloud links only, and its check', async t => {
  const f = fixture(t);
  let opened = null;
  await run(['key', '--cloud', '--project', f.project, '--home', f.home], { openKeyWindow: async (ctx, o) => { opened = o; return { window: 'opened' }; } });
  assert.equal(opened.kind, 'cloud');
  const { CLOUD_KEY_PAGE, BUDGET_PAGE } = await import('../src/key.mjs');
  assert.ok(CLOUD_KEY_PAGE.startsWith('https://docs.cloud.google.com/') && BUDGET_PAGE.startsWith('https://docs.cloud.google.com/'));
  // The window's own data file, as openKeyWindow writes it, through the command builder.
  const data = `${f.home}/key-window.json`;
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(data, JSON.stringify({ kind: 'cloud', keyFile: keyFile(f.ctx, 'win32', 'cloud'), resultFile: `${f.home}/r`, lang: 'zh' }));
  const script = Buffer.from(keyWindowCommand(data).at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("'ai-memory-keeper/cloud-key/v1'") && script.includes("$KeyKind = 'cloud'") && script.includes('cloud-key.dpapi'));
  const ps = fs.readFileSync(new URL('../src/key-window.ps1', import.meta.url), 'utf8');
  assert.ok(ps.includes("-like 'https://docs.cloud.google.com/*'") && ps.includes("' --cloud'"));
});
