import { DiagramData } from './diagramBuilder';

export interface ComponentDetail {
  title: string;
  summary: string;
  does: string[];
  talksTo: string[];
}

export interface CommitInfo {
  hash: string;
  short: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitDiffResult {
  ok: boolean;
  changedFiles?: string[];
  changedNodeNames?: string[];
  annotations?: Array<{ name: string; summary: string; added: number; removed: number }>;
  commitInfo?: CommitInfo & { filesChanged: number };
  featureFlow?: { mermaid: string; descriptions?: Record<string, string> };
  codeFlow?: { mermaid: string; happyPath?: string[] };
  error?: string;
}

export interface ChangeContextNode {
  node: string;
  whatNow: string;
  dataIn: string;
  transform: string;
  dataOut: string;
  neighbours: string[];
}

export interface PRInfo {
  number: number;
  title: string;
  author: string;
  branch: string;
  baseBranch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  url?: string;
}

export interface PRReviewResult {
  ok: boolean;
  pr?: PRInfo;
  diff?: string;
  changedFiles?: string[];
  featureFlow?: { mermaid: string; descriptions?: Record<string, string> };
  codeFlow?: { mermaid: string; descriptions?: Record<string, string> };
  error?: string;
}

export interface WalkthroughSettings {
  // Execution Flow
  entryPoints: boolean;
  callChain: boolean;
  asyncPatterns: boolean;
  branchingLogic: boolean;
  // Data
  dataFlow: boolean;
  dataTypes: boolean;
  stateManagement: boolean;
  // Persistence
  dbInteractions: boolean;
  dbSchema: boolean;
  // Network & APIs
  restCalls: boolean;
  graphqlOps: boolean;
  externalIntegrations: boolean;
  // Access Control
  authChecks: boolean;
  permissions: boolean;
  // Security
  inputValidation: boolean;
  sensitiveData: boolean;
  // Error Handling
  errorHandling: boolean;
  fallbacks: boolean;
  // Performance
  caching: boolean;
  concurrency: boolean;
  // Observability
  logging: boolean;
  // Events
  events: boolean;
  // Testing
  testCoverage: boolean;
  // Architecture
  designPatterns: boolean;
  businessLogic: boolean;
  frameworkUnderstanding: boolean;
}

declare global {
  interface Window {
    electronAPI: {
      isDebugMode: () => Promise<boolean>;
      getAccountState: () => Promise<{ configured: boolean; user: { email: string; name: string; picture?: string } | null; subscription: { plan: 'monthly' | 'yearly'; status: string; id: string; renewsAt?: string } | null }> ;
      signInWithGoogle: () => Promise<{ configured: boolean; user: { email: string; name: string; picture?: string } | null; subscription: { plan: 'monthly' | 'yearly'; status: string; id: string; renewsAt?: string } | null }> ;
      startSubscription: (plan: 'monthly' | 'yearly') => Promise<{ configured: boolean; user: { email: string; name: string; picture?: string } | null; subscription: { plan: 'monthly' | 'yearly'; status: string; id: string; renewsAt?: string } | null }> ;
      signOut: () => Promise<{ configured: boolean; user: null; subscription: null }> ;
      openFolder: () => Promise<{ opened: boolean; folder: string; hasCachedDiagram?: boolean; access: { kind: 'open-source' | 'private'; source: string; detail: string; remoteUrl?: string } } | null>;
      clearProjectCache: () => Promise<{ ok: boolean; error?: string }>;
      getAiProvider: () => Promise<{ provider: string; providers: { id: string; label: string }[] }>;
      setAiProvider: (provider: string) => Promise<{ provider: string; providers: { id: string; label: string }[] }>;
      getAnalysisDepth: () => Promise<1 | 2 | 3>;
      setAnalysisDepth: (depth: 1 | 2 | 3) => Promise<1 | 2 | 3>;
      getRelationships: () => Promise<{ ok: boolean; mermaid?: string; error?: string }>;
      runAnalysis: () => Promise<{ ok?: boolean; error?: string }>;
      buildGraphAndAnalyse: () => Promise<{ ok: boolean; error?: string; nodeCount?: number; edgeCount?: number; analysis?: { ok?: boolean; error?: string } }> ;
      getComponentDetail: (name: string) => Promise<{ ok?: boolean; error?: string; detail?: ComponentDetail }>;
      getComponentDrilldown: (name: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string }>;
      getComponentCodeFlow: (name: string, drillMermaid?: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; dataFlow?: Record<string, { input: string; output: string; change: string }>; happyPath?: string[] }> ;
      getComponentSource: (name: string) => Promise<{ ok: boolean; error?: string; files?: Array<{ path: string; content: string; highlight?: string }>; graphify?: { available: boolean; confidence?: string; matchKind?: string; reasons?: string[] } }> ;
      getActualCodeFlow: (name: string) => Promise<{ ok: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }> ;
      getComponentImplementation: (name: string, drillMermaid?: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }>;
      getArchitectureStory: () => Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }>;
      getRepositoryImplementation: () => Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> ;
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
      executeCanvasCommand: (req: { command: string; canvasContext: string; nodeNames: string[]; folder: string }) => Promise<{ ok: boolean; statusMessage?: string; error?: string }>;
      onCanvasCommandStatus: (cb: (msg: string) => void) => void;
      listGitCommits: () => Promise<{ ok: boolean; commits?: CommitInfo[]; error?: string }>;
      getCommitDiff: (hash: string) => Promise<CommitDiffResult>;
      // PR Review
      listPRs: () => Promise<{ ok: boolean; prs: PRInfo[]; error?: string }>;
      reviewPR: (pr: PRInfo) => Promise<PRReviewResult>;
      askAboutComponents: (req: { question: string; components: string[]; canvasContext: string; folder: string }) => Promise<{ ok: boolean; diagram?: DiagramData; error?: string }>;
      // Diagram type preference
      setPreferredDiagramType: (type: string) => void;
      // Session panel persistence
      saveSessionPanels: (panels: { name: string; mode: string }[]) => void;
      onRestoreSession: (cb: (panels: { name: string; mode: string }[]) => void) => void;
      // Change context
      onChangeContext: (cb: (nodes: ChangeContextNode[]) => void) => void;
      // Walkthrough settings
      getWalkthroughSettings: () => Promise<WalkthroughSettings>;
      setWalkthroughSettings: (settings: WalkthroughSettings) => Promise<WalkthroughSettings>;
      // MCP
      onMcpGetCanvasState: (cb: (data: { replyChannel: string }) => void) => void;
      answerMcpGetCanvasState: (replyChannel: string, state: string) => void;
      onMcpGetRawElements: (cb: (data: { replyChannel: string }) => void) => void;
      answerMcpGetRawElements: (replyChannel: string, elements: unknown[]) => void;
      onMcpShowDrilldown: (cb: (data: { name: string }) => void) => void;
      onMcpShowCodeFlow:  (cb: (data: { name: string }) => void) => void;
      onMcpUpdateNodeDescription: (cb: (data: { name: string; description: string }) => void) => void;
      onCanvasAddNote: (cb: (data: { text: string; bg: string; stroke: string; textColor: string }) => void) => void;
      onCanvasClear: (cb: () => void) => void;
    };
  }
}

export {};
