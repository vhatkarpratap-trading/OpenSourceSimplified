import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';
import type { ExcalidrawElement as EXEl } from '@excalidraw/excalidraw/types/element/types';
import { DiagramData, DiagramKind, FlatScene, ExcalidrawElement, TYPE_COLORS } from './diagramBuilder';
import { buildMermaidScene } from './mermaidScene';

interface CanvasProps {
  diagramData?: DiagramData | null;
  activeKind?: DiagramKind;
  onAPIReady?: (api: ExcalidrawImperativeAPI) => void;
  onRenderError?: (message: string | null) => void;
  onDrilldownChange?: (active: boolean) => void;
  onCodeFlowChange?: (active: boolean) => void;
  onSelectionChange?: (name: string | null) => void;
  clearDrilldownRef?: React.MutableRefObject<(() => void) | null>;
  clearCodeFlowRef?: React.MutableRefObject<(() => void) | null>;
  renderDrilldownRef?: React.MutableRefObject<((name: string) => void) | null>;
  renderCodeFlowRef?: React.MutableRefObject<((name: string) => void) | null>;
}

interface GitAnnotation { name: string; summary: string; added: number; removed: number }

/**
 * Visibility + highlighting rules:
 *   zoom hidden              → opacity 0
 *   no git info              → full opacity, all grey (default state)
 *   git changed (rect)       → restore type color (vivid), full opacity
 *   git changed (text/arrow) → full opacity
 *   git unchanged            → 10% opacity (almost invisible, changed ones pop)
 *   Claude changed           → amber stroke + yellow bg
 *   Claude impacted          → orange stroke + peach bg
 */

interface ClaudeHighlights { changedNames: string[]; impactedNames: string[] }

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
      // Everything else greys out so the change clearly pops
      const dimmed = Math.max(1, Math.floor(baseOp * 0.12));
      return el.opacity === dimmed ? el : { ...el, opacity: dimmed };
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
      // Unchanged — dim hard so changed components clearly pop
      const dimmed = Math.max(1, Math.floor(baseOp * 0.10));
      return el.opacity === dimmed ? el : { ...el, opacity: dimmed };
    }

    // No changes — full grey base, normal opacity
    return el.opacity === baseOp ? el : { ...el, opacity: baseOp };
  });
}

export default function Canvas({ diagramData, activeKind = 'structure', onAPIReady, onRenderError, onDrilldownChange, onCodeFlowChange, onSelectionChange, clearDrilldownRef, clearCodeFlowRef, renderDrilldownRef, renderCodeFlowRef }: CanvasProps) {
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
  const selectedNameRef    = useRef<string | null>(null);
  const drillBusyRef       = useRef(false);
  const drilldownActiveRef = useRef(false);
  const drillStackRef      = useRef<ExcalidrawElement[][]>([]);
  // Code flow has its own independent stack — both panels live on canvas simultaneously
  const flowActiveRef      = useRef(false);
  const flowStackRef       = useRef<ExcalidrawElement[][]>([]);

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
        flat = await buildMermaidScene(mermaid, diagramData.descriptions);
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
      idToNameRef.current = rev;
      selectedNameRef.current = null;

      const zoom = (api.getAppState().zoom as { value: number }).value;
      lastZoomRef.current = zoom;

      const elements = applyZoomAndGit(flat, zoom, gitRef.current, claudeRef.current);
      api.updateScene({ elements: elements as unknown as EXEl[] });

      // Fit to visible elements
      const tryFit = (n: number) => {
        const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 0);
        if (els.length > 0) {
          api.scrollToContent(els as EXEl[], { fitToContent: true, animate: false });
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
      if (drilldownActiveRef.current || flowActiveRef.current) return; // overlays own the scene

      const zoom = (api.getAppState().zoom as { value: number }).value;
      if (Math.abs(zoom - lastZoomRef.current) < 0.001) return;

      lastZoomRef.current = zoom;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const api2 = apiRef.current;
        const flat2 = flatRef.current;
        if (!api2 || !flat2 || drilldownActiveRef.current || flowActiveRef.current) return;
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
      if (drilldownActiveRef.current || flowActiveRef.current) return; // don't overwrite drill/flow scene
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
      if (drilldownActiveRef.current || flowActiveRef.current) return; // don't overwrite drill/flow scene
      const api  = apiRef.current;
      const flat = flatRef.current;
      if (!api || !flat) return;
      const zoom = (api.getAppState().zoom as { value: number }).value;
      const updated = applyZoomAndGit(flat, zoom, null, changes);
      flatRef.current = { ...flat, elements: updated };
      api.updateScene({ elements: updated as unknown as EXEl[] });
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

  // ── Selection tracking ────────────────────────────────────────────────────────

  const clearSelection = useCallback(() => {
    selectedNameRef.current = null;
    onSelectionChange?.(null);
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
      const drillScene = await bms(res.mermaid);

      // Place new drill panel to the right of everything currently on canvas
      const freshEls = api.getSceneElements() as unknown as ExcalidrawElement[];
      const freshRects = freshEls.filter(e =>
        e.type === 'rectangle' && !e.id.startsWith('drill-loading')
      ) as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
      const panelOffsetX = freshRects.reduce((m, e) => Math.max(m, e.x + e.width), 0) + 100;
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

  const renderCodeFlow = useCallback(async (rawName: string) => {
    const name = rawName.trim();
    const api = apiRef.current;
    if (!api) return;

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
      text: `Tracing flow of ${name}…`, originalText: `Tracing flow of ${name}…`,
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
      const res = await window.electronAPI.getComponentCodeFlow(name);
      console.log('[codeflow] ok:', res?.ok, 'error:', res?.error);
      if (!res?.ok || !res.mermaid) throw new Error(res?.error || 'no mermaid');

      const { buildMermaidScene: bms } = await import('./mermaidScene');
      const flowScene = await bms(res.mermaid);

      const freshEls = api.getSceneElements() as unknown as ExcalidrawElement[];
      const freshRects = freshEls.filter(e =>
        e.type === 'rectangle' && !e.id.startsWith('flow-loading')
      ) as (ExcalidrawElement & { x: number; y: number; width: number; height: number })[];
      const panelOffsetX = freshRects.reduce((m, e) => Math.max(m, e.x + e.width), 0) + 100;
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

      const labelText = happyPath.length > 0
        ? `⟳ Code Flow: ${name}  ·  🔴 = happy path (read in order)`
        : `⟳ Code Flow: ${name}`;
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
      const withoutLoading = (api.getSceneElements() as unknown as ExcalidrawElement[])
        .filter(e => !e.id.startsWith('flow-loading'));
      api.updateScene({ elements: withoutLoading as unknown as EXEl[] });
    }
  }, [onCodeFlowChange]);


  useEffect(() => {
    if (renderCodeFlowRef) renderCodeFlowRef.current = renderCodeFlow;
  }, [renderCodeFlow, renderCodeFlowRef]);

  const handleChange = useCallback((_els: readonly EXEl[], appState: { selectedElementIds?: Record<string, boolean> }) => {
    const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(id => appState.selectedElementIds![id]);
    if (selectedIds.length === 0) {
      clearSelection();
      return;
    }
    // Find the first selected element that maps to a known component name
    let name: string | undefined;
    for (const id of selectedIds) {
      const n = idToNameRef.current[id];
      if (n) { name = n; break; }
    }
    if (!name) { clearSelection(); return; }
    if (name === selectedNameRef.current) return;
    selectedNameRef.current = name;
    console.log('[canvas] selected component:', name, '— ids:', selectedIds);
    onSelectionChange?.(name.trim());
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
