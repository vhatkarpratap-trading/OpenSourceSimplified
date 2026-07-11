import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as fs from 'fs';

// Resolve claude binary — Electron strips PATH so we can't rely on bare 'claude'
function findClaude(): string {
  const candidates = [
    process.env.CLAUDE_PATH,
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'claude'; // fallback — hope it's on PATH
}

const CLAUDE_BIN = findClaude();

let ptyProcess: pty.IPty | null = null;
let ptyDataCallback: ((data: string) => void) | null = null;

export function setPtyDataCallback(cb: ((data: string) => void) | null) {
  ptyDataCallback = cb;
}

// Returns the actual working directory of the PTY shell process (follows cd commands).
// Uses lsof on macOS to read the cwd of the child shell PID.
export function getPtyCwd(): string | null {
  if (!ptyProcess) return null;
  try {
    const pid = ptyProcess.pid;
    // lsof -a -p <pid> -d cwd -Fn  prints "ncwd\n<path>"
    const out = require('child_process').execSync(
      `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 }
    ) as string;
    const match = out.match(/^n(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function createPty(win: BrowserWindow, cwd?: string) {
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/zsh');

  const env = {
    ...process.env,
    PATH: `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
  } as { [key: string]: string };

  ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env,
  });

  ptyProcess.onData((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('pty:data', data);
    }
    ptyDataCallback?.(data);
  });

  ptyProcess.onExit(() => {
    if (!win.isDestroyed()) {
      win.webContents.send('pty:exit');
    }
  });
}

export function restartPty(win: BrowserWindow, cwd: string) {
  killPty();
  createPty(win, cwd);
}

export function writeToPty(data: string) {
  ptyProcess?.write(data);
}

export function resizePty(cols: number, rows: number) {
  ptyProcess?.resize(cols, rows);
}

export function killPty() {
  ptyProcess?.kill();
  ptyProcess = null;
}

export function runCapture(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let output = '';

    // Write prompt to a temp file and pass via stdin to avoid shell arg length limits
    const tmpFile = require('os').tmpdir() + '/rex-canvas-prompt-' + Date.now() + '.txt';
    require('fs').writeFileSync(tmpFile, prompt, 'utf8');

    // Use: claude --print < prompt-file
    const shell = process.env.SHELL || '/bin/zsh';
    const cmd = `${CLAUDE_BIN} --print < "${tmpFile}"`;

    const capture = pty.spawn(shell, ['-c', cmd], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      env: {
        ...process.env,
        PATH: `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
      } as { [key: string]: string },
    });

    capture.onData((data) => {
      output += data;
    });

    capture.onExit(() => {
      try { require('fs').unlinkSync(tmpFile); } catch {} // cleanup temp file
      resolve(output);
    });

    // Safety timeout: 5 minutes
    const timer = setTimeout(() => {
      try { capture.kill(); } catch {}
      try { require('fs').unlinkSync(tmpFile); } catch {}
      resolve(output);
    }, 300000);

    capture.onExit(() => clearTimeout(timer));
  });
}
