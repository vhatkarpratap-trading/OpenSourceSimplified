import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, FONT_FAMILY } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';
import type { ExcalidrawElement as EXEl } from '@excalidraw/excalidraw/types/element/types';
import { DiagramData, DiagramKind, FlatScene, ExcalidrawElement, TYPE_COLORS } from './diagramBuilder';
import { buildMermaidScene } from './mermaidScene';
import { serializeCanvasContext } from './canvasSerializer';
import type { CommitDiffResult } from './global';

interface CanvasProps {
  diagramData?: DiagramData | null;
  activeKind?: DiagramKind;
  onAPIReady?: (api: ExcalidrawImperativeAPI) => void;
  onRenderError?: (message: string | null) => void;
  onDrilldownChange?: (active: boolean) => void;
  onCodeFlowChange?: (active: boolean) => void;
  onSelectionChange?: (names: string[]) => void;
  clearDrilldownRef?: React.MutableRefObject<(() => void) | null>;
  clearCodeFlowRef?: React.MutableRefObject<(() => void) | null>;
  clearAllCodeFlowsRef?: React.MutableRefObject<(() => void) | null>;
  renderDrilldownRef?: React.MutableRefObject<((name: string) => void) | null>;
  renderCodeFlowRef?: React.MutableRefObject<((name: string, mode?: 'story' | 'implementation' | 'actual', drillMermaid?: string) => Promise<void>) | null>;
  componentNamesRef?: React.MutableRefObject<(() => string[]) | null>;
  canvasContextRef?: React.MutableRefObject<(() => string) | null>;
  rawElementsRef?: React.MutableRefObject<(() => unknown[]) | null>;
  renderCommitDiffRef?: React.MutableRefObject<((diff: CommitDiffResult) => Promise<void>) | null>;
  clearCommitDiffRef?: React.MutableRefObject<(() => void) | null>;
  addNoteRef?: React.MutableRefObject<((data: { text: string; bg: string; stroke: string; textColor: string }) => void) | null>;
  selectionAnswerRef?: React.MutableRefObject<((diagram: DiagramData) => Promise<void>) | null>;
  errorAnnotations?: { node: string; error: string }[];
}

interface GitAnnotation { name: string; summary: string; added: number; removed: number }

/**
 * Visibility + highlighting rules:
 *   zoom hidden              → opacity 0
 *   no git info              → full opacity, all grey (default state)
 *   git changed (rect)       → restore type color (vivid), full opacity
 *   git changed (text/arrow) → full opacity
 *   git unchanged            → full opacity so the entire diagram remains readable
 *   Claude changed           → amber stroke + yellow bg
 *   Claude impacted          → orange stroke + peach bg
 */

interface ClaudeHighlights { changedNames: string[]; impactedNames: string[] }

/** Render Implementation descriptions as readable Excalidraw code cards. */
function applyImplementationCodeCards(elements: ExcalidrawElement[], descriptions?: Record<string, string>): ExcalidrawElement[] {
  if (!descriptions) return elements;
  const descriptionByLabel = new Map(Object.entries(descriptions).map(([key, value]) => [key.trim().toLowerCase(), value]));
  const labelByContainer = new Map<string, string>();
  for (const el of elements) {
    if (el.type === 'text') {
      const text = el as ExcalidrawElement & { containerId?: string | null; text?: string };
      if (text.containerId && text.text) labelByContainer.set(text.containerId, text.text.trim());
    }
  }

  const cards = new Map<string, { title: string; code: string; explanation: string; height: number }>();
  for (const el of elements) {
    if (el.type !== 'rectangle') continue;
    const label = labelByContainer.get(el.id);
    const description = label ? descriptionByLabel.get(label.toLowerCase()) : undefined;
    const match = description?.match(/^Code:\s*([\s\S]*?)(?:\n\s*Explanation:\s*([\s\S]*))?$/i);
    if (!label || !match?.[1]?.trim()) continue;
    const code = match[1].trim();
    const explanation = (match[2] ?? '').trim();
    const codeLines = code.split('\n').length;
    cards.set(el.id, { title: label, code, explanation, height: Math.max(180, 108 + codeLines * 23 + (explanation ? 42 : 0)) });
  }
  if (cards.size === 0) return elements;

  let seed = 6300000;
  const extras: ExcalidrawElement[] = [];
  const updated = elements.map(el => {
    if (el.type === 'rectangle' && cards.has(el.id)) {
      const card = cards.get(el.id)!;
      return { ...el, width: Math.max((el as { width: number }).width, 600), height: card.height, backgroundColor: '#ffffff', strokeColor: '#242424', strokeWidth: 2, roughness: 0.8, roundness: { type: 3 } } as ExcalidrawElement;
    }
    if (el.type === 'text') {
      const text = el as ExcalidrawElement & { containerId?: string | null; x: number; y: number; width: number; height: number; text: string };
      const card = text.containerId ? cards.get(text.containerId) : undefined;
      if (card) {
        const rect = elements.find(candidate => candidate.id === text.containerId) as ExcalidrawElement & { x: number; y: number; width: number };
        const groupIds = [...new Set([...(text.groupIds ?? []), 'node-group-' + text.containerId])];
        extras.push({ type: 'text', id: 'code-card-' + text.containerId, x: rect.x + 26, y: rect.y + 66, width: 548, height: card.code.split('\n').length * 23, text: card.code, originalText: card.code, fontSize: 16, fontFamily: FONT_FAMILY.Cascadia, textAlign: 'left', verticalAlign: 'top', strokeColor: '#1f2937', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds, frameId: null, seed: seed++, version: 1, versionNonce: seed++, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, containerId: null, lineHeight: 1.35, baseline: 13 } as unknown as ExcalidrawElement);
        if (card.explanation) extras.push({ type: 'text', id: 'code-note-' + text.containerId, x: rect.x + 26, y: rect.y + 76 + card.code.split('\n').length * 23, width: 548, height: 36, text: card.explanation, originalText: card.explanation, fontSize: 13, fontFamily: FONT_FAMILY.Helvetica, textAlign: 'left', verticalAlign: 'top', strokeColor: '#374151', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds, frameId: null, seed: seed++, version: 1, versionNonce: seed++, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, containerId: null, lineHeight: 1.35, baseline: 11 } as unknown as ExcalidrawElement);
        return { ...text, x: rect.x + 26, y: rect.y + 22, width: 548, height: 24, text: card.title, originalText: card.title, fontSize: 19, fontFamily: FONT_FAMILY.Helvetica, textAlign: 'left', verticalAlign: 'top', lineHeight: 1.25 } as ExcalidrawElement;
      }
    }
    return el;
  });
  return [...updated, ...extras];
}

function getTypeColor(el: ExcalidrawElement) {
  const nodeType = (el.customData?.nodeType as string | undefined) || '';
  return TYPE_COLORS[nodeType] || null;
}

function applyZoomAndGit(
  scene: FlatScene,
  zoom: number,
  gitChangedNames: string[] | null,
  claudeHighlights: ClaudeHighlights | null,
): ExcalidrawElement[] {
  const overviewSet    = new Set(scene.overviewIds);
  const gitChangedIds  = new Set<string>();

  if (gitChangedNames && gitChangedNames.length > 0) {
    for (const name of gitChangedNames) {
      (scene.nodeIds[name] || []).forEach(id => gitChangedIds.add(id));
    }
  }

  const claudeChangedIds  = new Set<string>();
  const claudeImpactedIds = new Set<string>();
  if (claudeHighlights) {
    for (const name of claudeHighlights.changedNames) {
      (scene.nodeIds[name] || []).forEach(id => claudeChangedIds.add(id));
    }
    for (const name of claudeHighlights.impactedNames) {
      (scene.nodeIds[name] || []).forEach(id => claudeImpactedIds.add(id));
    }
  }

  const hasGitChanges = gitChangedNames !== null && gitChangedNames.length > 0;
  const hasClaudeChanges = claudeChangedIds.size > 0 || claudeImpactedIds.size > 0;

  return scene.elements.map(el => {
    const thresh     = (el.customData?.zoomThresh as number | undefined) ?? 0;
    const isOverview = overviewSet.has(el.id);
    const visible    = isOverview ? zoom < 0.4 : zoom >= thresh;
    const baseOp     = (el as ExcalidrawElement & { _baseOpacity?: number })._baseOpacity ?? 100;

    if (!visible) return el.opacity === 0 ? el : { ...el, opacity: 0 };

    // ── Claude changes: keep base fixed, color ONLY changed nodes, grey the rest ──
    if (hasClaudeChanges) {
      const isChanged  = claudeChangedIds.has(el.id);
      const isImpacted = claudeImpactedIds.has(el.id);

      if (isChanged || isImpacted) {
        const stroke = isChanged ? '#d97706' : '#ea580c';
        const bg     = isChanged ? '#fef3c7' : '#fff7ed';
        if (el.type === 'rectangle') return { ...el, opacity: baseOp, strokeColor: stroke, backgroundColor: bg, strokeWidth: 2 } as ExcalidrawElement;
        if (el.type === 'text')      return { ...el, opacity: baseOp, strokeColor: isChanged ? '#92400e' : '#9a3412' } as ExcalidrawElement;
        return { ...el, opacity: baseOp, strokeColor: stroke } as ExcalidrawElement;
      }
      // Keep the full diagram legible while the changed nodes remain colour-coded.
      return el.opacity === baseOp ? el : { ...el, opacity: baseOp };
    }

    if (hasGitChanges) {
      if (gitChangedIds.has(el.id)) {
        if (el.type === 'rectangle') {
          // Restore the component's actual type color so it looks vivid and recognisable
          const tc = getTypeColor(el);
          return tc
            ? { ...el, opacity: baseOp, strokeColor: tc.stroke, backgroundColor: tc.bg, strokeWidth: 2 } as ExcalidrawElement
            : { ...el, opacity: baseOp, strokeColor: '#16a34a', backgroundColor: '#dcfce7', strokeWidth: 2 } as ExcalidrawElement;
        }
        // Text/arrows of changed nodes: restore color too
        if (el.type === 'text') {
          const tc = getTypeColor(el);
          return { ...el, opacity: baseOp, strokeColor: tc?.text ?? '#1e293b' } as ExcalidrawElement;
        }
        return el.opacity === baseOp ? el : { ...el, opacity: baseOp };
      }
      // Keep unchanged components fully visible; colour still identifies changes.
      return el.opacity === baseOp ? el : { ...el, opacity: baseOp };
    }

    // No changes — full grey base, normal opacity
    return el.opacity === baseOp ? el : { ...el, opacity: baseOp };
  });
}

