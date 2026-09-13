import React, { useState } from 'react';
import MermaidDiagram from './MermaidDiagram';

const defaultFlow = `graph TD
    A[Fetch Current Holdings] --> B[Fetch Live Market Prices]
    B --> C{Calculate Drift}
    C -->|Drift > Threshold| D[Generate Rebalance Orders]
    C -->|Drift <= Threshold| E[Hold]
    D --> F[Submit to Brokerage API]`;

const DiagramEditor = () => {
  const [code, setCode] = useState(defaultFlow);

  return (
    <div style={{ display: 'flex', gap: '20px', height: '500px', width: '100%' }}>
      {/* Left Side: Code Editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Diagram Code</h3>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{
            flex: 1,
            fontFamily: 'monospace',
            fontSize: '14px',
            padding: '10px',
            border: '1px solid #ccc',
            borderRadius: '4px'
          }}
        />
      </div>

      {/* Right Side: Live Preview */}
      <div style={{ flex: 1, border: '1px solid #ccc', padding: '15px', overflow: 'auto', borderRadius: '4px' }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Live Preview</h3>
        <MermaidDiagram chart={code} />
      </div>
    </div>
  );
};

export default DiagramEditor;