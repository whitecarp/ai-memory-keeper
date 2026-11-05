#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context, enqueue, drain, recall, recallDetails, status, recordError, rememberSummary, tailSummary } from './store.mjs';
import { enable, disable, enabled, authorizeHook, cliPath } from './hooks.mjs';
import { fail, safeCode, noLinks, redact } from './safety.mjs';
import { extractMemory, geminiEngine } from './engine.mjs';
import { modelCheck } from './audit.mjs';
import { userMessage, userLines, workingLines, lateGreeting, lateMessage } from './persona.mjs';
import { overlayEnabled, overlaySupported, setOverlay, showOverlay } from './overlay.mjs';
import { keyStatus, resolveKey, resolveCloudKey, saveKey, clearKey, openKeyWindow, promptKey, keyCheckAnswer, setRoute, routeSetting } from './key.mjs';
import { doctor } from './doctor.mjs';
import { spawnOutside } from './outside.mjs';
import { beginCycle, cycleStatus } from './cycle.mjs';
import { compactionFinished, saveLanded, saveFailed, recalled, lateDue } from './reply.mjs';

export function parse(argv) {
  const [command = 'help', ...rest] = argv; const options = {};
  const flags = new Set(['background', 'clear', 'wait', 'terminal', 'cloud']);
  const values = new Set(['project', 'home', 'profile', 'name', 'agent', 'transcript', 'summary', 'model', 'lang', 'owner', 'set']);
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) fail('invalid_arguments');
    const key = rest[i].slice(2);
    if (options[key] !== undefined) fail('duplicate_argument');
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) options[key] = rest[++i];
    else fail('invalid_arguments');
  }
  if (options.lang && !['zh', 'en'].includes(options.lang)) fail('invalid_language');
  if (options.model && !/^gemini-[a-zA-Z0-9_.-]{1,80}$/.test(options.model)) fail('invalid_model');
  return { command, options };
}
export function startWorker(ctx, { outside = false } = {}) {
  const args = [cliPath, 'worker', '--home', ctx.home, '--project', ctx.project, '--profile', ctx.profile, '--model', ctx.model, '--lang', ctx.lang];
  if (ctx.name) args.push('--name', ctx.name);
  // Codex kills the hook's process tree when the hook returns: start it outside (outside.mjs).
  if (outside) return spawnOutside(process.execPath, args, { cwd: ctx.project });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ctx.project, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function hookInput() {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 512 * 1024) fail('hook_input_too_large'); }
  try { return JSON.parse(text); } catch { fail('invalid_hook_input'); }
}
const HELP = `AI Memory Keeper · amk (also: ai-memory-keeper), Node 22+
  doctor                          What's ready, and the skill file an agent should follow
  key                             Store your Gemini API key on this computer (Windows: a small window)
  key --terminal | --clear        Type it in this terminal instead (hidden), or remove it
  key --cloud                     The same for a Google Cloud Agent Platform key (Cloud billing)
  route --set auto|cloud          Which goes first: AI Studio (auto, default) or Agent Platform
  enable --agent claude|codex       Merge only this tool's project hooks
  disable --agent claude|codex      Remove exactly those hooks
  status                          Last save/recall/error, queued jobs, local model check
  save --transcript FILE           Save new .txt/.jsonl content using Gemini
  save --transcript FILE --background  Queue and return immediately
  recall [--summary FILE]          Local gap recall, no network
  worker                          Retry/drain existing queued snapshots
  gemini-check [--cloud]          One tiny made-up request; shows each step (needs a key)
  overlay --set on|off|preview|preview-alert  Desktop pop-up during compaction (Windows, on by default)
Options: --project DIR (default: this folder) --home KEEPER_DIR --profile work|companion
         --name LABEL --model gemini-3.8-flash --lang zh|en
The key: GEMINI_API_KEY if set, else the one stored by "amk key". Never in hooks, logs or arguments.
Free-tier Google services may use submitted data. Redaction is best-effort.
OpenCode/DeepSeek Harness: explicit save/recall only.
`;

