import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enabled } from './hooks.mjs';
import { ruleEnabled } from './rules.mjs';
import { keyStatus } from './key.mjs';
import { overlaySupported } from './overlay.mjs';

// `amk doctor`: what an agent needs before following the skill file. Never the key.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(root, 'skills', 'ai-memory-keeper', 'SKILL.md');
export const OMNI_SKILL = path.join(root, 'skills', 'gemini-omni', 'SKILL.md');
export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();

// A hint only: the agent knows best which agent it is.
export function detectAgent(env = process.env) {
  if (env.CLAUDECODE) return 'claude';
  if (Object.keys(env).some(k => /^CODEX_(THREAD_ID|SANDBOX|SANDBOX_NETWORK_DISABLED|CI|MANAGED_BY_NPM)$/.test(k))) return 'codex';
  return 'unknown';
}

export function doctor(ctx, env = process.env) {
  const major = Number(process.versions.node.split('.')[0]);
  const on = agent => { try { return enabled(ctx, agent); } catch { return false; } };
  const agent = detectAgent(env);
  return {
    amk: VERSION,
    node: major >= 22
      ? { version: process.version, ok: true }
      : { version: process.version, ok: false, needs: 'Node.js 22 or newer', get: 'Windows: winget install OpenJS.NodeJS.LTS · macOS: brew install node · or https://nodejs.org' },
    key: keyStatus(ctx, env),
    agent: { guess: agent, autoMode: agent === 'unknown' ? 'Auto mode works in Claude Code and Codex (WorkBuddy: preview); Antigravity uses the no-key rule; other agents use amk save / amk recall by hand' : 'supported' },
    project: ctx.project,
    enabled: { claude: on('claude'), codex: on('codex'), workbuddy: on('workbuddy') },
    rules: { antigravity: ruleEnabled(ctx, 'antigravity'), workbuddy: ruleEnabled(ctx, 'workbuddy') },
    overlay: overlaySupported() ? 'Windows desktop pop-up' : 'not on this system; her words show as text only',
    skill: SKILL,
    omniSkill: OMNI_SKILL,
    next: `Read ${SKILL} and follow it.`,
  };
}
