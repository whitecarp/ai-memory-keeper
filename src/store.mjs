import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail, hash, stamp, mkdir, read, atomic, noLinks, plainPath, withLock, safeCode, json, redact, redactObject } from './safety.mjs';
import { validateMemory, transcriptText, latestSummary, gapRecall, gapItems } from './memory.mjs';
import { extractMemory, geminiEngine, cleanPersonaLine } from './engine.mjs';
import { MODELS, estimateTokens } from '../vendor/core.js';
import { recordAudit, modelCheck } from './audit.mjs';
import { resolveKey, resolveCloudKey, routeSetting } from './key.mjs';

export function context(options = {}) {
  const project = fs.realpathSync(path.resolve(options.project || process.cwd()));
  const profile = options.profile || 'work';
  if (!['work', 'companion'].includes(profile)) fail('invalid_profile');
  const name = options.name || '';
  if (name && !/^[a-zA-Z0-9_-]{1,40}$/.test(name)) fail('invalid_name');
  const identity = process.platform === 'win32' ? project.toLowerCase() : project;
  const projectId = `${name ? name + '-' : ''}${hash(identity).slice(0, 20)}`;
  const home = path.resolve(options.home || path.join(os.homedir(), '.ai-memory-keeper'));
  const dir = path.join(home, profile, projectId);
  noLinks(dir);
  return { project, profile, home, dir, projectId, name, model: options.model || 'gemini-3.8-flash', lang: options.lang || 'zh' };
}
export const emptyMemory = () => ({ wake_up_note: '', items: [] });
export function loadMemory(ctx) {
  const doc = read(path.join(ctx.dir, 'memory.json'), null);
  if (!doc) return { version: 1, projectId: ctx.projectId, profile: ctx.profile, savedAt: null, completed: [], memory: emptyMemory() };
  if (doc.version !== 1 || doc.projectId !== ctx.projectId || doc.profile !== ctx.profile || !Array.isArray(doc.completed)) fail('invalid_memory_file');
  validateMemory(doc.memory, ctx.profile);
  return doc;
}
function workerLockState(ctx) {
  const file = path.join(ctx.dir, 'worker.lock');
  if (!fs.existsSync(file)) return false;
  const pid = read(file, null)?.pid;
  try { process.kill(pid, 0); return 'running'; } catch { return 'stale (cleared by the next save)'; }
}
export function recordError(ctx, e, extra = {}) {
  // Codes and numbers only: never server text, transcript text or keys.
  const doc = { time: stamp(), code: safeCode(e) };
  if (Number.isInteger(e?.httpStatus)) doc.httpStatus = e.httpStatus;
  if (Array.isArray(extra.retries) && extra.retries.length) doc.retries = extra.retries.slice(-6);
  if (typeof extra.event === 'string' && /^[A-Za-z]{3,24}$/.test(extra.event)) doc.event = extra.event;
  // An undocumented transcript format: its file type and record shape (key names only).
  if (typeof extra.ext === 'string' && /^\.[A-Za-z0-9]{1,8}$/.test(extra.ext)) doc.transcriptExt = extra.ext.toLowerCase();
  if (Array.isArray(e?.shape)) doc.recordShape = e.shape.filter(k => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(k)).slice(0, 12);
  if (Array.isArray(e?.types)) doc.recordTypes = e.types.filter(k => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,23}$/.test(k)).slice(0, 8);
  if (doc.code === 'operation_failed') {
    // Where in our own code, and the system error code (e.g. EBUSY): never a message or data.
    const at = String(e?.stack || '').match(/[\\/](?:src|vendor)[\\/]([\w.-]+\.m?js):(\d+)/);
    if (at) doc.where = `${at[1]}:${at[2]}`;
    if (typeof e?.syscall === 'string' && /^[a-z_]{2,20}$/.test(e.syscall)) doc.syscall = e.syscall;
    if (typeof e?.code === 'string' && /^[A-Z0-9_]{2,30}$/.test(e.code)) doc.errno = e.code;
  }
  // Which rule an answer broke (a fixed word from memory.mjs, never content).
  if (typeof e?.detail === 'string' && /^[a-z_]{2,20}$/.test(e.detail)) doc.detail = e.detail;
  atomic(path.join(ctx.dir, 'error.json'), doc);
}
function journal(ctx) {
  const data = read(path.join(ctx.dir, 'queue.json'), { sources: {}, jobs: [] });
  if (!data || !data.sources || !Array.isArray(data.jobs) || data.jobs.some(id => !/^[a-f0-9-]{36}$/.test(id))) fail('invalid_queue');
  return data;
}
function anchor(fd, end) {
  const buf = Buffer.alloc(Math.min(256, end));
  fs.readSync(fd, buf, 0, buf.length, end - buf.length);
  return hash(buf);
}

