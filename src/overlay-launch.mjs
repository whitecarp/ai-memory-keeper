// Started detached by the hook (so the hook returns at once). Windows PowerShell
// exits immediately when it has no console at all (Node's detached mode), so this
// console-less launcher starts it normally: Windows then gives PowerShell its own
// hidden console instead of sharing the agent's terminal.
import { spawn } from 'node:child_process';
import { overlayCommand } from './overlay.mjs';

const dataFile = process.argv[2];
if (dataFile) {
  try {
    const child = spawn('powershell.exe', overlayCommand(dataFile), { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
  } catch { /* decoration only */ }
}
