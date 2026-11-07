import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class SafeError extends Error { constructor(code) { super(code); this.code = code; } }
export const fail = code => { throw new SafeError(code); };
export const hash = value => createHash('sha256').update(value).digest('hex');
export const stamp = () => new Date().toISOString();
export const json = value => JSON.stringify(value, null, 2) + '\n';
export function redactObject(value, context = null) {
  if (typeof value === 'string') return redact(value, context);
  if (Array.isArray(value)) return value.map(v => redactObject(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactObject(v, context)]));
  return value;
}
export function redact(text, context = null) {
  let s = String(text);
  if (!context) {
    return s
      .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/\b(?:AIza[\w-]{12,}|sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{12,})\b/g, '[REDACTED_KEY]')
      .replace(/\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH]')
      .replace(/((?:["']?)(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi, '$1[REDACTED_VALUE]')
      .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, word => {
        const unique = new Set(word).size;
        return unique >= 12 && /[A-Za-z]/.test(word) && (/[0-9_+/=-]/.test(word) || unique >= 18) ? '[REDACTED_RANDOM]' : word;
      });
  }

  if (context.inPrivateKey) {
    const endMatch = s.match(/^[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----(?:\r?\n)?/);
    if (endMatch) {
      s = '[REDACTED_PRIVATE_KEY]\n' + s.slice(endMatch[0].length);
      context.inPrivateKey = false;
    } else {
      context.inPrivateKey = true;
      context.tail = '';
      return '[REDACTED_PRIVATE_KEY]';
    }
  }

  if (context.tail) {
    const splitAt = context.tail.length;
    const sPrefix = s.slice(0, 1024);
    const combined = context.tail + sPrefix;

    const assignRe = /((?:["']?)(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi;
    let m;
    while ((m = assignRe.exec(combined)) !== null) {
      if (m.index < splitAt && m.index + m[0].length > splitAt) {
        const inSLength = (m.index + m[0].length) - splitAt;
        s = '[REDACTED_VALUE]' + s.slice(inSLength);
        break;
      }
    }

    const authRe = /\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
    while ((m = authRe.exec(combined)) !== null) {
      if (m.index < splitAt && m.index + m[0].length > splitAt) {
        const inSLength = (m.index + m[0].length) - splitAt;
        s = '[REDACTED_AUTH]' + s.slice(inSLength);
        break;
      }
    }

    const keyRe = /\b(?:AIza[\w-]{12,}|sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{12,})\b/g;
    while ((m = keyRe.exec(combined)) !== null) {
      if (m.index < splitAt && m.index + m[0].length > splitAt) {
        const inSLength = (m.index + m[0].length) - splitAt;
        s = '[REDACTED_KEY]' + s.slice(inSLength);
        break;
      }
    }

    const randRe = /[A-Za-z0-9_+\/-]{32,}={0,2}/g;
    while ((m = randRe.exec(combined)) !== null) {
      if (m.index < splitAt && m.index + m[0].length > splitAt) {
        const word = m[0];
        const unique = new Set(word).size;
        if (unique >= 12 && /[A-Za-z]/.test(word) && (/[0-9_+/=-]/.test(word) || unique >= 18)) {
          const inSLength = (m.index + m[0].length) - splitAt;
          s = '[REDACTED_RANDOM]' + s.slice(inSLength);
          break;
        }
      }
    }
  }

  s = s.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, match => {
    if (!match.includes('-----END')) {
      context.inPrivateKey = true;
    }
    return '[REDACTED_PRIVATE_KEY]';
  });

  s = s
    .replace(/\b(?:AIza[\w-]{12,}|sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{12,})\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH]')
    .replace(/((?:["']?)(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi, '$1[REDACTED_VALUE]')
    .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, word => {
      const unique = new Set(word).size;
      return unique >= 12 && /[A-Za-z]/.test(word) && (/[0-9_+/=-]/.test(word) || unique >= 18) ? '[REDACTED_RANDOM]' : word;
    });

  context.tail = context.inPrivateKey ? '' : String(text).slice(-1024);

  return s;
}

// Refuse linked paths, including Windows junctions; never follow them for writes.
// Windows extended-length paths (\\?\C:\…, \\?\UNC\server\…), which some agents pass (Rust's
// canonicalize returns them), as plain ones: Node's lstat fails on their root with EISDIR.
export function plainPath(p, platform = process.platform) {
  if (typeof p !== 'string' || platform !== 'win32') return p;
  if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(p)) return p.slice(4);
  return p;
}
export function noLinks(file) {
  let cur = path.resolve(plainPath(file));
  for (;;) {
    try { if (fs.lstatSync(cur).isSymbolicLink()) fail('linked_path'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}
export function mkdir(dir) { noLinks(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
export function read(file, fallback, maxBytes = 8 * 1024 * 1024) {
  noLinks(file);
  try {
    if (fs.statSync(file).size > maxBytes) fail('file_too_large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; if (e instanceof SyntaxError) fail('invalid_local_json'); throw e; }
}
export function atomic(file, value) {
  noLinks(file); mkdir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function deadOwner(file) {
  let owner; try { owner = read(file, null); } catch { return false; }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
}
function acquire(file) {
  const guard = file + '.reclaim';
  // All new acquirers honor the same reclaim guard. A PID reused by the OS,
  // malformed lock, permission error, or abandoned reclaim guard is not guessed.
  if (fs.existsSync(guard)) fail('lock_recovery_busy');
  try { return fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!deadOwner(file)) fail('busy');
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('lock_recovery_busy'); throw e; }
  try {
    if (!deadOwner(file)) fail('busy');
    fs.unlinkSync(file);
    try { return fs.openSync(file, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') fail('busy'); throw e; }
  } finally { fs.rmdirSync(guard); }
}
export function withLock(dir, name, action) {
  mkdir(dir); const file = path.join(dir, name + '.lock'); noLinks(file);
  const fd = acquire(file);
  fs.writeFileSync(fd, json({ pid: process.pid, started: stamp() })); fs.closeSync(fd);
  const release = () => fs.unlinkSync(file);
  try {
    const result = action();
    if (result?.then) return result.finally(release);
    release(); return result;
  } catch (e) { release(); throw e; }
}
export function safeCode(e) {
  if (e instanceof SafeError) return e.code;
  if (['network', 'region', 'ratelimit', 'busy', 'badjson', 'empty', 'incomplete', 'failed', 'http', 'aborted'].includes(e?.kind)) return `gemini_${e.kind}`;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  return 'operation_failed';
}
