import fs from 'node:fs';

// Windows PowerShell scripts run as -EncodedCommand: no script file is executed, so no
// execution-policy change is ever needed. Comments and indentation are dropped to stay
// well under the 32,767-character command-line limit. Variables are prepended as
// single-quoted literals; never pass a secret this way (secrets go through stdin).
export const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
export function encodedScript(file, vars = {}) {
  const body = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trimStart()).filter(l => l && !l.startsWith('#')).join('\n');
  const head = Object.entries(vars).map(([k, v]) => `$${k} = ${psQuote(v)}`).join('\n');
  return Buffer.from((head ? head + '\n' : '') + body, 'utf16le').toString('base64');
}
export const psArgs = encoded => ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded];
// A short inline script (for the key helpers below), encoded the same way.
export const inlineArgs = script => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