/** Add a quiet visual boundary around the generated diagram without making it a component. */
function withGeneratedDesignBoundary(scene: FlatScene): FlatScene {
  const content = scene.elements.filter(el => !el.isDeleted && !el.customData?.isGeneratedDesignBoundary);
  if (content.length === 0) return scene;

  const left = Math.min(...content.map(el => el.x));
  const top = Math.min(...content.map(el => el.y));
  const right = Math.max(...content.map(el => el.x + el.width));
  const bottom = Math.max(...content.map(el => el.y + el.height));
  const padding = 48;

  const boundary = {
    type: 'rectangle',
    id: '__generated-design-boundary__',
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
    strokeColor: '#64748b',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'dashed',
    angle: 0,
    roughness: 0.5,
    opacity: 100,
    roundness: { type: 3 },
    groupIds: [],
    frameId: null,
    seed: 246813,
    version: 1,
    versionNonce: 246814,
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: true,
    boundElements: [],
    customData: { isGeneratedDesignBoundary: true },
  } as unknown as ExcalidrawElement;

  return {
    ...scene,
    elements: [boundary, ...scene.elements],
    normalIds: [boundary.id, ...scene.normalIds],
  };
}

/** Mermaid scenes can start left of their nominal origin. Account for their
 * actual bounds when placing a new panel beside an existing diagram. */
function horizontalBounds(elements: ExcalidrawElement[]): { left: number; right: number } {
  const visible = elements.filter(el => !el.isDeleted);
  if (visible.length === 0) return { left: 0, right: 0 };
  return {
    left: Math.min(...visible.map(el => el.x)),
    right: Math.max(...visible.map(el => el.x + el.width)),
  };
}

// Mermaid's automatic layout can make a valid wide diagram. Fitting every
// element into the viewport in that case turns the whole map into illegible
// postage stamps. Start centred on the map, but keep a readable floor and let
// people pan across the remaining branches.
const MIN_INITIAL_DIAGRAM_ZOOM = 0.55;

function fitDiagramAtReadableZoom(api: ExcalidrawImperativeAPI, elements: EXEl[]): number {
  api.scrollToContent(elements, { fitToContent: true, animate: false });
  const appState = api.getAppState();
  const fittedZoom = (appState.zoom as { value: number }).value;
  if (fittedZoom < MIN_INITIAL_DIAGRAM_ZOOM) {
    // Keep the scene centre fixed while raising the zoom. Excalidraw's public
    // imperative API does not expose zoomCanvas in v0.17, but updateScene
    // supports app-state updates.
    const centreX = appState.width / 2 / fittedZoom - appState.scrollX;
    const centreY = appState.height / 2 / fittedZoom - appState.scrollY;
    api.updateScene({
      appState: {
        zoom: { value: MIN_INITIAL_DIAGRAM_ZOOM as typeof appState.zoom.value },
        scrollX: appState.width / 2 / MIN_INITIAL_DIAGRAM_ZOOM - centreX,
        scrollY: appState.height / 2 / MIN_INITIAL_DIAGRAM_ZOOM - centreY,
      },
    });
    return MIN_INITIAL_DIAGRAM_ZOOM;
  }
  return fittedZoom;
}