export async function run(argv, dependencies = {}) {
  const { command, options } = parse(argv);
  if (command === 'help' || command === '--help') return HELP;
  const ctx = context(options);
  const start = dependencies.startWorker || startWorker;
  let hookEvent = null;
  try {
    if (command === 'enable') return enable(ctx, options.agent);
    if (command === 'disable') return disable(ctx, options.agent);
    if (command === 'status') return { ...status(ctx), lastCompaction: cycleStatus(ctx), key: keyStatus(ctx), overlay: { enabled: overlayEnabled(ctx), supported: overlaySupported() }, enabled: { claude: enabled(ctx, 'claude'), codex: enabled(ctx, 'codex') } };
    if (command === 'doctor') return doctor(ctx);
    if (command === 'route') {
      if (options.set) return setRoute(ctx, options.set);
      return { route: routeSetting(ctx) };
    }
    if (command === 'key') {
      const kind = options.cloud ? 'cloud' : 'studio';
      if (options.clear) return clearKey(ctx, process.platform, kind);
      if (process.platform === 'win32' && !options.terminal) return await (dependencies.openKeyWindow || openKeyWindow)(ctx, { wait: !!options.wait, kind });
      const typed = await (dependencies.promptKey || promptKey)(ctx.lang === 'en' ? 'Gemini API key (hidden): ' : 'Gemini API key（输入时不显示）：');
      return saveKey(ctx, typed, process.platform, kind);
    }
    if (command === 'overlay') {
      if (options.set === 'on' || options.set === 'off') return setOverlay(ctx, options.set === 'on');
      if (options.set === 'preview' || options.set === 'preview-alert') {
        // Plays a short compaction: "working" for a few seconds, then the result.
        const zh = ctx.lang !== 'en';
        const lines = options.set === 'preview' ? {
          gemini: zh ? '我是 Gemini娘。每次压缩完，我都会在这里出现，把记忆带回来～' : "I'm Gemini-chan. After every compaction I'll pop up here and bring your memories back.",
          partner: { level: 'ok', text: zh ? '这里会显示对面是哪个模型（预览）' : 'Which model answered will show here (preview)' },
        } : {
          gemini: zh ? '等一下！这段对话有点不对劲，记忆我先收好了。' : 'Wait! Something looks off. I kept your memories safe first.',
          partner: { level: 'suspect', text: zh ? '回复自称来自 glm-4.6，不是 Claude（预览）' : 'replies say they came from glm-4.6, not Claude (preview)' },
        };
        const show = dependencies.showOverlay || showOverlay;
        // No agent to follow: an agent's command runner exits at once and must not close her.
        const started = await show(ctx, { phase: 'working', lines: workingLines('claude', ctx.lang), lang: ctx.lang, agentPid: null, outside: true });
        await new Promise(resolve => setTimeout(resolve, dependencies.previewWorkingMs ?? 4000));
        return { previewed: started && await show(ctx, { lines, lang: ctx.lang, agentPid: null, outside: true }) };
      }
      fail('invalid_arguments');
    }
    if (command === 'worker') {
      // When the save lands (or stops) after a compaction, she answers in the pop-up.
      const show = dependencies.showOverlay || showOverlay;
      return await drain(ctx, { ...dependencies, onLanded: ({ line }) => saveLanded(ctx, { line, show }), onFailed: e => saveFailed(ctx, { code: safeCode(e), show }) });
    }
    if (command === 'key-check') {
      // Run by the key window right after it saves: the same tiny check, in plain words.
      // A key Google rejects is removed again, so `doctor` never reports a bad key as set.
      const result = await run(['gemini-check', ...argv.slice(1)], { ...dependencies, print: () => {}, checkTimeoutMs: dependencies.checkTimeoutMs ?? 20000 });
      const kind = options.cloud ? 'cloud' : 'studio';
      const answer = keyCheckAnswer(result, ctx.lang, kind);
      if (!answer.keep) clearKey(ctx, process.platform, kind);
      return { ok: answer.ok, kept: answer.keep, reason: answer.reason, code: result.code ?? null };
    }
    if (command === 'gemini-check') {
      // A tiny made-up chat through the same path as a real save, narrating each step,
      // so a failure says whether it was the key, the region, a busy/rate-limited model or time.
      // --cloud checks the Agent Platform key alone; otherwise the AI Studio key alone.
      const key = dependencies.engine ? null : options.cloud ? await resolveCloudKey(ctx) : await resolveKey(ctx);
      if (!key && !dependencies.engine) fail('missing_gemini_key');
      let via = null;
      const t0 = Date.now();
      const secs = () => +((Date.now() - t0) / 1000).toFixed(1);
      const say = dependencies.print || (s => process.stderr.write(s + '\n'));
      const onWait = (s, why) => say(`[${secs()}s] Gemini ${why === 'busy' ? 'is busy (503)' : 'rate limit (429)'}; waiting ${s}s, then retrying`);
      say(`[0s] sending a tiny test request to ${ctx.model}${options.cloud ? ' on Agent Platform' : ''} ...`);
      let personaLine = '';
      try {
        const memory = await extractMemory({
          text: '[2026-11-04] user: Remember: I prefer short answers. We decided to use Postgres.\n[2026-11-04] assistant: OK.',
          old: { wake_up_note: '', items: [] }, profile: 'work', date: new Date().toISOString().slice(0, 10), model: ctx.model, lang: ctx.lang,
          engine: dependencies.engine || geminiEngine(options.cloud ? { cloudKey: key, route: 'cloud', onWait, onVia: v => { via = v; } } : { key, onWait, onVia: v => { via = v; } }), timeoutMs: dependencies.checkTimeoutMs ?? 90000, onPersonaLine: l => { personaLine = l; },
        });
        return { ok: true, seconds: secs(), model: ctx.model, via, items: memory.items.length, personaLine: personaLine || null };
      } catch (e) {
        return { ok: false, seconds: secs(), model: ctx.model, code: safeCode(e), httpStatus: e?.httpStatus ?? null, message: redact(String(e?.message || '')).slice(0, 200) };
      }
    }
    if (command === 'save') {
      if (!options.transcript) fail('transcript_required');
      const captured = enqueue(ctx, path.resolve(options.transcript));
      if (options.background) { await start(ctx); return captured; }
      return { ...captured, ...await drain(ctx, dependencies) };
    }
    if (command === 'recall') {
      let summary = '';
      if (options.summary) {
        noLinks(options.summary);
        if (fs.statSync(options.summary).size > 1024 * 1024) fail('summary_too_large');
        summary = fs.readFileSync(options.summary, 'utf8');
      }
      return recall(ctx, { summary, transcript: options.transcript });
    }
    if (command === 'hook') {
      const input = dependencies.input || await hookInput();
      hookEvent = typeof input?.hook_event_name === 'string' ? input.hook_event_name : null;
      authorizeHook(ctx, options.agent, options.owner, input);
      const show = dependencies.showOverlay || showOverlay;
      if (input.hook_event_name === 'PreCompact') {
        if (!input.transcript_path) fail('transcript_unavailable');
        const captured = enqueue(ctx, input.transcript_path, input.session_id);
        const cycle = beginCycle(ctx, { session: input.session_id, agent: options.agent });
        await start(ctx, { outside: options.agent === 'codex' });
        // Gemini娘 appears as compaction starts and stays until her reply.
        if (overlayEnabled(ctx)) {
          try { await show(ctx, { phase: 'working', lines: workingLines(options.agent, ctx.lang, { partial: captured.skippedOlderBytes > 0 }), lang: ctx.lang, transcript: input.transcript_path, cycle, outside: options.agent === 'codex' }); }
          catch { /* decoration only */ }
        }
        return ''; // No blocking decision, no raw text, no inherited child pipes.
      }
      if (input.hook_event_name === 'UserPromptSubmit') {
        // A save that was still running when SessionStart handed over the memories: once
        // it lands, the model gets it with the next message, once. Otherwise nothing at all.
        if (!lateDue(ctx, { session: input.session_id })) return '';
        const { text } = recallDetails(ctx, { session: input.session_id, agent: options.agent, greeting: lateGreeting(options.agent, ctx.lang) });
        if (!text) return '';
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }, systemMessage: lateMessage(options.agent, ctx.lang) };
      }
      if (input.hook_event_name === 'PostCompact') {
        // Codex: she answers now, in the pop-up (SessionStart waits for the next message).
        // Claude Code runs SessionStart right after, so only the state moves on here.
        try { await compactionFinished(ctx, { session: input.session_id, agent: options.agent, display: options.agent === 'codex', outside: options.agent === 'codex', show }); }
        catch { /* the reply is display only */ }
        if (options.agent === 'codex') {
          // Codex's documented payload has no compact_summary. Read only the transcript
          // supplied by this authorized session, backwards from its end (rollouts get huge).
          if (!input.transcript_path) fail('transcript_unavailable');
          const summary = tailSummary(input.transcript_path);
          if (summary) rememberSummary(ctx, { session_id: input.session_id, compact_summary: summary });
        } else rememberSummary(ctx, input);
        return '';
      }
      if (options.agent === 'codex' && input.transcript_path) {
        // Codex can run SessionStart before PostCompact, or before the summary is in the
        // rollout: read the newest summary now so recall can compare against it.
        try {
          const summary = tailSummary(input.transcript_path);
          if (summary) rememberSummary(ctx, { session_id: input.session_id, compact_summary: summary });
        } catch { /* recall falls back to the whole memory, with a warning */ }
      }
      const { text, gaps, first, pending, line } = recallDetails(ctx, { transcript: input.transcript_path, session: input.session_id, agent: options.agent });
      // Still saving: the model is owed this save's memories on the message after it lands.
      let cycle = null; try { cycle = recalled(ctx, { session: input.session_id, pending }); } catch { /* no late delivery */ }
      const out = text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {};
      const persona = { agent: options.agent, lang: ctx.lang, gaps, first, pending, line, check: modelCheck(ctx) };
      // Both agents show a top-level systemMessage to the user (Claude Code as a status line,
      // Codex as a warning in the UI, per its hooks docs); additionalContext only reaches the model.
      out.systemMessage = userMessage(persona);
      // The desktop overlay works for any agent, because it does not go through the agent's UI.
      // In Codex her reply to this save already popped up after compaction: don't repeat it.
      const replied = options.agent === 'codex' && cycle?.shown && !pending;
      if (overlayEnabled(ctx) && !replied) {
        try { await show(ctx, { lines: userLines(persona), lang: ctx.lang, cycle: cycle?.startedAt ?? null, outside: options.agent === 'codex' }); }
        catch { /* the overlay is decoration; never affect the hook */ }
      }
      return Object.keys(out).length ? out : '';
    }
    fail('unknown_command');
  } catch (error) {
    // drain() has already written a fuller record (with retries and model switches): keep it.
    try { if (!error?.recorded) recordError(ctx, error, { event: hookEvent }); } catch { /* Do not print filesystem paths or raw errors. */ }
    if (command === 'hook') return ''; // Always allow compaction, even on a bad input.
    if (command === 'worker' && safeCode(error) === 'busy') return { busy: true };
    throw error;
  }
}
// Run as a command: directly, through npm's Windows .cmd shim, or through the symlink npm
// puts on the PATH elsewhere (so compare real paths, not the link).
const invoked = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || ''), b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (invoked) {
  try {
    const result = await run(process.argv.slice(2));
    if (result) process.stdout.write(typeof result === 'string' ? result + '\n' : JSON.stringify(result) + '\n');
  } catch (error) {
    // Even failures before context construction must not block a hook.
    if (process.argv[2] !== 'hook') { process.stderr.write(JSON.stringify({ error: safeCode(error) }) + '\n'); process.exitCode = 1; }
  }
}
