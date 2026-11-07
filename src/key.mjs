import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, noLinks } from './safety.mjs';
import { encodedScript, psArgs, inlineArgs, psQuote } from './powershell.mjs';
import { spawnOutside } from './outside.mjs';
import { parseServiceAccount } from '../vendor/core.js';

// The person's Gemini API key, kept only on this computer, so an agent that is already
// running doesn't need GEMINI_API_KEY in its environment. GEMINI_API_KEY still wins.
// Windows: encrypted with DPAPI for the current Windows user. Elsewhere: a file only this
// user can read (not encrypted). The key is never printed, logged, written to hook files
// or passed on a command line: it moves only through a pipe or the key window itself.

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_SCRIPT = path.join(here, 'key-window.ps1');
const WINDOW_XAML = path.join(here, 'key-window.xaml');
const LAUNCHER = path.join(here, 'key-launch.mjs');
const ENTROPY = 'ai-memory-keeper/gemini-key/v1';
const KEY_SHAPE = /^[\x21-\x7e]{20,200}$/;

// Two keys, each stored the same way: "studio" for AI Studio's Gemini API (free tier),
// "cloud" for Google Cloud's Agent Platform (billed to the Cloud project, Cloud credits).
const KINDS = {
  studio: { base: 'gemini-key', entropy: ENTROPY },
  cloud: { base: 'cloud-key', entropy: 'ai-memory-keeper/cloud-key/v1' },
};
const kindOf = kind => (kind === 'cloud' ? KINDS.cloud : KINDS.studio);

export const keyFile = (ctx, platform = process.platform, kind = 'studio') => path.join(ctx.home, kindOf(kind).base + (platform === 'win32' ? '.dpapi' : ''));
const storedFrom = platform => (platform === 'win32' ? 'stored on this computer, encrypted for this Windows user' : 'stored on this computer, readable only by this user');

// Which way a save goes first: "auto" (AI Studio, then Agent Platform) or "cloud".
const routeFile = ctx => path.join(ctx.home, 'route.json');
export function routeSetting(ctx) {
  try { return JSON.parse(fs.readFileSync(routeFile(ctx), 'utf8'))?.route === 'cloud' ? 'cloud' : 'auto'; } catch { return 'auto'; }
}
export function setRoute(ctx, route) {
  if (!['auto', 'cloud'].includes(route)) fail('invalid_arguments');
  fs.mkdirSync(ctx.home, { recursive: true });
  noLinks(routeFile(ctx));
  fs.writeFileSync(routeFile(ctx), JSON.stringify({ route }) + '\n');
  return { route };
}

// Whether keys are available, without reading or decrypting them.
export function keyStatus(ctx, env = process.env, platform = process.platform) {
  const cloud = fs.existsSync(keyFile(ctx, platform, 'cloud')) ? { set: true, from: storedFrom(platform) } : { set: false, from: null };
  const extra = { cloud, route: routeSetting(ctx) };
  if (env.GEMINI_API_KEY) return { set: true, from: 'GEMINI_API_KEY', ...extra };
  if (fs.existsSync(keyFile(ctx, platform))) return { set: true, from: storedFrom(platform), ...extra };
  return { set: false, from: null, ...extra };
}

export async function storedKey(ctx, platform = process.platform, kind = 'studio') {
  const file = keyFile(ctx, platform, kind);
  if (!fs.existsSync(file)) return null;
  noLinks(file);
  if (platform !== 'win32') return fs.readFileSync(file, 'utf8').trim() || null;
  // Decrypted in PowerShell and handed back on stdout (base64), never as an argument.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; `
    + `$p=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes(${psQuote(file)}), [Text.Encoding]::UTF8.GetBytes(${psQuote(kindOf(kind).entropy)}), 'CurrentUser'); `
    + `[Console]::Out.Write([Convert]::ToBase64String($p))`;
  return new Promise(resolve => {
    const child = spawn('powershell.exe', inlineArgs(script), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.once('error', () => resolve(null));
    child.once('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(Buffer.from(out.trim(), 'base64').toString('utf8').trim() || null); } catch { resolve(null); }
    });
  });
}
export async function resolveKey(ctx, env = process.env) { return env.GEMINI_API_KEY || await storedKey(ctx); }
// The Agent Platform key: only the one stored by `amk key --cloud`.
export async function resolveCloudKey(ctx) { return storedKey(ctx, process.platform, 'cloud'); }

