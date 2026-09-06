import React, { useEffect, useRef, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';

interface Props {
  path?: string;
  content?: string;
  highlight?: string;
  /** Local AST evidence, encoded as Mermaid by the main process. */
  callHierarchy?: string;
  emptyMessage?: string;
}

type CallEdge = { from: string; to: string; kind: string };
type EditorArrow = { x: number; fromY: number; toY: number; label: string; kind: string; continues: 'up' | 'down' | null };

function callEdgesFromHierarchy(mermaid?: string): CallEdge[] {
  if (!mermaid) return [];
  const labels = new Map<string, string>();
  for (const match of mermaid.matchAll(/\b([A-Za-z0-9_]+)\[([^\]]+)]/g)) labels.set(match[1], match[2]);
  const edges: CallEdge[] = [];
  for (const line of mermaid.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\[([^\]]+)]\s+-->(?:\|([^|]+)\|)?\s*([A-Za-z0-9_]+)\[([^\]]+)]/);
    if (match) edges.push({ from: labels.get(match[1]) ?? match[2], to: labels.get(match[4]) ?? match[5], kind: match[3] ?? 'next' });
  }
  return edges;
}

function languageFor(path = ''): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', java: 'java', kt: 'kotlin', swift: 'swift', dart: 'dart',
    cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', go: 'go', rs: 'rust',
    json: 'json', xml: 'xml', html: 'html', css: 'css', sql: 'sql',
  };
  return map[ext ?? ''] ?? 'plaintext';
}

