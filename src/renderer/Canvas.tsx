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
  clearDrilldownRef?: React.MutableRefObject<(() => void) | null>;
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

export default function Canvas({ diagramData, activeKind = 'structure', onAPIReady, onRenderError, onDrilldownChange, clearDrilldownRef }: CanvasProps) {
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

  // Click-to-inspect + drilldown state
  const idToNameRef        = useRef<Record<string, string>>({});
  const selectedNameRef    = useRef<string | null>(null);
  const detailBusyRef      = useRef(false);
  // Drilldown: stores base element ids so we can restore them on Back
  const drilldownActiveRef = useRef(false);
  const baseElementsRef    = useRef<ExcalidrawElement[]>([]);

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
    lastDiagramKey.current = key;
    lastDataRef.current = diagramData;

    let cancelled = false;

    (async () => {
      let flat: FlatScene;
      try {
        flat = await buildMermaidScene(mermaid);
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

      const zoom = (api.getAppState().zoom as { value: number }).value;
      if (Math.abs(zoom - lastZoomRef.current) < 0.001) return;

      lastZoomRef.current = zoom;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const api2 = apiRef.current;
        const flat2 = flatRef.current;
        if (!api2 || !flat2) return;
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

  // ── Click-to-inspect + inline drilldown ──────────────────────────────────────

  const clearDetail = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const els = api.getSceneElements() as unknown as (EXEl & { id: string; opacity?: number; _baseOpacity?: number })[];
    const cleaned = els
      .filter(e => !e.id.startsWith('detail-'))
      .map(e => {
        const base = (e as { _baseOpacity?: number })._baseOpacity ?? 100;
        return (e.opacity ?? 100) === base ? e : { ...e, opacity: base };
      });
    api.updateScene({ elements: cleaned as Parameters<typeof api.updateScene>[0]['elements'] });
    selectedNameRef.current = null;
  }, []);

  // Restore the full base diagram (exit drilldown)
  const clearDrilldown = useCallback(() => {
    const api = apiRef.current;
    if (!api || !drilldownActiveRef.current) return;
    drilldownActiveRef.current = false;
    onDrilldownChange?.(false);
    const base = baseElementsRef.current;
    api.updateScene({ elements: base as unknown as EXEl[] });
    setTimeout(() => {
      const els = api.getSceneElements().filter(e => (e.opacity ?? 100) > 0);
      if (els.length > 0) api.scrollToContent(els as EXEl[], { fitToContent: true, animate: true });
    }, 100);
  }, [onDrilldownChange]);

  // Expose clearDrilldown so App's Back button can call it
  useEffect(() => {
    if (clearDrilldownRef) clearDrilldownRef.current = clearDrilldown;
  }, [clearDrilldown, clearDrilldownRef]);

  // Expand a component's drilldown inline: dim the base, add the sub-diagram to the right
  const renderDrilldown = useCallback(async (name: string) => {
    const api  = apiRef.current;
    const flat = flatRef.current;
    if (!api || !flat || detailBusyRef.current) return;

    detailBusyRef.current = true;

    // Snapshot base elements before we modify them
    const currentEls = api.getSceneElements() as unknown as ExcalidrawElement[];
    const baseEls = currentEls.filter(e =>
      !e.id.startsWith('detail-') && !e.id.startsWith('drill-')
    );

    // Show a loading indicator next to the selected node
    const nodeElIds = new Set(flat.nodeIds[name] || []);
    const box = baseEls.find(e => nodeElIds.has(e.id) && e.type === 'rectangle') as
      (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined;

    const loadX = box ? box.x + box.width + 60 : 800;
    const loadY = box ? box.y : 200;
    let seed = 9000000;

    const loadingEls: unknown[] = [
      {
        type: 'rectangle', id: 'drill-loading',
        x: loadX, y: loadY, width: 220, height: 48,
        strokeColor: '#7c3aed', backgroundColor: '#f5f3ff',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'dashed',
        angle: 0, roughness: 0, opacity: 100, roundness: { type: 3 }, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
      },
      {
        type: 'text', id: 'drill-loading-text',
        x: loadX + 12, y: loadY + 14, width: 196, height: 20,
        text: `Loading ${name} details…`, originalText: `Loading ${name} details…`,
        fontSize: 12, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
        strokeColor: '#7c3aed', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.25, baseline: 10,
      },
    ];

    // Dim everything, show loader
    const dimmed = baseEls.map(e => {
      const base = (e as ExcalidrawElement & { _baseOpacity?: number })._baseOpacity ?? 100;
      return { ...e, opacity: nodeElIds.has(e.id) ? base : Math.max(1, Math.floor(base * 0.15)) };
    });
    api.updateScene({ elements: [...dimmed, ...loadingEls] as unknown as EXEl[] });

    try {
      const res = await window.electronAPI.getComponentDrilldown(name);
      if (!res?.ok || !res.mermaid) throw new Error('no mermaid');

      // Parse the drilldown Mermaid into Excalidraw elements
      const { buildMermaidScene: bms } = await import('./mermaidScene');
      const drillScene = await bms(res.mermaid);

      // Compute bounding box of base elements to place drilldown to the right
      const visibleBase = baseEls.filter(e => e.type === 'rectangle' || e.type === 'text');
      const maxX = visibleBase.reduce((m, e) => Math.max(m, (e as { x: number; width: number }).x + (e as { width: number }).width), 0);
      const minY = visibleBase.reduce((m, e) => Math.min(m, (e as { y: number }).y), Infinity);
      const offsetX = maxX + 120;
      const offsetY = isFinite(minY) ? minY : 0;

      // Shift drilldown elements so they sit to the right of the main diagram
      const drillEls = drillScene.elements.map((e, i) => ({
        ...e,
        id: `drill-${i}-${e.id}`,
        x: (e as { x: number }).x + offsetX,
        y: (e as { y: number }).y + offsetY,
        _baseOpacity: 100,
        opacity: 100,
      })) as unknown as ExcalidrawElement[];

      // Draw a connector from the selected box to the drilldown area
      const drillMinX = drillEls.reduce((m, e) => Math.min(m, (e as { x: number }).x), Infinity);
      const drillMidY = offsetY + (drillScene.elements.reduce((m, e) =>
        m + (e as { y: number }).y + (e as { height: number }).height / 2, 0) / Math.max(1, drillScene.elements.length));

      seed = 9100000;
      const connectorEls: unknown[] = box ? [{
        type: 'arrow', id: 'drill-connector',
        x: box.x + box.width, y: box.y + box.height / 2,
        width: drillMinX - (box.x + box.width),
        height: drillMidY - (box.y + box.height / 2),
        points: [[0, 0], [drillMinX - (box.x + box.width), drillMidY - (box.y + box.height / 2)]],
        strokeColor: '#7c3aed', backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 2, strokeStyle: 'dashed', angle: 0, roughness: 0, opacity: 80,
        startArrowhead: null, endArrowhead: 'arrow', boundElements: null,
        groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, updated: Date.now(), link: null, locked: false,
        startBinding: null, endBinding: null, roundness: { type: 2 }, elbowed: false,
      }] : [];

      // Label above the drilldown area
      const labelEls: unknown[] = [{
        type: 'text', id: 'drill-label',
        x: offsetX, y: offsetY - 28, width: 300, height: 20,
        text: `◆ ${name} — internals`, originalText: `◆ ${name} — internals`,
        fontSize: 13, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
        strokeColor: '#5b21b6', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.25, baseline: 10,
      }];

      // Save base snapshot and mark drilldown active
      baseElementsRef.current = dimmed as ExcalidrawElement[];
      drilldownActiveRef.current = true;
      onDrilldownChange?.(true);

      const allEls = [...dimmed, ...connectorEls, ...labelEls, ...drillEls];
      api.updateScene({ elements: allEls as unknown as EXEl[] });

      // Scroll to show both the selected node and the drilldown
      setTimeout(() => {
        const visible = api.getSceneElements().filter(e => (e.opacity ?? 100) > 5);
        if (visible.length > 0) api.scrollToContent(visible as EXEl[], { fitToContent: true, animate: true });
      }, 150);

    } catch {
      // Restore base on failure
      const cleaned = baseEls.map(e => {
        const base = (e as ExcalidrawElement & { _baseOpacity?: number })._baseOpacity ?? 100;
        return { ...e, opacity: base };
      });
      api.updateScene({ elements: cleaned as unknown as EXEl[] });
    } finally {
      detailBusyRef.current = false;
      // Remove any lingering detail/loading cards
      clearDetail();
    }
  }, [clearDetail, onDrilldownChange]);

  const renderDetailCard = useCallback((name: string, detail: { title?: string; summary?: string; does?: string[]; talksTo?: string[] }, showDrillButton = true) => {
    const api  = apiRef.current;
    const flat = flatRef.current;
    if (!api || !flat) return;

    const existing = api.getSceneElements() as unknown as (EXEl & { id: string; type: string; x: number; y: number; width: number; height: number })[];
    const withoutOld = existing.filter(e => !e.id.startsWith('detail-'));

    const nodeElIds = new Set(flat.nodeIds[name] || []);
    const box = existing.find(e => nodeElIds.has(e.id) && e.type === 'rectangle');
    if (!box) return;

    const dimmed = withoutOld.map(e => {
      const keep = nodeElIds.has(e.id);
      const base = (e as { _baseOpacity?: number })._baseOpacity ?? 100;
      return { ...e, opacity: keep ? base : Math.max(1, Math.floor(base * 0.12)) };
    });

    const lines: string[] = [];
    if (detail.summary) lines.push(detail.summary);
    if (detail.does?.length) { lines.push(''); for (const d of detail.does) lines.push(`• ${d}`); }
    if (detail.talksTo?.length) { lines.push(''); lines.push(`Works with: ${detail.talksTo.join(', ')}`); }
    // Hint for drill button
    if (showDrillButton) lines.push('\n[ Drill in → ]');
    const body = lines.join('\n');

    const cardW = 300;
    const cardH = Math.max(120, 46 + body.split('\n').length * 18 + 16);
    const cardX = box.x + box.width + 28;
    const cardY = box.y;

    let seed = 5000000;
    const card: unknown[] = [];

    card.push({
      type: 'arrow', id: 'detail-arrow',
      x: box.x + box.width, y: box.y + box.height / 2,
      width: cardX - (box.x + box.width), height: (cardY + 24) - (box.y + box.height / 2),
      points: [[0, 0], [cardX - (box.x + box.width), (cardY + 24) - (box.y + box.height / 2)]],
      strokeColor: '#7c3aed', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 1.5, strokeStyle: 'solid', angle: 0, roughness: 0, opacity: 90,
      startArrowhead: null, endArrowhead: 'arrow', boundElements: null,
      groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, updated: Date.now(), link: null, locked: false,
      startBinding: null, endBinding: null, roundness: { type: 2 }, elbowed: false,
    });

    card.push({
      type: 'rectangle', id: 'detail-card',
      x: cardX, y: cardY, width: cardW, height: cardH,
      strokeColor: '#7c3aed', backgroundColor: '#faf5ff',
      fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: { type: 3 }, groupIds: [],
      frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
      customData: { isDetail: true },
    });

    const title = detail.title || name;
    card.push({
      type: 'text', id: 'detail-title',
      x: cardX + 12, y: cardY + 10, width: cardW - 24, height: 22,
      text: title, originalText: title, fontSize: 15, fontFamily: 2,
      textAlign: 'left', verticalAlign: 'top',
      strokeColor: '#5b21b6', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: null,
      groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      containerId: null, lineHeight: 1.25, baseline: 12, customData: { isDetail: true },
    });

    card.push({
      type: 'text', id: 'detail-body',
      x: cardX + 12, y: cardY + 38, width: cardW - 24, height: cardH - 48,
      text: body, originalText: body, fontSize: 12, fontFamily: 2,
      textAlign: 'left', verticalAlign: 'top',
      strokeColor: '#4c1d95', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
      angle: 0, roughness: 0, opacity: 100, roundness: null,
      groupIds: [], frameId: null, seed: seed++, version: 1, versionNonce: seed++,
      isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
      containerId: null, lineHeight: 1.4, baseline: 10, customData: { isDetail: true },
    });

    // "Drill in →" button box — clickable rectangle at the bottom of the card
    if (showDrillButton) {
      const btnY = cardY + cardH - 34;
      card.push({
        type: 'rectangle', id: 'detail-drill-btn',
        x: cardX + 12, y: btnY, width: cardW - 24, height: 26,
        strokeColor: '#7c3aed', backgroundColor: '#ede9fe',
        fillStyle: 'solid', strokeWidth: 1.5, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: { type: 3 }, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false,
        customData: { isDrillBtn: true, drillTarget: name },
      });
      card.push({
        type: 'text', id: 'detail-drill-btn-label',
        x: cardX + 12, y: btnY + 5, width: cardW - 24, height: 16,
        text: 'Drill in →', originalText: 'Drill in →',
        fontSize: 12, fontFamily: 2, textAlign: 'center', verticalAlign: 'top',
        strokeColor: '#5b21b6', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        angle: 0, roughness: 0, opacity: 100, roundness: null, groupIds: [],
        frameId: null, seed: seed++, version: 1, versionNonce: seed++,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
        containerId: null, lineHeight: 1.25, baseline: 10,
        customData: { isDrillBtn: true, drillTarget: name },
      });
    }

    api.updateScene({ elements: [...dimmed, ...card] as Parameters<typeof api.updateScene>[0]['elements'] });
  }, []);

  const handleSelect = useCallback(async (name: string) => {
    if (detailBusyRef.current) return;
    selectedNameRef.current = name;
    detailBusyRef.current = true;

    renderDetailCard(name, { title: name, summary: 'Looking into this part…', does: [], talksTo: [] }, false);

    try {
      const res = await window.electronAPI.getComponentDetail(name);
      if (selectedNameRef.current !== name) return;
      if (res?.ok && res.detail) {
        renderDetailCard(name, res.detail as { title?: string; summary?: string; does?: string[]; talksTo?: string[] }, true);
      } else {
        renderDetailCard(name, { title: name, summary: 'Could not load details right now.', does: [], talksTo: [] }, false);
      }
    } finally {
      detailBusyRef.current = false;
    }
  }, [renderDetailCard]);

  const handleChange = useCallback((_els: readonly EXEl[], appState: { selectedElementIds?: Record<string, boolean> }) => {
    const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(id => appState.selectedElementIds![id]);
    if (selectedIds.length === 0) {
      if (selectedNameRef.current) clearDetail();
      return;
    }

    // Check if the user clicked the "Drill in →" button
    const allEls = apiRef.current?.getSceneElements() as unknown as (ExcalidrawElement & { customData?: Record<string, unknown> })[] | undefined;
    const drillTarget = selectedIds
      .map(id => allEls?.find(e => e.id === id)?.customData?.drillTarget as string | undefined)
      .find(Boolean);

    if (drillTarget) {
      clearDetail();
      renderDrilldown(drillTarget);
      return;
    }

    const name = selectedIds.map(id => idToNameRef.current[id]).find(Boolean);
    if (!name) return;
    if (name === selectedNameRef.current) return;
    handleSelect(name);
  }, [clearDetail, handleSelect, renderDrilldown]);

  const handleAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
    setApiReady(true);
    onAPIReady?.(api);
  }, [onAPIReady]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <style>{`
        .excalidraw .App-toolbar,
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
        initialData={{ appState: { viewBackgroundColor: '#f8fafc' } }}
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
