import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);

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

    term.onData((data) => window.electronAPI.ptyWrite(data));

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
