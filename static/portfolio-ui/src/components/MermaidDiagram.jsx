import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

// Initialize configuration once on load.
// Note: we deliberately do NOT pin `theme` or `look` here. Mermaid 12 gives
// class/sequence/state/ER (and others) their own default theme — redux-color
// with the neo look — and hard-coding `theme: 'default'` opts every diagram
// back out of that, which is why diagrams previously rendered flat and
// uncoloured compared to the Mermaid docs.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose', // Allows click events and interactions
});

let renderSeq = 0;

/**
 * Renders Mermaid source text as inline SVG. Debounced so it doesn't
 * re-render on every keystroke, and guards against out-of-order async
 * results (a slow render for an older `chart` value landing after a
 * newer one has already resolved).
 *
 * Props:
 *  - chart: mermaid source text
 *  - onError(message | null): called when a render fails/succeeds, so a
 *    parent can show its own error banner instead of the inline <pre>.
 *  - debounceMs: default 350
 */
const MermaidDiagram = ({ chart, onError, debounceMs = 350 }) => {
  const ref = useRef(null);
  const [svgContent, setSvgContent] = useState('');

  useEffect(() => {
    if (!chart) return undefined;
    const mySeq = ++renderSeq;
    const timer = setTimeout(() => {
      const id = `mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      mermaid
        .render(id, chart)
        .then((result) => {
          if (mySeq !== renderSeq) return; // a newer render has since started
          setSvgContent(result.svg);
          onError && onError(null);
        })
        .catch((err) => {
          if (mySeq !== renderSeq) return;
          console.error('Mermaid rendering failed', err);
          if (onError) {
            onError(err.message || 'Failed to render diagram.');
          } else {
            setSvgContent(`<pre style="color: red; font-size: 12px;">${err.message}</pre>`);
          }
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [chart]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} data-testid="mermaid-render-target" dangerouslySetInnerHTML={{ __html: svgContent }} />;
};

export default MermaidDiagram;
