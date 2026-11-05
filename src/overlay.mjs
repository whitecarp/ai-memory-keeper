import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { read, atomic } from './safety.mjs';
import { encodedScript, psArgs } from './powershell.mjs';
import { spawnOutside } from './outside.mjs';

// Desktop overlay: Gemini娘 floats over the agent's window after compaction.
// On by default (Windows only). Never blocks or fails a hook: the window runs
// in its own detached process, and every error here is swallowed by callers.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'overlay.ps1');
const NATIVE = path.join(here, 'overlay-native.cs');
const XAML = path.join(here, 'overlay.xaml');
const LAUNCHER = path.join(here, 'overlay-launch.mjs');
const ASSETS = path.join(here, '..', 'assets');
// Transparent cut-outs. Poses: "working" while compaction runs, "alert" when the model
// check is suspect, "base" otherwise. The poses don't line up with each other, so the
// window crossfades between them. The blink and talk frames line up with the base, and
// only their checked box (eyes, mouth) is ever shown, copied into the base.
const FRAME_FILES = { base: 'gemini-overlay-closed-mouth.png', working: 'gemini-overlay-working.png', alert: 'gemini-overlay-alert.png' };
const OLD_BASE = 'gemini-overlay.png'; // the first picture, used only if the new base is missing
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function overlayFrames(assets = ASSETS) {
  const at = name => path.join(assets, name);
  const has = name => typeof name === 'string' && /^[\w.-]+\.png$/.test(name) && fs.existsSync(at(name));
  const baseName = has(FRAME_FILES.base) ? FRAME_FILES.base : OLD_BASE;
  const frames = { base: at(baseName) };
  for (const pose of ['working', 'alert']) if (has(FRAME_FILES[pose])) frames[pose] = at(FRAME_FILES[pose]);
  // tools/check-frames.mjs records each checked frame with both files' hashes; a frame
  // whose file changed since (or that was checked against another base) is left out.
  let checked = {};
  try { checked = JSON.parse(fs.readFileSync(at('frames.json'), 'utf8')) || {}; } catch { /* no checked frames */ }
  let baseHash = null;
  for (const kind of ['blink', 'talk']) {
    const c = checked[kind];
    const box = Array.isArray(c?.box) && c.box.length === 4 && c.box.every(n => Number.isInteger(n) && n >= 0) ? c.box : null;
    if (!box || c.base !== baseName || !has(c.file) || !has(baseName)) continue;
    try {
      baseHash ??= sha256(at(baseName));
      if (c.baseSha256 !== baseHash || c.sha256 !== sha256(at(c.file))) continue;
    } catch { continue; }
    frames[kind] = at(c.file); frames[kind + 'Box'] = box.join(',');
  }
  return frames;
}
// "saving": compaction is over, the background save is still running (same pose as working).
export const overlayPose = (phase, level) => (phase === 'working' || phase === 'saving' ? 'working' : level === 'suspect' ? 'alert' : 'base');
// The picture for a pose (the base if that pose's frame is missing).
export function overlayArt(level, phase = 'done', frames = overlayFrames()) {
  return { art: frames[overlayPose(phase, level)] || frames.base, fit: 'contain' };
}

const CREDIT = {
  zh: '角色设计参考 @ZipZipPipe的 Gemini 拟人形象（非 Google 官方角色）',
  en: "Character design reference: @ZipZipPipe's Gemini personification (not an official Google character)",
};

const settingsFile = ctx => path.join(ctx.dir, 'settings.json');
export const overlaySupported = (platform = process.platform) => platform === 'win32';
export function overlayEnabled(ctx) {
  try { return read(settingsFile(ctx), {})?.overlay !== false; } catch { return true; }
}
export function setOverlay(ctx, on) {
  const current = (() => { try { return read(settingsFile(ctx), {}) || {}; } catch { return {}; } })();
  atomic(settingsFile(ctx), { ...current, overlay: !!on });
  return { overlay: !!on, supported: overlaySupported() };
}

