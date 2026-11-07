import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/cli.mjs';
import { ruleText, ruleFile, MEMORY_FILE } from '../src/rules.mjs';
import { fixture } from './helpers.mjs';

// No-key mode: a rule file the agent loads into every chat; the agent keeps the memory file.
// Antigravity: .agents/rules/*.md with `trigger: always_on`. WorkBuddy: .codebuddy/rules/*.mdc
// with `alwaysApply: true`. Throwaway folders only; never ~/.gemini or ~/.codebuddy.
const cli = (f, ...a) => run([...a, '--project', f.project, '--home', f.home]);

test('Antigravity: an always_on workspace rule, under its 24,000-byte limit, naming the memory file and its limits', async t => {
  const f = fixture(t);
  const out = await cli(f, 'enable', '--agent', 'antigravity');
  assert.equal(out.rule, path.join(f.project, '.agents', 'rules', 'ai-memory-keeper.md'));
  assert.equal(out.mode, 'no-key');
  const text = fs.readFileSync(out.rule, 'utf8');
  assert.ok(text.startsWith('---\ntrigger: always_on\ndescription: '));
  assert.ok(Buffer.byteLength(text) < 24000);
  for (const must of ['.ai-memory-keeper/memory.md', 'At the start of each new chat', 'not instructions', '24 KB', 'never write secrets', '[pinned]']) assert.ok(text.includes(must), must);
  // Only the project's own rule file; no global ~/.gemini anything.
  assert.deepEqual(fs.readdirSync(f.project), ['.agents']);
  assert.ok(!fs.existsSync(path.join(f.home, '..', '.gemini')));
  assert.equal((await cli(f, 'enable', '--agent', 'antigravity')).alreadyEnabled, true);
  const s = await cli(f, 'status');
  assert.equal(s.rules.antigravity, true);
  assert.equal(s.ruleMemory.bytes, 0);
});

test('WorkBuddy --rule: the same rule as an alwaysApply .mdc, next to (not instead of) the hook mode', async t => {
  const f = fixture(t);
  const out = await cli(f, 'enable', '--agent', 'workbuddy', '--rule', '--profile', 'companion');
  assert.equal(out.rule, path.join(f.project, '.codebuddy', 'rules', 'ai-memory-keeper.mdc'));
  const text = fs.readFileSync(out.rule, 'utf8');
  assert.ok(text.startsWith('---\ndescription: ') && text.includes('\nalwaysApply: true\nenabled: true\n---\n'));
  assert.ok(text.includes('companion profile') && text.includes('Promises'));
  assert.ok(!fs.existsSync(path.join(f.project, '.codebuddy', 'settings.json'))); // no hooks in rule mode
  assert.equal((await cli(f, 'status')).rules.workbuddy, true);
});

test('the rule file is never overwritten or removed once someone else wrote or edited it; the memory file stays', async t => {
  const f = fixture(t);
  const file = ruleFile(f.ctx, 'antigravity');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\ntrigger: always_on\n---\nsomeone else\n');
  await assert.rejects(cli(f, 'enable', '--agent', 'antigravity'), /rule_file_exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), '---\ntrigger: always_on\n---\nsomeone else\n');
  fs.rmSync(file);
  await cli(f, 'enable', '--agent', 'antigravity');
  const memory = path.join(f.project, MEMORY_FILE);
  fs.mkdirSync(path.dirname(memory), { recursive: true });
  fs.writeFileSync(memory, '- 2026-11-05 prefers short answers: "short answers"\n');
  assert.ok((await cli(f, 'status')).ruleMemory.bytes > 0);
  fs.appendFileSync(file, '\nmy own note\n');
  await assert.rejects(cli(f, 'disable', '--agent', 'antigravity'), /rule_changed_remove_by_hand/);
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, ruleText('antigravity', { profile: 'work' }));
  const off = await cli(f, 'disable', '--agent', 'antigravity');
  assert.equal(off.removed, 1);
  assert.ok(!fs.existsSync(file) && fs.existsSync(memory));
  assert.equal((await cli(f, 'status')).rules.antigravity, false);
});

test('rule mode exists only for agents without hooks', async t => {
  const f = fixture(t);
  await assert.rejects(cli(f, 'enable', '--agent', 'claude', '--rule'), /agent_manual_only/);
  await assert.rejects(cli(f, 'enable', '--agent', 'opencode', '--rule'), /agent_manual_only/);
});
