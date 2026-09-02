const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Terminal PTY
  ptyWrite: (data: string) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', cols, rows),
  onPtyData: (callback: (data: string) => void) => {
    ipcRenderer.on('pty:data', (_event: unknown, data: string) => callback(data));
  },
  onPtyExit: (callback: () => void) => {
    ipcRenderer.on('pty:exit', () => callback());
  },

  // Folder
  openFolder: (): Promise<{ folder: string; hasCachedDiagram: boolean } | null> =>
    ipcRenderer.invoke('folder:open'),
  clearProjectCache: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cache:clearProject'),

  // AI provider used for all canvas analysis and question requests
  getAiProvider: (): Promise<{ provider: string; providers: { id: string; label: string }[] }> =>
    ipcRenderer.invoke('ai:getProvider'),
  setAiProvider: (provider: string): Promise<{ provider: string; providers: { id: string; label: string }[] }> =>
    ipcRenderer.invoke('ai:setProvider', provider),

  // Analysis
  runAnalysis: (): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('analysis:run'),

  // Click-to-inspect: fetch kid-friendly detail for one component
  getComponentDetail: (name: string): Promise<{ ok?: boolean; error?: string; detail?: unknown }> =>
    ipcRenderer.invoke('component:detail', name),

  // Double-click drilldown: fetch a detailed sub-diagram for one component
  getComponentDrilldown: (name: string): Promise<{ ok?: boolean; error?: string; mermaid?: string }> =>
    ipcRenderer.invoke('component:drilldown', name),

  // Code flow: structured class/function/data trace rendered onto the canvas
  getComponentCodeFlow: (name: string, drillMermaid?: string): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }> =>
    ipcRenderer.invoke('component:codeflow', name, drillMermaid),
  getComponentImplementation: (name: string, drillMermaid?: string): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }> =>
    ipcRenderer.invoke('component:implementation', name, drillMermaid),

  // Project orientation: framework, architecture, state, and data/integrations
  getArchitectureStory: (): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> =>
    ipcRenderer.invoke('project:architectureStory'),
  getRepositoryImplementation: (): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> =>
    ipcRenderer.invoke('project:implementation'),

  // Events from main → renderer
  onDiagram: (callback: (diagram: unknown) => void) => {
    ipcRenderer.on('canvas:diagram', (_event: unknown, diagram: unknown) => callback(diagram));
  },
  onAnalysisStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('analysis:status', (_event: unknown, status: string) => callback(status));
  },
  onAnalysisStatusDetail: (callback: (detail: string) => void) => {
    ipcRenderer.on('analysis:statusDetail', (_event: unknown, detail: string) => callback(detail));
  },
  onFolderRestored: (callback: (result: { folder: string; hasCachedDiagram: boolean }) => void) => {
    ipcRenderer.on('folder:restored', (_event: unknown, result: { folder: string; hasCachedDiagram: boolean }) => callback(result));
  },
  onGitStatus: (callback: (changedNames: string[]) => void) => {
    ipcRenderer.on('canvas:gitStatus', (_event: unknown, names: string[]) => callback(names));
  },
  onGitAnnotations: (callback: (annotations: { name: string; summary: string; added: number; removed: number }[]) => void) => {
    ipcRenderer.on('canvas:gitAnnotations', (_event: unknown, annotations: unknown) =>
      callback(annotations as { name: string; summary: string; added: number; removed: number }[]));
  },
  onClaudeChanges: (callback: (changes: { changedNames: string[]; impactedNames: string[] }) => void) => {
    ipcRenderer.on('canvas:claudeChanges', (_event: unknown, changes: unknown) =>
      callback(changes as { changedNames: string[]; impactedNames: string[] }));
  },
  onImpactSummary: (callback: (summary: {
    changed: { name: string; type: string; description: string; oldDescription: string }[];
    impacted: { name: string; type: string; description: string; reason: string }[];
  }) => void) => {
    ipcRenderer.on('analysis:impactSummary', (_event: unknown, summary: unknown) =>
      callback(summary as {
        changed: { name: string; type: string; description: string; oldDescription: string }[];
        impacted: { name: string; type: string; description: string; reason: string }[];
      }));
  },

  // Canvas-aware terminal: execute a natural-language command with canvas context
  executeCanvasCommand: (req: { command: string; canvasContext: string; nodeNames: string[]; folder: string }): Promise<{ ok: boolean; statusMessage?: string; error?: string }> =>
    ipcRenderer.invoke('canvas:command', req),
  onCanvasCommandStatus: (callback: (msg: string) => void) => {
    ipcRenderer.on('canvas:commandStatus', (_event: unknown, msg: string) => callback(msg));
  },

  // Git history
  listGitCommits: (): Promise<{
    ok: boolean;
    commits?: Array<{ hash: string; short: string; message: string; author: string; date: string }>;
    error?: string;
  }> => ipcRenderer.invoke('git:listCommits'),

  getCommitDiff: (hash: string): Promise<{
    ok: boolean;
    changedFiles?: string[];
    changedNodeNames?: string[];
    annotations?: Array<{ name: string; summary: string; added: number; removed: number }>;
    commitInfo?: { hash: string; short: string; message: string; author: string; date: string; filesChanged: number };
    featureFlow?: { mermaid: string; descriptions?: Record<string, string> };
    codeFlow?: { mermaid: string; happyPath?: string[] };
    error?: string;
  }> => ipcRenderer.invoke('git:commitDiff', hash),

  // MCP: canvas state request (main asks renderer for serialized canvas)
  onMcpGetCanvasState: (cb: (data: { replyChannel: string }) => void) => {
    ipcRenderer.on('mcp:getCanvasState', (_event: unknown, data: { replyChannel: string }) => cb(data));
  },
  answerMcpGetCanvasState: (replyChannel: string, state: string) => {
    ipcRenderer.send(replyChannel, state);
  },

  // MCP: raw elements request (for freehand canvas → mermaid conversion)
  onMcpGetRawElements: (cb: (data: { replyChannel: string }) => void) => {
    ipcRenderer.on('mcp:getRawElements', (_event: unknown, data: { replyChannel: string }) => cb(data));
  },
  answerMcpGetRawElements: (replyChannel: string, elements: unknown[]) => {
    ipcRenderer.send(replyChannel, elements);
  },

  // MCP: canvas action triggers
  onMcpShowDrilldown: (cb: (data: { name: string }) => void) => {
    ipcRenderer.on('mcp:showDrilldown', (_event: unknown, data: { name: string }) => cb(data));
  },
  onMcpShowCodeFlow: (cb: (data: { name: string }) => void) => {
    ipcRenderer.on('mcp:showCodeFlow', (_event: unknown, data: { name: string }) => cb(data));
  },
  onMcpUpdateNodeDescription: (cb: (data: { name: string; description: string }) => void) => {
    ipcRenderer.on('mcp:updateNodeDescription', (_event: unknown, data: { name: string; description: string }) => cb(data));
  },
  onCanvasAddNote: (cb: (data: { text: string; bg: string; stroke: string; textColor: string }) => void) => {
    ipcRenderer.on('canvas:addNote', (_event: unknown, data: unknown) => cb(data as { text: string; bg: string; stroke: string; textColor: string }));
  },
  onCanvasClear: (cb: () => void) => {
    ipcRenderer.on('canvas:clear', () => cb());
  },

  // PR Review
  listPRs: (): Promise<{ ok: boolean; prs: unknown[]; error?: string }> =>
    ipcRenderer.invoke('pr:list'),
  reviewPR: (pr: unknown): Promise<unknown> =>
    ipcRenderer.invoke('pr:review', pr),

  // Answer a focused question about selected canvas components as a flowchart
  askAboutComponents: (req: { question: string; components: string[]; canvasContext: string; folder: string }): Promise<{ ok: boolean; diagram?: unknown; error?: string }> =>
    ipcRenderer.invoke('selection:ask', req),

  // Diagram type preference for completed response diagrams
  setPreferredDiagramType: (type: string) => ipcRenderer.send('canvas:setPreferredDiagramType', type),

  // Change context (ambient panel — fires after Claude edits)
  onChangeContext: (cb: (nodes: unknown[]) => void) => {
    ipcRenderer.on('canvas:changeContext', (_event: unknown, nodes: unknown[]) => cb(nodes));
  },

  // Build/test error annotations
  onErrorAnnotations: (cb: (annotations: unknown[]) => void) => {
    ipcRenderer.on('canvas:errorAnnotations', (_event: unknown, annotations: unknown[]) => cb(annotations));
  },
});
