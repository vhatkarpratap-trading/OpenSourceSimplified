import { DiagramData } from './diagramBuilder';

export interface ComponentDetail {
  title: string;
  summary: string;
  does: string[];
  talksTo: string[];
}

declare global {
  interface Window {
    electronAPI: {
      ptyWrite: (data: string) => void;
      ptyResize: (cols: number, rows: number) => void;
      onPtyData: (cb: (data: string) => void) => void;
      onPtyExit: (cb: () => void) => void;
      openFolder: () => Promise<{ folder: string; hasCachedDiagram: boolean } | null>;
      runAnalysis: () => Promise<{ ok?: boolean; error?: string }>;
      getComponentDetail: (name: string) => Promise<{ ok?: boolean; error?: string; detail?: ComponentDetail }>;
      getComponentDrilldown: (name: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string }>;
      getComponentCodeFlow: (name: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string; happyPath?: string[] }>;
      onDiagram: (cb: (diagram: DiagramData | null) => void) => void;
      onAnalysisStatus: (cb: (status: string) => void) => void;
      onAnalysisStatusDetail: (cb: (detail: string) => void) => void;
      onFolderRestored: (cb: (result: { folder: string; hasCachedDiagram: boolean }) => void) => void;
      onGitStatus: (cb: (changedNames: string[]) => void) => void;
      onGitAnnotations: (cb: (annotations: { name: string; summary: string; added: number; removed: number }[]) => void) => void;
      onClaudeChanges: (cb: (changes: { changedNames: string[]; impactedNames: string[] }) => void) => void;
      onImpactSummary: (cb: (summary: {
        changed: { name: string; type: string; description: string; oldDescription: string }[];
        impacted: { name: string; type: string; description: string; reason: string }[];
      }) => void) => void;
    };
  }
}

export {};
