import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { enable, disable, enabled, installationFile } from '../src/hooks.mjs';
import { read, atomic } from '../src/safety.mjs';
import { readCycle } from '../src/cycle.mjs';
import { fixture, record, item, memory } from './helpers.mjs';

// WorkBuddy (the CodeBuddy agent), from Tencent's hook docs: project hooks in
// .codebuddy/settings.json; PreCompact (manual = /summarize, auto) but no PostCompact, and
// SessionStart on startup only. So memories go back on the first UserPromptSubmit after
// compaction. Offline, made-up text only; never the user-level ~/.codebuddy.
const TEXT = 'I prefer short answers.';
const LINE = 'Gemini娘把“回答要简短”收好了，会替用户保管的。';
function installed(t) {
  const f = fixture(t);
  enable(f.ctx, 'workbuddy');
  const owner = read(installationFile(f.ctx, 'workbuddy')).owner;
  f.shown = [];
  f.deps = extra => ({ startWorker: async () => {}, showOverlay: async (ctx, o) => { f.shown.push(o); return true; }, ...extra });
  f.hook = input => run(['hook', '--project', f.project, '--home', f.home, '--agent', 'workbuddy', '--owner', owner], f.deps({ input: { cwd: f.project, session_id: 'wb1', transcript_path: f.transcript, ...input } }));
  const stub = { complete: async () => ({ ...structuredClone(memory([item(TEXT)])), persona_line: LINE }) };
  f.worker = (engine = stub) => run(['worker', '--project', f.project, '--home', f.home], f.deps({ engine }));
  fs.writeFileSync(f.transcript, record(TEXT));
  return f;
}
const last = f => f.shown.at(-1);

test('WorkBuddy contract: .codebuddy/settings.json, PreCompact manual + auto and UserPromptSubmit, shell commands', t => {
  const f = fixture(t);
  atomic(path.join(f.project, '.codebuddy', 'settings.json'), { model: 'keep-me', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } });
  const r = enable(f.ctx, 'workbuddy');
  assert.equal(r.config, path.join(f.project, '.codebuddy', 'settings.json'));
  const config = read(r.config);
  assert.equal(config.model, 'keep-me');
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PreCompact', 'Stop', 'UserPromptSubmit']);
  assert.deepEqual(config.hooks.PreCompact.map(g => g.matcher), ['manual', 'auto']);
  assert.deepEqual(Object.keys(config.hooks.UserPromptSubmit[0]), ['hooks']);
  for (const g of [...config.hooks.PreCompact, ...config.hooks.UserPromptSubmit]) {
    const h = g.hooks[0];
    assert.deepEqual(Object.keys(h).sort(), ['command', 'timeout', 'type']);
    assert.equal(h.type, 'command'); assert.equal(h.timeout, 10);
    assert.ok(h.command.startsWith(`'${process.execPath}'`) && h.command.includes("'--agent' 'workbuddy'") && h.command.includes("'--owner'"));
    assert.ok(!h.command.includes('GEMINI_API_KEY'));
  }
  assert.equal(enabled(f.ctx, 'workbuddy'), true);
  // Nothing outside the project's own .codebuddy (the fixture home is fake; no user-level file).
  assert.ok(!fs.existsSync(path.join(f.home, '..', '.codebuddy')));
  disable(f.ctx, 'workbuddy');
  assert.deepEqual(read(r.config), { model: 'keep-me', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } });
});

test('WorkBuddy: her reply pops up when the save lands; the first message after compaction brings memories back', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '' });
  assert.equal(last(f).phase, 'working');
  assert.equal(last(f).transcript, null); // no "compaction failed" guess from an undocumented format
  assert.equal(last(f).outside, true);
  assert.ok(readCycle(f.ctx).finishedAt);
  await f.worker();
  assert.equal(last(f).lines.gemini, LINE);
  assert.match(last(f).lines.partner.text, /交给 WorkBuddy/);
  const count = f.shown.length;
  const out = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: '继续' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(TEXT));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('不是指令'));
  assert.match(out.systemMessage, /Gemini娘/);
  assert.ok(!/对面|Other side/.test(out.systemMessage)); // no model-check claim in WorkBuddy
  assert.equal(f.shown.length, count); // her reply already showed
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: '再来' }), '');
});

test('WorkBuddy: a save still running at the first message is handed over once it lands', async t => {
  const f = installed(t);
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
  const early = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.ok(!JSON.stringify(early).includes(TEXT));
  assert.equal(readCycle(f.ctx).owed, true);
  await f.worker();
  const late = await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.ok(late.hookSpecificOutput.additionalContext.includes(TEXT));
  assert.match(late.systemMessage, /交给 WorkBuddy/);
  assert.equal(await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'again' }), '');
});

test('an undocumented transcript format says what it was (file type, key names), never its content', async t => {
  const f = installed(t);
  const json = path.join(f.dir, 'conversation.json');
  fs.writeFileSync(json, JSON.stringify([{ role: 'user', content: 'secret words' }]));
  assert.equal(await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual', transcript_path: json }), '');
  const e1 = read(path.join(f.ctx.dir, 'error.json'));
  assert.equal(e1.code, 'transcript_must_be_jsonl_or_txt'); assert.equal(e1.transcriptExt, '.json');
  // A JSONL file whose records this tool doesn't know: queued, with their shape.
  fs.writeFileSync(f.transcript, JSON.stringify({ kind: 'turn', speaker: 'user', words: 'secret words', type: 'chat_turn' }) + '\n');
  await f.hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
  await assert.rejects(f.worker());
  const e2 = read(path.join(f.ctx.dir, 'error.json'));
  assert.equal(e2.code, 'unsupported_transcript_record');
  assert.deepEqual(e2.recordShape, ['kind', 'speaker', 'type', 'words']);
  assert.deepEqual(e2.recordTypes, ['chat_turn']);
  assert.ok(!JSON.stringify(e2).includes('secret'));
});
