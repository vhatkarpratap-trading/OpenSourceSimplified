import React, { useEffect, useState } from 'react';

export interface ExplorerNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: ExplorerNode[];
}

interface Props { tree: ExplorerNode[]; activePath?: string; onOpen: (path: string) => void }

function iconFor(name: string): string {
  if (/\.(ts|tsx|js|jsx)$/i.test(name)) return '◆';
  if (/\.(json|ya?ml)$/i.test(name)) return '{}';
  if (/\.(md|txt)$/i.test(name)) return '≡';
  if (/\.(xml|html)$/i.test(name)) return '<>';
  return '•';
}

export default function FileExplorer({ tree, activePath, onOpen }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.filter(n => n.type === 'folder').map(n => n.path)));
  useEffect(() => {
    // Open the first level like VS Code; deeper folders stay user-controlled.
    setExpanded(new Set(tree.filter(node => node.type === 'folder').map(node => node.path)));
  }, [tree]);
  const renderNode = (node: ExplorerNode, depth: number): React.ReactNode => {
    const open = expanded.has(node.path);
    if (node.type === 'folder') return <React.Fragment key={node.path}>
      <button onClick={() => setExpanded(prev => { const next = new Set(prev); open ? next.delete(node.path) : next.add(node.path); return next; })} style={rowStyle(depth, false)}>
        <span style={{ width: 13, color: '#a8a8ba' }}>{open ? '⌄' : '›'}</span><span style={{ color: '#c8c8db' }}>▾</span><span>{node.name}</span>
      </button>
      {open && node.children?.map(child => renderNode(child, depth + 1))}
    </React.Fragment>;
    const active = activePath === node.path;
    return <button key={node.path} onClick={() => onOpen(node.path)} title={node.path} style={rowStyle(depth, active)}>
      <span style={{ width: 13 }} /> <span style={{ color: '#a78bfa', fontSize: 9 }}>{iconFor(node.name)}</span><span>{node.name}</span>
    </button>;
  };

  return <>{tree.map(node => renderNode(node, 0))}</>;
}

function rowStyle(depth: number, active: boolean): React.CSSProperties {
  return {
    width: '100%', display: 'flex', alignItems: 'center', gap: 5, textAlign: 'left',
    border: 'none', borderLeft: active ? '2px solid #a78bfa' : '2px solid transparent',
    background: active ? '#25233d' : 'transparent', color: active ? '#e9ddff' : '#a9a9c2',
    padding: `5px 7px 5px ${7 + depth * 13}px`, cursor: 'pointer', fontSize: 10,
    fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
}
