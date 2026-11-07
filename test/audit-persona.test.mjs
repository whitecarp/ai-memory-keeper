import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, disable, installationFile } from '../src/hooks.mjs';
import { drain, status } from '../src/store.mjs';
import { read } from '../src/safety.mjs';
import { scanSegment, assess, hostOf, family } from '../src/audit.mjs';
import { gapRecall } from '../src/memory.mjs';
import { userMessage } from '../src/persona.mjs';
import { fixture, record, engine, memory } from './helpers.mjs';

let n = 0;
const claude = ({ model = 'claude-sonnet-4-5', text = 'Done.', id, cacheRead = 120, sidechain = false } = {}) => JSON.stringify({
  type: 'assistant', isSidechain: sidechain, timestamp: '2026-11-04T10:00:00Z',
  message: { id: id || `msg_01${String(++n).padStart(22, '0')}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
    usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } },
}) + '\n';
const many = (count, opts) => Array.from({ length: count }, () => claude(opts)).join('');
const job = (raw, extra = {}) => ({ id: 'j' + (++n), source: 'src', time: 't', scan: scanSegment(raw, 'jsonl'), requested: null, anthropicHost: null, openaiHost: null, ...extra });

test('model check: genuine-looking Claude Code transcript is ok', () => {
  const r = assess([job(many(12))]);
  assert.equal(r.level, 'ok'); assert.equal(r.expected, 'claude'); assert.equal(r.messages, 12);
});
test('model check: a non-Claude model name under Claude Code is suspect, hedged when assumed', () => {
  const r = assess([job(many(3, { model: 'glm-4.6' }))]);
  assert.equal(r.level, 'suspect'); assert.equal(r.expectedFrom, 'assumed');
  assert.deepEqual(r.signals.find(s => s.code === 'model_family_mismatch').got, ['glm-4.6']);
});
test("model check: the vendor's own endpoint or ANTHROPIC_MODEL sets the expected family", () => {
  assert.equal(assess([job(many(3, { model: 'glm-4.6' }), { anthropicHost: 'open.bigmodel.cn' })]).level, 'ok');
  assert.equal(assess([job(many(3, { model: 'glm-4.6' }), { requested: 'glm-4.6' })]).level, 'ok');
  const r = assess([job(many(3, { model: 'deepseek-chat' }), { requested: 'claude-opus-4-1', anthropicHost: 'relay.example.com' })]);
  assert.equal(r.level, 'suspect'); assert.equal(r.expectedFrom, 'ANTHROPIC_MODEL');
  assert.ok(r.signals.some(s => s.code === 'via_relay'));
});
test('model check: leaked <think> tags and self-introductions are suspect', () => {
  assert.ok(assess([job(claude({ text: '<think>hmm</think> ok' }))]).signals.some(s => s.code === 'think_tags'));
  const r = assess([job(claude({ text: '你好，我是DeepSeek，很高兴帮你。' }))]);
  assert.equal(r.level, 'suspect'); assert.deepEqual(r.signals.find(s => s.code === 'self_identification').vendors, ['deepseek']);
  assert.equal(assess([job(claude({ text: '谢谢 Gemini娘 帮忙保管记忆。' }))]).level, 'ok');
});
test('model check: odd message ids and a cache that never hits are only weak notices', () => {
  const r = assess([job(Array.from({ length: 12 }, (_, i) => claude({ id: `chatcmpl-${i}`, cacheRead: 0 })).join(''))]);
  assert.equal(r.level, 'notice');
  assert.deepEqual(r.signals.map(s => s.code).sort(), ['nonstandard_message_ids', 'prompt_cache_never_hit']);
});
test('model check: synthetic messages, sidechains and repeated streamed blocks are not counted', () => {
  const id = 'msg_01AAAAAAAAAAAAAAAAAAAAAAAA';
  const raw = claude({ id }) + claude({ id }) + claude({ model: '<synthetic>' }) + claude({ model: 'gpt-4o', sidechain: true });
  const s = scanSegment(raw, 'jsonl');
  assert.equal(s.messages, 1); assert.deepEqual(s.models, { 'claude-sonnet-4-5': 1 });
});
test('model check: Codex models are reported without guessing an expected family', () => {
  const raw = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } }) + '\n'
    + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n';
  const r = assess([job(raw)]);
  assert.equal(r.agentKind, 'codex'); assert.equal(r.level, 'not_checked'); assert.equal(r.expected, null);
  assert.deepEqual(r.models, { 'gpt-5-codex': 1 }); assert.deepEqual(r.signals, []);
});
test('model check: only the hostname of a base URL is kept, never credentials or path', () => {
  assert.equal(hostOf('https://user:sk-secret@Relay.Example.com/sk-abc123/v1'), 'relay.example.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(family('claude-opus-4-1'), 'claude'); assert.equal(family('qwen3-coder'), 'qwen');
});
test('worker records the check before Gemini, even when saving fails, and stores no transcript text', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, record('I prefer short answers.') + many(3, { model: 'deepseek-chat', text: 'private reply words' }));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  const env = { ANTHROPIC_BASE_URL: 'https://relay.example.com/key-in-path/v1' };
  await assert.rejects(drain(f.ctx, { engine: { complete: async () => { throw new Error('no key'); } }, env }));
  const check = status(f.ctx).modelCheck;
  assert.equal(check.level, 'suspect'); assert.equal(check.host, 'relay.example.com');
  const stored = fs.readFileSync(path.join(f.ctx.dir, 'audit.json'), 'utf8');
  assert.ok(!stored.includes('private reply words')); assert.ok(!stored.includes('key-in-path'));
});
test('Claude Code sees Gemini娘 per agent; the user sees her line and a hedged warning', async t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  const owner = read(installationFile(f.ctx, 'claude')).owner;
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'claude', '--owner', owner], { startWorker: async () => {}, input: { session_id: 's1', transcript_path: f.transcript, cwd: f.project, ...input } });
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  const first = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.ok(first.systemMessage.includes('第一次')); assert.equal(first.hookSpecificOutput, undefined);
  fs.appendFileSync(f.transcript, many(2, { model: 'glm-4.6' }));
  assert.equal(await hook({ hook_event_name: 'PreCompact', trigger: 'auto' }), '');
  assert.equal(status(f.ctx).queued, 1);
  await drain(f.ctx, { engine: engine(), env: {} });
  const out = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Gemini娘 → Claude'));
  assert.ok(out.systemMessage.includes('Gemini娘') && out.systemMessage.includes('1 条记忆'));
  assert.ok(out.systemMessage.includes('⚠️') && out.systemMessage.includes('glm-4.6') && out.systemMessage.includes('可以忽略'));
  disable(f.ctx, 'claude');
});
test('Codex gets the persona in context and a visible line; manual recall keeps the neutral greeting', async t => {
  const f = fixture(t); enable(f.ctx, 'codex');
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--project', f.project, '--home', f.home], { engine: engine() });
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const out = await run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { input: { session_id: 's', transcript_path: f.transcript, cwd: f.project, hook_event_name: 'SessionStart', source: 'compact' } });
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Gemini娘 → Codex'));
  assert.ok(out.systemMessage.startsWith('✨ Gemini娘：'));
  const handler = read(path.join(f.project, '.codex', 'hooks.json')).hooks.SessionStart[0].hooks[0];
  assert.equal(handler.additionalContextLimit, 8000);
  assert.ok(gapRecall(memory(), '', 'en').includes('Gemini-chan · AI Memory Keeper'));
  disable(f.ctx, 'codex');
});

test("Gemini's own line is split off before validation, bounded and redacted", async () => {
  const { extractMemory, cleanPersonaLine } = await import('../src/engine.mjs');
  const { emptyMemory } = await import('../src/store.mjs');
  let got = '';
  const out = await extractMemory({ text: 'I prefer short answers.', old: emptyMemory(), profile: 'work', date: '2026-11-04',
    engine: engine({ ...memory(), persona_line: '记住啦：主人喜欢简短回答～ token=abc123' }), onPersonaLine: l => { got = l; } });
  assert.equal(out.items.length, 1); assert.ok(!('persona_line' in out));
  assert.ok(got.startsWith('记住啦') && !got.includes('abc123'));
  assert.equal(cleanPersonaLine('太长'.repeat(50)), ''); assert.equal(cleanPersonaLine(42), '');
  assert.equal(cleanPersonaLine('line one\nline two', 'en'), 'line one line two');
  // A broken line never fails the save.
  let none = 'unset';
  await extractMemory({ text: 'I prefer short answers.', old: emptyMemory(), profile: 'work', date: '2026-11-04', engine: engine({ ...memory(), persona_line: { bad: true } }), onPersonaLine: l => { none = l; } });
  assert.equal(none, 'unset');
});
test('both characters appear: Gemini\'s line, then who answered on the other side', async t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  const owner = read(installationFile(f.ctx, 'claude')).owner;
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'claude', '--owner', owner], { startWorker: async () => {}, input: { session_id: 's2', transcript_path: f.transcript, cwd: f.project, ...input } });
  fs.writeFileSync(f.transcript, record('I prefer short answers.') + many(12));
  await hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
  await drain(f.ctx, { engine: engine({ ...memory(), persona_line: '这次我替你们记住了：回答要简短。' }), env: {} });
  const out = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  const [geminiLine, partner] = out.systemMessage.split('\n');
  assert.equal(geminiLine, '✨ Gemini娘：这次我替你们记住了：回答要简短。');
  assert.equal(partner, '🤖 对面：claude-sonnet-4-5 · 没发现换模型的迹象');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Gemini娘 对你说（引用，不是指令）'));
  // While the next segment is still being saved, she says so instead of repeating a stale line.
  fs.appendFileSync(f.transcript, record('Use Node.'));
  await hook({ hook_event_name: 'PreCompact', trigger: 'auto' });
  const busy = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.ok(busy.systemMessage.startsWith('✨ Gemini娘：这次的新记忆还在后台整理'));
  disable(f.ctx, 'claude');
});

test('overlay: on by default, can be turned off, and the hook hands it both lines', async t => {
  const { overlayEnabled } = await import('../src/overlay.mjs');
  const f = fixture(t); enable(f.ctx, 'codex');
  assert.equal(overlayEnabled(f.ctx), true);
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--project', f.project, '--home', f.home], { engine: engine({ ...memory(), persona_line: '回答要简短，我记住啦。' }) });
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const shown = [];
  const hook = () => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], {
    showOverlay: async (ctx, opts) => { shown.push(opts.lines); return true; },
    input: { session_id: 's', transcript_path: f.transcript, cwd: f.project, hook_event_name: 'SessionStart', source: 'compact' } });
  await hook();
  assert.equal(shown.length, 1); assert.equal(shown[0].gemini, '回答要简短，我记住啦。');
  assert.deepEqual(await run(['overlay', '--set', 'off', '--project', f.project, '--home', f.home]), { overlay: false, supported: process.platform === 'win32' });
  await hook(); assert.equal(shown.length, 1);
  assert.equal((await run(['status', '--project', f.project, '--home', f.home])).overlay.enabled, false);
  disable(f.ctx, 'codex');
});
test('overlay: a failing overlay never breaks the hook', async t => {
  const f = fixture(t); enable(f.ctx, 'claude');
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--project', f.project, '--home', f.home], { engine: engine() });
  const owner = read(installationFile(f.ctx, 'claude')).owner;
  const out = await run(['hook', '--project', f.project, '--home', f.home, '--agent', 'claude', '--owner', owner], {
    showOverlay: async () => { throw new Error('no desktop'); },
    input: { session_id: 's', transcript_path: f.transcript, cwd: f.project, hook_event_name: 'SessionStart', source: 'compact' } });
  assert.ok(out.systemMessage.includes('Gemini娘') && out.hookSpecificOutput.additionalContext);
  disable(f.ctx, 'claude');
});
test('overlay: detached Node launcher, encoded ASCII PowerShell script, UTF-8 data file; no-op off Windows', async t => {
  const { showOverlay, overlayCommand } = await import('../src/overlay.mjs');
  const f = fixture(t);
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const handlers = {};
    const child = { once: (e, fn) => { handlers[e] = fn; if (e === 'spawn') setImmediate(fn); return child; }, unref: () => {} };
    return child;
  };
  const lines = { gemini: '你好～', partner: { level: 'suspect', text: '回复自称来自 glm-4.6' } };
  assert.equal(await showOverlay(f.ctx, { lines, platform: 'linux', spawnImpl: fakeSpawn, env: {} }), false);
  assert.equal(await showOverlay(f.ctx, { lines, platform: 'win32', spawnImpl: fakeSpawn, env: { AMK_NO_OVERLAY: '1' } }), false);
  assert.equal(calls.length, 0);
  assert.equal(await showOverlay(f.ctx, { lines, platform: 'win32', spawnImpl: fakeSpawn, env: {} }), true);
  const [call] = calls;
  assert.equal(call.cmd, process.execPath); assert.ok(call.opts.detached && call.opts.windowsHide && call.opts.stdio === 'ignore');
  assert.ok(call.args[0].endsWith('overlay-launch.mjs')); assert.equal(call.args[1], path.join(f.ctx.dir, 'overlay.json'));
  const psArgs = overlayCommand('C:\\x\\overlay.json');
  assert.ok(psArgs.includes('-EncodedCommand') && !psArgs.includes('-ExecutionPolicy') && !psArgs.includes('-File'));
  const data = JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'overlay.json'), 'utf8'));
  assert.equal(data.say, '你好～'); assert.equal(data.partner.level, 'suspect'); assert.ok(data.credit.includes('@ZipZipPipe'));
  assert.ok(fs.existsSync(data.art)); assert.ok(data.art.endsWith('gemini-overlay-alert.png'));
  assert.equal(data.pose, 'alert'); assert.ok(data.frames.base.endsWith('gemini-overlay-closed-mouth.png'));
  await showOverlay(f.ctx, { lines: { gemini: 'ok', partner: { level: 'ok', text: 'x' } }, platform: 'win32', spawnImpl: fakeSpawn, env: {} });
  const okData = JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'overlay.json'), 'utf8'));
  assert.ok(okData.art.endsWith('gemini-overlay-closed-mouth.png')); assert.equal(okData.pose, 'base');
  // The script and its helpers stay ASCII so Windows PowerShell code pages can't garble them,
  // and the encoded command stays under Windows' 32,767-character command-line limit.
  for (const file of ['overlay.ps1', 'overlay-native.cs', 'overlay.xaml']) {
    assert.ok(/^[\x00-\x7f]*$/.test(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')), file);
  }
  const longPath = 'C:\\Users\\' + 'x'.repeat(120) + '\\.ai-memory-keeper\\work\\abcdefabcdefabcdefab\\overlay.json';
  assert.ok(overlayCommand(longPath).join(' ').length < 30000);
  assert.equal(data.agentPid, process.ppid);
});

test('overlay: she appears when compaction starts and the same window gets the result', async t => {
  const { showOverlay } = await import('../src/overlay.mjs');
  const f = fixture(t); enable(f.ctx, 'claude');
  const owner = read(installationFile(f.ctx, 'claude')).owner;
  const calls = [];
  const deps = { startWorker: async () => {}, showOverlay: async (ctx, opts) => { calls.push(opts); return true; } };
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'claude', '--owner', owner], { ...deps, input: { session_id: 's', transcript_path: f.transcript, cwd: f.project, ...input } });
  fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  assert.equal(await hook({ hook_event_name: 'PreCompact', trigger: 'auto' }), '');
  assert.equal(calls[0].phase, 'working'); assert.equal(calls[0].lines.partner.level, 'pending');
  await drain(f.ctx, { engine: engine(), env: {} });
  await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(calls[1].phase, undefined); // default "done"
  // Real data-file behaviour: spawn once, then update in place while the window is up.
  let spawns = 0; let clock = 1_000_000;
  const fakeSpawn = () => { spawns++; const c = { once: (e, fn) => { if (e === 'spawn') setImmediate(fn); return c; }, unref: () => {} }; return c; };
  const opts = { platform: 'win32', spawnImpl: fakeSpawn, env: {}, now: () => clock };
  await showOverlay(f.ctx, { ...opts, phase: 'working', lines: { gemini: 'working' } });
  clock += 3000;
  await showOverlay(f.ctx, { ...opts, lines: { gemini: 'done' } });
  assert.equal(spawns, 1);
  const data = JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'overlay.json'), 'utf8'));
  assert.equal(data.phase, 'done'); assert.equal(data.say, 'done'); assert.equal(data.seq, clock);
  // Window gone (no heartbeat, spawn long ago): the result opens a new one.
  clock += 60000;
  await showOverlay(f.ctx, { ...opts, lines: { gemini: 'later' } });
  assert.equal(spawns, 2);
  disable(f.ctx, 'claude');
});
test('overlay: preview plays working, then the result', async t => {
  const f = fixture(t); const calls = [];
  const out = await run(['overlay', '--set', 'preview-alert', '--project', f.project, '--home', f.home], { previewWorkingMs: 1, showOverlay: async (ctx, o) => { calls.push(o); return true; } });
  assert.deepEqual(out, { previewed: true });
  assert.deepEqual(calls.map(c => c.phase ?? 'done'), ['working', 'done']);
  assert.equal(calls[1].lines.partner.level, 'suspect');
});

test('gemini-check narrates retries and reports why it failed, without leaking the key', async t => {
  const f = fixture(t); const said = [];
  const args = ['gemini-check', '--project', f.project, '--home', f.home];
  const ok = await run(args, { print: s => said.push(s), engine: engine({ ...memory([{ key: 'answers', category: 'preference', text: 'Prefers short answers.', date: '2026-11-04', evidence: 'I prefer short answers.', rank: 1, status: 'none' }]), persona_line: '记住啦～' }) });
  assert.equal(ok.ok, true); assert.equal(ok.items, 1); assert.equal(ok.personaLine, '记住啦～');
  const { GeminiError } = await import('../vendor/core.js');
  const bad = await run(args, { print: s => said.push(s), engine: { complete: async () => { throw new GeminiError('busy', 'model overloaded key=AIzaSyFAKEFAKEFAKEFAKEFAKE1234', 503); } } });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'gemini_busy'); assert.equal(bad.httpStatus, 503);
  assert.ok(!bad.message.includes('AIzaSyFAKE')); assert.ok(said[0].includes('sending a tiny test request'));
});
test('a failed save records retry waits and the HTTP status, never server text', async t => {
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  const { GeminiError } = await import('../vendor/core.js');
  // Stub engine that reports two waits through the real onWait path is not reachable here,
  // so check the shape recordError writes for an HTTP failure.
  await assert.rejects(drain(f.ctx, { engine: { complete: async () => { throw new GeminiError('ratelimit', 'secret server words', 429); } }, env: {} }));
  const err = status(f.ctx).lastError;
  assert.equal(err.code, 'gemini_ratelimit'); assert.equal(err.httpStatus, 429);
  assert.ok(!JSON.stringify(err).includes('secret server words'));
});

// Record shapes seen in a real Claude Code 2.1.314 transcript (made-up text).
const real = (o) => JSON.stringify(o) + '\n';
const realSegment = () => [
  real({ type: 'ai-title', aiTitle: '用户偏好设置', sessionId: 's' }),
  real({ type: 'mode', mode: 'default', sessionId: 's' }),
  real({ type: 'permission-mode', permissionMode: 'default', sessionId: 's' }),
  real({ type: 'attachment', attachment: { type: 'hook_additional_context', content: 'AI Memory Keeper injected text must not be re-saved' }, sessionId: 's' }),
  real({ type: 'api-request', sessionId: 's', id: 'r1', params: { system: 'huge request log' } }),
  real({ type: 'api-request-blob', sessionId: 's', hash: 'h' }),
  real({ type: 'file-history-delta', messageId: 'm', trackingPath: 'x' }),
  real({ type: 'atis-latch', atis: 1, sessionId: 's' }),
  real({ type: 'tools-used', tools: [], sessionId: 's' }),
  real({ type: 'user', timestamp: '2026-11-04T23:49:00Z', origin: { kind: 'human' }, message: { role: 'user', content: '记住两件事：我喜欢简短的回答；数据库用 Postgres。只回复 OK。' } }),
  real({ type: 'assistant', timestamp: '2026-11-04T23:49:05Z', requestedModel: 'claude-sonnet-4-5', message: { id: 'msg_011CginPiqAAAAAAAAAAAAAA', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } } }),
].join('');
test('real Claude Code 2.1.314 transcript: new metadata record types are skipped, conversation kept', async () => {
  const { transcriptText } = await import('../src/memory.mjs');
  const text = transcriptText(realSegment(), 'jsonl');
  assert.ok(text.includes('数据库用 Postgres') && text.includes('assistant: OK'));
  assert.ok(!text.includes('must not be re-saved') && !text.includes('huge request log') && !text.includes('用户偏好设置'));
  // A file with no record type we recognise at all still stays queued.
  assert.throws(() => transcriptText('{"new_format":"real words"}\n', 'jsonl'), /unsupported_transcript_record/);
});
test('model check: requestedModel vs the model that answered (real relay case: asked 4-5, got 4-6)', () => {
  const r = assess([job(realSegment())]);
  assert.equal(r.expectedFrom, 'transcript'); assert.equal(r.level, 'notice');
  assert.deepEqual(r.signals.find(s => s.code === 'model_version_mismatch'), { code: 'model_version_mismatch', strength: 'weak', from: 'claude-sonnet-4-5', to: 'claude-sonnet-4-6' });
  const msg = userMessage({ agent: 'claude', lang: 'zh', gaps: 1, check: r });
  assert.ok(msg.includes('🔎 对面：claude-sonnet-4-6 · 小疑点：你要的是 claude-sonnet-4-5，回复来自 claude-sonnet-4-6（同一家，版本不同）'));
  const down = claude({ model: 'claude-haiku-4-5' }).replace('"type":"assistant"', '"type":"assistant","requestedModel":"claude-opus-4-1"');
  const r2 = assess([job(down)]);
  assert.equal(r2.level, 'suspect'); assert.equal(r2.signals.find(s => s.code === 'model_tier_mismatch').to, 'claude-haiku-4-5');
});
test('overlay data carries the transcript and the failed-compaction line', async t => {
  const { showOverlay } = await import('../src/overlay.mjs');
  const f = fixture(t);
  const fakeSpawn = () => { const c = { once: (e, fn) => { if (e === 'spawn') setImmediate(fn); return c; }, unref: () => {} }; return c; };
  await showOverlay(f.ctx, { phase: 'working', lines: { gemini: 'hi' }, transcript: 'C:\\t\\s.jsonl', platform: 'win32', spawnImpl: fakeSpawn, env: {} });
  const data = JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'overlay.json'), 'utf8'));
  assert.equal(data.transcript, 'C:\\t\\s.jsonl'); assert.ok(data.failSay.includes('没完成'));
  await showOverlay(f.ctx, { lines: { gemini: 'done' }, platform: 'win32', spawnImpl: fakeSpawn, env: {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.ctx.dir, 'overlay.json'), 'utf8')).transcript, 'C:\\t\\s.jsonl');
});

test('a busy or out-of-quota default model falls back once to the other free model, and the switch is recorded', async t => {
  const { GeminiError } = await import('../vendor/core.js');
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  const models = [];
  const flaky = { complete: async body => {
    models.push(body.model);
    if (body.model === 'gemini-3.8-flash') throw new GeminiError('busy', 'overloaded', 503);
    return memory();
  } };
  await drain(f.ctx, { engine: flaky, env: {} });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.6-flash']);
  assert.equal(read(path.join(f.ctx.dir, 'memory.json')).savedWith, 'gemini-3.6-flash');
  assert.equal(status(f.ctx).lastSave !== null, true);
  // Both busy: the error is kept, with the switch noted.
  fs.appendFileSync(f.transcript, record('Use Node.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  await assert.rejects(drain(f.ctx, { engine: { complete: async () => { throw new GeminiError('busy', 'overloaded', 503); } }, env: {} }));
  const err = status(f.ctx).lastError;
  assert.equal(err.code, 'gemini_busy'); assert.deepEqual(err.retries.map(r => r.why), ['switch_model']);
  // A daily-quota 429 on the default model also switches.
  fs.appendFileSync(f.transcript, record('Use tabs.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  const quota = []; await drain(f.ctx, { env: {}, engine: { complete: async body => {
    quota.push(body.model); if (body.model === 'gemini-3.8-flash') throw new GeminiError('ratelimit', 'daily quota exceeded', 429); return memory();
  } } });
  assert.ok(quota.includes('gemini-3.6-flash'));
});
test('the worker command keeps the retry and model-switch record instead of overwriting it', async t => {
  // Real case (11-05): both free models answered 429, but error.json ended up without its retries.
  const { GeminiError } = await import('../vendor/core.js');
  const f = fixture(t); fs.writeFileSync(f.transcript, record('I prefer short answers.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  const limited = { complete: async () => { throw new GeminiError('ratelimit', 'secret server words', 429); } };
  await assert.rejects(run(['worker', '--project', f.project, '--home', f.home], { engine: limited, env: {} }));
  const err = status(f.ctx).lastError;
  assert.equal(err.code, 'gemini_ratelimit'); assert.equal(err.httpStatus, 429);
  assert.deepEqual(err.retries.map(r => r.why), ['switch_model']);
  assert.ok(!JSON.stringify(err).includes('secret server words'));
  assert.equal(status(f.ctx).queued, 1);
});

test('each queued segment gets its own time limit, so a backlog drains instead of timing out together', async t => {
  const f = fixture(t);
  for (const words of ['I prefer short answers.', 'Use Node.', 'Use tabs.']) {
    fs.appendFileSync(f.transcript, record(words));
    await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  }
  assert.equal(status(f.ctx).queued, 3);
  // Each call takes 100 ms against a 250 ms per-segment limit: 300 ms in total, which a shared
  // 250 ms budget would not allow. (Wide margins: a busy machine adds tens of ms per call.)
  const slow = { complete: async () => { await new Promise(r => setTimeout(r, 100)); return memory(); } };
  const out = await drain(f.ctx, { engine: slow, timeoutMs: 250, env: {} });
  assert.equal(out.processed, 3); assert.equal(status(f.ctx).queued, 0);
  // The whole run still has a cap.
  fs.appendFileSync(f.transcript, record('Use spaces.'));
  await run(['save', '--transcript', f.transcript, '--background', '--project', f.project, '--home', f.home], { startWorker: async () => {} });
  await assert.rejects(drain(f.ctx, { engine: slow, timeoutMs: 250, maxRunMs: 1, env: {} }), /timeout/);
});

// Frames: a tiny 4x4 picture is enough to test the checks.
async function framesKit(t) {
  const { encodePng } = await import('../tools/check-frames.mjs');
  const f = fixture(t);
  const assets = path.join(f.dir, 'assets'); fs.mkdirSync(assets);
  const png = (change = []) => {
    const rgba = Buffer.alloc(4 * 4 * 4, 200);
    for (const [x, y] of change) rgba[(y * 4 + x) * 4] = 0;
    return encodePng({ width: 4, height: 4, rgba });
  };
  return { f, assets, png };
}
test('frame check: decode round trip, a change inside the box passes, a change on its edge fails', async t => {
  const { decodePng, compareFrames, patchOk } = await import('../tools/check-frames.mjs');
  const { png } = await framesKit(t);
  const base = decodePng(png()), same = decodePng(png());
  assert.equal(base.width, 4); assert.equal(base.rgba[0], 200);
  assert.equal(compareFrames(base, same).differ, 0);
  const inner = compareFrames(base, decodePng(png([[1, 1]])), { box: [0, 0, 3, 3] });
  assert.equal(inner.inside, 1); assert.equal(inner.bbox.join(), '1,1,1,1');
  // A box whose edge changes would show a seam once only the box is copied.
  const wide = await import('../tools/check-frames.mjs');
  const big = { width: 12, height: 12, rgba: Buffer.alloc(12 * 12 * 4, 200) };
  const moved = { width: 12, height: 12, rgba: Buffer.from(big.rgba) };
  moved.rgba[(5 * 12 + 5) * 4] = 0;
  assert.ok(patchOk(wide.compareFrames(big, moved, { box: [2, 2, 9, 9] })));
  moved.rgba[(2 * 12 + 4) * 4] = 0; moved.rgba[(3 * 12 + 4) * 4] = 0; moved.rgba[(9 * 12 + 4) * 4] = 0; moved.rgba[(8 * 12 + 6) * 4] = 0; moved.rgba[(4 * 12 + 2) * 4] = 0;
  assert.equal(patchOk(wide.compareFrames(big, moved, { box: [2, 2, 9, 9] })), false);
  assert.equal(patchOk(wide.compareFrames(big, big, { box: [2, 2, 9, 9] })), false); // nothing to show
});
test('overlay frames: a blink or talk frame is used only while its checked hashes match', async t => {
  const { overlayFrames } = await import('../src/overlay.mjs');
  const { sha256 } = await import('../tools/check-frames.mjs');
  const { assets, png } = await framesKit(t);
  const put = (name, buf) => fs.writeFileSync(path.join(assets, name), buf);
  put('gemini-overlay-closed-mouth.png', png()); put('gemini-overlay-talk.png', png([[2, 2]]));
  put('gemini-overlay-working.png', png([[0, 0]]));
  const at = n => path.join(assets, n);
  const checked = { talk: { file: 'gemini-overlay-talk.png', base: 'gemini-overlay-closed-mouth.png', box: [1, 1, 3, 3], sha256: sha256(at('gemini-overlay-talk.png')), baseSha256: sha256(at('gemini-overlay-closed-mouth.png')) } };
  put('frames.json', JSON.stringify(checked));
  let fr = overlayFrames(assets);
  assert.equal(fr.base, at('gemini-overlay-closed-mouth.png')); assert.equal(fr.working, at('gemini-overlay-working.png'));
  assert.equal(fr.talk, at('gemini-overlay-talk.png')); assert.equal(fr.talkBox, '1,1,3,3');
  assert.equal(fr.blink, undefined); assert.equal(fr.alert, undefined);
  // A replaced talk frame is ignored until it is checked again.
  put('gemini-overlay-talk.png', png([[3, 3]]));
  fr = overlayFrames(assets); assert.equal(fr.talk, undefined);
  // So is one checked against another base, or with a bad box or a path in its name.
  put('gemini-overlay-talk.png', png([[2, 2]]));
  for (const bad of [{ base: 'gemini-overlay.png' }, { box: [1, 1, 3] }, { box: [-1, 1, 3, 3] }, { file: '../gemini-overlay-talk.png' }]) {
    put('frames.json', JSON.stringify({ talk: { ...checked.talk, ...bad } }));
    assert.equal(overlayFrames(assets).talk, undefined, JSON.stringify(bad));
  }
  // No new base: the first picture, and nothing lines up with it.
  fs.unlinkSync(at('gemini-overlay-closed-mouth.png'));
  fr = overlayFrames(assets); assert.equal(fr.base, at('gemini-overlay.png')); assert.equal(fr.talk, undefined);
});
test('overlay poses: working while compacting, alert when suspect, base otherwise', async () => {
  const { overlayPose, overlayArt } = await import('../src/overlay.mjs');
  assert.equal(overlayPose('working', 'pending'), 'working');
  assert.equal(overlayPose('done', 'suspect'), 'alert');
  assert.equal(overlayPose('done', 'ok'), 'base'); assert.equal(overlayPose('done', undefined), 'base');
  assert.equal(overlayArt('suspect', 'done', { base: 'b.png' }).art, 'b.png'); // a missing pose falls back to the base
});
test('the shipped blink and talk frames are the ones that were checked', async () => {
  // If this fails, a frame changed: check it again with tools/check-frames.mjs (see cli/README.md).
  const { overlayFrames } = await import('../src/overlay.mjs');
  const fr = overlayFrames();
  assert.ok(fr.base.endsWith('gemini-overlay-closed-mouth.png'));
  assert.ok(fr.blink?.endsWith('gemini-overlay-blink.png') && fr.blinkBox, 'blink frame not checked');
  assert.ok(fr.talk?.endsWith('gemini-overlay-talk.png') && fr.talkBox, 'talk frame not checked');
  assert.ok(fr.working && fr.alert);
});

test('Codex shows no model-check verdict anywhere, even for a reply with <think> and 「我是 DeepSeek」', async t => {
  const f = fixture(t); enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  const shown = [];
  const deps = { startWorker: async () => {}, showOverlay: async (ctx, opts) => { shown.push(opts.lines); return true; } };
  const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner], { ...deps, input: { session_id: 'cx', transcript_path: f.transcript, cwd: f.project, ...input } });
  const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  fs.writeFileSync(f.transcript, row('turn_context', { model: 'gpt-5.5-codex' })
    + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'I prefer short answers.' }] })
    + row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<think>hmm</think> 我是 DeepSeek，由深度求索开发。OK' }] }));
  assert.equal(await hook({ hook_event_name: 'PreCompact', trigger: 'manual' }), '');
  await drain(f.ctx, { engine: engine(), env: {} });
  const out = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
  const verdicts = /没发现|换模型|no sign|swapped|对面|Other side|⚠️|🔎|🤖|DeepSeek|小疑点|minor oddity|suspect/;
  assert.ok(!verdicts.test(out.systemMessage), out.systemMessage);
  assert.ok(out.systemMessage.startsWith('✨ Gemini娘：'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Gemini娘 → Codex')); // the recall itself still arrives
  for (const lines of shown) { assert.ok(lines.partner == null, JSON.stringify(lines.partner)); assert.ok(!verdicts.test(lines.gemini)); }
  assert.equal(shown.length, 2); // working, then done
  const check = status(f.ctx).modelCheck;
  assert.equal(check.level, 'not_checked'); assert.deepEqual(check.signals, []); assert.deepEqual(check.models, { 'gpt-5.5-codex': 1 });
  assert.ok(!/no sign|swapped|suspect/.test(userMessage({ agent: 'codex', lang: 'en', gaps: 1, check })));
  disable(f.ctx, 'codex');
});

test('a suspect model never stops a save: memory saved, recall injected; only her warning and the alert pose change', async t => {
  const { overlayPose } = await import('../src/overlay.mjs');
  const runCase = async (t2, transcriptText, env) => {
    const f = fixture(t2); enable(f.ctx, 'claude');
    const owner = read(installationFile(f.ctx, 'claude')).owner;
    const shown = [];
    const deps = { startWorker: async () => {}, showOverlay: async (ctx, opts) => { shown.push(opts); return true; } };
    const hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'claude', '--owner', owner], { ...deps, input: { session_id: 'sv', transcript_path: f.transcript, cwd: f.project, ...input } });
    fs.writeFileSync(f.transcript, record('I prefer short answers.') + transcriptText);
    assert.equal(await hook({ hook_event_name: 'PreCompact', trigger: 'auto' }), ''); // compaction is never blocked
    await drain(f.ctx, { engine: engine(), env });
    const out = await hook({ hook_event_name: 'SessionStart', source: 'compact' });
    const saved = read(path.join(f.ctx.dir, 'memory.json'));
    const result = { out, saved, done: shown.at(-1), check: status(f.ctx).modelCheck, lastError: status(f.ctx).lastError };
    disable(f.ctx, 'claude');
    return result;
  };
  const clean = await runCase(t, many(3));
  // Asked for Opus, Haiku answered, through a relay host, and a reply calls itself DeepSeek.
  const swapped = claude({ model: 'claude-haiku-4-5', text: '我是 DeepSeek，很高兴帮你。' }).replace('"type":"assistant"', '"type":"assistant","requestedModel":"claude-opus-4-1"');
  const bad = await runCase(t, swapped + swapped, { ANTHROPIC_BASE_URL: 'https://relay.example.com/v1/sk-not-a-key' });
  assert.equal(clean.check.level, 'ok'); assert.equal(bad.check.level, 'suspect');
  // Saving and recall are exactly the same.
  assert.equal(bad.lastError, null); assert.equal(clean.lastError, null);
  assert.deepEqual(bad.saved.memory.items.map(i => i.text), clean.saved.memory.items.map(i => i.text));
  assert.equal(bad.saved.memory.items.length, 1);
  assert.equal(bad.out.hookSpecificOutput.additionalContext, clean.out.hookSpecificOutput.additionalContext);
  // Only her warning and the overlay pose differ.
  assert.ok(bad.out.systemMessage.includes('⚠️') && bad.out.systemMessage.includes('这不能百分百证明换了模型'));
  assert.ok(clean.out.systemMessage.includes('🤖') && !clean.out.systemMessage.includes('⚠️'));
  assert.equal(bad.out.systemMessage.split('\n')[0], clean.out.systemMessage.split('\n')[0]);
  assert.equal(overlayPose(bad.done.phase ?? 'done', bad.done.lines.partner.level), 'alert');
  assert.equal(overlayPose(clean.done.phase ?? 'done', clean.done.lines.partner.level), 'base');
});
