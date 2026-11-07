import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../src/store.mjs';
import { redact } from '../src/safety.mjs';
export const testRoot = fileURLToPath(new URL('../.test-runs/', import.meta.url));
// Never open real Gemini-chan overlay windows from tests or the offline demo (children inherit this).
process.env.AMK_NO_OVERLAY = '1';
// Keep test workers in the test's environment (fake key, offline stub): no WMI start.
process.env.AMK_NO_OUTSIDE = '1';
export function fixture(t) {
  fs.mkdirSync(testRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(testRoot, 'case-'));
  const project = path.join(dir, "project space ' $ & 中文");
  const home = path.join(dir, 'fake-home', 'keeper');
  fs.mkdirSync(project, { recursive: true });
  const ctx = context({ project, home });
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');
  // Only generated fixture directories, checked to remain below our local test root.
  t?.after(() => cleanup(dir));
  return { dir, project, home, ctx, transcript };
}
export function cleanup(dir) {
  const target = path.resolve(dir), root = path.resolve(testRoot) + path.sep;
  if (!target.startsWith(root)) throw new Error('unsafe test cleanup');
  fs.rmSync(target, { recursive: true, force: true });
}
export const record = text => JSON.stringify({ type: 'user', timestamp: '2026-11-04T10:00:00Z', message: { role: 'user', content: text } }) + '\n';
export const item = (text = 'I prefer short answers.', extra = {}) => ({ key: 'answer-style', category: 'preference', text, date: '2026-11-04', evidence: text, rank: 1, status: 'none', ...extra });
export const memory = (items = [item()]) => ({ wake_up_note: 'Resume using the saved preferences.', items });
export const engine = (data = memory()) => ({ complete: async () => structuredClone(data) });
export function sampleEngine() {
  return { complete: async body => {
    const evidence = 'Remember: use short answers.';
    if (!redact(body.input).includes(evidence)) return memory([]);
    return memory([item(evidence)]);
  } };
}
