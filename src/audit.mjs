import path from 'node:path';
import { read, atomic, stamp } from './safety.mjs';

// Local model check. Reads only the transcript segment the hook already queued
// plus the base-URL hostname from the agent's environment. No network, no
// credentials, no transcript text is stored: only model names, counts and codes.
// It catches careless relays (wrong model name, leaked <think>, self-introduction);
// a relay that rewrites every field cannot be detected this way.

const SAFE_NAME = /^[\w.:/@<>+-]{1,80}$/;
const cleanName = s => (typeof s === 'string' && SAFE_NAME.test(s) ? s : 'unrecognized');
const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };

export function family(name = '') {
  const n = String(name).toLowerCase();
  if (/claude|anthropic|sonnet|opus|haiku/.test(n)) return 'claude';
  if (/deepseek/.test(n)) return 'deepseek';
  if (/glm|zhipu|bigmodel/.test(n)) return 'glm';
  if (/qwen|qwq|dashscope/.test(n)) return 'qwen';
  if (/kimi|moonshot/.test(n)) return 'kimi';
  if (/gemini/.test(n)) return 'gemini';
  if (/llama/.test(n)) return 'llama';
  if (/gpt|codex|openai|^o\d/.test(n)) return 'gpt';
  return 'other';
}

// Vendors' own endpoints: there the vendor's model is the expected one.
const VENDOR_HOSTS = {
  'api.anthropic.com': 'claude',
  'open.bigmodel.cn': 'glm', 'api.z.ai': 'glm',
  'api.deepseek.com': 'deepseek',
  'api.moonshot.cn': 'kimi', 'api.moonshot.ai': 'kimi',
  'dashscope.aliyuncs.com': 'qwen', 'dashscope-intl.aliyuncs.com': 'qwen',
};

// Hostname only: some relays put the key in the URL path.
export function hostOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch { return null; }
}

