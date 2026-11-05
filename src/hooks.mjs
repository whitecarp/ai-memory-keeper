import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail, hash, read, atomic, noLinks, withLock } from './safety.mjs';

export const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const registry = ctx => path.join(ctx.home, 'installations', hash(ctx.project));
// Project-local, tool-owned coordination is shared even by different --home roots.
const configLocks = ctx => path.join(ctx.project, '.ai-memory-keeper', 'config-locks');
export function installationFile(ctx, agent) { return path.join(registry(ctx), agent + '.json'); }
// WorkBuddy runs the CodeBuddy agent: Tencent's hook docs (WorkBuddy Enterprise, CodeBuddy IDE)
// put project hooks in <workspace>/.codebuddy/settings.json. Never the user-level ~/.codebuddy.
export const AGENTS = ['claude', 'codex', 'workbuddy'];
function agentFile(ctx, agent) {
  if (agent === 'claude') return path.join(ctx.project, '.claude', 'settings.local.json');
  if (agent === 'codex') return path.join(ctx.project, '.codex', 'hooks.json');
  if (agent === 'workbuddy') return path.join(ctx.project, '.codebuddy', 'settings.json');
  fail('agent_manual_only');
}
const shellQuote = s => `'${s.replace(/'/g, `'"'"'`)}'`;
const psQuote = s => `'${s.replace(/'/g, "''")}'`;
// UserPromptSubmit hands the model a save that landed after SessionStart had already run,
// once, on the next message (both agents document additionalContext for it; it takes no matcher).
export const HOOK_EVENTS = ['PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit'];
// WorkBuddy's documented events have PreCompact (trigger manual = /summarize, or auto) but no
// PostCompact, and SessionStart fires on startup only. So the first UserPromptSubmit after
// compaction brings the memories back (its documented hookSpecificOutput.additionalContext).
// Commands run in a shell (CodeBuddy's CLI docs: Git Bash on Windows), so they're shell-quoted;
// timeouts are in seconds.
function workbuddyEntries(ctx, args) {
  const handler = { type: 'command', command: [process.execPath, ...args].map(shellQuote).join(' '), timeout: 10 };
  return [
    { event: 'PreCompact', group: { matcher: 'manual', hooks: [handler] } },
    { event: 'PreCompact', group: { matcher: 'auto', hooks: [handler] } },
    { event: 'UserPromptSubmit', group: { hooks: [handler] } },
  ];
}
export function hookEntries(ctx, agent, owner) {
  const args = [cliPath, 'hook', '--project', ctx.project, '--home', ctx.home, '--profile', ctx.profile, '--model', ctx.model, '--lang', ctx.lang, '--agent', agent, '--owner', owner];
  if (ctx.name) args.push('--name', ctx.name);
  if (agent === 'workbuddy') return workbuddyEntries(ctx, args);
  return HOOK_EVENTS.map(event => {
    const zh = ctx.lang !== 'en';
    const label = { PreCompact: zh ? '保存记忆' : 'saving memories', PostCompact: zh ? '收下摘要' : 'taking the summary', SessionStart: zh ? '带回记忆' : 'bringing memories back', UserPromptSubmit: zh ? '补上迟到的记忆' : 'late memories' }[event];
    const handler = { type: 'command', timeout: 5, statusMessage: `AI Memory Keeper · ${label}` };
    if (agent === 'claude') Object.assign(handler, { command: process.execPath, args, onFailure: 'continue' });
    else {
      const words = [process.execPath, ...args];
      handler.command = words.map(shellQuote).join(' ');
      handler.commandWindows = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from('& ' + words.map(psQuote).join(' '), 'utf16le').toString('base64');
      // Codex spills context over ~2,500 tokens to a file by default; the memory file is
      // capped at 24 KB, so allow the whole recall through.
      if (event === 'SessionStart' || event === 'UserPromptSubmit') handler.additionalContextLimit = 8000;
    }
    if (event === 'UserPromptSubmit') return { event, group: { hooks: [handler] } };
    return { event, group: { matcher: event === 'SessionStart' ? '^compact$' : 'manual|auto', hooks: [handler] } };
  });
}
// Removes exactly the given entries (same matcher, same handler); returns how many.
function removeEntries(config, entries) {
  let removed = 0;
  for (const { event, group } of entries) {
    if (!Array.isArray(config.hooks?.[event])) continue;
    config.hooks[event] = config.hooks[event].map(g => {
      if (!Array.isArray(g.hooks) || g.matcher !== group.matcher) return g;
      const hooks = g.hooks.filter(h => { if (same(h, group.hooks[0])) { removed++; return false; } return true; });
      if (hooks.length === g.hooks.length) return g;
      return hooks.length ? { ...g, hooks } : null;
    }).filter(g => g !== null);
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (config.hooks && !Object.keys(config.hooks).length) delete config.hooks;
  return removed;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function configAt(file) {
  const config = read(file, {});
  if (!config || Array.isArray(config) || typeof config !== 'object') fail('invalid_hook_config');
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) fail('invalid_hook_config');
  return config;
}
export function enable(ctx, agent) {
  const file = agentFile(ctx, agent);
  // A home-directory project would turn a project install into a global one.
  if (path.resolve(ctx.project) === path.resolve(process.env.USERPROFILE || process.env.HOME || '/')) fail('home_project_refused');
  noLinks(file);
  return withLock(configLocks(ctx), agent, () => {
    const previous = read(installationFile(ctx, agent), null);
    let upgraded = false, owner = randomUUID();
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const config = configAt(file);
    if (previous?.enabled) {
      if (previous.projectId !== ctx.projectId || previous.profile !== ctx.profile) fail('disable_other_profile_first');
      if (!enabled(ctx, agent)) fail('hooks_changed_disable_first');
      // An install from an older version: swap exactly its own hooks for this version's,
      // keeping its owner tag (Codex then asks to review the changed hooks once).
      if (same(previous.entries, hookEntries(ctx, agent, previous.owner))) return { alreadyEnabled: true, config: file, added: [] };
      owner = previous.owner;
      removeEntries(config, previous.entries);
      upgraded = true;
    }
    const entries = hookEntries(ctx, agent, owner);
    config.hooks ||= {};
    for (const { event, group } of entries) {
      if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) fail('invalid_hook_config');
      config.hooks[event] ||= []; config.hooks[event].push(group);
    }
    // Write ownership before config so a failed config write remains recoverable.
    atomic(installationFile(ctx, agent), { owner, enabled: true, projectId: ctx.projectId, profile: ctx.profile, file, entries });
    if (before === null ? fs.existsSync(file) : !fs.existsSync(file) || !fs.readFileSync(file).equals(before)) fail('hook_config_changed');
    atomic(file, config);
    // A sandbox can refuse or hide the write (Codex keeps .codex read-only inside it): only
    // report enabled once the hooks are really in the file on disk, else undo and say so.
    if (!enabled(ctx, agent)) {
      atomic(installationFile(ctx, agent), { owner, enabled: false, projectId: ctx.projectId, profile: ctx.profile, file, entries });
      fail('hook_file_not_written');
    }
    return { config: file, added: entries, ...(upgraded ? { upgraded: true } : {}) };
  });
}
export function enabled(ctx, agent) {
  const state = read(installationFile(ctx, agent), null);
  if (!state?.enabled || state.projectId !== ctx.projectId || state.profile !== ctx.profile) return false;
  const config = configAt(agentFile(ctx, agent));
  return state.entries.every(({ event, group }) => config.hooks?.[event]?.some(g => g.matcher === group.matcher && g.hooks?.some(h => same(h, group.hooks[0]))));
}
export function disable(ctx, agent) {
  const file = agentFile(ctx, agent);
  return withLock(configLocks(ctx), agent, () => {
    const state = read(installationFile(ctx, agent), null);
    if (!state?.enabled) return { removed: 0, config: file };
    if (state.projectId !== ctx.projectId || state.profile !== ctx.profile) fail('profile_mismatch');
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const config = configAt(file);
    const removed = removeEntries(config, state.entries);
    noLinks(file);
    if (before === null ? fs.existsSync(file) : !fs.existsSync(file) || !fs.readFileSync(file).equals(before)) fail('hook_config_changed');
    if (!Object.keys(config).length) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else atomic(file, config);
    atomic(installationFile(ctx, agent), { ...state, enabled: false });
    return { removed, config: file };
  });
}
export function authorizeHook(ctx, agent, owner, input) {
  const state = read(installationFile(ctx, agent), null);
  if (!owner || !state?.enabled || state.owner !== owner || !enabled(ctx, agent)) fail('hook_not_enabled');
  if (!input || typeof input.cwd !== 'string' || fs.realpathSync(input.cwd) !== ctx.project || typeof input.session_id !== 'string' || !input.session_id) fail('hook_project_mismatch');
  if (!HOOK_EVENTS.includes(input.hook_event_name)) fail('unsupported_hook');
  if (input.hook_event_name === 'SessionStart' && input.source !== 'compact') fail('unsupported_hook');
  if (['PreCompact', 'PostCompact'].includes(input.hook_event_name) && !['auto', 'manual'].includes(input.trigger)) fail('unsupported_hook');
}
