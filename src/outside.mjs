import { spawn, spawnSync } from 'node:child_process';
import { inlineArgs, psQuote } from './powershell.mjs';

// Codex ends a hook's whole process tree (its job) as soon as the hook returns, which
// killed the background save and the pop-up within seconds. On Windows, CIM's
// Win32_Process.Create starts the process from the WMI service instead: outside that job,
// as the same user, on the same desktop, with its console hidden. Its environment is the
// user's own, not the agent's, which is fine for the save (it finds the key `amk key`
// stored) and the pop-up. If CIM can't start it, or elsewhere, a plain detached start.
const winQuote = a => '"' + String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export const commandLine = (exe, args) => [exe, ...args].map(winQuote).join(' ');

function detached(exe, args, cwd, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve('detached'); });
  });
}

// Tests and the offline demo set AMK_NO_OUTSIDE=1: their fake key and network stub live in
// the environment, which a WMI start would not pass on.
export async function spawnOutside(exe, args, { cwd, platform = process.platform, spawnImpl = spawn, runSync = spawnSync, env = process.env } = {}) {
  if (platform !== 'win32' || env.AMK_NO_OUTSIDE === '1') return detached(exe, args, cwd, spawnImpl);
  const script = '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; '
    + `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine(exe, args))}; CurrentDirectory = ${psQuote(cwd)}; ProcessStartupInformation = $s }; `
    + 'exit [int]$r.ReturnValue';
  const r = runSync('powershell.exe', inlineArgs(script), { stdio: 'ignore', windowsHide: true, timeout: 4000 });
  if (r.status === 0) return 'outside';
  return detached(exe, args, cwd, spawnImpl);
}
