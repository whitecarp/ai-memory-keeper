import path from 'node:path';
import { read } from './safety.mjs';
import { updateCycle, readCycle, REPLY_WINDOW_MS } from './cycle.mjs';
import { savingLines, savedLines, failedLines } from './persona.mjs';
import { overlayEnabled, showOverlay } from './overlay.mjs';
import { cleanPersonaLine } from './engine.mjs';

// Her reply after compaction. Codex runs SessionStart(compact) only before the next model
// request, and a free-tier save takes about a minute, so she answers in the pop-up as soon
// as the background save lands: PostCompact says "收好了，我在整理…", the worker shows her line.

const storedLine = ctx => {
  try { return cleanPersonaLine(read(path.join(ctx.dir, 'persona.json'), null)?.line, ctx.lang, ctx.profile); } catch { return ''; }
};
// Her reply can pop up only once compaction is over, and only for a recent one.
const canReply = (c, now) => !!c.finishedAt && now - c.startedAt <= REPLY_WINDOW_MS;

// PostCompact. display: Codex shows the pop-up now; Claude Code runs SessionStart right after.
export async function compactionFinished(ctx, { session, agent, display = true, outside = false, show = showOverlay, now = Date.now() }) {
  const c = updateCycle(ctx, c => {
    if (!c || c.session !== session) return {};
    const next = { ...c, finishedAt: now };
    if (c.phase === 'compacting') next.phase = 'finished';
    else if (display && ['saved', 'failed'].includes(c.phase)) next.shown = true;
    return { next, value: next };
  });
  if (!c || !display || !overlayEnabled(ctx)) return c?.phase ?? null;
  const lines = c.phase === 'finished' ? savingLines(agent, ctx.lang)
    : c.phase === 'saved' ? savedLines({ agent, lang: ctx.lang, line: storedLine(ctx) })
      : failedLines(c.failCode || 'operation_failed', ctx.lang);
  try { await show(ctx, { phase: c.phase === 'finished' ? 'saving' : 'done', lines, lang: ctx.lang, cycle: c.startedAt, outside }); }
  catch { /* decoration only */ }
  return c.phase;
}

// The worker saved everything queued. line: her line from this save, if Gemini wrote one.
export async function saveLanded(ctx, { line = '', nothingNew = false, show = showOverlay, now = Date.now() } = {}) {
  const c = updateCycle(ctx, c => {
    if (!c || !['compacting', 'finished', 'failed'].includes(c.phase)) return {};
    const next = { ...c, phase: 'saved', savedAt: now };
    if (canReply(c, now)) next.shown = true;
    return { next, value: next };
  });
  if (!c?.shown || !canReply(c, now) || !overlayEnabled(ctx)) return false;
  // Nothing new (say, a second /compact right after the first): no old line passed off as new.
  try { await show(ctx, { lines: savedLines({ agent: c.agent, lang: ctx.lang, line: nothingNew ? '' : line || storedLine(ctx), nothingNew }), lang: ctx.lang, cycle: c.startedAt, agentPid: 'keep' }); }
  catch { return false; }
  return true;
}

// The worker stopped with an error; the new part stays queued for the next run.
export async function saveFailed(ctx, { code, show = showOverlay, now = Date.now() } = {}) {
  const c = updateCycle(ctx, c => {
    if (!c || !['compacting', 'finished'].includes(c.phase)) return {};
    const next = { ...c, phase: 'failed', failCode: code, failedAt: now };
    if (canReply(c, now)) next.shown = true;
    return { next, value: next };
  });
  if (!c?.shown || !canReply(c, now) || !overlayEnabled(ctx)) return false;
  try { await show(ctx, { lines: failedLines(code, ctx.lang), lang: ctx.lang, cycle: c.startedAt, agentPid: 'keep' }); }
  catch { return false; }
  return true;
}

// SessionStart(compact): the model gets the memories now; if the save is still running,
// it is owed them on the first message after the save lands. Returns the cycle as it was.
export function recalled(ctx, { session, pending, now = Date.now() }) {
  return updateCycle(ctx, c => {
    if (!c || c.session !== session) return { value: null };
    return { next: { ...c, owed: !!pending, recalledAt: now }, value: c };
  });
}

// WorkBuddy's first UserPromptSubmit after compaction: no hand-back has happened yet.
export function awaitingRecall(ctx, { session }) {
  const c = readCycle(ctx);
  return !!(c && c.session === session && !c.recalledAt && Date.now() - c.startedAt <= 24 * 60 * 60 * 1000);
}

// UserPromptSubmit: true once, when a save that was still running at SessionStart has landed.
export function lateDue(ctx, { session, now = Date.now() }) {
  return !!updateCycle(ctx, c => {
    if (!c?.owed || c.session !== session) return {};
    if (now - c.startedAt > 24 * 60 * 60 * 1000) return { next: { ...c, owed: false } };
    if (c.phase !== 'saved' || !(c.savedAt > (c.recalledAt || 0))) return {};
    return { next: { ...c, owed: false, deliveredAt: now }, value: true };
  });
}
