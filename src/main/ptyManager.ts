import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

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

export type AiProvider = 'claude' | 'codex' | 'gemini';

export const AI_PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'OpenAI Codex' },
  { id: 'gemini', label: 'Google Gemini' },
];

let activeProvider: AiProvider = 'claude';

export function getAiProvider(): AiProvider { return activeProvider; }

export function setAiProvider(provider: string): AiProvider {
  if (provider === 'claude' || provider === 'codex' || provider === 'gemini') {
    activeProvider = provider;
  }
  return activeProvider;
}

let ptyProcess: pty.IPty | null = null;
let ptyDataCallback: ((data: string) => void) | null = null;

// Canvas requests use one Claude conversation per project. The CLI process itself
// can still exit after each response, but --resume keeps the project conversation
// (and its context) alive instead of starting a fresh one for every canvas action.
const initializedProjectSessions = new Set<string>();
const captureQueues = new Map<string, Promise<void>>();
const projectSessionIds = new Map<string, string>();

function projectSessionId(cwd: string): string {
  let id = projectSessionIds.get(cwd);
  if (!id) {
    // A fresh ID avoids colliding with a session left behind by an earlier app run.
    id = crypto.randomUUID();
    projectSessionIds.set(cwd, id);
  }
  return id;
}

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
  const provider = activeProvider;
  const queueKey = `${provider}:${cwd}`;
  // A resumed conversation must receive turns in order. This also prevents two
  // simultaneous diagrams from leaking their prompts into each other's context.
  const previous = captureQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => runCaptureInProjectSession(prompt, cwd, provider));
  captureQueues.set(queueKey, run.then(() => undefined, () => undefined));
  return run;
}

function runCaptureInProjectSession(prompt: string, cwd: string, provider: AiProvider): Promise<string> {
  return new Promise((resolve) => {
    let output = '';

    // Write prompt to a temp file and pass via stdin to avoid shell arg length limits
    const tmpFile = require('os').tmpdir() + '/rex-canvas-prompt-' + Date.now() + '.txt';
    require('fs').writeFileSync(tmpFile, prompt, 'utf8');
    // Codex emits progress and tool events to its normal output. Ask it to put
    // just the final assistant message in a file so structured canvas replies
    // are not polluted by those events.
    const finalMessageFile = provider === 'codex'
      ? require('os').tmpdir() + '/rex-canvas-codex-final-' + Date.now() + '.txt'
      : null;

    // Claude supports resumable sessions. Other CLIs receive the complete prompt
    // for each request, so selecting one never sends a query to Claude.
    const shell = process.env.SHELL || '/bin/zsh';
    const sessionKey = `${provider}:${cwd}`;
    let cmd: string;
    if (provider === 'claude') {
      const sessionId = projectSessionId(sessionKey);
      const sessionFlag = initializedProjectSessions.has(sessionKey)
        ? '--resume ' + sessionId
        : '--session-id ' + sessionId;
      cmd = CLAUDE_BIN + ' --print ' + sessionFlag + ' < "' + tmpFile + '"';
    } else if (provider === 'codex') {
      cmd = 'codex exec --skip-git-repo-check --output-last-message "' + finalMessageFile + '" "$(cat "' + tmpFile + '")"';
    } else {
      cmd = 'gemini -p "$(cat "' + tmpFile + '")"';
    }

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
      if (finalMessageFile) {
        try { output = require('fs').readFileSync(finalMessageFile, 'utf8') || output; } catch {}
        try { require('fs').unlinkSync(finalMessageFile); } catch {}
      }
      try { require('fs').unlinkSync(tmpFile); } catch {} // cleanup temp file
      if (provider === 'claude') initializedProjectSessions.add(sessionKey);
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