// A first capture of a long chat (Codex rollouts reach gigabytes) takes only its newest
// part: copying all of it would cost gigabytes on disk and hours of free-tier requests.
export const FIRST_CAPTURE_BYTES = 8 * 1024 * 1024;
// The first line that starts at or after pos (text: or the next whole UTF-8 character).
function lineStart(fd, pos, size, format) {
  const step = 1024 * 1024;
  for (let at = pos; at < size && at - pos < 16 * 1024 * 1024; at += step) {
    const buf = Buffer.alloc(Math.min(step, size - at));
    const n = fs.readSync(fd, buf, 0, buf.length, at);
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl >= 0) return at + nl + 1;
  }
  if (format === 'jsonl') return size; // no record starts in the tail: capture nothing
  const buf = Buffer.alloc(Math.min(4, size - pos));
  fs.readSync(fd, buf, 0, buf.length, pos);
  let skip = 0; while (skip < buf.length && (buf[skip] & 0xc0) === 0x80) skip++;
  return pos + skip;
}

// The newest compaction summary in a transcript of any size, read backwards from the end
// in 1 MiB steps (at most maxBytes); never the whole file.
export function tailSummary(file, { maxBytes = 32 * 1024 * 1024, step = 1024 * 1024 } = {}) {
  file = plainPath(file);
  noLinks(file);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let end = size, carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - step);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      // Lines before the first newline may begin earlier in the file: keep them for the next step.
      const cut = start === 0 ? 0 : data.indexOf(10) + 1;
      if (start > 0 && cut === 0) { carry = data; end = start; continue; }
      const lines = data.subarray(cut).toString('utf8').split('\n').filter(l => l.includes('"compacted"') || l.includes('isCompactSummary'));
      const found = lines.length ? latestSummary(lines.join('\n')) : '';
      if (found) return found;
      carry = data.subarray(0, cut);
      end = start;
    }
    return '';
  } finally { fs.closeSync(fd); }
}

export function enqueue(ctx, transcript, session = 'manual', { firstCaptureBytes = FIRST_CAPTURE_BYTES, agent = null } = {}) {
  return withLock(ctx.dir, 'queue', () => {
    // One transcript, one source, whichever way the agent spells its path.
    transcript = plainPath(transcript);
    noLinks(transcript);
    const resolved = fs.realpathSync(transcript);
    if (!/\.(?:jsonl|txt)$/i.test(resolved)) fail('transcript_must_be_jsonl_or_txt');
    const fd = fs.openSync(resolved, 'r');
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile()) fail('invalid_transcript');
      const source = hash(resolved + '\n' + session);
      const state = journal(ctx);
      // A prior compaction's summary must never suppress this cycle's recall.
      const summaryFile = path.join(ctx.dir, 'summaries', hash(session) + '.json');
      noLinks(summaryFile); if (fs.existsSync(summaryFile)) fs.unlinkSync(summaryFile);
      const previous = state.sources[source];
      let start = previous?.end || 0;
      if (info.size < start || (previous && anchor(fd, start) !== previous.anchor)) fail('transcript_rewritten');
      const format = /\.jsonl$/i.test(resolved) ? 'jsonl' : 'text';
      let skipped = 0;
      if (!previous && info.size > firstCaptureBytes) {
        start = lineStart(fd, info.size - firstCaptureBytes, info.size, format);
        skipped = start;
        // Recorded at once, so the older part is never captured later either.
        state.sources[source] = { end: start, anchor: anchor(fd, start), skipped };
        atomic(path.join(ctx.dir, 'queue.json'), state);
        atomic(path.join(ctx.dir, 'capture.json'), { time: stamp(), skippedOlderBytes: skipped, totalBytes: info.size });
      }
      let captured = 0, jobs = 0, lastId;
      while (start < info.size) {
        let length = Math.min(info.size - start, 4 * 1024 * 1024);
        let bytes = Buffer.alloc(length);
        if (fs.readSync(fd, bytes, 0, length, start) !== length) fail('transcript_changed');
        let complete = format === 'jsonl' ? bytes.lastIndexOf(10) + 1 : length;
        if (format === 'jsonl' && !complete && length < info.size - start) {
          // A single large JSONL record is bounded separately from a large log.
          length = Math.min(info.size - start, 16 * 1024 * 1024);
          bytes = Buffer.alloc(length);
          if (fs.readSync(fd, bytes, 0, length, start) !== length) fail('transcript_changed');
          complete = bytes.lastIndexOf(10) + 1;
          if (!complete && length < info.size - start) fail('transcript_record_over_16mb');
        }
        if (!complete) break;
        if (format === 'text' && complete < info.size - start) {
          // Preserve a UTF-8 character split across a bounded text slice.
          while (complete && (bytes[complete - 1] & 0xc0) === 0x80) complete--;
          if (complete && (bytes[complete - 1] & 0x80)) complete--;
        }
        if (!complete) break;
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, complete));
        const end = start + complete;
        const id = randomUUID();
        mkdir(path.join(ctx.dir, 'jobs'));
        atomic(path.join(ctx.dir, 'jobs', id + '.json'), { id, source, format, ...(['claude', 'codex', 'workbuddy'].includes(agent) ? { agent } : {}), start, end, created: stamp(), raw });
        state.jobs.push(id);
        state.sources[source] = { ...(state.sources[source]?.skipped ? { skipped: state.sources[source].skipped } : {}), end, anchor: anchor(fd, end) };
        atomic(path.join(ctx.dir, 'queue.json'), state);
        start = end; captured += complete; jobs++; lastId = id;
      }
      return { queued: jobs > 0, bytes: captured, jobs, ...(lastId ? { id: lastId } : {}), ...(skipped ? { skippedOlderBytes: skipped } : {}) };
    } finally { fs.closeSync(fd); }
  });
}