export default function CodeEditor({ path, content, highlight, callHierarchy, emptyMessage }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const hierarchyDecorations = useRef<string[]>([]);
  const [editorArrows, setEditorArrows] = useState<EditorArrow[]>([]);
  const arrowListeners = useRef<{ dispose: () => void }[]>([]);

  const applyHighlight = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model || !highlight) return;
    const word = highlight.split(/[^A-Za-z0-9_]+/).find(part => part.length >= 3) ?? highlight;
    const matches = model.findMatches(word, false, false, false, null, true).slice(0, 12);
    editor.deltaDecorations([], matches.map((match: any) => ({
      range: match.range,
      options: { inlineClassName: 'rex-code-highlight', minimap: { color: '#f59e0b', position: 1 } },
    })));
    if (matches[0]) editor.revealRangeInCenter(matches[0].range);
  };

  useEffect(() => { applyHighlight(); }, [content, highlight]);

  // Keep the call path in the source view itself.  These are Monaco
  // decorations, not comments written into the user's file: each proven local
  // call appears beside the function that makes it, with an arrow to what runs next.
  const applyCallPath = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    const decorations: any[] = [];
    for (const edge of callEdgesFromHierarchy(callHierarchy).slice(0, 20)) {
      const owner = edge.from.split('.').pop() ?? edge.from;
      const target = edge.to.split('.').pop() ?? edge.to;
      const matches = model.findMatches(owner, false, false, false, null, true);
      const declaration = new RegExp(`(?:function|class|const|let|var)\\s+${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
      const match = matches.find((item: any) => declaration.test(model.getLineContent(item.range.startLineNumber))) ?? matches[0];
      if (!match) continue;
      decorations.push({
        range: new monaco.Range(match.range.startLineNumber, 1, match.range.startLineNumber, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: edge.kind === 'calls' ? 'rex-call-gutter' : 'rex-import-gutter',
          after: { content: `  ↳ ${edge.kind} ${target}`, inlineClassName: 'rex-call-arrow' },
          hoverMessage: { value: `**Local ${edge.kind}** → \`${edge.to}\`` },
          overviewRuler: { color: edge.kind === 'calls' ? '#a78bfa' : '#60a5fa', position: 2 },
        },
      });
    }
    hierarchyDecorations.current = editor.deltaDecorations(hierarchyDecorations.current, decorations);
  };

  const updateEditorArrows = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const findDefinitionLine = (symbol: string): number | null => {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declaration = new RegExp(`(?:function|class|const|let|var)\\s+${escaped}\\b|${escaped}\\s*\\(`);
      const matches = model.findMatches(symbol, false, false, false, null, true);
      const match = matches.find((item: any) => declaration.test(model.getLineContent(item.range.startLineNumber))) ?? matches[0];
      return match?.range.startLineNumber ?? null;
    };
    const arrows: EditorArrow[] = [];
    const layout = editor.getLayoutInfo();
    // Route through the editor's unused horizontal space, like a call-flow
    // diagram laid over the source. This keeps the connector between the two
    // function blocks instead of hiding it in Monaco's gutter.
    const arrowX = Math.max(160, Math.min(layout.width - 115, layout.contentLeft + layout.contentWidth * 0.56));
    for (const edge of callEdgesFromHierarchy(callHierarchy).filter(edge => edge.kind === 'calls').slice(0, 12)) {
      const fromLine = findDefinitionLine(edge.from.split('.').pop() ?? edge.from);
      const toLine = findDefinitionLine(edge.to.split('.').pop() ?? edge.to);
      if (!fromLine || !toLine || fromLine === toLine) continue;
      const from = editor.getScrolledVisiblePosition({ lineNumber: fromLine, column: 1 });
      const to = editor.getScrolledVisiblePosition({ lineNumber: toLine, column: 1 });
      if (!from || !to) continue;
      const rawToY = to.top + to.height / 2;
      const continues = rawToY < 18 ? 'up' : rawToY > layout.height - 20 ? 'down' : null;
      arrows.push({
        x: arrowX, fromY: from.top + from.height / 2,
        toY: Math.max(18, Math.min(rawToY, layout.height - 20)),
        label: edge.to.split('.').pop() ?? edge.to, kind: edge.kind, continues,
      });
    }
    setEditorArrows(arrows);
  };

  useEffect(() => { applyCallPath(); updateEditorArrows(); }, [content, callHierarchy]);

  useEffect(() => () => {
    arrowListeners.current.forEach(listener => listener.dispose());
    arrowListeners.current = [];
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme('rex-dark', {
      base: 'vs-dark', inherit: true,
      rules: [], colors: { 'editor.background': '#10101b', 'editorLineNumber.foreground': '#555574' },
    });
    monaco.editor.setTheme('rex-dark');
    applyHighlight();
    applyCallPath();
    arrowListeners.current.forEach(listener => listener.dispose());
    arrowListeners.current = [
      editor.onDidScrollChange(updateEditorArrows),
      editor.onDidLayoutChange(updateEditorArrows),
    ];
    requestAnimationFrame(updateEditorArrows);
  };

  if (!content) return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24, background: '#10101b', color: '#777795', fontSize: 12, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      {emptyMessage ?? 'Select a diagram step to open its local source code.'}
    </div>
  );

  return <div style={{ position: 'relative', height: '100%' }}>
    <style>{`
      .rex-code-highlight { background: rgba(245, 158, 11, 0.28); border-bottom: 1px solid #fbbf24; }
      .rex-call-gutter { border-left: 3px solid #a78bfa; margin-left: 3px; }
      .rex-import-gutter { border-left: 3px solid #60a5fa; margin-left: 3px; }
      .rex-call-arrow { color: #c4b5fd; font-style: italic; font-weight: 600; opacity: .95; }
    `}</style>
    <Editor
      path={path}
      value={content}
      language={languageFor(path)}
      theme="rex-dark"
      onMount={handleMount}
      options={{ readOnly: true, minimap: { enabled: false }, wordWrap: 'on', fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, padding: { top: 10 } }}
    />
    <svg aria-label="Local call arrows" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden', zIndex: 20 }}>
      <defs><marker id="rex-call-arrowhead" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 Z" fill="#38bdf8" /></marker></defs>
      {editorArrows.map((arrow, index) => {
        const lane = 14 + (index % 3) * 14;
        const direction = arrow.toY > arrow.fromY ? 1 : -1;
        const controlY = arrow.toY - direction * 8;
        const label = `${arrow.continues === 'down' ? '↓ ' : arrow.continues === 'up' ? '↑ ' : ''}calls → ${arrow.label}`;
        return <g key={`${arrow.label}-${index}`}>
          <path d={`M ${arrow.x} ${arrow.fromY} h ${lane} V ${controlY} h 16`} fill="none" stroke="#38bdf8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" markerEnd="url(#rex-call-arrowhead)" opacity="0.98" />
          <rect x={Math.max(3, arrow.x - 76)} y={Math.min(arrow.fromY, arrow.toY) + 4} width="74" height="17" rx="3" fill="#0c4a6e" opacity="0.96" />
          <text x={Math.max(7, arrow.x - 72)} y={Math.min(arrow.fromY, arrow.toY) + 16} fill="#e0f2fe" fontSize="10" fontWeight="700" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{label.slice(0, 14)}</text>
        </g>;
      })}
    </svg>
  </div>;
}
