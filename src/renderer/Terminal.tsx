import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onCanvasCommand?: (command: string) => Promise<void>;
}

export default function Terminal({ onCanvasCommand }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCanvasCommandRef = useRef(onCanvasCommand);
  useEffect(() => { onCanvasCommandRef.current = onCanvasCommand; }, [onCanvasCommand]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#0d0d1a',
        foreground: '#cdd6f4',
        cursor: '#f38ba8',
        selectionBackground: '#313244',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#89dceb',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#89dceb',
        brightWhite: '#a6adc8',
      },
      cursorBlink: true,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    window.electronAPI.onPtyData((data) => term.write(data));
    window.electronAPI.onPtyExit(() => term.write('\r\n\x1b[31m[Process exited]\x1b[0m\r\n'));
    window.electronAPI.onCanvasCommandStatus((msg) =>
      term.write(`\r\n\x1b[36m[canvas] ${msg}\x1b[0m\r\n`));

    // Intercept mode: when the user's first character is '/', we take over
    // echo and buffering entirely — nothing goes to the PTY until Enter is
    // pressed and we know it's NOT a /canvas command. This is necessary
    // because the PTY may be running Claude Code (not a plain shell), which
    // would interpret /canvas as its own slash command before we could stop it.
    let interceptBuf: string | null = null; // null = pass-through, string = intercepting

    const flushInterceptBuf = () => {
      // Replay buffered chars to PTY as if the user typed them normally
      if (interceptBuf !== null) {
        window.electronAPI.ptyWrite(interceptBuf);
        interceptBuf = null;
      }
    };

    term.onData((data) => {
      // ── Enter ────────────────────────────────────────────────────────────────
      if (data === '\r') {
        if (interceptBuf !== null) {
          const line = interceptBuf.trim();
          interceptBuf = null;

          if (line.startsWith('/canvas ') || line === '/canvas') {
            const command = line.slice('/canvas'.length).trim();
            term.write('\r\n');

            if (!command) {
              term.write('\x1b[33m[canvas] Usage: /canvas <your request>\x1b[0m\r\n');
              return;
            }

            term.write(`\x1b[36m[canvas] Running: ${command}\x1b[0m\r\n`);
            onCanvasCommandRef.current?.(command).catch((err: unknown) => {
              term.write(`\x1b[31m[canvas] Error: ${String(err)}\x1b[0m\r\n`);
            });
            return;
          }

          // Not a canvas command — replay to PTY then send Enter
          window.electronAPI.ptyWrite(line + '\r');
          return;
        }

        window.electronAPI.ptyWrite(data);
        return;
      }

      // ── Ctrl-C ───────────────────────────────────────────────────────────────
      if (data === '\x03') {
        if (interceptBuf !== null) {
          // Erase the locally-echoed line visually
          term.write('\r\x1b[2K');
          interceptBuf = null;
          // Still forward Ctrl-C so PTY (e.g. Claude Code) can handle it
          window.electronAPI.ptyWrite(data);
          return;
        }
        window.electronAPI.ptyWrite(data);
        return;
      }

      // ── Backspace ────────────────────────────────────────────────────────────
      if (data === '\x7f') {
        if (interceptBuf !== null) {
          if (interceptBuf.length > 0) {
            interceptBuf = interceptBuf.slice(0, -1);
            term.write('\b \b');
          }
          if (interceptBuf.length === 0) {
            // Nothing left — exit intercept mode, let PTY take over
            interceptBuf = null;
          }
          return;
        }
        window.electronAPI.ptyWrite(data);
        return;
      }

      // ── Escape sequences (arrow keys, function keys, etc.) ───────────────────
      if (data.startsWith('\x1b') || data.length > 1) {
        if (interceptBuf !== null) {
          // Can't meaningfully handle escape sequences in our local buffer.
          // Flush buffered text to PTY and exit intercept mode, then forward.
          flushInterceptBuf();
        }
        window.electronAPI.ptyWrite(data);
        return;
      }

      // ── Printable character ──────────────────────────────────────────────────
      if (data.length === 1 && data >= ' ') {
        if (interceptBuf === null && data === '/') {
          // First char is '/' — enter intercept mode: echo locally, hold from PTY
          interceptBuf = '/';
          term.write('/');
          return;
        }

        if (interceptBuf !== null) {
          interceptBuf += data;
          term.write(data);
          return;
        }
      }

      // Default: pass through to PTY
      window.electronAPI.ptyWrite(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      window.electronAPI.ptyResize(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
