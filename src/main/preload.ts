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

  // Analysis
  runAnalysis: (): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('analysis:run'),

  // Click-to-inspect: fetch kid-friendly detail for one component
  getComponentDetail: (name: string): Promise<{ ok?: boolean; error?: string; detail?: unknown }> =>
    ipcRenderer.invoke('component:detail', name),

  // Double-click drilldown: fetch a detailed sub-diagram for one component
  getComponentDrilldown: (name: string): Promise<{ ok?: boolean; error?: string; mermaid?: string }> =>
    ipcRenderer.invoke('component:drilldown', name),

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
});