function finishJob(ctx, id) {
  withLock(ctx.dir, 'queue', () => {
    const q = journal(ctx); q.jobs = q.jobs.filter(x => x !== id);
    atomic(path.join(ctx.dir, 'queue.json'), q);
    const file = path.join(ctx.dir, 'jobs', id + '.json');
    noLinks(file); if (fs.existsSync(file)) fs.unlinkSync(file);
  });
}

export async function drain(ctx, { engine, timeoutMs = 120000, maxRunMs = 600000, chunkTokens = 50000, maxBytes = 24576, env = process.env, onLanded, onFailed } = {}) {
  return withLock(ctx.dir, 'worker', async () => {
    let processed = 0, withText = 0;
    // Her line from the newest segment saved in this run, for the reply after compaction.
    let lastLine = '';
    // Retry waits (busy / rate limit, seconds) so a timeout can say why it happened.
    const retries = [];
    // Both keys and the route setting, read once and only if a segment needs Gemini.
    let workerKeys = null;
    const keys = () => (workerKeys ??= Promise.all([resolveKey(ctx), resolveCloudKey(ctx)]).then(([key, cloudKey]) => ({ key, cloudKey, route: routeSetting(ctx) })));
    const onWait = (seconds, why) => retries.push({ why, seconds, at: Math.round((Date.now() - startedAt) / 1000) });
    const startedAt = Date.now();
    try {
      // Each queued segment gets its own time limit (free-tier Gemini is slow, and several
      // segments can pile up); the worker as a whole stops after maxRunMs.
      const runDeadline = startedAt + maxRunMs;
      for (;;) {
        const id = journal(ctx).jobs[0];
        if (!id) {
          if (typeof onLanded === 'function') { try { await onLanded({ processed, line: lastLine, nothingNew: processed > 0 && withText === 0 }); } catch { /* the reply is display only */ } }
          return { processed };
        }
        let totalDeadline = Math.min(Date.now() + timeoutMs, runDeadline);
        const prior = loadMemory(ctx);
        if (prior.completed.includes(id)) { finishJob(ctx, id); continue; }
        const job = read(path.join(ctx.dir, 'jobs', id + '.json'), null, 100 * 1024 * 1024);
        if (!job || job.id !== id || typeof job.raw !== 'string') fail('invalid_job');
        // Local, network-free model check first, so it is ready before recall
        // and works even without a Gemini key. It must never block saving.
        try { recordAudit(ctx, job, env); } catch { /* audit is best-effort */ }
        const redactionFile = path.join(ctx.dir, 'redaction.json');
        const redactions = read(redactionFile, {});
        const redactionContext = redactions[job.source] || { inPrivateKey: false, tail: '' };
        const text = redact(transcriptText(job.raw, job.format, { agent: job.agent }), redactionContext);
        // A long segment (say, the first capture of a big chat) is read in several requests:
        // each gets the per-segment time, within the run's cap.
        const parts = Math.max(1, Math.ceil(estimateTokens(text) / chunkTokens));
        // (one more for the merge that joins their notes).
        if (parts > 1) totalDeadline = Math.min(Date.now() + timeoutMs * (parts + 1), runDeadline);
        const remaining = totalDeadline - Date.now();
        if (remaining <= 0) fail('timeout');
        let personaLine = '';
        let savedWith = ctx.model, savedVia = null, dropped = 0;
        // AI Studio: GEMINI_API_KEY if set, else `amk key`; Agent Platform: `amk key --cloud`.
        const extract = async model => extractMemory({ text, old: prior.memory, profile: ctx.profile, date: job.created.slice(0, 10), model, lang: ctx.lang, engine: engine || geminiEngine({ ...(await keys()), onWait, onVia: v => { savedVia = v; } }), onDropped: n => { dropped += n; }, timeoutMs: totalDeadline - Date.now(), chunkTokens, maxBytes, onPersonaLine: line => { personaLine = line; } });
        let memory = prior.memory;
        if (text.trim()) {
          withText++;
          try { memory = await extract(ctx.model); }
          catch (e) {
            // The default free model is often overloaded (503) or out of free quota (429) when
            // the other free one isn't (free quotas are per model): try it once, if there is time.
            const alt = MODELS.find(m => m.free && m.id !== ctx.model);
            if (!['busy', 'ratelimit'].includes(e?.kind) || !alt || totalDeadline - Date.now() < 15000) throw e;
            retries.push({ why: 'switch_model', to: alt.id, at: Math.round((Date.now() - startedAt) / 1000) });
            memory = await extract(alt.id); savedWith = alt.id;
          }
        }
        validateMemory(memory, ctx.profile);
        const file = path.join(ctx.dir, 'memory.json');
        // Detect a user's pin/edit made while the model was working.
        if (json(loadMemory(ctx)) !== json(prior)) fail('memory_changed_during_save');
        if (fs.existsSync(file)) atomic(path.join(ctx.dir, 'backups', `${stamp().replace(/[:.]/g, '-')}-${id}.json`), prior);
        const doc = { ...prior, savedAt: stamp(), savedWith, ...(savedVia ? { savedVia } : {}), droppedItems: dropped, completed: [...prior.completed, id].slice(-1000), memory };
        atomic(file, doc);
        // Gemini's own line for the next compaction; written only after memory commits.
        if (personaLine) { lastLine = personaLine; try { atomic(path.join(ctx.dir, 'persona.json'), { line: personaLine, time: stamp() }); } catch { /* display only */ } }
        redactions[job.source] = redactionContext;
        atomic(redactionFile, redactions);
        finishJob(ctx, id); processed++;
        atomic(path.join(ctx.dir, 'error.json'), { time: stamp(), code: null });
      }
    } catch (e) {
      recordError(ctx, e, { retries });
      // This record carries the retry list; the CLI's outer handler must not overwrite it.
      try { if (e && typeof e === 'object') e.recorded = true; } catch { /* keep the original error */ }
      if (typeof onFailed === 'function') { try { await onFailed(e); } catch { /* the reply is display only */ } }
      throw e;
    }
  });
}