const SELF_ID = [
  ['deepseek', /我是\s*DeepSeek|由深度求索|I(?:'m| am) DeepSeek|developed by DeepSeek/i],
  ['glm', /我是\s*(?:ChatGLM|GLM|智谱)|由智谱|I(?:'m| am) (?:ChatGLM|GLM)|developed by Zhipu/i],
  ['qwen', /我是\s*(?:通义千问|Qwen)|I(?:'m| am) Qwen|developed by Alibaba/i],
  ['kimi', /我是\s*Kimi|由月之暗面|I(?:'m| am) Kimi|developed by Moonshot/i],
  ['gpt', /我是\s*ChatGPT|I(?:'m| am) ChatGPT|trained by OpenAI/i],
  ['gemini', /我是\s*Gemini(?!娘)|I(?:'m| am) Gemini\b(?!-chan)|trained by Google/i],
  ['llama', /I(?:'m| am) Llama|developed by Meta AI/i],
];

function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => ['text', 'output_text'].includes(b?.type)).map(b => b.text || '').join('\n');
}
function scanText(text, out) {
  if (!text) return;
  if (/<think>|<\/think>/.test(text)) out.thinkTags++;
  for (const [vendor, re] of SELF_ID) if (re.test(text)) bump(out.selfId, vendor);
}

export function scanSegment(raw, format) {
  const out = { kind: 'unknown', messages: 0, models: {}, requested: {}, swaps: {}, nonStandardIds: 0, cacheReported: 0, cacheHits: 0, thinkTags: 0, selfId: {} };
  if (format !== 'jsonl' || typeof raw !== 'string') return out;
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    // Codex rollout: the active model is in turn_context.
    if (r.type === 'turn_context' && typeof r.payload?.model === 'string') { out.kind = 'codex'; bump(out.models, cleanName(r.payload.model)); continue; }
    if (r.type === 'response_item' && r.payload?.role === 'assistant') { out.kind = 'codex'; out.messages++; scanText(blocksText(r.payload.content), out); continue; }
    // Claude Code: one line per streamed block, all sharing message.id and usage.
    if (r.type !== 'assistant' || !r.message || r.isSidechain) continue;
    const m = r.message;
    if (m.model === '<synthetic>') continue; // locally generated, not from the API
    out.kind = 'claude';
    scanText(blocksText(m.content), out);
    const id = typeof m.id === 'string' ? m.id : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.messages++;
    if (typeof m.model === 'string') bump(out.models, cleanName(m.model));
    // Claude Code records the model it asked for next to the one that answered.
    const req = typeof r.requestedModel === 'string' ? cleanName(r.requestedModel) : null;
    if (req) bump(out.requested, req);
    if (req && typeof m.model === 'string' && req !== cleanName(m.model)) bump(out.swaps, `${req} -> ${cleanName(m.model)}`);
    if (!/^msg_[A-Za-z0-9_]{16,}$/.test(id)) out.nonStandardIds++;
    const u = m.usage;
    if (u && typeof u === 'object' && ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u)) {
      out.cacheReported++;
      if ((u.cache_read_input_tokens || 0) > 0) out.cacheHits++;
    }
  }
  return out;
}

const auditFile = ctx => path.join(ctx.dir, 'audit.json');

export function recordAudit(ctx, job, env = process.env) {
  const scan = scanSegment(job.raw, job.format);
  if (scan.kind === 'unknown') return null;
  const doc = read(auditFile(ctx), { jobs: [] });
  const jobs = Array.isArray(doc?.jobs) ? doc.jobs.filter(j => j?.id !== job.id) : [];
  jobs.push({
    id: job.id, source: job.source, time: stamp(), scan,
    requested: env.ANTHROPIC_MODEL ? cleanName(env.ANTHROPIC_MODEL) : null,
    anthropicHost: hostOf(env.ANTHROPIC_BASE_URL), openaiHost: hostOf(env.OPENAI_BASE_URL),
  });
  atomic(auditFile(ctx), { jobs: jobs.slice(-30) });
  return scan;
}

// Combine the latest transcript source's recent segments into one verdict.
export function assess(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return { level: 'unknown', signals: [] };
  const latest = jobs.at(-1);
  const recent = jobs.filter(j => j.source === latest.source).slice(-10);
  const total = { messages: 0, models: {}, requested: {}, swaps: {}, nonStandardIds: 0, cacheReported: 0, cacheHits: 0, thinkTags: 0, selfId: {} };
  for (const { scan } of recent) {
    total.messages += scan.messages; total.nonStandardIds += scan.nonStandardIds;
    total.cacheReported += scan.cacheReported; total.cacheHits += scan.cacheHits; total.thinkTags += scan.thinkTags;
    for (const field of ['models', 'requested', 'swaps', 'selfId']) {
      for (const [k, v] of Object.entries(scan[field] || {})) total[field][k] = (total[field][k] || 0) + v;
    }
  }
  const kind = latest.scan.kind;
  const host = kind === 'claude' ? latest.anthropicHost : latest.openaiHost;
  const result = { level: 'ok', agentKind: kind, models: total.models, messages: total.messages, host, expected: null, expectedFrom: null, signals: [] };
  if (!total.messages) return { ...result, level: 'unknown' };
  // Codex can use many providers and its rollout names only the configured model, so
  // nothing here can tell a swap: keep the model names as plain facts and give no verdict
  // (no "ok", no warning), wherever the check is shown.
  if (kind === 'codex') return { ...result, level: 'not_checked' };

  // Only Claude Code gets an expected family.
  if (kind === 'claude') {
    const asked = Object.entries(total.requested).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (VENDOR_HOSTS[host]) { result.expected = VENDOR_HOSTS[host]; result.expectedFrom = 'host'; }
    else if (asked && family(asked) !== 'other') { result.expected = family(asked); result.expectedFrom = 'transcript'; }
    else if (latest.requested) { result.expected = family(latest.requested); result.expectedFrom = 'ANTHROPIC_MODEL'; }
    else { result.expected = 'claude'; result.expectedFrom = 'assumed'; }
    if (host && host !== 'api.anthropic.com' && !VENDOR_HOSTS[host]) result.signals.push({ code: 'via_relay', strength: 'info' });
  }
  const names = Object.keys(total.models).filter(n => n !== 'unrecognized');
  if (names.length > 1) result.signals.push({ code: 'model_switched', strength: 'info', models: names });
  if (result.expected && result.expected !== 'other') {
    const off = names.filter(n => family(n) !== result.expected);
    if (off.length) result.signals.push({ code: 'model_family_mismatch', strength: 'strong', got: off });
    const vendors = Object.keys(total.selfId).filter(v => v !== result.expected);
    if (vendors.length) result.signals.push({ code: 'self_identification', strength: 'medium', vendors });
    if (result.expected === 'claude' && total.thinkTags) result.signals.push({ code: 'think_tags', strength: 'medium', count: total.thinkTags });
    // Asked for one model, got another of the expected family: a lower tier is a medium
    // signal (e.g. Opus answered by Haiku), a different version of the same tier is weak.
    const tier = n => (/opus/.test(n) ? 3 : /sonnet/.test(n) ? 2 : /haiku/.test(n) ? 1 : 0);
    for (const pair of Object.keys(total.swaps)) {
      const [from, to] = pair.split(' -> ');
      if (family(to) !== result.expected || family(from) !== result.expected) continue;
      if (tier(from) && tier(to) && tier(to) < tier(from)) result.signals.push({ code: 'model_tier_mismatch', strength: 'medium', from, to });
      else result.signals.push({ code: 'model_version_mismatch', strength: 'weak', from, to });
    }
  }
  if (kind === 'claude' && result.expected === 'claude') {
    if (total.messages >= 3 && total.nonStandardIds * 2 >= total.messages) result.signals.push({ code: 'nonstandard_message_ids', strength: 'weak' });
    if (total.messages >= 10 && !total.cacheHits) result.signals.push({ code: 'prompt_cache_never_hit', strength: 'weak' });
  }
  const has = s => result.signals.some(x => x.strength === s);
  result.level = has('strong') || has('medium') ? 'suspect' : has('weak') ? 'notice' : 'ok';
  return result;
}

export function modelCheck(ctx) {
  try {
    const doc = read(auditFile(ctx), { jobs: [] });
    const jobs = Array.isArray(doc?.jobs) ? doc.jobs : [];
    return { ...assess(jobs), checkedAt: jobs.at(-1)?.time || null };
  } catch { return { level: 'unknown', signals: [], checkedAt: null }; }
}
