import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, installationFile } from '../src/hooks.mjs';
import { drain, enqueue } from '../src/store.mjs';
import { hash, read } from '../src/safety.mjs';
import { transcriptText } from '../src/memory.mjs';
import { fixture, engine, item, memory } from './helpers.mjs';

const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
function installed(t) {
  const f = fixture(t);
  enable(f.ctx, 'codex');
  const owner = read(installationFile(f.ctx, 'codex')).owner;
  f.args = ['hook', '--project', f.project, '--home', f.home, '--agent', 'codex', '--owner', owner];
  f.input = { cwd: f.project, session_id: 'codex-contract', transcript_path: f.transcript, model: 'gpt-6.1-sol' };
  return f;
}

test('Codex contract: four events under hooks with documented command fields and matchers', t => {
  const f = installed(t);
  const config = read(path.join(f.project, '.codex', 'hooks.json'));
  assert.deepEqual(Object.keys(config), ['hooks']);
  assert.deepEqual(Object.keys(config.hooks), ['PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit']);
  for (const [event, groups] of Object.entries(config.hooks)) {
    const group = groups[0], handler = group.hooks[0];
    // UserPromptSubmit takes no matcher (OpenAI's hooks page: matcher isn't used for it).
    assert.equal(group.matcher, event === 'UserPromptSubmit' ? undefined : event === 'SessionStart' ? '^compact$' : 'manual|auto');
    if (event === 'UserPromptSubmit') assert.deepEqual(Object.keys(group), ['hooks']);
    const fields = ['command', 'commandWindows', 'statusMessage', 'timeout', 'type'];
    if (event === 'SessionStart' || event === 'UserPromptSubmit') fields.push('additionalContextLimit');
    assert.deepEqual(Object.keys(handler).sort(), fields.sort());
    assert.equal(handler.type, 'command'); assert.equal(handler.timeout, 5);
    const script = Buffer.from(handler.commandWindows.split(' ').at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes('--project') && script.includes('--home') && script.includes('--owner'));
    assert.ok(!script.includes('GEMINI_API_KEY') && !script.includes('bypass-hook-trust'));
  }
});

test('Codex PostCompact uses rollout summary instead of a non-contract compact_summary field', async t => {
  const f = installed(t);
  fs.writeFileSync(f.transcript, row('compacted', { message: 'Earlier summary' }) + row('compacted', { message: 'Database: Postgres.' }));
  const out = await run(f.args, { input: { ...f.input, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'Must not use this field for Codex.' } });
  assert.equal(out, '');
  assert.equal(read(path.join(f.ctx.dir, 'summaries', hash(f.input.session_id) + '.json')).text, 'Database: Postgres.');
});

test('Codex PostCompact with no summary does not fabricate one', async t => {
  const f = installed(t);
  fs.writeFileSync(f.transcript, row('event_msg', { type: 'task_started' }));
  assert.equal(await run(f.args, { input: { ...f.input, hook_event_name: 'PostCompact', trigger: 'auto' } }), '');
  assert.ok(!fs.existsSync(path.join(f.ctx.dir, 'summaries')));
});

test('Codex PostCompact: a missing rollout records a safe error; a big one is read from its end', async t => {
  const f = installed(t);
  assert.equal(await run(f.args, { input: { ...f.input, transcript_path: null, hook_event_name: 'PostCompact', trigger: 'manual' } }), '');
  assert.equal(read(path.join(f.ctx.dir, 'error.json')).code, 'transcript_unavailable');
  // 40 MiB of older history (zeros: never read), then the newest summary at the end.
  const fd = fs.openSync(f.transcript, 'w'); fs.ftruncateSync(fd, 40 * 1024 * 1024); fs.closeSync(fd);
  fs.appendFileSync(f.transcript, '\n' + row('compacted', { message: 'Database: Postgres.' }));
  assert.equal(await run(f.args, { input: { ...f.input, hook_event_name: 'PostCompact', trigger: 'manual' } }), '');
  assert.equal(read(path.join(f.ctx.dir, 'summaries', hash(f.input.session_id) + '.json')).text, 'Database: Postgres.');
});

test('Codex replay: rollout dialogue, summary gap and SessionStart JSON output contract', async t => {
  const f = installed(t);
  const text = 'I prefer short answers.';
  const raw = row('session_meta', { id: f.input.session_id, cwd: f.project })
    + row('turn_context', { model: f.input.model })
    + row('event_msg', { type: 'user_message', message: text })
    + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
    + row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] })
    + row('response_item', { type: 'function_call_output', output: 'Do not include tool output.' });
  const parsed = transcriptText(raw, 'jsonl');
  assert.equal(parsed.split(text).length - 1, 1); assert.ok(parsed.includes('OK'));
  assert.ok(!parsed.includes('tool output'));
  fs.writeFileSync(f.transcript, raw);
  enqueue(f.ctx, f.transcript, f.input.session_id);
  await drain(f.ctx, { engine: engine(memory([item(text)])), env: {} });
  fs.appendFileSync(f.transcript, row('compacted', { message: 'Database: Postgres.' }));
  await run(f.args, { input: { ...f.input, hook_event_name: 'PostCompact', trigger: 'manual' } });
  const out = await run(f.args, { input: { ...f.input, hook_event_name: 'SessionStart', source: 'compact' } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(text));
  assert.deepEqual(read(path.join(f.ctx.dir, 'audit.json')).jobs[0].scan.models, { 'gpt-6.1-sol': 1 });
});
