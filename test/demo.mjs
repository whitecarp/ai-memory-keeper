process.env.AMK_NO_OUTSIDE = '1'; // keep the demo's worker in its offline environment
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fixture, cleanup, record } from './helpers.mjs';
import { cliPath, installationFile } from '../src/hooks.mjs';
import { read } from '../src/safety.mjs';

export async function demo(agent = 'claude') {
  const f = fixture();
  const preloader = new URL('./offline-preload.mjs', import.meta.url).href;
  const counter = path.join(f.dir, 'network-counter.txt');
  const fakeHome = path.join(f.dir, 'fake-home');
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: path.join(fakeHome, 'claude'), CODEX_HOME: path.join(fakeHome, 'codex'), GEMINI_API_KEY: 'unit-test-only', AMK_OFFLINE_TEST: '1', AMK_OFFLINE_COUNTER: counter, NODE_OPTIONS: `--import ${JSON.stringify(preloader)}` };
  const invoke = (command, extra = [], input) => {
    const r = spawnSync(process.execPath, [cliPath, command, '--project', f.project, '--home', f.home, ...extra], { cwd: f.project, env, input, encoding: 'utf8', windowsHide: true, timeout: 8000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
  };
  let config;
  try {
    config = JSON.parse(invoke('enable', ['--agent', agent])).config;
    const state = read(installationFile(f.ctx, agent));
    const handler = state.entries[0].group.hooks[0];
    fs.writeFileSync(f.transcript, record('Remember: use short answers. password=supersecret sk-demoSecret123456789'));
    const common = { session_id: 'abc123', transcript_path: f.transcript, cwd: f.project };
    const pre = { ...common, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null };
    const started = performance.now();
    // Execute precisely the command configured for the target agent.
    const opts = { cwd: f.project, env, input: JSON.stringify(pre), encoding: 'utf8', windowsHide: true, timeout: 8000 };
    const child = agent === 'claude' ? spawnSync(handler.command, handler.args, opts) : spawnSync(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', handler.commandWindows] : ['-c', handler.command], opts);
    const hookMs = performance.now() - started;
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
    const hookArgs = ['--agent', agent, '--owner', state.owner];
    const premature = invoke('hook', hookArgs, JSON.stringify({ ...common, hook_event_name: 'SessionStart', source: 'compact' }));
    if (premature) {
      const early = JSON.parse(premature);
      // Before the first save finishes, the agent only gets Gemini娘's user-visible line.
      if (early.hookSpecificOutput) assert.equal(early.hookSpecificOutput.hookEventName, 'SessionStart');
      else assert.ok(early.systemMessage.includes('Gemini'));
    }
    const deadline = Date.now() + 10000;
    let s;
    do {
      await new Promise(resolve => setTimeout(resolve, 80));
      s = JSON.parse(invoke('status'));
      if (s.lastError?.code) throw new Error(s.lastError.code);
    } while ((!s.lastSave || s.workerLock) && Date.now() < deadline);
    assert.ok(s.lastSave); assert.equal(s.queued, 0); assert.equal(s.workerLock, false);
    if (agent === 'claude') invoke('hook', hookArgs, JSON.stringify({ ...common, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'The summary covers other work.' }));
    else fs.appendFileSync(f.transcript, JSON.stringify({ type: 'compacted', payload: { message: 'The summary covers other work.' } }) + '\n');
    const after = JSON.parse(invoke('hook', hookArgs, JSON.stringify({ ...common, hook_event_name: 'SessionStart', source: 'compact' })));
    assert.ok(after.hookSpecificOutput.additionalContext.includes('Remember: use short answers.'));
    assert.ok(!after.hookSpecificOutput.additionalContext.includes('supersecret'));
    assert.ok(after.systemMessage.includes('Gemini'));
    invoke('hook', hookArgs, JSON.stringify(pre));
    await new Promise(resolve => setTimeout(resolve, 250));
    const count = fs.readFileSync(counter, 'utf8').trim().split('\n').length;
    assert.equal(count, 1);
    invoke('disable', ['--agent', agent]); assert.ok(!fs.existsSync(config));
    return { agent, hookMs: Math.round(hookMs), outboundStubRequests: count, saved: true, gapRecalled: true, rawJobsRemoved: fs.readdirSync(path.join(f.ctx.dir, 'jobs')).length === 0, hookConfigRemoved: true, realAgentRun: false, realNetworkCalls: 0 };
  } finally {
    if (config && fs.existsSync(config)) invoke('disable', ['--agent', agent]);
    const deadline = Date.now() + 5000;
    while (fs.existsSync(path.join(f.ctx.dir, 'worker.lock')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    cleanup(f.dir);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [];
  for (const agent of ['claude', 'codex']) results.push(await demo(agent));
  process.stdout.write(JSON.stringify({ offlineDemo: results }, null, 2) + '\n');
}
