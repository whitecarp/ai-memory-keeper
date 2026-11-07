// Pure logic shared by the page and the Node tests: no DOM here.
// Gemini facts below were checked on Google's official docs on 2026-11-04:
//   models + limits  https://aistudio.google.com/docs/models
//   request format   https://aistudio.google.com/api-reference/interactions-api/create-interaction
//   free tier        https://aistudio.google.com/docs/pricing

export const APP_VERSION = '0.2.1';

export const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Google Cloud's Agent Platform (Gemini Enterprise Agent Platform, formerly Vertex AI): the same
// Gemini models, billed to the Cloud project, so Cloud credits apply. API keys work with
// generateContent on the global endpoint, key in x-goog-api-key (checked 2026-11-05):
//   https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference
//   https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference
// AI Studio's own billing page: Cloud trial/Welcome credit can't pay for the Gemini API, and a
// Prepay account at $0 stops every Gemini API call it pays for (HTTP 402).
export const CLOUD_API_BASE = 'https://aiplatform.googleapis.com/v1/publishers/google/models/';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const cloudUrl = (model, projectId = null) => projectId
  ? `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/global/publishers/google/models/${encodeURIComponent(model)}:generateContent`
  : `${CLOUD_API_BASE}${encodeURIComponent(model)}:generateContent`;

// Detects a Google Cloud Service Account JSON key (type: "service_account") so the browser
// or CLI can exchange it via RS256 JWT for an OAuth2 Bearer token automatically.
export function parseServiceAccount(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    try { obj = JSON.parse(t); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || obj.type !== 'service_account') return null;
  const project_id = typeof obj.project_id === 'string' ? obj.project_id.trim() : '';
  const client_email = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
  const private_key = typeof obj.private_key === 'string' ? obj.private_key.trim() : '';
  if (!project_id || !client_email || !private_key.includes('BEGIN PRIVATE KEY')) return null;
  return { type: 'service_account', project_id, client_email, private_key, token_uri: OAUTH_TOKEN_URL };
}