export default function Canvas({ diagramData, activeKind = 'structure', onAPIReady, onRenderError, onDrilldownChange, onCodeFlowChange, onSelectionChange, clearDrilldownRef, clearCodeFlowRef, clearAllCodeFlowsRef, renderDrilldownRef, renderCodeFlowRef, componentNamesRef, canvasContextRef, rawElementsRef, renderCommitDiffRef, clearCommitDiffRef, addNoteRef, selectionAnswerRef, errorAnnotations }: CanvasProps) {
  const [apiReady, setApiReady] = useState(false);
  const apiRef          = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastDataRef     = useRef<DiagramData | null>(null);
  const flatRef         = useRef<FlatScene | null>(null);
  const lastZoomRef     = useRef<number>(1);
  const gitRef          = useRef<string[] | null>(null);
  const claudeRef       = useRef<ClaudeHighlights | null>(null);
  const annotationsRef  = useRef<GitAnnotation[]>([]);
  const debounceRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDiagramKey  = useRef<string>('');

  // Selection + drilldown state
  const idToNameRef        = useRef<Record<string, string>>({});
  const selectedNameRef    = useRef<string>('');
  const drillBusyRef       = useRef(false);
  const drilldownActiveRef = useRef(false);
  const drillStackRef      = useRef<ExcalidrawElement[][]>([]);
  // Code flow has its own independent stack — both panels live on canvas simultaneously
  const flowActiveRef      = useRef(false);
  const flowStackRef       = useRef<ExcalidrawElement[][]>([]);
  const commitHighlightActiveRef = useRef(false);

  // Load scene when data, active diagram kind, or API changes
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !apiReady) return;

    const mermaid = diagramData?.diagrams?.[activeKind];
    if (!diagramData || !mermaid) {
      api.resetScene();
      lastDataRef.current = null;
      flatRef.current = null;
      lastDiagramKey.current = '';
      gitRef.current = null;
      claudeRef.current = null;
      annotationsRef.current = [];
      return;
    }

    // Fingerprint = active kind + its mermaid source; redraw only when it changes
    const key = `${activeKind}|${mermaid.length}|${mermaid.slice(0, 64)}`;
    if (key === lastDiagramKey.current) return;
    // Don't reload base scene while drilldown or code flow is active — it would wipe the overlay
    if (drilldownActiveRef.current || flowActiveRef.current) return;
    lastDiagramKey.current = key;
    lastDataRef.current = diagramData;

    let cancelled = false;

    (async () => {
      let flat: FlatScene;
      try {
        flat = withGeneratedDesignBoundary(await buildMermaidScene(mermaid, diagramData.descriptions));
        onRenderError?.(null);
      } catch (err) {
        // Invalid Mermaid from the LLM — keep the last good scene, surface error
        const message = err instanceof Error ? err.message : String(err);
        onRenderError?.(message.split('\n')[0].slice(0, 160) || 'Invalid diagram');
        lastDiagramKey.current = ''; // allow retry on next payload
        return;
      }
      if (cancelled) return;

      // Store _baseOpacity = design opacity (100 for boxes/text, original for arrows)
      flat.elements = flat.elements.map(el => {
        const designOpacity = el.type === 'arrow' ? (el.opacity > 0 ? el.opacity : 55) : 100;
        return { ...el, _baseOpacity: designOpacity, opacity: designOpacity } as unknown as ExcalidrawElement;
      });

      flatRef.current = flat;

      // Build element-id → component-name reverse map for click-to-inspect
      const rev: Record<string, string> = {};
      for (const [name, ids] of Object.entries(flat.nodeIds)) {
        for (const id of ids) rev[id] = name;
      }
      // Edges carry their own source → destination handoff. Treating that as a
      // selectable target lets Code Story and Code Walkthrough explain the
      // contract on the arrow rather than only either endpoint.
      for (const element of flat.elements) {
        if (element.type !== 'arrow') continue;
        const handoff = element.customData?.handoff;
        if (typeof handoff === 'string' && handoff.trim()) rev[element.id] = handoff.trim();
      }
      idToNameRef.current = rev;
      selectedNameRef.current = '';

      const zoom = (api.getAppState().zoom as { value: number }).value;
      lastZoomRef.current = zoom;

      const elements = applyZoomAndGit(flat, zoom, gitRef.current, claudeRef.current);
      api.updateScene({ elements: elements as unknown as EXEl[] });

      // Fit to visible elements
      const tryFit = (n: number) => {
        const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 0);
        if (els.length > 0) {
          lastZoomRef.current = fitDiagramAtReadableZoom(api, els as EXEl[]);
          if (annotationsRef.current.length > 0) {
            setTimeout(() => renderAnnotationBadges(annotationsRef.current), 100);
          }
        } else if (n > 0) setTimeout(() => tryFit(n - 1), 150);
      };
      setTimeout(() => tryFit(20), 200);
    })();

    return () => { cancelled = true; };
  }, [diagramData, activeKind, apiReady]);

  // Poll zoom every 200ms — update opacities when zoom or git changes
  useEffect(() => {
    const interval = setInterval(() => {
      const api  = apiRef.current;
      const flat = flatRef.current;
      if (!api || !flat) return;
      if (drilldownActiveRef.current || flowActiveRef.current || commitHighlightActiveRef.current) return; // overlays own the scene

      const zoom = (api.getAppState().zoom as { value: number }).value;
      if (Math.abs(zoom - lastZoomRef.current) < 0.001) return;

      lastZoomRef.current = zoom;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const api2 = apiRef.current;
        const flat2 = flatRef.current;
        if (!api2 || !flat2 || drilldownActiveRef.current || flowActiveRef.current || commitHighlightActiveRef.current) return;
        const z = (api2.getAppState().zoom as { value: number }).value;
        const updated = applyZoomAndGit(flat2, z, gitRef.current, claudeRef.current);
        flatRef.current = { ...flat2, elements: updated };
        api2.updateScene({ elements: updated as unknown as EXEl[] });
      }, 300);
    }, 200);

    return () => { clearInterval(interval); if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Git status + Claude change listeners — re-apply highlights immediately
  useEffect(() => {
    window.electronAPI.onGitStatus((changedNames: string[]) => {
      gitRef.current = changedNames;
      if (drilldownActiveRef.current || flowActiveRef.current || commitHighlightActiveRef.current) return; // don't overwrite drill/flow/commit scene
      const api  = apiRef.current;
      const flat = flatRef.current;
      if (!api || !flat) return;
      const zoom = (api.getAppState().zoom as { value: number }).value;
      const updated = applyZoomAndGit(flat, zoom, changedNames, claudeRef.current);
      flatRef.current = { ...flat, elements: updated };
      api.updateScene({ elements: updated as unknown as EXEl[] });
    });

    window.electronAPI.onGitAnnotations((annotations: GitAnnotation[]) => {
      annotationsRef.current = annotations;
      renderAnnotationBadges(annotations);
    });

    window.electronAPI.onClaudeChanges((changes: ClaudeHighlights) => {
      claudeRef.current = changes;
      gitRef.current = null;
      if (drilldownActiveRef.current || flowActiveRef.current || commitHighlightActiveRef.current) return;
      const api  = apiRef.current;
      const flat = flatRef.current;
      if (!api || !flat) return;
      const zoom = (api.getAppState().zoom as { value: number }).value;
      const updated = applyZoomAndGit(flat, zoom, null, changes);
      flatRef.current = { ...flat, elements: updated };
      api.updateScene({ elements: updated as unknown as EXEl[] });

      // Auto-zoom: pan+fit to the changed nodes so developer immediately sees what moved
      setTimeout(() => {
        const changedIds = new Set<string>();
        for (const name of changes.changedNames) {
          (flat.nodeIds[name] || []).forEach(id => changedIds.add(id));
        }
        for (const name of changes.impactedNames) {
          (flat.nodeIds[name] || []).forEach(id => changedIds.add(id));
        }
        const changedEls = api.getSceneElements().filter(e => changedIds.has(e.id)) as EXEl[];
        if (changedEls.length > 0) {
          api.scrollToContent(changedEls, { fitToContent: true, animate: true });
        }
      }, 100);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render green annotation badges directly on the scene next to changed components
  const renderAnnotationBadges = useCallback((annotations: GitAnnotation[]) => {
    const api  = apiRef.current;
    const flat = flatRef.current;
    if (!api || !flat || annotations.length === 0) return;

    // Remove existing annotation badges (ids starting with "git-ann-")
    const existing = api.getSceneElements() as unknown as (EXEl & { id: string })[];
    const withoutOld = existing.filter(e => !e.id.startsWith('git-ann-'));

    let seed = 1000000;
    const newEls: unknown[] = [];

    for (const ann of annotations) {
      // Find the box element for this node
      const nodeElIds = flat.nodeIds[ann.name] || [];
      const boxEl = existing.find(e => nodeElIds.includes(e.id) && e.type === 'rectangle') as
        (EXEl & { x: number; y: number; width: number; height: number }) | undefined;
      if (!boxEl) continue;

      const badgeW = 160;
      const lines = ann.summary.split('\n');
      const badgeH = 20 + lines.length * 14 + 10;
      const bx = boxEl.x + boxEl.width + 10;
      const by = boxEl.y;

      const statColor = ann.added > 0 && ann.removed === 0 ? '#15803d'
        : ann.removed > 0 && ann.added === 0 ? '#dc2626'
        : '#0369a1';
      const statBg = ann.added > 0 && ann.removed === 0 ? '#f0fdf4'
        : ann.removed > 0 && ann.added === 0 ? '#fef2f2'
        : '#eff6ff';

      const rectId = `git-ann-rect-${ann.name}`;
      const textId = `git-ann-text-${ann.name}`;

      // Badge box
      newEls.push({
        type: 'rectangle', id: rectId,
        x: bx, y: by, width: badgeW, height: badgeH,
        strokeColor: statColor, backgroundColor: statBg,
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100,
        roundness: { type: 3 }, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
        customData: { isAnnotation: true },
      });

      // Badge text — component name bold + summary lines
      const fullText = `● ${ann.name}\n${ann.summary}`;
      newEls.push({
        type: 'text', id: textId,
        x: bx + 8, y: by + 6, width: badgeW - 16, height: badgeH - 12,
        text: fullText, originalText: fullText,
        fontSize: 10, fontFamily: 1,
        textAlign: 'left', verticalAlign: 'top',
        strokeColor: statColor, backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null,
        groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.4, baseline: 8,
        customData: { isAnnotation: true },
      });
    }

    if (newEls.length > 0) {
      api.updateScene({
        elements: [...withoutOld, ...newEls] as Parameters<typeof api.updateScene>[0]['elements'],
      });
    }
  }, []);

  // ── Commit diff overlay ───────────────────────────────────────────────────────

  const renderCommitDiff = useCallback(async (diff: CommitDiffResult) => {
    const api = apiRef.current;
    if (!api || !diff.ok) return;

    commitHighlightActiveRef.current = true;

    let seed = 8500000;
    const allEls: unknown[] = [];

    const info = diff.commitInfo;
    const short = info?.short ?? diff.changedFiles?.[0]?.slice(0, 7) ?? '?';
    const commitMsg = info?.message ?? '';

    // ── Feature Flow panel (left) ──────────────────────────────────────────
    if (diff.featureFlow?.mermaid) {
      let featureScene: FlatScene | null = null;
      try {
        const { buildMermaidScene: bms } = await import('./mermaidScene');
        featureScene = await bms(diff.featureFlow.mermaid, diff.featureFlow.descriptions);
      } catch { /* fall through */ }

      if (featureScene) {
        const fEls = featureScene.elements.map((e, i) => ({
          ...e,
          id: `commit-ff-${i}-${e.id}`,
          _baseOpacity: 100, opacity: 100,
        }));

        const minX = fEls.filter(e => e.type === 'rectangle').reduce((m, e) => Math.min(m, (e as { x: number }).x), Infinity);
        const minY = fEls.filter(e => e.type === 'rectangle').reduce((m, e) => Math.min(m, (e as { y: number }).y), Infinity);
        const labelY = isFinite(minY) ? minY - 28 : -28;
        const labelX = isFinite(minX) ? minX : 0;

        const labelText = `⊡ Feature Flow · ${short}${commitMsg ? '  ·  ' + commitMsg.slice(0, 50) : ''}`;
        allEls.push({
          type: 'text', id: 'commit-ff-label',
          x: labelX, y: labelY, width: 600, height: 20,
          text: labelText, originalText: labelText,
          fontSize: 13, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
          strokeColor: '#6d28d9', backgroundColor: 'transparent',
          fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
          angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
          frameId: null, seed: seed++, version: 1, versionNonce: seed++,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
          containerId: null, lineHeight: 1.25, baseline: 10,
        });
        allEls.push(...fEls);
      }
    }

    // ── Code Flow panel (right, offset from feature flow) ─────────────────
    if (diff.codeFlow?.mermaid) {
      let codeScene: FlatScene | null = null;
      try {
        const { buildMermaidScene: bms } = await import('./mermaidScene');
        codeScene = await bms(diff.codeFlow.mermaid);
      } catch { /* fall through */ }

      if (codeScene) {
        // Place to the right of the feature flow panel
        type RectEl = { type: string; x: number; y: number; width: number };
        const ffRects = allEls.filter((e): e is RectEl => (e as RectEl).type === 'rectangle') as RectEl[];
        const ffMaxX: number = ffRects.reduce((m, e) => Math.max(m, e.x + (e.width ?? 0)), 0);
        const ffMinY: number = ffRects.reduce((m, e) => Math.min(m, e.y), Infinity);

        const offsetX: number = isFinite(ffMaxX) ? ffMaxX + 120 : 800;
        const offsetY: number = isFinite(ffMinY) ? ffMinY : 0;

        // Parse mermaid node labels for happy-path matching (same pattern as renderCodeFlow)
        const happyPath: string[] = diff.codeFlow.happyPath ?? [];
        const mermaidNodeLabels = new Map<string, string>();
        for (const line of (diff.codeFlow.mermaid || '').split('\n')) {
          const m = line.trim().match(/^([A-Za-z0-9_]+)\s*[\[({]+"?([^\\"\\n]+)/);
          if (m) mermaidNodeLabels.set(m[1], m[2].replace(/["]/g, '').trim());
        }

        const cEls = codeScene.elements.map((e, i) => ({
          ...e,
          id: `commit-cf-${i}-${e.id}`,
          x: (e as { x: number }).x + offsetX,
          y: (e as { y: number }).y + offsetY,
          _baseOpacity: 100, opacity: 100,
          customData: {
            ...(e as { customData?: object }).customData,
            drillName: (e as { type?: string }).type === 'rectangle'
              ? (() => {
                  const t = codeScene!.elements.find(t =>
                    (t as { type?: string; containerId?: string }).type === 'text' &&
                    (t as { containerId?: string }).containerId === (e as { id: string }).id
                  );
                  return t ? (t as { text?: string }).text?.split('\n')[0].trim() : undefined;
                })()
              : undefined,
          },
        })) as unknown as ExcalidrawElement[];

        // Happy path: match labels → element ids
        const rectTexts = new Map<string, string>();
        for (const el of cEls) {
          if (el.type !== 'text') continue;
          const cid = (el as { containerId?: string | null }).containerId;
          const txt = ((el as { text?: string }).text ?? '').split('\n')[0].trim().toLowerCase().replace(/[().\s]/g, '');
          if (cid) rectTexts.set(cid, txt);
        }
        const origToNewId = new Map<string, string>();
        for (const [mermaidId, labelText] of mermaidNodeLabels.entries()) {
          if (mermaidId.endsWith('Desc')) continue;
          const needle = labelText.toLowerCase().replace(/[().\s]/g, '').slice(0, 14);
          const match = cEls.find(el => el.type === 'rectangle' && (rectTexts.get(el.id) ?? '').startsWith(needle));
          if (match) origToNewId.set(mermaidId, match.id);
        }
        const happyNodeIds = new Set(happyPath.map(id => origToNewId.get(id)).filter(Boolean) as string[]);

        const cElsMutable = cEls.map(el => {
          if (happyNodeIds.has(el.id) && el.type === 'rectangle')
            return { ...el, strokeColor: '#dc2626', strokeWidth: 2.5 } as ExcalidrawElement;
          if (el.type === 'arrow') {
            const sb = (el as { startBinding?: { elementId: string } | null }).startBinding;
            const eb = (el as { endBinding?: { elementId: string } | null }).endBinding;
            if (sb && eb) {
              const from = happyPath.find(id => origToNewId.get(id + 'Desc') === sb.elementId || origToNewId.get(id) === sb.elementId);
              const to = happyPath.find(id => origToNewId.get(id) === eb.elementId);
              if (from && to && happyPath.indexOf(to) === happyPath.indexOf(from) + 1)
                return { ...el, strokeColor: '#dc2626', strokeWidth: 2.5, opacity: 100 } as ExcalidrawElement;
            }
          }
          return el;
        });

        // Numbered badges on happy path nodes
        let badgeSeed = seed + 300000;
        happyPath.forEach((origId, idx) => {
          const newId = origToNewId.get(origId);
          if (!newId) return;
          const el = cElsMutable.find(e => e.id === newId) as (ExcalidrawElement & { x: number; y: number }) | undefined;
          if (!el || el.type !== 'rectangle') return;
          const bSize = 20;
          allEls.push(
            { type: 'rectangle', id: `commit-hp-rect-${idx}`, x: el.x - bSize / 2, y: el.y - bSize / 2, width: bSize, height: bSize, strokeColor: '#dc2626', backgroundColor: '#dc2626', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', angle: 0, roughness: 0.8, opacity: 100, roundness: { type: 3 }, groupIds: [], frameId: null, seed: badgeSeed++, version: 1, versionNonce: badgeSeed++, isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false },
            { type: 'text', id: `commit-hp-text-${idx}`, x: el.x - bSize / 2, y: el.y - bSize / 2 + 2, width: bSize, height: bSize - 2, text: String(idx + 1), originalText: String(idx + 1), fontSize: 11, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle', strokeColor: '#ffffff', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [], frameId: null, seed: badgeSeed++, version: 1, versionNonce: badgeSeed++, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, containerId: null, lineHeight: 1.2, baseline: 9 },
          );
        });
        seed = badgeSeed;

        const cfMinX = cEls.filter(e => e.type === 'rectangle').reduce((m, e) => Math.min(m, (e as { x: number }).x), Infinity);
        const cfMinY = cEls.filter(e => e.type === 'rectangle').reduce((m, e) => Math.min(m, (e as { y: number }).y), Infinity);
        const cfLabelY = isFinite(cfMinY) ? cfMinY - 28 : offsetY - 28;
        const cfLabelX = isFinite(cfMinX) ? cfMinX : offsetX;
        const cfLabel = happyPath.length > 0
          ? `⟳ Code Flow · ${short}  ·  🔴 = happy path`
          : `⟳ Code Flow · ${short}`;
        allEls.push({
          type: 'text', id: 'commit-cf-label',
          x: cfLabelX, y: cfLabelY, width: 520, height: 20,
          text: cfLabel, originalText: cfLabel,
          fontSize: 13, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
          strokeColor: '#16a34a', backgroundColor: 'transparent',
          fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
          angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
          frameId: null, seed: seed++, version: 1, versionNonce: seed++,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
          containerId: null, lineHeight: 1.25, baseline: 10,
        });
        allEls.push(...cElsMutable);
      }
    }

    // Clear old commit elements and set new scene
    api.updateScene({ elements: allEls as unknown as EXEl[] });

    // Fit to the new content — retry a few times to ensure scene has settled
    const tryFit = (attempts: number) => {
      const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 0);
      if (els.length > 0) {
        api.scrollToContent(els as EXEl[], { fitToContent: true, animate: false });
      } else if (attempts > 0) {
        setTimeout(() => tryFit(attempts - 1), 200);
      }
    };
    setTimeout(() => tryFit(5), 100);

  }, []);

  const clearCommitDiff = useCallback(() => {
    commitHighlightActiveRef.current = false;
    const api  = apiRef.current;
    const flat = flatRef.current;
    if (!api) return;

    if (flat) {
      const zoom = (api.getAppState().zoom as { value: number }).value;
      const restored = applyZoomAndGit(flat, zoom, gitRef.current, claudeRef.current);
      api.updateScene({ elements: restored as unknown as EXEl[] });
      if (annotationsRef.current.length > 0) {
        setTimeout(() => renderAnnotationBadges(annotationsRef.current), 80);
      }
    } else {
      api.updateScene({ elements: [] });
    }

    // Fit back to restored content
    setTimeout(() => {
      const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 0);
      if (els.length > 0) api.scrollToContent(els as EXEl[], { fitToContent: true, animate: true });
    }, 100);
  }, [renderAnnotationBadges]);

  useEffect(() => {
    if (renderCommitDiffRef) renderCommitDiffRef.current = renderCommitDiff;
  }, [renderCommitDiff, renderCommitDiffRef]);

  useEffect(() => {
    if (clearCommitDiffRef) clearCommitDiffRef.current = clearCommitDiff;
  }, [clearCommitDiff, clearCommitDiffRef]);

  const renderSelectionAnswer = useCallback(async (answer: DiagramData) => {
    const api = apiRef.current;
    const mermaid = answer.diagrams?.structure;
    if (!api || !mermaid) return;

    const scene = withGeneratedDesignBoundary(await buildMermaidScene(mermaid, answer.descriptions));
    const existing = api.getSceneElements() as unknown as ExcalidrawElement[];
    const existingRects = existing.filter(e => e.type === 'rectangle') as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
    const existingRight = existingRects.reduce((max, e) => Math.max(max, e.x + e.width), 0);
    const offsetX = existingRight + 140 - horizontalBounds(scene.elements).left;
    const offsetY = existingRects.reduce((min, e) => Math.min(min, e.y), Infinity);
    const panelY = isFinite(offsetY) ? offsetY : 0;
    const seedBase = 9200000 + existing.length;

    const answerElements = scene.elements.map((el, index) => ({
      ...el,
      id: `selection-answer-${index}-${el.id}`,
      x: (el as { x: number }).x + offsetX,
      y: (el as { y: number }).y + panelY,
    })) as unknown as ExcalidrawElement[];

    const title: ExcalidrawElement = {
      type: 'text', id: `selection-answer-title-${seedBase}`,
      x: offsetX, y: panelY - 30, width: 520, height: 22,
      text: `Answer: ${answer.pattern || 'Selected components'}`, originalText: `Answer: ${answer.pattern || 'Selected components'}`,
      fontSize: 14, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
      strokeColor: '#4f46e5', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [], frameId: null,
      seed: seedBase, version: 1, versionNonce: seedBase + 1, isDeleted: false, boundElements: null,
      updated: Date.now(), link: null, locked: false, containerId: null, lineHeight: 1.25, baseline: 11,
    } as ExcalidrawElement;

    for (const [name, ids] of Object.entries(scene.nodeIds)) {
      for (const id of ids) idToNameRef.current[`selection-answer-${scene.elements.findIndex(el => el.id === id)}-${id}`] = name;
    }
    api.updateScene({ elements: [...existing, title, ...answerElements] as unknown as EXEl[] });
    setTimeout(() => api.scrollToContent([title, ...answerElements] as unknown as EXEl[], { fitToContent: false, animate: true }), 50);
  }, []);

  useEffect(() => {
    if (selectionAnswerRef) selectionAnswerRef.current = renderSelectionAnswer;
  }, [renderSelectionAnswer, selectionAnswerRef]);

  // ── Selection tracking ────────────────────────────────────────────────────────

  const clearSelection = useCallback(() => {
    if (selectedNameRef.current === '') return;
    selectedNameRef.current = '';
    onSelectionChange?.([]);
  }, [onSelectionChange]);

  // ── Drilldown clear/back ─────────────────────────────────────────────────────

  const clearDrilldown = useCallback(() => {
    const api = apiRef.current;
    if (!api || drillStackRef.current.length === 0) return;

    drillStackRef.current.pop();
    const prev = drillStackRef.current[drillStackRef.current.length - 1] ?? null;

    if (prev) {
      api.updateScene({ elements: prev as unknown as EXEl[] });
    } else {
      drilldownActiveRef.current = false;
      onDrilldownChange?.(false);
      lastDiagramKey.current = '';
      // If flow is still active, restore to the flow snapshot; else restore base scene
      if (flowActiveRef.current && flowStackRef.current.length > 0) {
        const flowBase = flowStackRef.current[0];
        api.updateScene({ elements: flowBase as unknown as EXEl[] });
      } else {
        const flat = flatRef.current;
        if (flat) {
          const els = applyZoomAndGit(flat, lastZoomRef.current, gitRef.current, claudeRef.current);
          api.updateScene({ elements: els as unknown as EXEl[] });
        } else {
          api.resetScene();
        }
      }
    }

    setTimeout(() => {
      const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 5);
      if (els.length > 0) api.scrollToContent(els as EXEl[], { fitToContent: true, animate: true });
    }, 100);
  }, [onDrilldownChange]);

  useEffect(() => {
    if (clearDrilldownRef) clearDrilldownRef.current = clearDrilldown;
  }, [clearDrilldown, clearDrilldownRef]);

  // ── Code flow clear/back ──────────────────────────────────────────────────────

  const clearCodeFlow = useCallback(() => {
    const api = apiRef.current;
    if (!api || flowStackRef.current.length === 0) return;

    flowStackRef.current.pop();
    const prev = flowStackRef.current[flowStackRef.current.length - 1] ?? null;

    if (prev) {
      api.updateScene({ elements: prev as unknown as EXEl[] });
    } else {
      flowActiveRef.current = false;
      onCodeFlowChange?.(false);
      lastDiagramKey.current = '';
      // If drill is still active, restore to drill snapshot; else restore base scene
      if (drilldownActiveRef.current && drillStackRef.current.length > 0) {
        const drillBase = drillStackRef.current[0];
        api.updateScene({ elements: drillBase as unknown as EXEl[] });
      } else {
        const flat = flatRef.current;
        if (flat) {
          const els = applyZoomAndGit(flat, lastZoomRef.current, gitRef.current, claudeRef.current);
          api.updateScene({ elements: els as unknown as EXEl[] });
        } else {
          api.resetScene();
        }
      }
    }

    setTimeout(() => {
      const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 5);
      if (els.length > 0) api.scrollToContent(els as EXEl[], { fitToContent: true, animate: true });
    }, 100);
  }, [onCodeFlowChange]);

  useEffect(() => {
    if (clearCodeFlowRef) clearCodeFlowRef.current = clearCodeFlow;
  }, [clearCodeFlow, clearCodeFlowRef]);

  const clearAllCodeFlows = useCallback(() => {
    const api = apiRef.current;
    if (!api || flowStackRef.current.length === 0) return;
    flowStackRef.current = [];
    flowActiveRef.current = false;
    onCodeFlowChange?.(false);
    lastDiagramKey.current = '';
    const flat = flatRef.current;
    if (flat) api.updateScene({ elements: applyZoomAndGit(flat, lastZoomRef.current, gitRef.current, claudeRef.current) as unknown as EXEl[] });
    else api.resetScene();
  }, [onCodeFlowChange]);

  useEffect(() => {
    if (clearAllCodeFlowsRef) clearAllCodeFlowsRef.current = clearAllCodeFlows;
  }, [clearAllCodeFlows, clearAllCodeFlowsRef]);

  const renderDrilldown = useCallback(async (rawName: string) => {
    const name = rawName.trim();
    const api = apiRef.current;
    if (!api) return;

    // Reset stuck busy flag — if a previous drill failed mid-way drillBusyRef
    // could be left true, blocking all future drills.
    drillBusyRef.current = false;
    drillBusyRef.current = true;

    console.log('[drill] starting drill for:', name);
    console.log('[drill] idToNameRef entries:', Object.entries(idToNameRef.current).slice(0, 20));

    // Snapshot the full current scene before we add to it
    const currentEls = api.getSceneElements() as unknown as ExcalidrawElement[];

    // Find the selected component's box anywhere on the current canvas.
    // Match by: idToNameRef lookup, customData.drillName, or text content of any rectangle's label.
    const nameLC = name.toLowerCase();
    const matchingIds = Object.entries(idToNameRef.current)
      .filter(([, n]) => n.toLowerCase() === nameLC)
      .map(([id]) => id);
    const nodeElIds = new Set(matchingIds);

    console.log('[drill] matching ids for', name, ':', matchingIds);

    const box = currentEls.find(e => {
      if (e.type !== 'rectangle') return false;
      if (nodeElIds.has(e.id)) return true;
      // Also match by drillName tag on drilled nodes
      const dn = (e as ExcalidrawElement & { customData?: { drillName?: string } }).customData?.drillName;
      return dn && dn.toLowerCase() === nameLC;
    }) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined;

    console.log('[drill] box found:', !!box, box ? `at (${box.x},${box.y})` : '');

    // Show loading indicator to the right of the selected box
    const allRects = currentEls.filter(e => e.type === 'rectangle') as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
    const maxX = allRects.reduce((m, e) => Math.max(m, e.x + e.width), box ? box.x + box.width : 0);
    const loadX = maxX + 80;
    const loadY = box ? box.y : allRects.reduce((m, e) => Math.min(m, e.y), 200);

    let seed = 9000000 + drillStackRef.current.length * 100000;
    const loadingEls: unknown[] = [{
      type: 'rectangle', id: `drill-loading-${seed}`,
      x: loadX, y: loadY, width: 220, height: 40,
      strokeColor: '#1a73b5', backgroundColor: '#e0f2fe',
      fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'dashed',
      angle: 0, roughness: 0, opacity: 100, roundness: { type: 3 }, groupIds: [],
      frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
    }, {
      type: 'text', id: `drill-loading-text-${seed}`,
      x: loadX + 10, y: loadY + 11, width: 200, height: 18,
      text: `Drilling into ${name}…`, originalText: `Drilling into ${name}…`,
      fontSize: 12, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
      strokeColor: '#0369a1', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
      frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      containerId: null, lineHeight: 1.25, baseline: 10,
    }];
    api.updateScene({ elements: [...currentEls, ...loadingEls] as unknown as EXEl[] });

    try {
      const res = await window.electronAPI.getComponentDrilldown(name);
      if (!res?.ok || !res.mermaid) throw new Error('no mermaid');

      const { buildMermaidScene: bms } = await import('./mermaidScene');
      const drillScene = withGeneratedDesignBoundary(await bms(res.mermaid));

      // Place new drill panel to the right of everything currently on canvas
      const freshEls = api.getSceneElements() as unknown as ExcalidrawElement[];
      const freshRects = freshEls.filter(e =>
        e.type === 'rectangle' && !e.id.startsWith('drill-loading')
      ) as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
      const existingRight = freshRects.reduce((m, e) => Math.max(m, e.x + e.width), 0);
      const panelOffsetX = existingRight + 100 - horizontalBounds(drillScene.elements).left;
      const panelOffsetY = freshRects.reduce((m, e) => Math.min(m, e.y), Infinity);
      const panelY = isFinite(panelOffsetY) ? panelOffsetY : 0;

      // Give each element in this drill level a unique id using depth + index
      const depth = drillStackRef.current.length;
      seed = 9000000 + depth * 100000;

      const drillEls = drillScene.elements.map((e, i) => ({
        ...e,
        id: `drill-d${depth}-${i}-${e.id}`,
        x: (e as { x: number }).x + panelOffsetX,
        y: (e as { y: number }).y + panelY,
        _baseOpacity: 100,
        opacity: 100,
        customData: {
          ...(e as { customData?: object }).customData,
          drillDepth: depth,
          // Tag each node with its label so future drills can find it
          drillName: (e as { type?: string }).type === 'rectangle'
            ? (() => {
                // extract label from the matching text element
                const textEl = drillScene.elements.find(t =>
                  (t as { type?: string; containerId?: string }).type === 'text' &&
                  (t as { containerId?: string }).containerId === (e as { id: string }).id
                );
                return textEl ? (textEl as { text?: string }).text?.split('\n')[0].trim() : undefined;
              })()
            : undefined,
        },
      })) as unknown as ExcalidrawElement[];

      // Dashed connector from selected box to first node of drill panel
      const drillMinX = drillEls
        .filter(e => e.type === 'rectangle')
        .reduce((m, e) => Math.min(m, (e as { x: number }).x), Infinity);
      const drillMidY = drillEls
        .filter(e => e.type === 'rectangle')
        .reduce((acc, e, _, arr) => acc + ((e as { y: number; height: number }).y + (e as { height: number }).height / 2) / arr.length, 0);

      const connEls: unknown[] = box ? [{
        type: 'arrow', id: `drill-conn-d${depth}`,
        x: box.x + box.width, y: box.y + box.height / 2,
        width: drillMinX - (box.x + box.width),
        height: drillMidY - (box.y + box.height / 2),
        points: [[0, 0], [drillMinX - (box.x + box.width), drillMidY - (box.y + box.height / 2)]],
        strokeColor: '#1a73b5', backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 2, strokeStyle: 'dashed', angle: 0, roughness: 0, opacity: 80,
        startArrowhead: null, endArrowhead: 'arrow', boundElements: null,
        groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, updated: Date.now(), link: null, locked: false,
        startBinding: null, endBinding: null, roundness: { type: 2 }, elbowed: false,
      }] : [];

      const labelEls: unknown[] = [{
        type: 'text', id: `drill-label-d${depth}`,
        x: panelOffsetX, y: panelY - 26, width: 320, height: 20,
        text: `${'▸ '.repeat(depth + 1)}${name}`,
        originalText: `${'▸ '.repeat(depth + 1)}${name}`,
        fontSize: 13, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
        strokeColor: '#0369a1', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.25, baseline: 10,
      }];

      // Remove loading placeholder, add drill panel
      const withoutLoading = (api.getSceneElements() as unknown as ExcalidrawElement[])
        .filter(e => !e.id.startsWith('drill-loading'));
      const finalEls = [...withoutLoading, ...connEls, ...labelEls, ...drillEls];

      // Push snapshot BEFORE adding the new drill level (so Back restores to current state)
      drillStackRef.current.push(withoutLoading as ExcalidrawElement[]);

      // Extend idToNameRef with new nodes so they can be selected + drilled further
      for (const e of drillEls) {
        const dn = (e as ExcalidrawElement & { customData?: { drillName?: string } }).customData?.drillName;
        if (dn && e.type === 'rectangle') idToNameRef.current[e.id] = dn;
      }
      // Also index text elements
      for (const e of drillEls) {
        if (e.type === 'text') {
          const text = (e as { text?: string }).text?.split('\n')[0].trim();
          if (text) idToNameRef.current[e.id] = text;
        }
      }

      drilldownActiveRef.current = true;
      onDrilldownChange?.(true);

      api.updateScene({ elements: finalEls as unknown as EXEl[] });
      setTimeout(() => {
        // Scroll to show the new drill panel
        const newPanelEls = (finalEls as ExcalidrawElement[]).filter((e: ExcalidrawElement) =>
          e.id.startsWith(`drill-d${depth}`) || e.id === `drill-conn-d${depth}` || e.id === `drill-label-d${depth}`
        );
        if (newPanelEls.length > 0)
          api.scrollToContent(newPanelEls as unknown as EXEl[], { fitToContent: false, animate: true });
      }, 150);

      // A drill is the first, user-facing learning level. Do not automatically
      // add Code Story and Implementation: three side-by-side maps are hard to
      // read and make an implementation look like a duplicate user journey.
      // The user can reveal either deeper level explicitly from the toolbar.

    } catch {
      // Remove loading indicator on failure, restore clean state
      const withoutLoading = (api.getSceneElements() as unknown as ExcalidrawElement[])
        .filter(e => !e.id.startsWith('drill-loading'));
      api.updateScene({ elements: withoutLoading as unknown as EXEl[] });
    } finally {
      drillBusyRef.current = false;
    }
  }, [onDrilldownChange]);

  useEffect(() => {
    if (renderDrilldownRef) renderDrilldownRef.current = renderDrilldown;
  }, [renderDrilldown, renderDrilldownRef]);

  const renderCodeFlow = useCallback(async (rawName: string, mode: 'story' | 'implementation' | 'actual' = 'story', drillMermaid = '') => {
    const name = rawName.trim();
    const api = apiRef.current;
    if (!api) return;
    onRenderError?.(null);

    const currentEls = api.getSceneElements() as unknown as ExcalidrawElement[];

    // Find anchor box for the dashed connector
    const nameLC = name.toLowerCase();
    const matchingIds = Object.entries(idToNameRef.current)
      .filter(([, n]) => n.toLowerCase() === nameLC).map(([id]) => id);
    const nodeElIds = new Set(matchingIds);
    const box = currentEls.find(e => {
      if (e.type !== 'rectangle') return false;
      if (nodeElIds.has(e.id)) return true;
      const dn = (e as ExcalidrawElement & { customData?: { drillName?: string } }).customData?.drillName;
      return dn && dn.toLowerCase() === nameLC;
    }) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined;

    // Loading indicator
    const allRects = currentEls.filter(e => e.type === 'rectangle') as
      (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
    const maxX = allRects.reduce((m, e) => Math.max(m, e.x + e.width), box ? box.x + box.width : 0);
    const loadX = maxX + 80;
    const loadY = box ? box.y : allRects.reduce((m, e) => Math.min(m, e.y), 200);
    let seed = 7000000 + flowStackRef.current.length * 100000;

    const loadingEls: unknown[] = [{
      type: 'rectangle', id: `flow-loading-rect-${seed}`,
      x: loadX, y: loadY, width: 240, height: 40,
      strokeColor: '#16a34a', backgroundColor: '#dcfce7',
      fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'dashed',
      angle: 0, roughness: 1, opacity: 100, roundness: { type: 3 }, groupIds: [],
      frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
    }, {
      type: 'text', id: `flow-loading-text-${seed}`,
      x: loadX + 10, y: loadY + 11, width: 220, height: 18,
      text: `${mode === 'actual' ? 'Tracing source code' : mode === 'implementation' ? 'Explaining implementation' : 'Tracing behavior'} of ${name}…`, originalText: `${mode === 'actual' ? 'Tracing source code' : mode === 'implementation' ? 'Explaining implementation' : 'Tracing behavior'} of ${name}…`,
      fontSize: 12, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
      strokeColor: '#15803d', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
      frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      containerId: null, lineHeight: 1.25, baseline: 10,
    }];
    api.updateScene({ elements: [...currentEls, ...loadingEls] as unknown as EXEl[] });

    try {
      const res = mode === 'actual'
        ? await window.electronAPI.getActualCodeFlow(name)
        : mode === 'implementation'
          ? await window.electronAPI.getComponentImplementation(name, drillMermaid)
          : await window.electronAPI.getComponentCodeFlow(name, drillMermaid);
      console.log('[codeflow] ok:', res?.ok, 'error:', res?.error);
      if (!res?.ok || !res.mermaid) throw new Error(res?.error || 'no mermaid');
      const { buildMermaidScene: bms } = await import('./mermaidScene');
      let flowScene = await bms(res.mermaid, res.descriptions);

      // Excalidraw styles text per element rather than per line. A Code
      // Walkthrough node contains an exact source snippet, so use its native
      // Cascadia (monospace) font for the complete node label. This preserves
      // indentation and makes the snippet reliably legible when zoomed.
      if (mode === 'implementation') {
        flowScene.elements = applyImplementationCodeCards(flowScene.elements, res.descriptions);
      }
      flowScene = withGeneratedDesignBoundary(flowScene);

      const freshEls = api.getSceneElements() as unknown as ExcalidrawElement[];
      const freshRects = freshEls.filter(e =>
        e.type === 'rectangle' && !e.id.startsWith('flow-loading')
      ) as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
      const existingRight = freshRects.reduce((m, e) => Math.max(m, e.x + e.width), 0);
      const panelOffsetX = existingRight + 100 - horizontalBounds(flowScene.elements).left;
      const panelOffsetY = freshRects.reduce((m, e) => Math.min(m, e.y), Infinity);
      const panelY = isFinite(panelOffsetY) ? panelOffsetY : 0;

      const depth = flowStackRef.current.length;
      seed = 7000000 + depth * 100000;

      // Parse Mermaid source to map nodeId → label text (first line only)
      // e.g. `A["login()\ncode line"]` → { A: "login()" }
      const mermaidNodeLabels = new Map<string, string>();
      for (const line of (res.mermaid || '').split('\n')) {
        const m = line.trim().match(/^([A-Za-z0-9_]+)\s*[\[({]+"?([^\\"\\n]+)/);
        if (m) mermaidNodeLabels.set(m[1], m[2].replace(/["]/g, '').trim());
      }

      const flowEls = flowScene.elements.map((e, i) => ({
        ...e,
        id: `flow-d${depth}-${i}-${e.id}`,
        x: (e as { x: number }).x + panelOffsetX,
        y: (e as { y: number }).y + panelY,
        _baseOpacity: 100, opacity: 100,
        customData: {
          ...(e as { customData?: object }).customData,
          drillDepth: depth,
          drillName: (e as { type?: string }).type === 'rectangle'
            ? (() => {
                const t = flowScene.elements.find(t =>
                  (t as { type?: string; containerId?: string }).type === 'text' &&
                  (t as { containerId?: string }).containerId === (e as { id: string }).id
                );
                return t ? (t as { text?: string }).text?.split('\n')[0].trim() : undefined;
              })()
            : undefined,
        },
      })) as unknown as ExcalidrawElement[];

      // ── Happy path overlay ────────────────────────────────────────────────────
      // Match Mermaid node IDs from happyPath to rendered element IDs by label text
      const happyPath: string[] = res.happyPath ?? [];

      // Build: mermaidNodeId → new element id, by matching label text against rendered elements
      const origToNewId = new Map<string, string>();

      // Build a lookup of all text content per rect (by containerId or by groupId proximity)
      const rectTexts = new Map<string, string>(); // rectId → first line of label text
      for (const el of flowEls) {
        if (el.type !== 'text') continue;
        const cid = (el as { containerId?: string | null }).containerId;
        const txt = ((el as { text?: string }).text ?? '').split('\n')[0].trim().toLowerCase().replace(/[().\s]/g, '');
        if (cid) {
          // prefer containerId binding
          const existing = rectTexts.get(cid) ?? '';
          if (!existing || txt.length > existing.length) rectTexts.set(cid, txt);
        }
      }
      // Fallback: for rects with no containerId text, use first text in same group
      for (const el of flowEls) {
        if (el.type !== 'rectangle' || rectTexts.has(el.id)) continue;
        const grp = el.groupIds?.[0];
        if (!grp) continue;
        const groupText = flowEls.find(t =>
          t.type === 'text' && t.groupIds?.includes(grp)
        );
        if (groupText) {
          const txt = ((groupText as { text?: string }).text ?? '').split('\n')[0].trim().toLowerCase().replace(/[().\s]/g, '');
          rectTexts.set(el.id, txt);
        }
      }

      for (const [mermaidId, labelText] of mermaidNodeLabels.entries()) {
        // Skip Desc nodes — we only track function nodes
        if (mermaidId.endsWith('Desc')) continue;
        const needle = labelText.toLowerCase().replace(/[().\s]/g, '').slice(0, 14);
        const match = flowEls.find(el =>
          el.type === 'rectangle' && (rectTexts.get(el.id) ?? '').startsWith(needle)
        );
        if (match) origToNewId.set(mermaidId, match.id);
      }

      console.log('[codeflow] happyPath:', happyPath, 'resolved:', happyPath.map(id => [id, origToNewId.get(id) ? '✓' : '✗']));

      // Apply red stroke to happy path nodes and find arrows to recolor
      const happyNodeIds = new Set<string>();
      happyPath.forEach(origId => {
        const newId = origToNewId.get(origId);
        if (newId) happyNodeIds.add(newId);
      });

      const flowElsMutable = flowEls.map(el => {
        // Red border on happy path function nodes
        if (happyNodeIds.has(el.id) && el.type === 'rectangle') {
          return { ...el, strokeColor: '#dc2626', strokeWidth: 2.5 } as ExcalidrawElement;
        }
        // Red arrows: connecting a happy path Desc node to the next happy path function node
        if (el.type === 'arrow') {
          const sb = (el as { startBinding?: { elementId: string } | null }).startBinding;
          const eb = (el as { endBinding?: { elementId: string } | null }).endBinding;
          if (!sb || !eb) return el;
          // Check if this arrow connects consecutive happy path nodes (via Desc intermediate)
          const fromOrigDesc = happyPath.find(id => origToNewId.get(id + 'Desc') === sb.elementId || origToNewId.get(id) === sb.elementId);
          const toOrig = happyPath.find(id => origToNewId.get(id) === eb.elementId);
          if (fromOrigDesc && toOrig) {
            const fi = happyPath.indexOf(fromOrigDesc);
            const ti = happyPath.indexOf(toOrig);
            if (ti === fi + 1) {
              return { ...el, strokeColor: '#dc2626', strokeWidth: 2.5, opacity: 100 } as ExcalidrawElement;
            }
          }
        }
        return el;
      });

      // Numbered step badges on happy path nodes
      const happyOverlayEls: unknown[] = [];
      let badgeSeed = seed + 500000;

      happyPath.forEach((origId, idx) => {
        const newId = origToNewId.get(origId);
        if (!newId) return;
        const el = flowElsMutable.find(e => e.id === newId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined;
        if (!el || el.type !== 'rectangle') return;

        const badgeSize = 20;
        happyOverlayEls.push({
          type: 'rectangle', id: `flow-hp-badge-rect-${depth}-${idx}`,
          x: el.x - badgeSize / 2, y: el.y - badgeSize / 2,
          width: badgeSize, height: badgeSize,
          strokeColor: '#dc2626', backgroundColor: '#dc2626',
          fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
          angle: 0, roughness: 0.8, opacity: 100,
          roundness: { type: 3 }, groupIds: [],
          frameId: null, seed: badgeSeed++, version: 1, versionNonce: badgeSeed++,
          isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
        });
        const stepNum = String(idx + 1);
        happyOverlayEls.push({
          type: 'text', id: `flow-hp-badge-text-${depth}-${idx}`,
          x: el.x - badgeSize / 2, y: el.y - badgeSize / 2 + 2,
          width: badgeSize, height: badgeSize - 2,
          text: stepNum, originalText: stepNum,
          fontSize: 11, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle',
          strokeColor: '#ffffff', backgroundColor: 'transparent',
          fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
          angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
          frameId: null, seed: badgeSeed++, version: 1, versionNonce: badgeSeed++,
          isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
          containerId: null, lineHeight: 1.2, baseline: 9,
        });
      });

      seed = badgeSeed;

      // Dashed green connector from anchor node to the flow panel
      const flowMinX = flowEls.filter(e => e.type === 'rectangle')
        .reduce((m, e) => Math.min(m, (e as { x: number }).x), Infinity);
      const flowMidY = flowEls.filter(e => e.type === 'rectangle')
        .reduce((acc, e, _, arr) => acc + ((e as { y: number; height: number }).y + (e as { height: number }).height / 2) / arr.length, 0);

      const connEls: unknown[] = box ? [{
        type: 'arrow', id: `flow-conn-d${depth}`,
        x: box.x + box.width, y: box.y + box.height / 2,
        width: flowMinX - (box.x + box.width),
        height: flowMidY - (box.y + box.height / 2),
        points: [[0, 0], [flowMinX - (box.x + box.width), flowMidY - (box.y + box.height / 2)]],
        strokeColor: '#16a34a', backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 2, strokeStyle: 'dashed', angle: 0, roughness: 0, opacity: 70,
        startArrowhead: null, endArrowhead: 'arrow', boundElements: null,
        groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, updated: Date.now(), link: null, locked: false,
        startBinding: null, endBinding: null, roundness: { type: 2 }, elbowed: false,
      }] : [];

      const title = mode === 'actual' ? 'Actual Code Flow' : mode === 'implementation' ? 'How it builds' : 'Code Story';
      const labelText = happyPath.length > 0
        ? `⟳ ${title}: ${name}  ·  🔴 = main path (read in order)`
        : `⟳ ${title}: ${name}`;
      const labelEls: unknown[] = [{
        type: 'text', id: `flow-label-d${depth}`,
        x: panelOffsetX, y: panelY - 26, width: 520, height: 20,
        text: labelText, originalText: labelText,
        fontSize: 13, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
        strokeColor: '#16a34a', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.25, baseline: 10,
      }];

      const withoutLoading = (api.getSceneElements() as unknown as ExcalidrawElement[])
        .filter(e => !e.id.startsWith('flow-loading'));
      const finalEls = [...withoutLoading, ...connEls, ...labelEls, ...flowElsMutable, ...happyOverlayEls];

      flowStackRef.current.push(withoutLoading as ExcalidrawElement[]);

      for (const e of flowElsMutable) {
        const dn = (e as ExcalidrawElement & { customData?: { drillName?: string } }).customData?.drillName;
        if (dn && e.type === 'rectangle') idToNameRef.current[e.id] = dn;
        if (e.type === 'text') {
          const text = (e as { text?: string }).text?.split('\n')[0].trim();
          if (text) idToNameRef.current[e.id] = text;
        }
      }

      flowActiveRef.current = true;
      onCodeFlowChange?.(true);

      api.updateScene({ elements: finalEls as unknown as EXEl[] });
      setTimeout(() => {
        const newEls = (finalEls as ExcalidrawElement[]).filter((e: ExcalidrawElement) =>
          e.id.startsWith(`flow-d${depth}`) || e.id === `flow-conn-d${depth}` || e.id === `flow-label-d${depth}`
        );
        if (newEls.length > 0)
          api.scrollToContent(newEls as unknown as EXEl[], { fitToContent: false, animate: true });
      }, 150);

    } catch (err) {
      console.error('[codeflow] failed:', err);
      onRenderError?.(err instanceof Error ? err.message : String(err));
      const withoutLoading = (api.getSceneElements() as unknown as ExcalidrawElement[])
        .filter(e => !e.id.startsWith('flow-loading'));
      api.updateScene({ elements: withoutLoading as unknown as EXEl[] });
    }
  }, [onCodeFlowChange, onRenderError]);


  useEffect(() => {
    if (renderCodeFlowRef) renderCodeFlowRef.current = renderCodeFlow;
  }, [renderCodeFlow, renderCodeFlowRef]);

  // Keep bulk plotting scoped to original diagram components; explanatory
  // panels add nodes which must not become new analysis targets.
  useEffect(() => {
    if (componentNamesRef) componentNamesRef.current = () => Object.keys(flatRef.current?.nodeIds ?? {});
    return () => {
      if (componentNamesRef) componentNamesRef.current = null;
    };
  }, [componentNamesRef]);

  // ── Error annotation badges ───────────────────────────────────────────────────

  useEffect(() => {
    const api = apiRef.current;
    const flat = flatRef.current;
    if (!api || !flat) return;

    // Remove old error badges
    const existing = api.getSceneElements() as unknown as (EXEl & { id: string })[];
    const withoutErr = existing.filter(e => !e.id.startsWith('err-badge-'));

    if (!errorAnnotations || errorAnnotations.length === 0) {
      if (existing.length !== withoutErr.length) {
        api.updateScene({ elements: withoutErr });
      }
      return;
    }

    let seed = 6000000;
    const newEls: unknown[] = [];

    for (const ann of errorAnnotations) {
      const nodeElIds = flat.nodeIds[ann.node] || [];
      const boxEl = (existing as unknown as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[])
        .find(e => nodeElIds.includes(e.id) && e.type === 'rectangle') as
        (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined;
      if (!boxEl) continue;

      const badgeW = 180;
      const lines = ann.error.slice(0, 100).match(/.{1,28}/g) ?? [ann.error.slice(0, 28)];
      const badgeH = 18 + lines.length * 13 + 8;
      const bx = boxEl.x + boxEl.width + 10;
      const by = boxEl.y;

      newEls.push({
        type: 'rectangle', id: `err-badge-rect-${ann.node}`,
        x: bx, y: by, width: badgeW, height: badgeH,
        strokeColor: '#dc2626', backgroundColor: '#fef2f2',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100,
        roundness: { type: 3 }, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
        customData: { isErrorBadge: true },
      });

      const fullText = `✗ ${ann.node}\n${lines.join('\n')}`;
      newEls.push({
        type: 'text', id: `err-badge-text-${ann.node}`,
        x: bx + 7, y: by + 5, width: badgeW - 14, height: badgeH - 10,
        text: fullText, originalText: fullText,
        fontSize: 10, fontFamily: 1,
        textAlign: 'left', verticalAlign: 'top',
        strokeColor: '#b91c1c', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null,
        groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.4, baseline: 8,
        customData: { isErrorBadge: true },
      });
    }

    api.updateScene({
      elements: [...withoutErr, ...newEls] as Parameters<typeof api.updateScene>[0]['elements'],
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorAnnotations]);

  // ── Add sticky note (from MCP add_canvas_note) ───────────────────────────────

  const addNote = useCallback((data: { text: string; bg: string; stroke: string; textColor: string }) => {
    const api = apiRef.current;
    if (!api) return;

    const existing = api.getSceneElements() as unknown as (EXEl & { x: number; y: number; width: number; height: number })[];

    // Place note to the right of all existing content, or at a default position
    const maxX = existing.reduce((m, e) => Math.max(m, (e as { x?: number }).x ?? 0 + ((e as { width?: number }).width ?? 0)), 80);
    const minY = existing.reduce((m, e) => Math.min(m, (e as { y?: number }).y ?? 0), 80);
    const nx = existing.length > 0 ? maxX + 40 : 80;
    const ny = existing.length > 0 ? minY : 80;

    const lines = data.text.split('\n');
    const noteW = Math.min(240, Math.max(140, lines.reduce((m, l) => Math.max(m, l.length * 7), 0) + 24));
    const noteH = 28 + lines.length * 18;
    let seed = 5500000 + Date.now() % 100000;

    const rectId = `note-rect-${seed}`;
    const textId = `note-text-${seed}`;

    const newEls: unknown[] = [
      {
        type: 'rectangle', id: rectId,
        x: nx, y: ny, width: noteW, height: noteH,
        strokeColor: data.stroke, backgroundColor: data.bg,
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
        angle: 0, roughness: 1.2, opacity: 100,
        roundness: { type: 3 }, groupIds: [rectId],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
        customData: { isNote: true },
      },
      {
        type: 'text', id: textId,
        x: nx + 10, y: ny + 8, width: noteW - 20, height: noteH - 16,
        text: data.text, originalText: data.text,
        fontSize: 13, fontFamily: 1,
        textAlign: 'left', verticalAlign: 'top',
        strokeColor: data.textColor, backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null,
        groupIds: [rectId], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.4, baseline: 11,
        customData: { isNote: true },
      },
    ];

    api.updateScene({
      elements: [...existing, ...newEls] as Parameters<typeof api.updateScene>[0]['elements'],
    });

    // Scroll to show the new note
    setTimeout(() => {
      api.scrollToContent(newEls.slice(0, 1) as unknown as EXEl[], { fitToContent: false, animate: true });
    }, 100);
  }, []);

  useEffect(() => {
    if (addNoteRef) addNoteRef.current = addNote;
  }, [addNote, addNoteRef]);

  const getCanvasContext = useCallback((): string => {
    const flat = flatRef.current;
    if (!flat || Object.keys(flat.nodeIds).length === 0) return '';
    const elements = flat.elements;
    return serializeCanvasContext(elements, flat.nodeIds, diagramData?.descriptions);
  }, [diagramData]);

  useEffect(() => {
    if (canvasContextRef) canvasContextRef.current = getCanvasContext;
  }, [getCanvasContext, canvasContextRef]);

  useEffect(() => {
    if (rawElementsRef) {
      rawElementsRef.current = () =>
        apiRef.current ? (apiRef.current.getSceneElements() as unknown as unknown[]) : [];
    }
  }, [rawElementsRef]);

  const handleChange = useCallback((_els: readonly EXEl[], appState: { selectedElementIds?: Record<string, boolean> }) => {
    const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(id => appState.selectedElementIds![id]);
    if (selectedIds.length === 0) {
      clearSelection();
      return;
    }
    // Find every selected element that maps to a known component name.
    const names = new Set<string>();
    for (const id of selectedIds) {
      const n = idToNameRef.current[id];
      if (n) names.add(n.trim());
    }
    const selectedNames = Array.from(names);
    if (selectedNames.length === 0) { clearSelection(); return; }
    const key = selectedNames.slice().sort().join('\n');
    if (key === selectedNameRef.current) return;
    selectedNameRef.current = key;
    console.log('[canvas] selected components:', selectedNames, '— ids:', selectedIds);
    onSelectionChange?.(selectedNames);
  }, [clearSelection, onSelectionChange]);

  const handleAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setApiReady(true);
    onAPIReady?.(api);
  }, [onAPIReady]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <style>{`
        .excalidraw .App-menu__left,
        .excalidraw .App-menu__right,
        .excalidraw .layer-ui__wrapper__footer,
        .excalidraw .HintViewer,
        .excalidraw .island.App-menu_top .App-toolbar-container {
          display: none !important;
        }
      `}</style>
      <Excalidraw
        excalidrawAPI={handleAPI}
        onChange={handleChange as unknown as React.ComponentProps<typeof Excalidraw>['onChange']}
        initialData={{ appState: { viewBackgroundColor: '#fafaf7' } }}
        UIOptions={{
          tools: { image: false },
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            clearCanvas: false,
            changeViewBackgroundColor: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
