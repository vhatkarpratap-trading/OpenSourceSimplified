/**
 * Convert Claude-authored Mermaid text into an Excalidraw `FlatScene`.
 *
 * Pipeline:  Mermaid string
 *   → parseMermaidToExcalidraw()   (mermaid-to-excalidraw)  → element skeletons
 *   → convertToExcalidrawElements() (@excalidraw/excalidraw) → full elements
 *   → mapped into the FlatScene shape consumed by Canvas.tsx
 *
 * We keep the existing FlatScene contract so the zoom / git-highlight /
 * annotation code in Canvas.tsx keeps working unchanged. Because Mermaid lays
 * everything out at a single zoom level, all elements go into `normalIds`
 * (threshold 0 = always visible); overview/detail tiers stay empty.
 */

import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { FlatScene, ExcalidrawElement } from './diagramBuilder';

/** Strip ```mermaid fences and stray whitespace an LLM may wrap around the code. */
export function cleanMermaid(src: string, keepSubgraphs = false): string {
  let s = src
    .replace(/^\s*```(?:mermaid)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\\n/g, '\n')
    .trim();
  s = s.replace(/^graph\b/im, 'flowchart');
  if (keepSubgraphs) return s;
  // Convert subgraphs to header nodes before stripping, so class names are preserved
  s = convertSubgraphsToHeaderNodes(s);
  s = stripSubgraphs(s);
  return s;
}

/**
 * Remove subgraph/end wrappers, promoting contained nodes to the top level.
 * @excalidraw/mermaid-to-excalidraw (all versions) throws "SubGraph element
 * not found" on any subgraph keyword, so we strip the wrappers entirely and
 * keep only the node definitions and edges inside each subgraph.
 */
function stripSubgraphs(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (/^subgraph\b/i.test(t)) continue;   // drop subgraph header
    if (/^end\b/i.test(t)) continue;        // drop end
    out.push(line);
  }

  return out.join('\n');
}

/**
 * Fix the Mermaid-syntax mistakes LLMs make most often:
 *  1. Dots/special chars in node IDs (e.g. `index.ts[Label]` → `indexts[Label]`)
 *  2. Bad chars inside bracket node labels: ( ) / : ; " ' | < > `
 *  3. Bad chars inside pipe edge labels: -->|some:label|
 *  4. HTML <br> tags in labels
 */
function sanitizeMermaid(src: string): string {
  // Step 1: fix node IDs — alphanumeric + underscore only before the bracket
  let out = src.replace(/([A-Za-z0-9_][A-Za-z0-9_.\-]*)(\s*[\[\(\{])/g, (_m, id, bracket) => {
    const safeId = id.replace(/[^A-Za-z0-9_]/g, '_');
    return safeId + bracket;
  });

  // Step 2: clean content inside bracket node labels [ ] ( ) { }
  // SKIP double-quoted labels like ["text"] — Mermaid supports these natively
  // and they may contain intentional newlines and special chars.
  out = out.replace(/([\[\(\{])([^\]\)\}]*)([\]\)\}])/g, (_m, open, inner, close) => {
    // If the inner content starts with a double-quote, leave it untouched
    if (String(inner).trimStart().startsWith('"')) return `${open}${inner}${close}`;
    const safe = String(inner)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/["'`]/g, '')
      .replace(/[\/():;<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `${open}${safe}${close}`;
  });

  // Step 3: clean edge labels inside pipes -->|label| or ---|label|
  out = out.replace(/\|([^|]*)\|/g, (_m, label) => {
    const safe = String(label)
      .replace(/["'`]/g, '')
      .replace(/[\/():;<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `|${safe}|`;
  });

  return out;
}

/**
 * Convert subgraph blocks into a class-header node pattern the library can render.
 * Each `subgraph ClassName ... end` becomes:
 *   - A header node:  ClsHdr_N{{"ClassName"}}
 *   - A dotted edge from that header to every first-level node inside the subgraph
 * This guarantees class names always render even when the library rejects subgraphs.
 */
function convertSubgraphsToHeaderNodes(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let insideSubgraph = false;
  let hdrId = '';
  let firstChildren: string[] = [];
  let hdrEdgesDeferred: string[] = [];
  let headerCounter = 0;

  for (const line of lines) {
    const t = line.trim();

    if (/^subgraph\b/i.test(t)) {
      insideSubgraph = true;
      firstChildren = [];
      const labelMatch = t.match(/^subgraph\s+(.+)$/i);
      const label = labelMatch ? labelMatch[1].replace(/["']/g, '').trim() : `Class${headerCounter}`;
      hdrId = `_ClsHdr${headerCounter++}`;
      // Hexagon shape for class header — visually distinct
      out.push(`  ${hdrId}{{"${label}"}}`);
      hdrEdgesDeferred = [];
      continue;
    }

    if (/^end\b/i.test(t) && insideSubgraph) {
      insideSubgraph = false;
      // Emit dotted edges from header to first-level children
      for (const child of firstChildren) {
        out.push(`  ${hdrId} -.-> ${child}`);
      }
      firstChildren = [];
      continue;
    }

    if (insideSubgraph) {
      // Collect node ids that appear at the start of a line (first node in an edge or standalone)
      const nodeMatch = t.match(/^([A-Za-z0-9_]+)\s*[\[(\{>]/);
      if (nodeMatch && !firstChildren.includes(nodeMatch[1])) {
        firstChildren.push(nodeMatch[1]);
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Normalise a Mermaid label / node id into a component name usable as a
 * highlight key. Mermaid labels can contain quotes, chevrons, or type tags.
 */
function labelToName(raw: string): string {
  return raw
    .replace(/["'`]/g, '')
    .replace(/<<.*?>>/g, '')      // classDiagram stereotypes «interface»
    .replace(/\([^)]*\)/g, '')    // drop method arg parens for matching
    .split('\n')[0]
    .trim();
}

/** Wrap explanatory text so it remains readable inside an Excalidraw node. */
function wrapDescription(text: string, width: number): string {
  const maxChars = Math.max(24, Math.floor(width / 6));
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * Build a name → element-ids map so Canvas.applyZoomAndGit can highlight the
 * boxes/labels belonging to a changed component. We index every rectangle by
 * its own text and by the text of any bound label element.
 */
function buildNodeIds(elements: ExcalidrawElement[], layerIds: Set<string>): Record<string, string[]> {
  const nodeIds: Record<string, string[]> = {};
  const add = (name: string, id: string) => {
    const key = labelToName(name);
    if (!key) return;
    (nodeIds[key] ||= []).push(id);
  };

  // text elements carry the visible label; associate them with their container
  const containerText = new Map<string, string>(); // containerId → text
  for (const el of elements) {
    if (el.type === 'text' && (el as { containerId?: string | null }).containerId) {
      containerText.set((el as { containerId: string }).containerId, (el as { text: string }).text);
    }
  }

  for (const el of elements) {
    if (layerIds.has(el.id)) continue;                       // layers are not components
    if (el.type === 'text') {
      const boundTo = (el as { containerId?: string | null }).containerId;
      if (boundTo && layerIds.has(boundTo)) continue;        // skip layer titles
      add(((el as { text: string }).text || '').trim(), el.id);
    } else if (el.type === 'rectangle') {
      const label = containerText.get(el.id);
      if (label) add(label.trim(), el.id);
    }
  }
  return nodeIds;
}

/** Parse Mermaid → skeletons, returning null if it fell back to a raster image. */
async function tryParse(def: string): Promise<{ type?: string }[] | null> {
  console.log('[mermaidScene] tryParse input:\n' + def.slice(0, 800));
  try {
    const { elements } = await parseMermaidToExcalidraw(def);
    if (elements.some(s => (s as { type?: string }).type === 'image')) {
      console.warn('[mermaidScene] parsed but got a raster image, not shapes');
      return null;
    }
    return elements as { type?: string }[];
  } catch (e) {
    console.warn('[mermaidScene] parse error:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function buildMermaidScene(mermaid: string, descriptions?: Record<string, string>): Promise<FlatScene> {
  const cleaned = cleanMermaid(mermaid);
  // cleanMermaid strips subgraphs — for diagrams that intentionally use them (code flow),
  // try the original cleaned version without stripping first, then fall back.
  const cleanedNoStrip = cleanMermaid(mermaid, /* keepSubgraphs */ true);

  let skeletons =
    await tryParse(cleanedNoStrip) ??
    await tryParse(cleaned) ??
    await tryParse(sanitizeMermaid(cleanedNoStrip)) ??
    await tryParse(sanitizeMermaid(cleaned));

  if (!skeletons) {
    console.error('[mermaidScene] FAILED to render. Raw input was:\n' + mermaid +
                  '\n--- cleaned ---\n' + cleaned +
                  '\n--- sanitized ---\n' + sanitizeMermaid(cleaned));
    throw new Error('Could not draw this diagram — the chart text was invalid');
  }

  const converted = convertToExcalidrawElements(skeletons as never) as unknown as ExcalidrawElement[];

  const NODE_BG = '#fffbe6', NODE_STROKE = '#1e1e2e', NODE_TEXT = '#1e1e2e';
  const EDGE = '#1e1e2e', EDGE_LABEL = '#555577';
  const LAYER_BG = '#f5f5f5', LAYER_STROKE = '#aaaabc', LAYER_TEXT = '#888899';
  const CHANGED_FILLS = new Set(['#fef3c7', '#fffbeb', '#fef9c3']);
  const DESC_TEXT = '#666677';
  // Sketch feel: slight roughness + hand-drawn font (Virgil = fontFamily 1)
  const ROUGHNESS = 1.2;
  const FONT = 1;

  const isLayer = (el: ExcalidrawElement): boolean =>
    el.type === 'rectangle' && Array.isArray(el.groupIds) &&
    el.groupIds.includes(`subgraph_group_${el.id}`);

  const layerIds = new Set(converted.filter(isLayer).map(el => el.id));

  // Build containerId → label text map so we can look up descriptions
  const containerLabel = new Map<string, string>();
  for (const el of converted) {
    if (el.type === 'text') {
      const cid = (el as { containerId?: string | null }).containerId;
      if (cid && !layerIds.has(cid)) {
        containerLabel.set(cid, ((el as { text: string }).text || '').trim());
      }
    }
  }

  // Normalise description keys to lowercase for fuzzy matching
  const descNorm: Record<string, string> = {};
  if (descriptions) {
    for (const [k, v] of Object.entries(descriptions)) {
      descNorm[k.toLowerCase().trim()] = v;
    }
  }

  const extraElements: ExcalidrawElement[] = [];
  let descSeed = 8000000;

  // Per-node group ID: rect + its bound label text + description overlay all share
  // this so they move together when dragged. Key = rectangle element ID.
  const nodeGroupId = new Map<string, string>();
  for (const el of converted) {
    if (el.type === 'rectangle' && !layerIds.has(el.id)) {
      nodeGroupId.set(el.id, `node-group-${el.id}`);
    }
  }

  const elements = converted.map(el => {
    if (el.type === 'rectangle') {
      if (layerIds.has(el.id)) {
        return {
          ...el,
          backgroundColor: LAYER_BG, strokeColor: LAYER_STROKE, strokeWidth: 1.5,
          fillStyle: 'solid', roughness: ROUGHNESS, strokeStyle: 'dashed',
          customData: { ...el.customData, isLayer: true },
        } as ExcalidrawElement;
      }
      const isChanged = CHANGED_FILLS.has((el.backgroundColor || '').toLowerCase());

      // Expand height if we have a description for this node
      const label = containerLabel.get(el.id);
      const desc = label ? (descNorm[label.toLowerCase()] ?? null) : null;
      const box = el as ExcalidrawElement & { x: number; y: number; width: number; height: number };
      const wrappedDesc = desc ? wrapDescription(desc, box.width - 16) : '';
      const extraH = wrappedDesc ? Math.max(30, wrappedDesc.split('\n').length * 13 + 12) : 0;
      const grp = nodeGroupId.get(el.id)!;
      // Merge the node's own group ID with the library-assigned groups (e.g. subgraph group)
      const mergedGroupIds = [...new Set([grp, ...el.groupIds])];

      if (desc && extraH > 0) {
        extraElements.push({
          type: 'text',
          id: `desc-${el.id}`,
          x: box.x + 8,
          y: box.y + box.height + 6,
          width: box.width - 16,
          height: extraH - 8,
          text: wrappedDesc,
          originalText: wrappedDesc,
          fontSize: 11,
          fontFamily: FONT,
          textAlign: 'center',
          verticalAlign: 'top',
          strokeColor: DESC_TEXT,
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 1,
          strokeStyle: 'solid',
          angle: 0,
          roughness: 0,
          opacity: 85,
          roundness: null,
          groupIds: mergedGroupIds,
          frameId: null,
          seed: descSeed++,
          version: 1,
          versionNonce: descSeed++,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link: null,
          locked: false,
          containerId: null,
          lineHeight: 1.3,
          baseline: 9,
          customData: { isDescription: true },
        } as unknown as ExcalidrawElement);
      }

      return {
        ...el,
        height: (el as { height: number }).height + extraH,
        groupIds: mergedGroupIds,
        backgroundColor: isChanged ? '#fef3c7' : NODE_BG,
        strokeColor:     isChanged ? '#d97706' : NODE_STROKE,
        strokeWidth:     isChanged ? 2.5 : 2,
        fillStyle: 'solid',
        roughness: ROUGHNESS,
        customData: { ...el.customData, nodeType: 'component', changed: isChanged },
      } as ExcalidrawElement;
    }
    if (el.type === 'text') {
      const boundTo = (el as { containerId?: string | null }).containerId;
      if (boundTo && layerIds.has(boundTo)) {
        return { ...el, strokeColor: LAYER_TEXT, fontFamily: FONT, opacity: 100 } as ExcalidrawElement;
      }
      const isEdgeLabel = !boundTo;
      const nodeGrp = boundTo ? nodeGroupId.get(boundTo) : undefined;
      // Check if this text belongs to a class header diamond
      const parentEl = boundTo ? converted.find(e => e.id === boundTo) : null;
      const isClassHeaderText = parentEl && (parentEl as { type: string }).type === 'diamond';
      const mergedGroupIds = nodeGrp
        ? [...new Set([nodeGrp, ...el.groupIds])]
        : el.groupIds;
      return {
        ...el,
        groupIds: mergedGroupIds,
        fontFamily: FONT,
        fontSize: isClassHeaderText ? 13 : (el as { fontSize?: number }).fontSize,
        strokeColor: isClassHeaderText ? '#ffffff' : isEdgeLabel ? EDGE_LABEL : NODE_TEXT,
        opacity: 100,
      } as ExcalidrawElement;
    }
    if (el.type === 'arrow') {
      // Dotted arrows are class-header connectors — style them subtly
      const isDotted = (el as { strokeStyle?: string }).strokeStyle === 'dashed';
      return { ...el, strokeColor: isDotted ? '#94a3b8' : EDGE, strokeWidth: isDotted ? 1 : 2, opacity: isDotted ? 50 : 90, roughness: ROUGHNESS } as ExcalidrawElement;
    }
    // Diamond/hexagon = class header node (from {{ClassName}} syntax) — passthrough with dark styling
    if ((el as unknown as { type: string }).type === 'diamond') {
      return {
        ...(el as unknown as Record<string, unknown>),
        backgroundColor: '#1e293b', strokeColor: '#1e293b', strokeWidth: 2,
        fillStyle: 'solid', roughness: ROUGHNESS,
        customData: { ...(el as unknown as { customData?: object }).customData, isClassHeader: true },
      } as unknown as ExcalidrawElement;
    }
    return el;
  });

  const allElements = [...elements, ...extraElements];
  const normalIds = allElements.map(el => el.id);

  return {
    elements: allElements,
    detailIds: [],
    overviewIds: [],
    normalIds,
    nodeIds: buildNodeIds(elements, layerIds),  // index base elements only (not desc overlays)
  };
}
