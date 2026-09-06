/**
 * Diagram data model + shared Excalidraw types.
 *
 * Layout is no longer computed here — Claude emits Mermaid text and
 * `mermaidScene.ts` converts it to Excalidraw elements. This module keeps the
 * shared type definitions, the `FlatScene` shape consumed by `Canvas.tsx`, and
 * the type/grey color palettes used for change highlighting.
 */

export type DiagramKind = 'structure' | 'sequence' | 'gitDiff';

export interface DiagramData {
  pattern: string;
  diagrams: {
    structure?: string;  // Mermaid: flowchart TD — primary user-facing journey
    sequence?: string;   // Mermaid: flowchart TD — additional user-facing journeys
    gitDiff?: string;    // Mermaid: flowchart — changed files + +/- lines
  };
  descriptions?: Record<string, string>;  // NodeLabel → 1-sentence description
}

export type ZoomTier = 'overview' | 'normal' | 'detail';

export interface FlatScene {
  elements:    ExcalidrawElement[];
  detailIds:   string[];
  overviewIds: string[];
  normalIds:   string[];
  nodeIds:     Record<string, string[]>; // node name → element IDs (box + labels)
}

// ── Excalidraw types ──────────────────────────────────────────────────────────

interface BaseEl {
  id: string; x: number; y: number; width: number; height: number;
  strokeColor: string; backgroundColor: string; fillStyle: string;
  strokeWidth: number; strokeStyle: string; angle: number;
  roughness: number; opacity: number; groupIds: string[];
  frameId: null; seed: number; version: number; versionNonce: number;
  isDeleted: false; updated: number; link: null; locked: false;
  customData?: Record<string, unknown>;
}
interface ExcalidrawRect extends BaseEl {
  type: 'rectangle';
  roundness: { type: number } | null;
  boundElements: { type: string; id: string }[];
}
interface ExcalidrawText extends BaseEl {
  type: 'text'; text: string; fontSize: number; fontFamily: number;
  textAlign: string; verticalAlign: string; roundness: null;
  boundElements: null; containerId: string | null;
  originalText: string; lineHeight: number; baseline: number;
}
interface ExcalidrawArrow extends BaseEl {
  type: 'arrow'; points: [number, number][];
  startArrowhead: null; endArrowhead: 'arrow' | null; boundElements: null;
  startBinding: { elementId: string; focus: number; gap: number } | null;
  endBinding:   { elementId: string; focus: number; gap: number } | null;
  roundness: { type: number } | null; elbowed: boolean;
}
export type ExcalidrawElement = ExcalidrawRect | ExcalidrawText | ExcalidrawArrow;

// ── Colors ────────────────────────────────────────────────────────────────────
// Default: components render in neutral grey (calm baseline).
// Only changed components get their type color injected by Canvas.tsx.

const GREY = { bg: '#fafafa', stroke: '#c1c8d4', text: '#8896a8', childBg: '#f5f6f8' };

// Type colors are used ONLY when a component is highlighted (git / Claude changed)
const TYPE_COLORS: Record<string, { bg: string; stroke: string; text: string; childBg: string }> = {
  folder:     { bg: '#f1f5f9', stroke: '#94a3b8', text: '#475569', childBg: '#ffffff' },
  file:       { bg: '#e0f2fe', stroke: '#0284c7', text: '#0c4a6e', childBg: '#f0f9ff' },
  class:      { bg: '#dbeafe', stroke: '#2563eb', text: '#1e40af', childBg: '#eff6ff' },
  component:  { bg: '#e0f2fe', stroke: '#0284c7', text: '#0c4a6e', childBg: '#f0f9ff' },
  function:   { bg: '#f0fdf4', stroke: '#16a34a', text: '#14532d', childBg: '#f0fdf4' },
  method:     { bg: '#f0fdf4', stroke: '#16a34a', text: '#14532d', childBg: '#f0fdf4' },
  interface:  { bg: '#faf5ff', stroke: '#7c3aed', text: '#4c1d95', childBg: '#faf5ff' },
  service:    { bg: '#dcfce7', stroke: '#16a34a', text: '#14532d', childBg: '#f0fdf4' },
  model:      { bg: '#fce7f3', stroke: '#db2777', text: '#831843', childBg: '#fdf4ff' },
  controller: { bg: '#dbeafe', stroke: '#2563eb', text: '#1e40af', childBg: '#eff6ff' },
  view:       { bg: '#e0f2fe', stroke: '#0284c7', text: '#0c4a6e', childBg: '#f0f9ff' },
  handler:    { bg: '#ffedd5', stroke: '#ea580c', text: '#7c2d12', childBg: '#fff7ed' },
  util:       { bg: '#f5f3ff', stroke: '#7c3aed', text: '#4c1d95', childBg: '#faf5ff' },
  config:     { bg: '#f8fafc', stroke: '#64748b', text: '#334155', childBg: '#f8fafc' },
  repository: { bg: '#fef9c3', stroke: '#ca8a04', text: '#713f12', childBg: '#fefce8' },
  gateway:    { bg: '#ede9fe', stroke: '#7c3aed', text: '#4c1d95', childBg: '#faf5ff' },
  enum:       { bg: '#fff7ed', stroke: '#ea580c', text: '#7c2d12', childBg: '#fff7ed' },
  viewmodel:  { bg: '#fffbeb', stroke: '#d97706', text: '#92400e', childBg: '#fef3c7' },
};

export { TYPE_COLORS, GREY as GREY_COLOR };
