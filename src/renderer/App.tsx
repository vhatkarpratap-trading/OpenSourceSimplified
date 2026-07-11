import React, { useState, useCallback, useRef } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';
import Terminal from './Terminal';
import Canvas from './Canvas';
import { DiagramData, DiagramKind } from './diagramBuilder';

type AnalysisStatus = 'idle' | 'running' | 'patching' | 'done' | 'error';

const DIAGRAM_TABS: { kind: DiagramKind; label: string }[] = [
  { kind: 'structure', label: 'Structure' },
  { kind: 'sequence',  label: 'Sequence' },
  { kind: 'gitDiff',   label: 'Git Diff' },
];

const STATUS_DOT_COLOR: Record<AnalysisStatus, string> = {
  idle:     'transparent',
  running:  '#f9e2af',
  patching: '#cba6f7',
  done:     '#a6e3a1',
  error:    '#f38ba8',
};

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  idle:     '',
  running:  'Analysing…',
  patching: 'Updating…',
  done:     'Done',
  error:    'Error',
};

export default function App() {
  const [folder, setFolder]           = useState<string | null>(null);
  const [diagram, setDiagram]         = useState<DiagramData | null>(null);
  const [status, setStatus]           = useState<AnalysisStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [impactSummary, setImpactSummary] = useState<{
    changed: { name: string; type: string; description: string; oldDescription: string }[];
    impacted: { name: string; type: string; description: string; reason: string }[];
  } | null>(null);
  const [activeKind, setActiveKind]         = useState<DiagramKind>('structure');
  const [renderError, setRenderError]       = useState<string | null>(null);
  const [drilldownActive, setDrilldownActive] = useState(false);
  const [drillDepth, setDrillDepth]           = useState(0);
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [drilling, setDrilling]               = useState(false);

  const excalidrawAPIRef  = useRef<ExcalidrawImperativeAPI | null>(null);
  const clearDrilldownRef = useRef<(() => void) | null>(null);
  const renderDrilldownRef = useRef<((name: string) => void) | null>(null);
  const listenersAttached = useRef(false);

  if (!listenersAttached.current) {
    listenersAttached.current = true;

    window.electronAPI.onDiagram((d) => {
      const data = d as DiagramData | null;
      setDiagram(data);
      setRenderError(null);
      // Prefer showing the git-diff explanation when a change produced one
      if (data?.diagrams) {
        if (data.diagrams.gitDiff) setActiveKind('gitDiff');
        else if (data.diagrams.structure) setActiveKind('structure');
        else if (data.diagrams.sequence) setActiveKind('sequence');
      }
    });

    window.electronAPI.onAnalysisStatus((s) => {
      setStatus(s as AnalysisStatus);
      if (s === 'running') setImpactSummary(null);
    });

    window.electronAPI.onAnalysisStatusDetail((d) => setStatusDetail(d));

    window.electronAPI.onFolderRestored((result) => {
      setFolder(result.folder);
      if (!result.hasCachedDiagram) { setStatus('idle'); setDiagram(null); }
    });

    window.electronAPI.onImpactSummary((summary) => setImpactSummary(summary));
  }

  const handleOpenFolder = useCallback(async () => {
    const result = await window.electronAPI.openFolder();
    if (result) {
      setFolder(result.folder);
      if (!result.hasCachedDiagram) { setStatus('idle'); setDiagram(null); }
    }
  }, []);

  const handleAnalyse = useCallback(async () => {
    if (!folder || status === 'running' || status === 'patching') return;
    await window.electronAPI.runAnalysis();
  }, [folder, status]);

  const folderName = folder ? folder.split('/').filter(Boolean).pop() : null;
  const busy = status === 'running' || status === 'patching';
  const canvasLabel = drilldownActive
    ? `Drill: ${selectedComponent ?? ''}`
    : (diagram ? diagram.pattern : 'Canvas');

  const handleBack = useCallback(() => {
    clearDrilldownRef.current?.();
    setDrillDepth(d => Math.max(0, d - 1));
  }, []);

  const handleDrill = useCallback(async () => {
    if (!selectedComponent || drilling) return;
    setDrilling(true);
    await renderDrilldownRef.current?.(selectedComponent);
    setDrillDepth(d => d + 1);
    setDrilling(false);
  }, [selectedComponent, drilling]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: '#0f0f1a' }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px', height: 44,
        background: '#13131f', borderBottom: '1px solid #1e1e3a',
        flexShrink: 0,
        // @ts-ignore
        WebkitAppRegion: 'drag',
      }}>
        <div style={{ width: 72, flexShrink: 0 }} />

        {/* Open Project */}
        <button onClick={handleOpenFolder} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 12px', background: '#1e1e3a',
          border: '1px solid #2a2a50', borderRadius: 6,
          color: '#cdd6f4', fontSize: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: 'pointer', flexShrink: 0,
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          <FolderIcon />
          Open Project
        </button>

        {/* Folder path */}
        <span style={{
          flex: 1, fontSize: 11, fontFamily: 'ui-monospace, monospace',
          color: '#6666aa', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none',
        }}>
          {folder ?? 'No project open'}
        </span>

        {/* Status dot + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: STATUS_DOT_COLOR[status],
            transition: 'background 0.3s',
          }} />
          {(statusDetail && status === 'running') ? (
            <span style={{ fontSize: 10, color: '#888', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusDetail}
            </span>
          ) : STATUS_LABEL[status] && (
            <span style={{ fontSize: 11, color: '#666688', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>

        {/* Drill button — enabled only when a component is selected */}
        <button
          onClick={handleDrill}
          disabled={!selectedComponent || drilling || drilldownActive}
          title={selectedComponent ? `Drill into ${selectedComponent}` : 'Select a component on the canvas first'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', background: selectedComponent && !drilldownActive ? '#0f4c75' : '#13131f',
            border: `1px solid ${selectedComponent && !drilldownActive ? '#1a73b5' : '#2a2a50'}`, borderRadius: 6,
            color: selectedComponent && !drilldownActive ? '#bae6fd' : '#444466', fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: selectedComponent && !drilldownActive ? 'pointer' : 'not-allowed',
            opacity: selectedComponent && !drilldownActive ? 1 : 0.45, flexShrink: 0,
            transition: 'all 0.2s',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <DrillIcon />
          {drilling ? 'Drilling…' : selectedComponent ? `Drill: ${selectedComponent}` : 'Drill'}
        </button>

        {/* Analyse */}
        <button onClick={handleAnalyse} disabled={!folder || busy} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 14px', background: '#5b21b6',
          border: '1px solid #7c3aed', borderRadius: 6,
          color: '#ede9fe', fontSize: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: (!folder || busy) ? 'not-allowed' : 'pointer',
          opacity: (!folder || busy) ? 0.45 : 1, flexShrink: 0,
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          <SparkleIcon />
          {status === 'running' ? 'Analysing…' : status === 'patching' ? 'Updating…' : 'Analyse'}
        </button>
      </div>

      {/* ── Impact Panel ── */}
      {impactSummary && (impactSummary.changed.length > 0 || impactSummary.impacted.length > 0) && (
        <div style={{
          background: '#0a0b0f', borderTop: '1px solid #2a1a08',
          padding: '10px 16px', flexShrink: 0, maxHeight: 180, overflowY: 'auto',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 10, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Claude changed {impactSummary.changed.length} node{impactSummary.changed.length !== 1 ? 's' : ''}
              {impactSummary.impacted.length > 0 && ` · ${impactSummary.impacted.length} impacted`}
            </span>
            <span onClick={() => setImpactSummary(null)} style={{ fontSize: 11, color: '#444466', cursor: 'pointer', lineHeight: 1 }}>✕</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {impactSummary.changed.map((node) => (
              <div key={node.name} style={{ background: '#1a1200', border: '1px solid #d97706', borderRadius: 6, padding: '5px 10px', minWidth: 140, maxWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: '#d97706', textTransform: 'uppercase', background: '#3a2200', padding: '1px 5px', borderRadius: 3 }}>{node.type}</span>
                  <span style={{ fontSize: 11, color: '#fef3c7', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{node.name}</span>
                </div>
                {node.description && <div style={{ fontSize: 10, color: '#a16207', lineHeight: 1.4 }}>{node.description}</div>}
                {node.oldDescription && node.oldDescription !== node.description && (
                  <div style={{ fontSize: 9, color: '#5a4010', lineHeight: 1.3, marginTop: 2 }}>was: {node.oldDescription}</div>
                )}
              </div>
            ))}
            {impactSummary.impacted.map((node) => (
              <div key={node.name} style={{ background: '#130800', border: '1px solid #ea580c', borderRadius: 6, padding: '5px 10px', minWidth: 140, maxWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: '#ea580c', textTransform: 'uppercase', background: '#2a1000', padding: '1px 5px', borderRadius: 3 }}>{node.type}</span>
                  <span style={{ fontSize: 11, color: '#fff7ed', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{node.name}</span>
                </div>
                <div style={{ fontSize: 9, color: '#9a3412', lineHeight: 1.3 }}>{node.reason}</div>
                {node.description && <div style={{ fontSize: 10, color: '#7c2d12', lineHeight: 1.4, marginTop: 2 }}>{node.description}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Panes ── */}
      <div style={{ display: 'flex', flex: 1, padding: '10px', gap: 10, overflow: 'hidden' }}>

        {/* Terminal */}
        <div style={{
          width: '38%', minWidth: 300, display: 'flex', flexDirection: 'column',
          background: '#0d0d1a', borderRadius: 10,
          border: '1px solid #2a2a4a', overflow: 'hidden',
        }}>
          <div style={{
            padding: '6px 12px', fontSize: 10,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: '#444466', letterSpacing: '0.1em',
            textTransform: 'uppercase', borderBottom: '1px solid #1a1a30',
            flexShrink: 0, userSelect: 'none',
          }}>
            {folderName ? `Terminal · ${folderName}` : 'Terminal'}
          </div>
          <div style={{ flex: 1, overflow: 'hidden', padding: 4 }}>
            <Terminal />
          </div>
        </div>

        {/* Canvas */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          background: '#ffffff', borderRadius: 10,
          border: '1px solid #e0e0e8', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 12px',
            borderBottom: '1px solid #ebebf5',
            flexShrink: 0, userSelect: 'none',
          }}>
            {/* Back button — shown only when a drilldown is active on the canvas */}
            {drilldownActive && (
              <button onClick={handleBack} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', fontSize: 11, borderRadius: 5,
                fontFamily: 'system-ui, -apple-system, sans-serif',
                border: '1px solid #1a73b5', background: '#e0f2fe',
                color: '#0369a1', cursor: 'pointer', flexShrink: 0,
              }}>
                ← Back {drillDepth > 1 ? `(${drillDepth} levels)` : ''}
              </button>
            )}

            <span style={{
              fontSize: 10, color: drilldownActive ? '#5b21b6' : '#aaaabc',
              letterSpacing: '0.1em', textTransform: 'uppercase',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontWeight: drilldownActive ? 600 : 400,
            }}>
              {canvasLabel}
            </span>

            {/* Diagram-type switcher — hidden during drilldown */}
            {!drilldownActive && (
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                {DIAGRAM_TABS.map(({ kind, label }) => {
                  const available = !!diagram?.diagrams?.[kind];
                  const active = activeKind === kind;
                  return (
                    <button
                      key={kind}
                      disabled={!available}
                      onClick={() => { setActiveKind(kind); setRenderError(null); }}
                      style={{
                        padding: '3px 10px', fontSize: 11, borderRadius: 5,
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        border: active ? '1px solid #7c3aed' : '1px solid #e0e0e8',
                        background: active ? '#f5f3ff' : '#ffffff',
                        color: active ? '#5b21b6' : available ? '#666688' : '#c8c8d4',
                        cursor: available ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {renderError && (
            <div style={{
              padding: '4px 12px', fontSize: 10, color: '#b91c1c', background: '#fef2f2',
              borderBottom: '1px solid #fecaca', fontFamily: 'ui-monospace, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              Diagram render failed: {renderError}
            </div>
          )}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Canvas
              diagramData={diagram}
              activeKind={activeKind}
              onAPIReady={(api) => { excalidrawAPIRef.current = api; }}
              onRenderError={setRenderError}
              onDrilldownChange={(active) => { setDrilldownActive(active); if (!active) setDrillDepth(0); }}
              onSelectionChange={setSelectedComponent}
              clearDrilldownRef={clearDrilldownRef}
              renderDrilldownRef={renderDrilldownRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DrillIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  );
}