function b64urlBytes(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlText(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const tokenCache = new Map();
export function clearTokenCache() { tokenCache.clear(); }

// Exchanges a Service Account JSON key for a short-lived OAuth2 Bearer token using standard
// WebCrypto RS256 JWT signing (works in both browsers and Node 22+ with zero dependencies).
export async function exchangeServiceAccountToken(sa, { signal, fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000) } = {}) {
  const parsed = parseServiceAccount(sa);
  if (!parsed) throw new GeminiError('cloudkey', 'Invalid service account JSON', 400);
  const now = nowSec();
  const cacheKey = `${parsed.project_id}:${parsed.client_email}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60 > now) return { token: cached.token, projectId: parsed.project_id };

  let signature;
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({
    iss: parsed.client_email,
    sub: parsed.client_email,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  }))}`;
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pemToDer(parsed.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
    signature = b64urlBytes(new Uint8Array(sigBuf));
  } catch (e) {
    throw new GeminiError('cloudkey', `Service account key error: ${e.message || 'invalid private_key'}`, 400);
  }

  let res;
  try {
    res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(`${unsigned}.${signature}`)}`,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    if (signal?.aborted) throw new GeminiError('aborted');
    throw new GeminiError('network', e.message);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const msg = data?.error_description || data?.error?.message || data?.error || res.statusText || 'token exchange failed';
    throw new GeminiError('cloudkey', String(msg), res.status || 401);
  }
  const ttl = Number(data.expires_in) > 120 ? Number(data.expires_in) : 3600;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: now + ttl });
  return { token: data.access_token, projectId: parsed.project_id };
}

// Each of these takes 1,048,576 input tokens and returns up to 65,536.
export const MODELS = [
  { id: 'gemini-3.8-flash', free: true },
  { id: 'gemini-3.6-flash', free: true },
  { id: 'gemini-4-argon', free: false },
];
export const MODEL_INPUT_LIMIT = 1048576;

// Default chunk size. Far below the model limit because free-tier keys also
// have a tokens-per-minute cap (shown per project in AI Studio).
export const DEFAULT_CHUNK_TOKENS = 200000;
export const CHUNK_CHOICES = [50000, 100000, 200000, 400000, 800000];

// ---------- token estimate and chunking ----------

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;

// Deliberately high: one token per CJK character, one per 3 other characters.
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = text.length - text.replace(CJK, '').length;
  return Math.ceil(cjk + (text.length - cjk) / 3);
}

function cutLongLine(line, maxTokens) {
  const pieces = [];
  let rest = line;
  while (rest.length) {
    let len = Math.min(rest.length, maxTokens * 3);
    while (len > 1 && estimateTokens(rest.slice(0, len)) > maxTokens) len = Math.floor(len * 0.8);
    pieces.push(rest.slice(0, len));
    rest = rest.slice(len);
  }
  return pieces;
}

// Splits on line breaks, preferring a blank line once a chunk is 90% full,
// so a conversation is less likely to be cut in the middle.
export function splitIntoChunks(text, maxTokens) {
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  const flush = () => {
    if (cur.length && cur.some((l) => l.trim())) chunks.push(cur.join('\n'));
    cur = [];
    curTokens = 0;
  };
  for (const line of text.split('\n')) {
    const t = estimateTokens(line) + 1;
    if (t > maxTokens) {
      flush();
      chunks.push(...cutLongLine(line, maxTokens));
      continue;
    }
    if (curTokens + t > maxTokens) flush();
    if (!line.trim() && curTokens > maxTokens * 0.9) {
      flush();
      continue;
    }
    cur.push(line);
    curTokens += t;
  }
  flush();
  return chunks;
}

// Groups strings so each group's estimate stays under maxTokens, but always
// pairs at least two items so merging rounds keep shrinking. Two partial
// sheets are at most 2 x 65,536 output tokens, well under the input limit.
export function groupByTokens(items, maxTokens) {
  const groups = [];
  let cur = [];
  let curTokens = 0;
  for (const item of items) {
    const t = estimateTokens(item);
    if (cur.length >= 2 && curTokens + t > maxTokens) {
      groups.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(item);
    curTokens += t;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------- importing files ----------

const TEXT_KEYS = ['content', 'text', 'message', 'msg', 'value', 'body', 'parts'];
const ROLE_KEYS = ['role', 'author', 'sender', 'from', 'speaker', 'name', 'user'];
const TIME_KEYS = ['time', 'timestamp', 'create_time', 'created_at', 'date', 'datetime'];
const LABEL_KEYS = ['title', 'category', 'key', 'topic'];

function flattenText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(flattenText).filter(Boolean).join('\n');
  if (v && typeof v === 'object') {
    for (const k of TEXT_KEYS) if (k in v) return flattenText(v[k]);
  }
  return '';
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = firstString(v, ['role', 'name']);
      if (inner) return inner;
    }
  }
  return '';
}

function formatTime(t) {
  if (/^\d{9,13}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    if (!isNaN(d)) return d.toISOString().slice(0, 16).replace('T', ' ');
  }
  return t;
}

// Turns any chat or memory export into readable lines. Objects with a text
// field become "[time] role: text"; anything unrecognised falls back to the
// JSON itself, which Gemini can still read.
export function jsonToText(data) {
  const lines = [];
  const visit = (node, inArray) => {
    if (typeof node === 'string') {
      if (inArray && node.trim()) lines.push(node.trim());
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => visit(n, true));
    if (!node || typeof node !== 'object') return;
    const textKey = TEXT_KEYS.find((k) => k in node && flattenText(node[k]).trim());
    const role = textKey ? firstString(node, ROLE_KEYS.filter((k) => k !== textKey)) : '';
    const time = textKey ? firstString(node, TIME_KEYS) : '';
    const label = textKey ? firstString(node, LABEL_KEYS.filter((k) => k !== textKey)) : '';
    const v = textKey && node[textKey];
    // {message: {...}} with nothing else to say is only a wrapper: look inside.
    const wrapper = v && typeof v === 'object' && !Array.isArray(v) && !role && !time && !label;
    if (textKey && !wrapper) {
      const text = flattenText(v).trim();
      const head = [time && `[${formatTime(time)}]`, label && `(${label})`, role && `${role}:`]
        .filter(Boolean)
        .join(' ');
      lines.push(head ? `${head} ${text}` : text);
      return;
    }
    Object.values(node).forEach((v) => visit(v, false));
  };
  visit(data, false);
  return lines.length ? lines.join('\n') : JSON.stringify(data, null, 1);
}

export function normalizeText(s) {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function textFromFile(name, raw) {
  const content = normalizeText(raw);
  if (/\.json$/i.test(name)) {
    try {
      return jsonToText(JSON.parse(content));
    } catch {
      return content;
    }
  }
  return content;
}

export function combineSources(pasted, files) {
  const parts = [];
  if (pasted.trim()) parts.push(normalizeText(pasted).trim());
  for (const f of files) parts.push(`=== ${f.name} ===\n${f.text.trim()}`);
  return parts.join('\n\n');
}

// ---------- prompts and request bodies ----------

const NOTE = { type: 'string' };
const LIST = { type: 'array', items: NOTE };
const WHO = { type: 'string', enum: ['owner', 'pet', 'both', 'other'] };

export const SHEET_SCHEMA = {
  type: 'object',
  properties: {
    pet_name: { type: 'string', description: "The AI pet or companion's name as used in the logs." },
    owner: {
      type: 'object',
      properties: {
        names: { ...LIST, description: 'What the pet calls the owner.' },
        summary: { type: 'string', description: 'Who the owner is, as the pet knows them, in 2-4 sentences.' },
        facts: { ...LIST, description: 'Concrete things the pet should remember about the owner.' },
      },
      required: ['names', 'summary', 'facts'],
    },
    personality: {
      type: 'object',
      properties: {
        traits: { ...LIST, description: '3-8 short personality traits.' },
        speaking_style: { type: 'string', description: 'Tone, sentence length, emoji, verbal tics, how it addresses the owner.' },
        catchphrases: LIST,
        sample_lines: { ...LIST, description: '3-6 short real quotes in its voice, in the original language.' },
      },
      required: ['traits', 'speaking_style', 'catchphrases', 'sample_lines'],
    },
    nicknames: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: NOTE, who: WHO, meaning: NOTE },
        required: ['name', 'who', 'meaning'],
      },
    },
    in_jokes: {
      type: 'array',
      items: { type: 'object', properties: { joke: NOTE, origin: NOTE }, required: ['joke', 'origin'] },
    },
    promises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          promise: NOTE,
          by: WHO,
          when: NOTE,
          status: { type: 'string', enum: ['kept', 'pending', 'broken', 'unknown'] },
        },
        required: ['promise', 'by', 'when', 'status'],
      },
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: { when: NOTE, event: NOTE, why_it_matters: NOTE },
        required: ['when', 'event', 'why_it_matters'],
      },
    },
    likes: {
      type: 'array',
      items: { type: 'object', properties: { who: WHO, thing: NOTE }, required: ['who', 'thing'] },
    },
    dislikes: {
      type: 'array',
      items: { type: 'object', properties: { who: WHO, thing: NOTE }, required: ['who', 'thing'] },
    },
    wake_up_note: { type: 'string' },
  },
  required: ['pet_name', 'owner', 'personality', 'nicknames', 'in_jokes', 'promises', 'timeline', 'likes', 'dislikes', 'wake_up_note'],
};

const LANG_NAME = { zh: 'Simplified Chinese (简体中文)', en: 'English' };

function baseRules({ lang, petName, ownerName }) {
  return [
    'You help the owner of an AI pet or AI companion keep its memories when its chat context fills up.',
    'Only record what the text actually says. Never invent details; leave a list empty rather than guess.',
    `Write every field in ${LANG_NAME[lang] || LANG_NAME.zh}, except quotes, which stay in their original language and under 30 words.`,
    'Leave out phone numbers, home addresses, ID numbers, school or company names, passwords, API keys and payment details even if they appear.',
    "Never guess anyone's gender. Unless the logs state it, refer to people by name, or as TA in Chinese and they/them in English.",
    'Fields: owner = who the owner is; personality = how the pet behaves and talks; nicknames = names either side uses, with "who" saying whose nickname it is; in_jokes = running jokes and their origin; promises = things promised, with their latest status; timeline = moments that mattered to the relationship, oldest first, "when" as written in the logs; likes / dislikes = with "who" saying whose.',
    petName && `The pet is called "${petName}".`,
    ownerName && `In the logs the owner appears as "${ownerName}".`,
  ]
    .filter(Boolean)
    .join('\n');
}

const WAKE_RULE =
  'Then write wake_up_note: a short note to paste at the start of a fresh session or into a memory plugin. Address the pet as "you". Say who it is, who its owner is and what it calls them, how it talks, the few shared memories and in-jokes that matter most, and any pending promises. Keep it warm and factual, under 250 words in English or 400 characters in Chinese.';

const config = (thinking) => ({
  store: false,
  generation_config: { thinking_level: thinking, max_output_tokens: 32768 },
  response_format: { type: 'text', mime_type: 'application/json', schema: SHEET_SCHEMA },
});

// The whole log fits in one request: read it and write the final sheet.
export function buildSingleRequest({ model, text, ...opts }) {
  return {
    model,
    system_instruction: `${baseRules(opts)}\n${WAKE_RULE}`,
    input: `Chat logs and memory exports:\n\n${text}`,
    ...config('medium'),
  };
}

export function buildChunkRequest({ model, text, index, total, ...opts }) {
  return {
    model,
    system_instruction: `${baseRules(opts)}\nYou are reading part ${index} of ${total} of one chat history. Leave wake_up_note as an empty string.`,
    input: `Part ${index} of ${total}:\n\n${text}`,
    ...config('low'),
  };
}

// final = true writes the wake-up note; otherwise it is an in-between merge.
export function buildMergeRequest({ model, sheets, final, ...opts }) {
  return {
    model,
    system_instruction: [
      baseRules(opts),
      'You will receive partial memory sheets (a JSON array) taken from consecutive parts of the same chat history, oldest first.',
      'Merge them into one sheet: remove duplicates, keep the most specific wording, keep the timeline in order, and let later parts update a promise\'s status.',
      final ? WAKE_RULE : 'Leave wake_up_note as an empty string.',
    ].join('\n'),
    input: `Partial memory sheets:\n${JSON.stringify(sheets)}`,
    ...config(final ? 'medium' : 'low'),
  };
}

// ---------- responses ----------

// Current Interactions schema is `steps`; `outputs` was the pre-June-2026 one. Agent Platform's
// generateContent answers in `candidates[0].content.parts` (thought parts are skipped).
export function textFromInteraction(resp) {
  const texts = [];
  for (const step of (resp && resp.steps) || []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content || []) if (c.type === 'text' && c.text) texts.push(c.text);
  }
  if (!texts.length) {
    for (const o of (resp && resp.outputs) || []) if (o.type === 'text' && o.text) texts.push(o.text);
  }
  if (!texts.length) {
    const cand = resp && Array.isArray(resp.candidates) ? resp.candidates[0] : null;
    for (const p of (cand && cand.content && cand.content.parts) || []) if (typeof p?.text === 'string' && p.text && !p.thought) texts.push(p.text);
  }
  return texts.join('');
}

// ---------- Agent Platform (generateContent) ----------

// The JSON schema above, in the Schema form generateContent takes: upper-case types, enums
// only on strings (an integer enum is dropped; minimum/maximum carry a numeric range).
export function cloudSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (Array.isArray(s.enum) && s.type === 'string') out.enum = s.enum.map(String);
  for (const k of ['minimum', 'maximum']) if (typeof s[k] === 'number') out[k] = s[k];
  if (s.items) out.items = cloudSchema(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, cloudSchema(v)]));
  if (Array.isArray(s.required)) out.required = s.required;
  return out;
}

// One Interactions request (system_instruction, input, generation_config, response_format)
// as the equivalent generateContent request.
export function toCloudBody(body) {
  const gc = body.generation_config || {};
  const generationConfig = { maxOutputTokens: gc.max_output_tokens ?? 32768 };
  if (gc.thinking_level) generationConfig.thinkingConfig = { thinkingLevel: String(gc.thinking_level).toUpperCase() };
  const rf = body.response_format;
  if (rf?.mime_type) generationConfig.responseMimeType = rf.mime_type;
  if (rf?.schema) generationConfig.responseSchema = cloudSchema(rf.schema);
  return {
    ...(body.system_instruction ? { systemInstruction: { parts: [{ text: body.system_instruction }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: String(body.input ?? '') }] }],
    generationConfig,
  };
}

// Token counts in the Interactions shape, whichever API answered.
export function usageOf(data) {
  if (data?.usage) return data.usage;
  const u = data?.usageMetadata;
  if (!u) return null;
  return { total_input_tokens: u.promptTokenCount || 0, total_output_tokens: u.candidatesTokenCount || 0, total_thought_tokens: u.thoughtsTokenCount || 0 };
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const objList = (v, keys) =>
  (Array.isArray(v) ? v : [])
    .filter((o) => o && typeof o === 'object')
    .map((o) => Object.fromEntries(keys.map((k) => [k, str(o[k])])))
    .filter((o) => str(o[keys[0]]));

export function normalizeSheet(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const owner = s.owner || {};
  const p = s.personality || {};
  return {
    pet_name: str(s.pet_name),
    owner: { names: strList(owner.names), summary: str(owner.summary), facts: strList(owner.facts) },
    personality: {
      traits: strList(p.traits),
      speaking_style: str(p.speaking_style),
      catchphrases: strList(p.catchphrases),
      sample_lines: strList(p.sample_lines),
    },
    nicknames: objList(s.nicknames, ['name', 'who', 'meaning']),
    in_jokes: objList(s.in_jokes, ['joke', 'origin']),
    promises: objList(s.promises, ['promise', 'by', 'when', 'status']),
    timeline: objList(s.timeline, ['event', 'when', 'why_it_matters']),
    likes: objList(s.likes, ['thing', 'who']),
    dislikes: objList(s.dislikes, ['thing', 'who']),
    wake_up_note: str(s.wake_up_note),
  };
}

// One entry per memory: these become the stars in the memory sky.
export function memoryItems(raw) {
  const s = normalizeSheet(raw);
  return [
    ...s.timeline.map((e) => [e.when, e.event].filter(Boolean).join(' ')),
    ...s.promises.map((p) => p.promise),
    ...s.nicknames.map((n) => n.name),
    ...s.in_jokes.map((j) => j.joke),
    ...s.owner.facts,
    ...s.personality.traits,
    ...s.likes.map((l) => l.thing),
    ...s.dislikes.map((l) => l.thing),
  ].filter(Boolean);
}

export function parseSheet(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return normalizeSheet(JSON.parse(cleaned));
}

// ---------- calling Gemini ----------

export class GeminiError extends Error {
  constructor(kind, message, httpStatus) {
    super(message || kind);
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

// Google's docs don't publish the wording of a region refusal, so this
// matches the usual phrasings; anything else falls through to the raw error.
const REGION = /location is not supported|not (?:supported|available) in your (?:country|region|location)|(?:country|region|territory) is not supported/i;

function retryDelayMs(err) {
  for (const d of (err && err.details) || []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d && d.retryDelay);
    if (m) return Math.ceil(Number(m[1]) * 1000) + 500;
  }
  return null;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new GeminiError('aborted'));
    }, { once: true });
  });

// Sends one request with the owner's key, straight to Google. Retries rate
// limits and overloads a few times; stops at once on anything else.
// Waits before each retry of a busy (500/503) or per-minute-limited (429) answer.
export const BACKOFF_MS = [5000, 15000, 30000];

// route: 'studio' sends to AI Studio's Gemini API (Interactions), 'cloud' to Agent Platform
// (generateContent, billed to the Cloud project). When `key` is a Google Cloud Service Account
// JSON (`type: "service_account"`), it is automatically exchanged for an OAuth2 Bearer token
// and sent to the project's global Agent Platform endpoint.
export async function callGemini({ body, key, route = 'studio', signal, onWait, fetchImpl = fetch, backoff = BACKOFF_MS }) {
  const sa = parseServiceAccount(key);
  const cloud = route === 'cloud' || Boolean(sa);
  for (let attempt = 0; ; attempt++) {
    let res;
    let authHeader = { 'x-goog-api-key': key };
    let url = cloud ? cloudUrl(body.model) : API_URL;
    if (sa) {
      const { token, projectId } = await exchangeServiceAccountToken(sa, { signal, fetchImpl });
      authHeader = { Authorization: `Bearer ${token}` };
      url = cloudUrl(body.model, projectId);
    }
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(cloud ? toCloudBody(body) : body),
        signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      if (signal?.aborted) throw new GeminiError('aborted');
      throw new GeminiError('network', e.message);
    }
    const data = await res.json().catch(() => null);
    if (res.ok) {
      if (data?.status === 'failed') throw new GeminiError('failed', data?.error?.message, res.status);
      const text = textFromInteraction(data);
      const finish = cloud && Array.isArray(data?.candidates) ? String(data.candidates[0]?.finishReason || '') : '';
      if (data?.status === 'incomplete' || /MAX_TOKENS/.test(finish)) throw new GeminiError('incomplete', text.slice(-200), res.status);
      if (cloud && !text && (data?.promptFeedback?.blockReason || /SAFETY|BLOCKLIST|PROHIBITED|SPII|RECITATION/.test(finish))) throw new GeminiError('failed', finish || data.promptFeedback.blockReason, res.status);
      if (!text) throw new GeminiError('empty', JSON.stringify(data).slice(0, 300), res.status);
      try {
        return { sheet: parseSheet(text), usage: usageOf(data) };
      } catch {
        throw new GeminiError('badjson', text.slice(0, 300), res.status);
      }
    }
    const err = (Array.isArray(data) ? data[0] : data)?.error || {};
    if (REGION.test(err.message || '')) throw new GeminiError('region', err.message, res.status);
    // Prepay billing at $0: Google stops every Gemini API call the account pays for.
    if (res.status === 402) throw new GeminiError('prepay', err.message || res.statusText, res.status);
    // Agent Platform takes only a key that carries an identity (one made on its API keys
    // page) in a project with its API on; an AI Studio key gets 401 here.
    if (cloud && (res.status === 401 || res.status === 403)) throw new GeminiError('cloudkey', err.message || res.statusText, res.status);
    const daily = /quota_exceeded|per ?day|daily/i.test(`${err.status} ${err.message}`);
    const busy = res.status === 500 || res.status === 503;
    if ((busy || (res.status === 429 && !daily)) && attempt < backoff.length) {
      const wait = retryDelayMs(err) ?? backoff[attempt];
      onWait?.(Math.round(wait / 1000), busy ? 'busy' : 'ratelimit');
      await sleep(wait, signal);
      continue;
    }
    const kind = busy ? 'busy' : res.status === 429 ? 'ratelimit' : 'http';
    throw new GeminiError(kind, err.message || res.statusText, res.status);
  }
}

// route 'auto': AI Studio first. When it can't answer now (busy 503, out of quota 429, Prepay
// at $0 402) or won't take the key (403), the same key gets one try on Agent Platform;
// onRoute('cloud') tells the caller to send the rest of the run there. If Agent Platform
// refuses the key too, the first error stands, with cloudStatus and cloudMessage (Google's
// own words) set. The CLI does the same with two separate keys.
export async function callGeminiAuto({ route = 'auto', onRoute, ...opts }) {
  if (parseServiceAccount(opts.key)) {
    onRoute?.('cloud');
    return callGemini({ ...opts, route: 'cloud' });
  }
  if (route !== 'auto') return callGemini({ ...opts, route });
  try {
    return await callGemini({ ...opts, route: 'studio' });
  } catch (e) {
    const refused = e instanceof GeminiError && (['prepay', 'ratelimit', 'busy'].includes(e.kind) || (e.kind === 'http' && e.httpStatus === 403));
    if (!refused) throw e;
    let out;
    try {
      out = await callGemini({ ...opts, route: 'cloud' });
    } catch (e2) {
      if (!(e2 instanceof GeminiError) || !(e2.kind === 'cloudkey' || (e2.kind === 'http' && e2.httpStatus === 404))) throw e2;
      e.cloudStatus = e2.httpStatus;
      e.cloudMessage = e2.message;
      throw e;
    }
    onRoute?.('cloud');
    return out;
  }
}

// ---------- the whole job ----------

// callModel(body) must resolve to { sheet, usage }. The page passes a
// callGemini wrapper; tests and demo mode pass a stub.
// onPartial(sheet, i) gets each part's notes as they arrive (the page turns
// them into stars and keeps them); cached[i] holds parts a failed run already
// read, so a retry skips them.
export async function runPipeline({ text, chunkTokens, model, lang, petName, ownerName, callModel, cached = [], onProgress = () => {}, onPartial = () => {} }) {
  const opts = { model, lang, petName, ownerName };
  const usage = { input: 0, output: 0, requests: 0 };
  const call = async (body) => {
    const r = await callModel(body);
    usage.requests += 1;
    usage.input += r.usage?.total_input_tokens || 0;
    usage.output += (r.usage?.total_output_tokens || 0) + (r.usage?.total_thought_tokens || 0);
    return normalizeSheet(r.sheet);
  };

  const chunks = splitIntoChunks(text, chunkTokens);
  if (!chunks.length) throw new GeminiError('nothing');
  if (chunks.length === 1) {
    onProgress({ phase: 'single' });
    return { sheet: await call(buildSingleRequest({ ...opts, text: chunks[0] })), chunks: 1, usage };
  }

  let sheets = [];
  for (let i = 0; i < chunks.length; i++) {
    let part = cached[i];
    if (part) {
      onProgress({ phase: 'cached', i: i + 1, n: chunks.length });
    } else {
      onProgress({ phase: 'chunk', i: i + 1, n: chunks.length });
      part = await call(buildChunkRequest({ ...opts, text: chunks[i], index: i + 1, total: chunks.length }));
    }
    sheets.push(part);
    onPartial(part, i);
  }

  // Merge in rounds until everything fits in one final request.
  for (let round = 1; ; round++) {
    const groups = groupByTokens(sheets.map((s) => JSON.stringify(s)), chunkTokens);
    if (groups.length === 1 || round > 10) {
      onProgress({ phase: 'merge', n: sheets.length });
      const sheet = await call(buildMergeRequest({ ...opts, sheets, final: true }));
      return { sheet, chunks: chunks.length, usage };
    }
    const next = [];
    for (let g = 0; g < groups.length; g++) {
      onProgress({ phase: 'premerge', i: g + 1, n: groups.length });
      const part = groups[g].map((s) => JSON.parse(s));
      next.push(part.length === 1 ? part[0] : await call(buildMergeRequest({ ...opts, sheets: part, final: false })));
    }
    sheets = next;
  }
}

// ---------- export ----------

export function sheetToJSON(sheet, meta) {
  return JSON.stringify({ app: 'AI Memory Keeper', version: APP_VERSION, ...meta, memory: sheet }, null, 2);
}

// t: the export strings for the sheet's language (see i18n.js `md`).
export function sheetToMarkdown(sheet, meta, t) {
  const out = [];
  const who = (w) => t.who[w] || w;
  const list = (items) => items.forEach((i) => out.push(`- ${i}`));
  const section = (title, has, fill) => {
    if (!has) return;
    out.push('', `## ${title}`, '');
    fill();
  };
  out.push(`# ${t.title(sheet.pet_name)}`, '', `> ${t.made(meta)}`);

  section(t.wake, sheet.wake_up_note, () => out.push('```text', sheet.wake_up_note, '```'));
  section(t.owner, sheet.owner.summary || sheet.owner.names.length || sheet.owner.facts.length, () => {
    if (sheet.owner.names.length) out.push(`**${t.calledBy}** ${sheet.owner.names.join(t.sep)}`, '');
    if (sheet.owner.summary) out.push(sheet.owner.summary, '');
    list(sheet.owner.facts);
  });
  const p = sheet.personality;
  section(t.personality, p.traits.length || p.speaking_style || p.catchphrases.length || p.sample_lines.length, () => {
    if (p.traits.length) out.push(`**${t.traits}** ${p.traits.join(t.sep)}`, '');
    if (p.speaking_style) out.push(`**${t.style}** ${p.speaking_style}`, '');
    if (p.catchphrases.length) out.push(`**${t.catchphrases}** ${p.catchphrases.map(t.quote).join(' ')}`, '');
    p.sample_lines.forEach((l) => out.push(`> ${l}`, ''));
  });
  section(t.nicknames, sheet.nicknames.length, () =>
    list(sheet.nicknames.map((n) => `**${n.name}**${t.lp}${who(n.who)}${t.rp}${n.meaning ? `${t.colon}${n.meaning}` : ''}`)));
  section(t.jokes, sheet.in_jokes.length, () =>
    list(sheet.in_jokes.map((j) => `**${j.joke}**${j.origin ? ` — ${j.origin}` : ''}`)));
  section(t.promises, sheet.promises.length, () =>
    list(sheet.promises.map((x) => `[${t.status[x.status] || x.status}] ${x.promise}${t.lp}${[who(x.by), x.when].filter(Boolean).join(t.sep)}${t.rp}`)));
  section(t.timeline, sheet.timeline.length, () =>
    list(sheet.timeline.map((e) => `**${e.when || '?'}** ${e.event}${e.why_it_matters ? ` — ${e.why_it_matters}` : ''}`)));
  section(t.likes, sheet.likes.length, () => list(sheet.likes.map((l) => `${who(l.who)}${t.colon}${l.thing}`)));
  section(t.dislikes, sheet.dislikes.length, () => list(sheet.dislikes.map((l) => `${who(l.who)}${t.colon}${l.thing}`)));
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