// -EncodedCommand (see powershell.mjs); the C# helper and the XAML layout load from files.
export function overlayCommand(dataFile) {
  return psArgs(encodedScript(SCRIPT, { DataFile: dataFile, NativeFile: NATIVE, XamlFile: XAML }));
}

// The window writes a heartbeat file every 400 ms while it is up. A window spawned
// moments ago may not have written one yet, so count that as up too.
export function overlayAlive(ctx, prev, now = Date.now()) {
  try { if (now - fs.statSync(path.join(ctx.dir, 'overlay.json.alive')).mtimeMs < 2500) return true; } catch { /* no heartbeat */ }
  return !!(prev?.spawnedAt && now - prev.spawnedAt < 8000);
}

// phase "working": compaction started, she stays until "done" (or a 5-minute cap).
// phase "saving": compaction finished, the save is still running; she waits for it (at most
//   saveCapMs), then says lines.late and fades if it hasn't landed.
// phase "done": the result is shown, then she fades out.
// An open window is updated in place; otherwise a new one is started.
// cycle: the compaction this belongs to; a "saving" update never replaces that cycle's "done".
// agentPid "keep": follow the window found for this compaction (used by the background save).
export function showOverlay(ctx, { lines, lang = 'zh', phase = 'done', durationMs = 6500, saveCapMs = 120000, agentPid = process.ppid, transcript = null, cycle = null, outside = false, platform = process.platform, spawnImpl = spawn, env = process.env, now = Date.now } = {}) {
  // Tests and offline demos set AMK_NO_OVERLAY=1 so they never open real windows.
  if (env.AMK_NO_OVERLAY === '1' || !overlaySupported(platform) || !lines?.gemini) return Promise.resolve(false);
  const dataFile = path.join(ctx.dir, 'overlay.json');
  let prev = null; try { prev = read(dataFile, null); } catch { /* start fresh */ }
  if (phase === 'saving' && cycle && prev?.cycle === cycle && prev?.phase === 'done') return Promise.resolve(true);
  const t = now();
  const alive = overlayAlive(ctx, prev, t);
  const frames = overlayFrames();
  const pid = agentPid === 'keep' ? prev?.agentPid : agentPid;
  atomic(dataFile, {
    ...overlayArt(lines.partner?.level, phase, frames), pose: overlayPose(phase, lines.partner?.level), frames,
    durationMs, phase, seq: t, spawnedAt: alive ? prev?.spawnedAt || t : t,
    cycle: cycle ?? prev?.cycle ?? null,
    saveCapMs, lateSay: typeof lines.late === 'string' ? lines.late : null,
    // The process that started this one (the agent, or the shell for a preview): the
    // window walks up from it to find the agent's window.
    agentPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    // While compacting: if a new typed prompt shows up in the transcript before "done",
    // compaction failed; she says so and leaves instead of waiting for the cap.
    transcript: typeof transcript === 'string' ? transcript : prev?.transcript || null,
    failSay: lang === 'en'
      ? "Looks like that compaction didn't finish (maybe a network or API hiccup). This part of the chat already went to my background save."
      : '这次压缩好像没完成（可能是网络或 API 出了问题）。没关系，这段对话已经交给后台整理了～',
    name: lang === 'en' ? 'Gemini-chan' : 'Gemini娘',
    say: lines.gemini, partner: lines.partner || null,
    credit: lang === 'en' ? CREDIT.en : CREDIT.zh,
  });
  if (alive) return Promise.resolve(true);
  // Codex ends the hook's process tree when the hook returns: start her outside it.
  if (outside && platform === 'win32' && spawnImpl === spawn) return spawnOutside(process.execPath, [LAUNCHER, dataFile], { cwd: ctx.dir }).then(() => true);
  return new Promise((resolve, reject) => {
    // Detached Node launcher -> PowerShell (see overlay-launch.mjs for why).
    const child = spawnImpl(process.execPath, [LAUNCHER, dataFile], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}
