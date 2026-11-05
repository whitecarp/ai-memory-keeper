import path from 'node:path';
import { read, atomic, withLock, safeCode } from './safety.mjs';

// The latest compaction, per project and profile: when it started, whether its background
// save has landed, whether her reply was shown, and whether the agent's model is still owed
// this save's memories (SessionStart ran while the save was running).
//   phase: compacting (PreCompact) -> finished (PostCompact, save still running) -> saved | failed
// The hooks and the background worker are separate processes, so every change is a short
// read-modify-write under a lock.

const file = ctx => path.join(ctx.dir, 'cycle.json');
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Her reply pops up only for a compaction this recent; later, only the next message gets it.
export const REPLY_WINDOW_MS = 15 * 60 * 1000;

export function readCycle(ctx) {
  try { return read(file(ctx), null); } catch { return null; }
}
// change(current) returns { next, value }: next (if any) is written, value is returned.
export function updateCycle(ctx, change) {
  for (let i = 0; ; i++) {
    try {
      return withLock(ctx.dir, 'cycle', () => {
        const result = change(readCycle(ctx)) || {};
        if (result.next) atomic(file(ctx), result.next);
        return result.value;
      });
    } catch (e) {
      if (safeCode(e) !== 'busy' || i >= 200) throw e;
      pause(25);
    }
  }
}
export function beginCycle(ctx, { session, agent, now = Date.now() }) {
  return updateCycle(ctx, () => ({ next: { session, agent, startedAt: now, phase: 'compacting', shown: false, owed: false }, value: now }));
}
// For `amk status`: what happened to the latest compaction, without any text.
export function cycleStatus(ctx) {
  const c = readCycle(ctx);
  if (!c) return null;
  const at = n => (Number.isFinite(n) ? new Date(n).toISOString() : null);
  return { phase: c.phase, startedAt: at(c.startedAt), savedAt: at(c.savedAt), replyShown: !!c.shown, owedToNextMessage: !!c.owed, deliveredAt: at(c.deliveredAt) };
}
