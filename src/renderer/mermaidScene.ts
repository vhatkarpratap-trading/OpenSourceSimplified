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
export function cleanMermaid(src: string): string {
  let s = src
    .replace(/^\s*```(?:mermaid)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\\n/g, '\n')   // un-escape literal \n that slipped through JSON
    .trim();
  // Normalise legacy `graph` keyword to `flowchart` (mermaid-to-excalidraw requires the latter).
  // classDiagram and sequenceDiagram are supported natively — leave them untouched.
  s = s.replace(/^graph\b/im, 'flowchart');
  // mermaid-to-excalidraw does not support subgraphs — strip them, keeping their nodes.
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
  // Matches: WordPart.ext[Label] or Word-Part[Label] etc.
  let out = src.replace(/([A-Za-z0-9_][A-Za-z0-9_.\-]*)(\s*[\[\(\{])/g, (_m, id, bracket) => {
    const safeId = id.replace(/[^A-Za-z0-9_]/g, '_');
    return safeId + bracket;
  });

  // Step 2: clean content inside bracket node labels [ ] ( ) { }
  out = out.replace(/([\[\(\{])([^\]\)\}]*)([\]\)\}])/g, (_m, open, inner, close) => {
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
      add((el as { text: string }).text, el.id);
    } else if (el.type === 'rectangle') {
      const label = containerText.get(el.id);
      if (label) add(label, el.id);
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

export async function buildMermaidScene(mermaid: string): Promise<FlatScene> {
  const cleaned = cleanMermaid(mermaid);

  // Attempt 1: as-is. Attempt 2: sanitised labels (fixes the common LLM mistakes
  // that make Mermaid silently rasterise to an unusable image).
  let skeletons = await tryParse(cleaned);
  if (!skeletons) skeletons = await tryParse(sanitizeMermaid(cleaned));
  if (!skeletons) {
    console.error('[mermaidScene] FAILED to render. Raw input was:\n' + mermaid +
                  '\n--- cleaned ---\n' + cleaned +
                  '\n--- sanitized ---\n' + sanitizeMermaid(cleaned));
    throw new Error('Could not draw this diagram — the chart text was invalid');
  }

  // convertToExcalidrawElements fills in all required Excalidraw fields, but the
  // default styling is very light/low-contrast. Apply a readable baseline palette
  // and preserve Mermaid `:::changed` styling (amber) as a highlighted node.
  const converted = convertToExcalidrawElements(skeletons as never) as unknown as ExcalidrawElement[];

  const NODE_BG = '#eff6ff', NODE_STROKE = '#3b5b8c', NODE_TEXT = '#1e293b';
  const EDGE = '#7c8aa0', EDGE_LABEL = '#475569';
  const LAYER_BG = '#f8fafc', LAYER_STROKE = '#cbd5e1', LAYER_TEXT = '#64748b';
  const CHANGED_FILLS = new Set(['#fef3c7', '#fffbeb', '#fef9c3']); // Mermaid classDef changed fills

  // A subgraph (layer) container is a rectangle whose own id has a matching
  // `subgraph_group_<id>` in its groupIds — style these as calm layer bands.
  const isLayer = (el: ExcalidrawElement): boolean =>
    el.type === 'rectangle' && Array.isArray(el.groupIds) &&
    el.groupIds.includes(`subgraph_group_${el.id}`);

  const layerIds = new Set(converted.filter(isLayer).map(el => el.id));

  const elements = converted.map(el => {
    if (el.type === 'rectangle') {
      if (layerIds.has(el.id)) {
        // Layer band — sits behind components, calm and dashed
        return {
          ...el,
          backgroundColor: LAYER_BG, strokeColor: LAYER_STROKE, strokeWidth: 1,
          fillStyle: 'solid', roughness: 0, strokeStyle: 'dashed',
          customData: { ...el.customData, isLayer: true },
        } as ExcalidrawElement;
      }
      const isChanged = CHANGED_FILLS.has((el.backgroundColor || '').toLowerCase());
      return {
        ...el,
        backgroundColor: isChanged ? '#fef3c7' : NODE_BG,
        strokeColor:     isChanged ? '#d97706' : NODE_STROKE,
        strokeWidth:     isChanged ? 2 : 1.5,
        fillStyle: 'solid',
        roughness: 0,          // crisp, not sketchy — improves legibility
        customData: { ...el.customData, nodeType: 'component', changed: isChanged },
      } as ExcalidrawElement;
    }
    if (el.type === 'text') {
      // Edge labels have a containerId of null and small size; node labels are bound.
      const boundTo = (el as { containerId?: string | null }).containerId;
      if (boundTo && layerIds.has(boundTo)) {
        return { ...el, strokeColor: LAYER_TEXT, opacity: 100 } as ExcalidrawElement; // layer title
      }
      const isEdgeLabel = !boundTo;
      return { ...el, strokeColor: isEdgeLabel ? EDGE_LABEL : NODE_TEXT, opacity: 100 } as ExcalidrawElement;
    }
    if (el.type === 'arrow') {
      return { ...el, strokeColor: EDGE, strokeWidth: 1.5, opacity: 90, roughness: 0 } as ExcalidrawElement;
    }
    return el;
  });

  const normalIds = elements.map(el => el.id);

  return {
    elements,
    detailIds: [],
    overviewIds: [],
    normalIds,
    nodeIds: buildNodeIds(elements, layerIds),
  };
}