export function saveKey(ctx, key, platform = process.platform, kind = 'studio') {
  const raw = String(key ?? '').trim();
  const sa = parseServiceAccount(raw);
  if (!sa && !KEY_SHAPE.test(raw)) fail('invalid_key_format');
  key = sa ? JSON.stringify(sa) : raw;
  fs.mkdirSync(ctx.home, { recursive: true });
  const file = keyFile(ctx, platform, kind);
  noLinks(file);
  if (platform !== 'win32') {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, key + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return { saved: true, kind: kind === 'cloud' ? 'cloud' : 'studio', format: sa ? 'service_account_json' : 'api_key', where: storedFrom(platform) };
  }
  // The key goes to PowerShell on stdin and is encrypted there.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $k=[Console]::In.ReadToEnd().Trim(); `
    + `$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($k), [Text.Encoding]::UTF8.GetBytes(${psQuote(kindOf(kind).entropy)}), 'CurrentUser'); `
    + `$t=${psQuote(file + '.tmp')}; [IO.File]::WriteAllBytes($t, $b); Move-Item -LiteralPath $t -Destination ${psQuote(file)} -Force`;
  const r = spawnSync('powershell.exe', inlineArgs(script), { input: key, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  if (r.status !== 0 || !fs.existsSync(file)) fail('key_save_failed');
  return { saved: true, kind: kind === 'cloud' ? 'cloud' : 'studio', format: sa ? 'service_account_json' : 'api_key', where: storedFrom(platform) };
}
export function clearKey(ctx, platform = process.platform, kind = 'studio') {
  const file = keyFile(ctx, platform, kind);
  noLinks(file);
  const had = fs.existsSync(file);
  if (had) fs.unlinkSync(file);
  return { cleared: had };
}

// After the window saves a key: the tiny check's result in plain words. A key Google
// rejects is not kept; a busy, rate-limited or offline moment keeps it (saving retries).
const ANSWERS = {
  zh: {
    ok: '没问题，这个 key 可以用。',
    rejected: 'Google 不接受这个 key。请确认复制完整，或者在 AI Studio 重新创建一个。',
    region: 'Google 拒绝了这次请求：你所在的地区用不了 Gemini API。key 已保存。',
    ratelimit: 'key 没问题，只是免费额度暂时用完了，之后会自动再试。',
    busy: 'key 已保存。Gemini 现在很忙，之后会自动再试。',
    offline: '连不上 Gemini API。key 已保存，请检查网络。',
    missing: 'key 没有保存成功，请再试一次。',
    other: code => `key 已保存，但检查没通过（代号 ${code}）。可以稍后运行 amk gemini-check 再看。`,
    prepay: 'key 已保存，但 Google 停掉了它所在结算账号的 Gemini API 调用（预付费余额为 0，HTTP 402）。可以在 AI Studio 充值、换一个没开结算的项目的 key，或者用 amk key --cloud 加一个 Agent Platform 密钥。',
    cloudRejected: 'Agent Platform 不接受这个 key。要在 Google Cloud 的「Agent Platform → API 密钥」页面创建，项目里也要先启用 Agent Platform API；AI Studio 的 key 在这里用不了。',
  },
  en: {
    ok: 'All good: this key works.',
    rejected: "Google didn't accept this key. Check you copied all of it, or create a new one in AI Studio.",
    region: "Google refused the request: the Gemini API isn't available where you are. The key is saved.",
    ratelimit: 'The key works, but the free quota is used up for now. Saving will try again later.',
    busy: 'Saved. Gemini is busy right now; saving will try again later.',
    offline: "Can't reach the Gemini API. The key is saved; check your network.",
    missing: "The key wasn't saved. Please try again.",
    other: code => `Saved, but the check didn't pass (code ${code}). You can run amk gemini-check later.`,
    prepay: "The key is saved, but Google has stopped the Gemini API for its billing account (Prepay balance at $0, HTTP 402). Add Prepay credit in AI Studio, use a key from a project without billing, or add an Agent Platform key with amk key --cloud.",
    cloudRejected: "Agent Platform didn't accept this key. Create it on Google Cloud's \"Agent Platform > API keys\" page, with the Agent Platform API turned on in that project; an AI Studio key doesn't work there.",
  },
};
export function keyCheckAnswer(result, lang = 'zh', kind = 'studio') {
  const a = ANSWERS[lang === 'en' ? 'en' : 'zh'];
  if (result?.ok) return { ok: true, keep: true, reason: a.ok };
  const code = String(result?.code || 'operation_failed');
  if (code === 'missing_gemini_key') return { ok: false, keep: false, reason: a.missing };
  if (kind === 'cloud' && (code === 'gemini_cloudkey' || (code === 'gemini_http' && result?.httpStatus === 400))) return { ok: false, keep: false, reason: a.cloudRejected };
  if (code === 'gemini_prepay') return { ok: false, keep: true, reason: a.prepay };
  if (code === 'gemini_region') return { ok: false, keep: true, reason: a.region };
  if (code === 'gemini_http' && [400, 401, 403].includes(result?.httpStatus)) return { ok: false, keep: false, reason: a.rejected };
  if (code === 'gemini_ratelimit') return { ok: false, keep: true, reason: a.ratelimit };
  if (code === 'gemini_busy') return { ok: false, keep: true, reason: a.busy };
  if (['gemini_network', 'gemini_aborted', 'timeout'].includes(code)) return { ok: false, keep: true, reason: a.offline };
  return { ok: false, keep: true, reason: a.other(code.replace(/[^\w-]/g, '').slice(0, 40)) };
}

// The small key window (Windows). Display text only in the data file, never the key.
// Links are fixed to Google's own pages (checked 11-05 on Google's API key docs).
export const KEY_PAGE = 'https://aistudio.google.com/apikey';
export const REGIONS_PAGE = 'https://aistudio.google.com/docs/available-regions';
// Google's own pages for the Agent Platform key: how to get one, and budget alerts.
export const CLOUD_KEY_PAGE = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys';
export const BUDGET_PAGE = 'https://docs.cloud.google.com/billing/docs/how-to/budgets';
const CLOUD_LABELS = {
  zh: {
    title: 'AI 记忆守护者 · Google Cloud 密钥 / JSON 令牌',
    head: '粘贴 Agent Platform API 密钥，或选择 Google Cloud 服务账号 JSON 密钥文件',
    body: '它只保存在这台电脑上，为当前 Windows 用户加密，不会出现在聊天里。若选择服务账号 JSON 文件，会自动用本地 RS256 签名换取 OAuth2 令牌调用 Google Cloud。',
    getKey: '怎么创建：Google 的说明（Agent Platform → API 密钥 / 服务账号 JSON）',
    rules: '默认先用 AI Studio 的免费额度，忙或额度用完时才改用这个密钥。建议先在 Cloud 结算里设一个预算提醒。',
    regions: '设置预算提醒（官方）',
  },
  en: {
    title: 'AI Memory Keeper · Google Cloud key / JSON token',
    head: 'Paste an Agent Platform API key, or pick a Google Cloud Service Account JSON file',
    body: "It stays on this computer only, encrypted for your Windows user, and never goes into the chat. A Service Account JSON file is automatically exchanged via RS256 JWT for an OAuth2 Bearer token.",
    getKey: "How to create one: Google's guide (Agent Platform > API keys / Service Account JSON)",
    rules: "By default the free AI Studio tier goes first; this key is used only when that's busy or out of quota. Set a budget alert in Cloud Billing first.",
    regions: 'Set a budget alert (official)',
  },
};
const LABELS = {
  zh: {
    title: 'AI 记忆守护者 · Gemini API key',
    head: '把你的 Gemini API key 粘贴到这里（或选择 Google Cloud JSON 密钥）',
    body: '它只保存在这台电脑上，为当前 Windows 用户加密，不会出现在聊天里。',
    getKey: '还没有 key？去 Google AI Studio 免费创建',
    rules: '需要年满 18 岁，并且身处 Gemini API 开放的地区（中国大陆和香港不在其中）。',
    regions: '可用地区列表（官方）',
    save: '保存', cancel: '取消', close: '关闭', pickJson: '选择 JSON 密钥…',
    invalid: '这看起来不像有效的 API key 或 Google Cloud 服务账号 JSON，请再检查一下。',
    checking: '已保存，正在用一条很短的编造消息检查这个 key……',
    slow: '检查有点慢。key 已经保存，可以先关掉这个窗口。',
  },
  en: {
    title: 'AI Memory Keeper · Gemini API key',
    head: 'Paste your Gemini API key here (or pick a Google Cloud JSON key)',
    body: 'It stays on this computer only, encrypted for your Windows user, and never goes into the chat.',
    getKey: 'No key yet? Create one free in Google AI Studio',
    rules: 'You need to be 18 or older and in a region where the Gemini API is available (mainland China and Hong Kong are not).',
    regions: 'Available regions (official)',
    save: 'Save', cancel: 'Cancel', close: 'Close', pickJson: 'Pick JSON key...',
    invalid: "That doesn't look like a valid API key or Google Cloud Service Account JSON. Please check it.",
    checking: 'Saved. Checking the key with one short made-up message...',
    slow: 'The check is slow. The key is saved; you can close this window.',
  },
};
const windowFiles = ctx => ({ data: path.join(ctx.home, 'key-window.json'), result: path.join(ctx.home, 'key-window.result') });
export function keyWindowCommand(dataFile) {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const kind = data.kind === 'cloud' ? 'cloud' : 'studio';
  return psArgs(encodedScript(WINDOW_SCRIPT, {
    DataFile: dataFile, XamlFile: WINDOW_XAML, KeyFile: data.keyFile, ResultFile: data.resultFile, Entropy: kindOf(kind).entropy,
    // After saving, the window runs `amk key-check` with these (paths and fixed words only).
    NodeExe: data.nodeExe || process.execPath, CliFile: data.cliFile || CLI, KeeperHome: data.keeperHome || '', KeyLang: data.lang || 'zh', KeyKind: kind,
  }));
}
const CLI = path.join(here, 'cli.mjs');
function prepareWindow(ctx, kind = 'studio') {
  fs.mkdirSync(ctx.home, { recursive: true });
  const { data, result } = windowFiles(ctx);
  noLinks(data); noLinks(result);
  fs.rmSync(result, { force: true });
  const lang = ctx.lang === 'en' ? 'en' : 'zh';
  const cloud = kind === 'cloud';
  fs.writeFileSync(data, JSON.stringify({
    ...LABELS[lang], ...(cloud ? CLOUD_LABELS[lang] : {}),
    keyPage: cloud ? CLOUD_KEY_PAGE : KEY_PAGE, regionsPage: cloud ? BUDGET_PAGE : REGIONS_PAGE, lang, kind: cloud ? 'cloud' : 'studio',
    keyFile: keyFile(ctx, 'win32', kind), resultFile: result, keeperHome: ctx.home, nodeExe: process.execPath, cliFile: CLI,
  }));
  return { data, result };
}
// Opens the window and returns at once, so an agent's command doesn't time out while the
// person finds their key. With wait, blocks until the window closes (for a terminal).
// kind "cloud": the Agent Platform key instead of the AI Studio one.
export async function openKeyWindow(ctx, { wait = false, kind = 'studio', spawnImpl = spawn, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (process.platform !== 'win32') fail('key_window_windows_only');
  const { data, result } = prepareWindow(ctx, kind);
  if (!wait) {
    await new Promise((resolve, reject) => {
      // Outside the agent's process tree (outside.mjs), so its key check can reach Google even
      // when the agent's sandbox has no network; tests pass their own spawnImpl.
      if (spawnImpl === spawn) return spawnOutside(process.execPath, [LAUNCHER, data], { cwd: ctx.home }).then(resolve, reject);
      const child = spawnImpl(process.execPath, [LAUNCHER, data], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { window: 'opened', then: 'When the person says they saved the key in that window, run: amk doctor' };
  }
  spawnSync('powershell.exe', keyWindowCommand(data), { stdio: 'ignore', windowsHide: true, timeout: timeoutMs });
  const outcome = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').trim() : 'closed';
  return { saved: outcome === 'saved', outcome };
}

// Terminal route: a hidden prompt (nothing echoed), or stdin when it isn't a terminal.
export async function promptKey(label, input = process.stdin, output = process.stderr) {
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) { text += chunk; if (text.length > 16384) break; }
    const trimmed = text.trim();
    return trimmed.startsWith('{') ? trimmed : text.split(/\r?\n/)[0];
  }
  output.write(label);
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = fn => { input.setRawMode(false); input.pause(); input.off('data', onData); output.write('\n'); fn(); };
    const onData = chunk => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n') return done(() => resolve(buf));
        if (c === '\u0003') return done(() => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })));
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    input.setRawMode(true); input.setEncoding('utf8'); input.resume(); input.on('data', onData);
  });
}
