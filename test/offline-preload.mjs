// Tests only. Replaces fetch in the CLI AND its detached worker; never forwards.
import fs from 'node:fs';
if (process.env.AMK_OFFLINE_TEST !== '1' || process.env.GEMINI_API_KEY !== 'unit-test-only') throw new Error('offline test isolation missing');
globalThis.fetch = async (url, options) => {
  if (url !== 'https://generativelanguage.googleapis.com/v1beta/interactions') throw new Error('unexpected test destination');
  const body = JSON.parse(options.body);
  if (body.input.includes('sk-demoSecret123456789') || body.input.includes('supersecret')) throw new Error('redaction failed');
  if (process.env.AMK_OFFLINE_COUNTER) fs.appendFileSync(process.env.AMK_OFFLINE_COUNTER, 'request\n');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const quote = 'Remember: use short answers.';
  const items = body.input.includes(quote) ? [{ key: 'answer-style', category: 'preference', text: quote, evidence: quote, date: '2026-11-04', rank: 1, status: 'none' }] : [];
  const payload = { wake_up_note: 'Resume the project using these saved notes.', items };
  return { ok: true, status: 200, json: async () => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(payload) }] }] }) };
};
