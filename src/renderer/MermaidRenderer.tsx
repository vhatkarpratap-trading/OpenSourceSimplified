import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  themeVariables: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '14px',
    primaryColor: '#fffbe6',
    primaryBorderColor: '#1e1e2e',
    primaryTextColor: '#1e1e2e',
    lineColor: '#1e1e2e',
    secondaryColor: '#f0f9ff',
    tertiaryColor: '#f5f3ff',
  },
  flowchart: { curve: 'basis', padding: 20 },
  sequence: { actorMargin: 80, messageMargin: 40, useMaxWidth: true },
  gantt: { useMaxWidth: true },
});

let idCounter = 0;

interface Props {
  mermaid: string;
  title?: string;
}

export default function MermaidRenderer({ mermaid: src, title }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const idRef = useRef(`mermaid-svg-${++idCounter}`);

  useEffect(() => {
    if (!containerRef.current) return;
    const id = idRef.current;
    setError(null);

    // Clean up src — strip fences, unescape \n
    const cleaned = src
      .replace(/^\s*```(?:mermaid)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/\\n/g, '\n')
      .trim();

    mermaid.render(id, cleaned).then(({ svg }) => {
      if (!containerRef.current) return;
      containerRef.current.innerHTML = svg;

      // Make SVG fill the container while preserving aspect ratio
      const svgEl = containerRef.current.querySelector('svg');
      if (svgEl) {
        svgEl.style.width = '100%';
        svgEl.style.height = '100%';
        svgEl.style.maxWidth = '100%';
        svgEl.style.display = 'block';
        // Ensure viewBox is set for proper scaling
        if (!svgEl.getAttribute('viewBox')) {
          const w = svgEl.getAttribute('width') || '800';
          const h = svgEl.getAttribute('height') || '600';
          svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
        }
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
      }
      setScale(1);
    }).catch(err => {
      setError(err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err));
    });
  }, [src]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#fafaf7' }}>
      {title && (
        <div style={{
          padding: '6px 16px', fontSize: 11, color: '#666688',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          borderBottom: '1px solid #ebebf5', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>{title}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setScale(s => Math.min(3, s + 0.2))} style={zoomBtnStyle}>+</button>
            <button onClick={() => setScale(s => Math.max(0.2, s - 0.2))} style={zoomBtnStyle}>−</button>
            <button onClick={() => setScale(1)} style={zoomBtnStyle}>⊡</button>
          </div>
        </div>
      )}
      {error && (
        <div style={{
          padding: '6px 16px', fontSize: 11, color: '#b91c1c',
          background: '#fef2f2', borderBottom: '1px solid #fecaca',
          fontFamily: 'ui-monospace, monospace', flexShrink: 0,
        }}>
          Diagram error: {error}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24 }}>
        <div
          ref={containerRef}
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'top center',
            minWidth: '100%',
            transition: 'transform 0.15s ease',
          }}
        />
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  padding: '1px 7px', fontSize: 12, borderRadius: 4,
  border: '1px solid #e0e0e8', background: '#fff',
  color: '#666688', cursor: 'pointer', lineHeight: 1.6,
};
