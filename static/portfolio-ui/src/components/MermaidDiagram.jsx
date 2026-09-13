import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

// Initialize configuration once on load
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose', // Allows click events and interactions
  fontFamily: 'sans-serif',
});

const MermaidDiagram = ({ chart }) => {
  const ref = useRef(null);
  const [svgContent, setSvgContent] = useState('');

  useEffect(() => {
    if (chart && ref.current) {
      // Generate a unique ID for each render
      const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;

      mermaid
        .render(id, chart)
        .then((result) => {
          setSvgContent(result.svg);
        })
        .catch((err) => {
          console.error('Mermaid rendering failed', err);
          setSvgContent(`<pre style="color: red; font-size: 12px;">${err.message}</pre>`);
        });
    }
  }, [chart]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: svgContent }} />;
};

export default MermaidDiagram;