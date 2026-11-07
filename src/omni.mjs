import fs from 'node:fs';
import path from 'node:path';
import { fail, noLinks } from './safety.mjs';
import { resolveCloudKey, resolveKey } from './key.mjs';
import { parseServiceAccount, exchangeServiceAccountToken } from '../vendor/core.js';

export const OMNI_MODEL = 'gemini-omni-1.2-flash';
export const omniInteractionsUrl = projectId =>
  `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/locations/global/interactions`;

export function extractVideoBase64(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.data === 'string' && obj.data.length > 256 && (obj.type === 'video' || obj.mime_type === 'video/mp4')) {
    return obj.data;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'data') {
      const found = extractVideoBase64(v);
      if (found) return found;
    }
  }
  return null;
}

function imageMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

export async function runOmni(ctx, { prompt, out, image = null, file = null, model = OMNI_MODEL, fetchImpl = fetch } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text || !out) fail('invalid_arguments');
  const outTarget = path.resolve(out);
  noLinks(outTarget);

  let rawKey = null;
  if (file) {
    const keyTarget = path.resolve(file);
    noLinks(keyTarget);
    if (!fs.existsSync(keyTarget) || fs.statSync(keyTarget).size > 64 * 1024) fail('invalid_key_format');
    rawKey = fs.readFileSync(keyTarget, 'utf8');
  } else {
    rawKey = (await resolveCloudKey(ctx)) || (await resolveKey(ctx));
  }
  const sa = parseServiceAccount(rawKey);
  if (!sa) fail('missing_service_account_json');

  const input = [];
  if (image) {
    const imgTarget = path.resolve(image);
    noLinks(imgTarget);
    if (!fs.existsSync(imgTarget) || fs.statSync(imgTarget).size > 20 * 1024 * 1024) fail('invalid_arguments');
    input.push({
      type: 'image',
      data: fs.readFileSync(imgTarget).toString('base64'),
      mime_type: imageMime(imgTarget),
    });
  }
  input.push({ type: 'text', text });

  const { token, projectId } = await exchangeServiceAccountToken(sa, { fetchImpl });
  const res = await fetchImpl(omniInteractionsUrl(projectId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, store: false, input }),
  });
  if (!res.ok) fail(`omni_http_${res.status}`);
  const data = await res.json();
  const b64 = extractVideoBase64(data);
  if (!b64) fail('omni_empty_video');

  const buf = Buffer.from(b64, 'base64');
  fs.mkdirSync(path.dirname(outTarget), { recursive: true });
  fs.writeFileSync(outTarget, buf);
  return {
    saved: true,
    out: outTarget,
    bytes: buf.length,
    model,
    projectId,
  };
}
