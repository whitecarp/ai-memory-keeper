// Started detached by `amk key`, so the command returns at once. Windows PowerShell exits
// at once without a console (Node's detached mode), so this console-less launcher starts
// it normally, the same way the overlay is started.
import { spawn } from 'node:child_process';
import { keyWindowCommand } from './key.mjs';

const dataFile = process.argv[2];
if (dataFile) {
  try {
    const child = spawn('powershell.exe', keyWindowCommand(dataFile), { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
  } catch { /* the person can run amk key again */ }
}