export function rememberSummary(ctx, input) {
  if (typeof input.compact_summary !== 'string' || !input.session_id) return;
  atomic(path.join(ctx.dir, 'summaries', hash(input.session_id) + '.json'), { text: redact(input.compact_summary), time: stamp() });
}
export function recall(ctx, options = {}) {
  return recallDetails(ctx, options).text;
}
export function recallDetails(ctx, { summary = '', transcript, session, agent = null, greeting = null } = {}) {
  const doc = loadMemory(ctx);
  // Still saving this compaction's segment, or not saved at all yet.
  let pending = false; try { pending = journal(ctx).jobs.length > 0; } catch { /* treat as not pending */ }
  if (!doc.savedAt) return { text: '', gaps: 0, first: true, pending, line: '' };
  let warning = null;
  try {
    if (!summary && session) summary = read(path.join(ctx.dir, 'summaries', hash(session) + '.json'), {})?.text || '';
    if (!summary && transcript) summary = tailSummary(transcript);
  } catch { warning = 'summary_unavailable_using_last_good_memory'; summary = ''; }
  const memory = redactObject(doc.memory);
  let line = '';
  try { const p = read(path.join(ctx.dir, 'persona.json'), null); line = cleanPersonaLine(p?.line, ctx.lang || 'zh', ctx.profile); } catch { /* fixed lines instead */ }
  const result = gapRecall(memory, summary, ctx.lang || 'zh', agent, pending ? '' : line, greeting);
  atomic(path.join(ctx.dir, 'recall.json'), { time: stamp(), items: doc.memory.items.length, summaryMatched: !!summary, warning });
  return { text: result, gaps: gapItems(memory, summary).length, first: false, pending, line };
}
export function status(ctx) {
  const doc = loadMemory(ctx);
  const recalled = read(path.join(ctx.dir, 'recall.json'), null);
  // A successful save leaves { code: null } in error.json; report that as no error.
  const failed = read(path.join(ctx.dir, 'error.json'), null);
  return { projectId: ctx.projectId, profile: ctx.profile, memoryFile: path.join(ctx.dir, 'memory.json'), lastSave: doc.savedAt, lastSaveVia: doc.savedVia || null, lastSaveDropped: doc.droppedItems || 0, lastRecall: recalled?.time || null, recallWarning: recalled?.warning || null, lastError: failed?.code ? failed : null, queued: journal(ctx).jobs.length, workerLock: workerLockState(ctx), modelCheck: modelCheck(ctx), firstCapture: read(path.join(ctx.dir, 'capture.json'), null), lastHook: read(path.join(ctx.dir, 'hook.json'), null) };
}
