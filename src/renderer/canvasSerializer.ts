import { ExcalidrawElement } from './diagramBuilder';

export function serializeCanvasContext(
  elements: ExcalidrawElement[],
  nodeIds: Record<string, string[]>,
  descriptions?: Record<string, string>,
): string {
  if (Object.keys(nodeIds).length === 0) return '';

  // Build reverse map: elementId → node name
  const idToName: Record<string, string> = {};
  for (const [name, ids] of Object.entries(nodeIds)) {
    for (const id of ids) idToName[id] = name;
  }

  // Collect node types from rectangle customData
  const nodeTypes: Record<string, string> = {};
  for (const el of elements) {
    if (el.type === 'rectangle') {
      const name = idToName[el.id];
      if (name) nodeTypes[name] = (el.customData?.nodeType as string | undefined) || 'component';
    }
  }

  // Collect arrow labels: arrow id → label text
  const arrowLabels: Record<string, string> = {};
  for (const el of elements) {
    if (el.type === 'text' && el.containerId) {
      const container = elements.find(e => e.id === el.containerId);
      if (container?.type === 'arrow') arrowLabels[el.containerId] = el.text;
    }
  }

  const nodeNames = Object.keys(nodeIds);

  const lines: string[] = [`Canvas design (${nodeNames.length} nodes):`, 'Nodes:'];
  for (const name of nodeNames) {
    const type = nodeTypes[name] || 'component';
    const desc = descriptions?.[name];
    lines.push(desc ? `- ${name} [${type}] — "${desc}"` : `- ${name} [${type}]`);
  }

  const relLines: string[] = [];
  for (const el of elements) {
    if (el.type !== 'arrow') continue;
    const from = el.startBinding?.elementId ? idToName[el.startBinding.elementId] : undefined;
    const to   = el.endBinding?.elementId   ? idToName[el.endBinding.elementId]   : undefined;
    if (!from || !to) continue;
    const label = arrowLabels[el.id];
    relLines.push(label ? `- ${from} --> ${to}: "${label}"` : `- ${from} --> ${to}`);
  }

  if (relLines.length > 0) {
    lines.push('Relationships:');
    lines.push(...relLines);
  }

  return lines.join('\n');
}
