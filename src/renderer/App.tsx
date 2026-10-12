import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types/types';
import Canvas from './Canvas';
import { DiagramData, DiagramKind } from './diagramBuilder';
import type { CommitInfo, CommitDiffResult, PRInfo, PRReviewResult, ChangeContextNode, WalkthroughSettings } from './global';

const DIAGRAM_TYPES: { id: string; label: string; emoji: string; description: string; template: string }[] = [
  { id: 'flowchart', label: 'Flow Chart', emoji: '⬡', description: 'Steps, decisions, processes',
    template: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n  C --> E[Done]\n  D --> E' },
  { id: 'sequenceDiagram', label: 'Sequence', emoji: '↔', description: 'Who talks to who, in order',
    template: 'sequenceDiagram\n  actor User\n  participant App\n  participant Server\n  User->>App: Open page\n  App->>Server: Fetch data\n  Server-->>App: Return data\n  App-->>User: Show results' },
  { id: 'mindmap', label: 'Mind Map', emoji: '✦', description: 'Ideas branching from a centre',
    template: 'mindmap\n  root((Main Idea))\n    Branch One\n      Detail A\n      Detail B\n    Branch Two\n      Detail C\n    Branch Three' },
  { id: 'timeline', label: 'Timeline', emoji: '→', description: 'Events in chronological order',
    template: 'timeline\n  title Project Timeline\n  section Phase 1\n    Jan : Kickoff\n    Feb : Design\n  section Phase 2\n    Mar : Build\n    Apr : Test\n  section Phase 3\n    May : Launch' },
  { id: 'classDiagram', label: 'Class', emoji: '▣', description: 'Objects, fields, relationships',
    template: 'classDiagram\n  class User {\n    +String name\n    +String email\n    +login()\n    +logout()\n  }\n  class Post {\n    +String title\n    +String body\n    +publish()\n  }\n  User "1" --> "many" Post : writes' },
  { id: 'erDiagram', label: 'ER Diagram', emoji: '⬜', description: 'Database tables and relations',
    template: 'erDiagram\n  USER {\n    int id PK\n    string name\n    string email\n  }\n  POST {\n    int id PK\n    string title\n    int user_id FK\n  }\n  USER ||--o{ POST : writes' },
  { id: 'gitGraph', label: 'Git Graph', emoji: '⌥', description: 'Branches and commits',
    template: 'gitGraph\n  commit id: "Initial"\n  branch feature\n  checkout feature\n  commit id: "Add feature"\n  commit id: "Fix bug"\n  checkout main\n  merge feature\n  commit id: "Release"' },
  { id: 'gantt', label: 'Gantt', emoji: '▬', description: 'Tasks and schedule',
    template: 'gantt\n  title Project Schedule\n  dateFormat YYYY-MM-DD\n  section Design\n    Research      : 2024-01-01, 7d\n    Wireframes    : 7d\n  section Build\n    Frontend      : 2024-01-15, 14d\n    Backend       : 2024-01-15, 14d\n  section Launch\n    Testing       : 5d\n    Deploy        : 2d' },
  { id: 'kanban', label: 'Kanban', emoji: '▦', description: 'Tasks by status',
    template: 'kanban\n  title Team Board\n  column Todo\n    task1: Write tests\n    task2: Update docs\n  column In Progress\n    task3: Build feature\n  column Done\n    task4: Fix login bug' },
  { id: 'pie', label: 'Pie Chart', emoji: '◔', description: 'Proportions and percentages',
    template: 'pie title Distribution\n  "Feature Work" : 45\n  "Bug Fixes" : 25\n  "Refactoring" : 20\n  "Meetings" : 10' },
];

function extractNodeNamesFromDiagram(diagram: DiagramData | null): string[] {
  const structure = diagram?.diagrams?.structure;
  if (!structure) return [];
  const names = new Set<string>();
  const re = /([A-Za-z0-9_]+)\s*[\[\(\{]([^\]\)\}]+)[\]\)\}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(structure))) {
    names.add(m[2].trim());
    names.add(m[1].trim());
  }
  return Array.from(names).filter(n => n && !/^(TD|LR|TB|RL|flowchart|classDef|changed)$/i.test(n));
}

function restoreSelectionLabel(name: string, diagram: DiagramData | null): string {
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const selected = compact(name);
  if (!selected || !diagram?.descriptions) return name;
  const match = Object.keys(diagram.descriptions).find(label => {
    const candidate = compact(label);
    return candidate === selected || candidate.startsWith(`${selected} `) || selected.startsWith(`${candidate} `);
  });
  return match ?? name;
}

type AnalysisStatus = 'idle' | 'running' | 'patching' | 'done' | 'error';
type AccountState = {
  configured: boolean;
  user: { email: string; name: string; picture?: string } | null;
  subscription: { plan: 'monthly' | 'yearly'; status: string; id: string; renewsAt?: string } | null;
};

const DIAGRAM_TABS: { kind: DiagramKind; label: string }[] = [
  { kind: 'structure', label: 'User Flow' },
  { kind: 'sequence',  label: 'More User Flows' },
  { kind: 'gitDiff',   label: 'Git Diff' },
];

const STATUS_DOT_COLOR: Record<AnalysisStatus, string> = {
  idle:     'transparent',
  running:  '#f9e2af',
  patching: '#cba6f7',
  done:     '#a6e3a1',
  error:    '#f38ba8',
};

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  idle:     '',
  running:  'Analysing…',
  patching: 'Updating…',
  done:     'Done',
  error:    'Error',
};

export default function App() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [debugMode, setDebugMode] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [folder, setFolder]           = useState<string | null>(null);
  const [diagram, setDiagram]         = useState<DiagramData | null>(null);
  const [status, setStatus]           = useState<AnalysisStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [impactSummary, setImpactSummary] = useState<{
    changed: { name: string; type: string; description: string; oldDescription: string }[];
    impacted: { name: string; type: string; description: string; reason: string }[];
  } | null>(null);
  const [activeKind, setActiveKind]         = useState<DiagramKind>('structure');
  const [renderError, setRenderError]       = useState<string | null>(null);
  const [drilldownActive, setDrilldownActive] = useState(false);
  const [drillDepth, setDrillDepth]           = useState(0);
  const [codeFlowActive, setCodeFlowActive]   = useState(false);
  const [codeFlowDepth, setCodeFlowDepth]     = useState(0);
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [selectionQuestion, setSelectionQuestion] = useState('');
  const [selectionQuestionOpen, setSelectionQuestionOpen] = useState(false);
  const [selectionAnswering, setSelectionAnswering] = useState(false);
  const [drilling, setDrilling]               = useState(false);
  const [storyLoading, setStoryLoading]       = useState(false);
  const [implLoading, setImplLoading]         = useState(false);
  const codeFlowLoading = storyLoading || implLoading;
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);
  const [sourceView, setSourceView] = useState<{ files?: Array<{ path: string; content: string; highlight?: string }>; error?: string; graphify?: { available: boolean; confidence?: string; matchKind?: string; reasons?: string[] } } | null>(null);
  const [sourceFileIndex, setSourceFileIndex] = useState(0);
  const [graphBuilding, setGraphBuilding] = useState(false);
  const [aiProvider, setAiProvider] = useState('claude');
  const [analysisDepth, setAnalysisDepth] = useState<1 | 2 | 3>(2);
  const [aiProviders, setAiProviders] = useState<{ id: string; label: string }[]>([
    { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'OpenAI Codex' }, { id: 'gemini', label: 'Google Gemini' },
  ]);

  const DEFAULT_WALKTHROUGH_SETTINGS: WalkthroughSettings = {
    entryPoints: false, callChain: false, asyncPatterns: false, branchingLogic: false,
    dataFlow: false, dataTypes: false, stateManagement: false,
    dbInteractions: false, dbSchema: false,
    restCalls: false, graphqlOps: false, externalIntegrations: false,
    authChecks: false, permissions: false,
    inputValidation: false, sensitiveData: false,
    errorHandling: false, fallbacks: false,
    caching: false, concurrency: false,
    logging: false, events: false, testCoverage: false,
    designPatterns: false, businessLogic: false, frameworkUnderstanding: false,
  };
  const [walkthroughSettings, setWalkthroughSettings] = useState<WalkthroughSettings>(DEFAULT_WALKTHROUGH_SETTINGS);
  const [walkthroughSettingsOpen, setWalkthroughSettingsOpen] = useState(false);
  const walkthroughSettingsRef = useRef<HTMLDivElement>(null);
  const activeWalkthroughFocusCount = Object.values(walkthroughSettings).filter(Boolean).length;

  // Canvas history — every diagram Claude draws gets appended here
  const [canvasHistory, setCanvasHistory] = useState<{ diagram: DiagramData; timestamp: number; index: number }[]>([]);
  const [canvasHistoryOpen, setCanvasHistoryOpen] = useState(false);
  const [canvasHistoryIndex, setCanvasHistoryIndex] = useState<number | null>(null); // null = live
  const lastHistoryMermaid = useRef<string>('');

  // Diagram type picker — what type Claude should draw next
  const [preferredDiagramType, setPreferredDiagramType] = useState<string>('flowchart');
  const [typePickerOpen, setTypePickerOpen] = useState(false);

  // Wrapped setDiagram that also appends to canvas history
  const setDiagramAndRecord = useCallback((data: DiagramData | null) => {
    setDiagram(data);
    if (!data?.diagrams?.structure) return;
    const mermaid = data.diagrams.structure;
    // Deduplicate: skip if same mermaid as last entry
    if (mermaid === lastHistoryMermaid.current) return;
    lastHistoryMermaid.current = mermaid;
    setCanvasHistory(prev => {
      const next = [...prev, { diagram: data, timestamp: Date.now(), index: prev.length }];
      return next.slice(-50); // keep last 50
    });
    setCanvasHistoryIndex(null); // jump to live
  }, []);

  const [historyActive, setHistoryActive]         = useState(false);
  const [commits, setCommits]                     = useState<CommitInfo[]>([]);
  const [commitsLoading, setCommitsLoading]       = useState(false);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const commitDiffLoadingRef = useRef(false);

  // Change story mode (a selected PR or branch)
  const [prActive, setPrActive]                   = useState(false);
  const [prs, setPrs]                             = useState<PRInfo[]>([]);
  const [prsLoading, setPrsLoading]               = useState(false);
  const [prPickerOpen, setPrPickerOpen]           = useState(false);
  const [changeStoryMode, setChangeStoryMode]     = useState<'pr' | 'branch'>('pr');
  const [activePR, setActivePR]                   = useState<PRInfo | null>(null);
  const [prReviewing, setPrReviewing]             = useState(false);
  const [prResult, setPrResult]                   = useState<PRReviewResult | null>(null);
  const [prView, setPrView]                       = useState<'feature' | 'code'>('feature');

  // Ambient change context panel
  const [changeContext, setChangeContext]         = useState<ChangeContextNode[] | null>(null);
  const [changeContextOpen, setChangeContextOpen] = useState(false);

  const typePickerRef = useRef<HTMLDivElement>(null);

  // Close type picker when clicking outside
  useEffect(() => {
    if (!typePickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (typePickerRef.current && !typePickerRef.current.contains(e.target as Node)) {
        setTypePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [typePickerOpen]);

  // Close walkthrough settings when clicking outside
  useEffect(() => {
    if (!walkthroughSettingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (walkthroughSettingsRef.current && !walkthroughSettingsRef.current.contains(e.target as Node)) {
        setWalkthroughSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [walkthroughSettingsOpen]);

  useEffect(() => {
    window.electronAPI.getAiProvider().then(({ provider, providers }) => {
      setAiProvider(provider);
      setAiProviders(providers);
    }).catch(() => undefined);
    window.electronAPI.getAnalysisDepth().then(setAnalysisDepth).catch(() => undefined);
    window.electronAPI.getAccountState().then(setAccount).catch(() => undefined);
    window.electronAPI.isDebugMode().then(setDebugMode).catch(() => undefined);
    window.electronAPI.getWalkthroughSettings().then(s => setWalkthroughSettings(s as WalkthroughSettings)).catch(() => undefined);
  }, []);

  const handleGoogleSignIn = useCallback(async () => {
    setAccountBusy(true); setAccountError(null);
    try { setAccount(await window.electronAPI.signInWithGoogle()); }
    catch (error) { setAccountError(error instanceof Error ? error.message : 'Google sign-in failed.'); }
    finally { setAccountBusy(false); }
  }, []);

  const handleSubscribe = useCallback(async (plan: 'monthly' | 'yearly') => {
    setAccountBusy(true); setAccountError(null);
    try { setAccount(await window.electronAPI.startSubscription(plan)); }
    catch (error) { setAccountError(error instanceof Error ? error.message : 'PayPal checkout failed.'); }
    finally { setAccountBusy(false); }
  }, []);

  const handleSignOut = useCallback(async () => {
    setAccountBusy(true); setAccountError(null);
    try { setAccount(await window.electronAPI.signOut()); }
    finally { setAccountBusy(false); }
  }, []);

  const excalidrawAPIRef   = useRef<ExcalidrawImperativeAPI | null>(null);
  const clearDrilldownRef  = useRef<(() => void) | null>(null);
  const clearCodeFlowRef   = useRef<(() => void) | null>(null);
  const clearAllCodeFlowsRef = useRef<(() => void) | null>(null);
  const renderDrilldownRef = useRef<((name: string) => void) | null>(null);
  const renderCodeFlowRef  = useRef<((name: string, mode?: 'story' | 'implementation' | 'actual', drillMermaid?: string) => Promise<void>) | null>(null);
  const flowInFlightRef    = useRef(false);
  const canvasContextRef   = useRef<(() => string) | null>(null);
  const rawElementsRef     = useRef<(() => unknown[]) | null>(null);
  const sessionPanelsRef   = useRef<{ name: string; mode: string }[]>([]);
  const renderCommitDiffRef = useRef<((diff: CommitDiffResult) => Promise<void>) | null>(null);
  const clearCommitDiffRef  = useRef<(() => void) | null>(null);
  const addNoteRef          = useRef<((data: { text: string; bg: string; stroke: string; textColor: string }) => void) | null>(null);
  const selectionAnswerRef  = useRef<((diagram: DiagramData) => Promise<void>) | null>(null);
  const listenersAttached  = useRef(false);

  if (!listenersAttached.current) {
    listenersAttached.current = true;

    window.electronAPI.onDiagram((d) => {
      const data = d as DiagramData | null;
      setDiagramAndRecord(data);
      setRenderError(null);
      if (data?.diagrams) {
        if (data.diagrams.gitDiff) setActiveKind('gitDiff');
        else if (data.diagrams.structure) setActiveKind('structure');
        else if (data.diagrams.sequence) setActiveKind('sequence');
      }
    });

    window.electronAPI.onAnalysisStatus((s) => {
      setStatus(s as AnalysisStatus);
      if (s === 'running') { setImpactSummary(null); setChangeContextOpen(false); }
    });

    window.electronAPI.onAnalysisStatusDetail((d) => setStatusDetail(d));

    window.electronAPI.onFolderRestored((result) => {
      setFolder(result.folder);
      // A previous project's failure must not remain visible after opening another project.
      setStatus('idle');
      setStatusDetail(null);
      setRenderError(null);
      if (!result.hasCachedDiagram) setDiagram(null);
    });

    window.electronAPI.onImpactSummary((summary) => setImpactSummary(summary));

    // MCP: respond to canvas state requests from main process
    window.electronAPI.onMcpGetCanvasState(({ replyChannel }) => {
      const state = canvasContextRef.current?.() ?? '';
      window.electronAPI.answerMcpGetCanvasState(replyChannel, state);
    });

    // MCP: respond to raw elements requests (freehand canvas → mermaid)
    window.electronAPI.onMcpGetRawElements(({ replyChannel }) => {
      const elements = rawElementsRef.current?.() ?? [];
      window.electronAPI.answerMcpGetRawElements(replyChannel, elements);
    });

    // MCP: show drilldown overlay for a named component
    window.electronAPI.onMcpShowDrilldown(({ name }) => {
      setSelectedComponent(name);
      setSelectedComponents([name]);
      renderDrilldownRef.current?.(name);
      setDrillDepth(d => d + 1);
      setDrilldownActive(true);
    });

    // MCP: show code flow overlay for a named component
    window.electronAPI.onMcpShowCodeFlow(({ name }) => {
      setSelectedComponent(name);
      setSelectedComponents([name]);
      renderCodeFlowRef.current?.(name);
      setCodeFlowDepth(d => d + 1);
      setCodeFlowActive(true);
    });

    // MCP: update a node description in the live diagram
    window.electronAPI.onMcpUpdateNodeDescription(({ name, description }) => {
      setDiagram(prev => {
        if (!prev) return prev;
        return { ...prev, descriptions: { ...(prev.descriptions ?? {}), [name]: description } };
      });
    });

    // MCP: add a sticky note to the canvas
    window.electronAPI.onCanvasAddNote((data) => {
      addNoteRef.current?.(data);
    });

    // MCP: clear the canvas
    window.electronAPI.onCanvasClear(() => {
      setDiagram(null);
      setRenderError(null);
      setDrilldownActive(false);
      setCodeFlowActive(false);
      setDrillDepth(0);
      setCodeFlowDepth(0);
      setSelectedComponent(null);
      clearDrilldownRef.current?.();
      clearAllCodeFlowsRef.current?.();
    });

    window.electronAPI.onChangeContext((nodes) => {
      setChangeContext(nodes as ChangeContextNode[]);
      setChangeContextOpen(true);
    });

    // Restore non-drill panels from cache. Drills are intentional, temporary
    // navigation and must only happen after the user explicitly requests one.
    window.electronAPI.onRestoreSession(async (panels) => {
      for (const panel of panels) {
        if (panel.mode === 'drill') {
          continue;
        } else {
          await renderCodeFlowRef.current?.(panel.name, panel.mode as 'story' | 'implementation' | 'actual');
          setCodeFlowDepth(d => d + 1);
          setCodeFlowActive(true);
        }
      }
    });

  }

  const handleOpenFolder = useCallback(async () => {
    const result = await window.electronAPI.openFolder();
    if (result) {
      setFolder(result.folder);
      sessionPanelsRef.current = [];
      if (!result.hasCachedDiagram) { setStatus('idle'); setDiagram(null); }
    }
  }, []);

  const handleClearProjectCache = useCallback(async () => {
    if (!folder || status === 'running' || status === 'patching') return;
    const result = await window.electronAPI.clearProjectCache();
    if (!result.ok) { setRenderError(result.error ?? 'Could not clear the project cache'); return; }
    clearDrilldownRef.current?.();
    clearAllCodeFlowsRef.current?.();
    sessionPanelsRef.current = [];
    window.electronAPI.saveSessionPanels([]);
    setDiagram(null);
    setSelectedComponent(null);
    setSelectedComponents([]);
    setStatus('idle');
    setStatusDetail('Project cache cleared — run Analyse to create a new map.');
  }, [folder, status]);

  const handleAnalyse = useCallback(async () => {
    if (!folder || status === 'running' || status === 'patching') return;
    await window.electronAPI.runAnalysis();
  }, [folder, status]);

  const handleBuildGraphAndAnalyse = useCallback(async () => {
    if (!folder || graphBuilding || status === 'running' || status === 'patching') return;
    setGraphBuilding(true);
    setRenderError(null);
    const result = await window.electronAPI.buildGraphAndAnalyse();
    setGraphBuilding(false);
    if (!result.ok || result.analysis?.error) {
      setRenderError(result.error || result.analysis?.error || 'Could not build the Graphify code graph');
    }
  }, [folder, graphBuilding, status]);

  const handleRelationships = useCallback(async () => {
    if (!folder) return;
    const result = await window.electronAPI.getRelationships();
    if (!result.ok || !result.mermaid) { setRenderError(result.error ?? 'Could not build the local relationship graph'); return; }
    clearDrilldownRef.current?.();
    clearAllCodeFlowsRef.current?.();
    setDiagramAndRecord({ pattern: `Local relationships — ${analysisDepth === 1 ? 'overview' : analysisDepth === 2 ? 'balanced' : 'deep'}`, diagrams: { structure: result.mermaid }, descriptions: {} });
    setActiveKind('structure');
    setSelectedComponent(null);
    setSelectedComponents([]);
    setRenderError(null);
  }, [folder, analysisDepth, setDiagramAndRecord]);

  const handleCanvasCommand = useCallback(async (command: string) => {
    if (!folder) return;
    const canvasContext = canvasContextRef.current?.() ?? '';
    const nodeNames = extractNodeNamesFromDiagram(diagram);
    setStatus('patching');
    setStatusDetail(`Canvas: ${command}`);
    const result = await window.electronAPI.executeCanvasCommand({ command, canvasContext, nodeNames, folder });
    if (!result.ok) {
      setStatus('error');
      setStatusDetail(result.error ?? 'Canvas command failed');
    }
  }, [folder, diagram]);

  const askAboutSelection = useCallback(async () => {
    if (!selectionQuestion.trim() || !folder) return;
    setSelectionAnswering(true);
    try {
      const canvasContext = canvasContextRef.current?.() ?? '';
      const result = await window.electronAPI.askAboutComponents({
        question: selectionQuestion.trim(),
        components: selectedComponents,
        canvasContext,
        folder: folder ?? '',
      });
      if (result.ok && result.diagram) {
        await selectionAnswerRef.current?.(result.diagram);
        setSelectionQuestionOpen(false);
        setSelectionQuestion('');
      } else {
        setRenderError(result.error ?? 'Could not create an answer diagram');
      }
    } finally {
      setSelectionAnswering(false);
    }
  }, [folder, selectedComponents, selectionQuestion, setDiagramAndRecord]);

  const handleSelectionChange = useCallback((names: string[]) => {
    const restoredNames = names.map(name => restoreSelectionLabel(name, diagram));
    setSelectedComponents(restoredNames);
    setSelectedComponent(restoredNames[0] ?? null);
    const selected = restoredNames[0];
    if (!selected) return;
  }, [diagram]);

  const folderName = folder ? folder.split('/').filter(Boolean).pop() : null;
  const busy = status === 'running' || status === 'patching';
  const canvasLabel = (drilldownActive || codeFlowActive)
    ? [drilldownActive && `Drill: ${selectedComponent ?? ''}`, codeFlowActive && `Flow: ${selectedComponent ?? ''}`].filter(Boolean).join(' · ')
    : prActive && activePR
      ? `PR #${activePR.number}: ${activePR.title}`
      : (diagram ? diagram.pattern : 'Canvas');

  // Only show diagram type tabs when a code-analysis result is loaded (has multiple diagram kinds)
  const isCodeAnalysisDiagram = !!(diagram?.diagrams?.sequence || diagram?.diagrams?.gitDiff);

  const handleBack = useCallback(() => {
    clearDrilldownRef.current?.();
    setDrillDepth(d => Math.max(0, d - 1));
    sessionPanelsRef.current = sessionPanelsRef.current.filter((p, i) => !(p.mode === 'drill' && i === sessionPanelsRef.current.length - 1));
    window.electronAPI.saveSessionPanels(sessionPanelsRef.current);
  }, []);

  const handleBackFlow = useCallback(() => {
    clearCodeFlowRef.current?.();
    setCodeFlowDepth(d => Math.max(0, d - 1));
    sessionPanelsRef.current = sessionPanelsRef.current.filter((_, i) => i !== sessionPanelsRef.current.length - 1);
    window.electronAPI.saveSessionPanels(sessionPanelsRef.current);
  }, []);

  const handleDrill = useCallback(async () => {
    if (!selectedComponent || drilling) return;
    setDrilling(true);
    await renderDrilldownRef.current?.(selectedComponent);
    setDrillDepth(d => d + 1);
    sessionPanelsRef.current = [...sessionPanelsRef.current, { name: selectedComponent, mode: 'drill' }];
    window.electronAPI.saveSessionPanels(sessionPanelsRef.current);
    setDrilling(false);
  }, [selectedComponent, drilling]);

  const handleCodeFlow = useCallback(async () => {
    if (!selectedComponent || flowInFlightRef.current) return;
    flowInFlightRef.current = true;
    setStoryLoading(true);
    try {
      await renderCodeFlowRef.current?.(selectedComponent);
      setCodeFlowDepth(d => d + 1);
      sessionPanelsRef.current = [...sessionPanelsRef.current, { name: selectedComponent, mode: 'story' }];
      window.electronAPI.saveSessionPanels(sessionPanelsRef.current);
    } finally {
      setStoryLoading(false);
      flowInFlightRef.current = false;
    }
  }, [selectedComponent]);

  const handleActualCodeFlow = useCallback(async () => {
    if (!selectedComponent) return;
    setSourcePanelOpen(true);
    setSourceFileIndex(0);
    setSourceView({});
    const result = await window.electronAPI.getComponentSource(selectedComponent);
    setSourceView(result.ok
      ? { files: result.files, graphify: result.graphify }
      : { error: result.error ?? 'No matching source file was found.' });
  }, [selectedComponent]);

  const handleImplementation = useCallback(async () => {
    if (!selectedComponent || flowInFlightRef.current) return;
    flowInFlightRef.current = true;
    setImplLoading(true);
    try {
      await renderCodeFlowRef.current?.(selectedComponent, 'implementation');
      setCodeFlowDepth(d => d + 1);
      sessionPanelsRef.current = [...sessionPanelsRef.current, { name: selectedComponent, mode: 'implementation' }];
      window.electronAPI.saveSessionPanels(sessionPanelsRef.current);
    } finally {
      setImplLoading(false);
      flowInFlightRef.current = false;
    }
  }, [selectedComponent]);

  const handleRepositoryCodeStory = useCallback(async () => {
    if (!folder || codeFlowLoading || flowInFlightRef.current) return;
    flowInFlightRef.current = true;
    setStoryLoading(true);
    setStatus('running');
    setStatusDetail('Creating whole-repository code story…');
    try {
      const result = await window.electronAPI.getComponentCodeFlow('__whole_repo__');
      if (!result?.ok || !result.mermaid) throw new Error(result?.error || 'No story was returned');
      clearDrilldownRef.current?.();
      clearCodeFlowRef.current?.();
      setDrilldownActive(false);
      setCodeFlowActive(false);
      setDiagramAndRecord({
        pattern: 'Whole repository — Code story',
        diagrams: { structure: result.mermaid },
        descriptions: result.descriptions ?? {},
      });
      setActiveKind('structure');
      setRenderError(null);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoryLoading(false);
      flowInFlightRef.current = false;
      setStatus('done');
      setStatusDetail(null);
    }
  }, [folder, codeFlowLoading, setDiagramAndRecord]);

  const handleArchitectureStory = useCallback(async () => {
    if (!folder || codeFlowLoading || flowInFlightRef.current) return;
    flowInFlightRef.current = true;
    setStoryLoading(true);
    setStatus('running');
    setStatusDetail('Finding the project architecture…');
    try {
      const result = await window.electronAPI.getArchitectureStory();
      if (!result?.ok || !result.mermaid) throw new Error(result?.error || 'No architecture story was returned');
      clearDrilldownRef.current?.();
      clearCodeFlowRef.current?.();
      setDrilldownActive(false);
      setCodeFlowActive(false);
      setDiagramAndRecord({
        pattern: 'Project architecture — Code story',
        diagrams: { structure: result.mermaid },
        descriptions: result.descriptions ?? {},
      });
      setActiveKind('structure');
      setRenderError(null);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoryLoading(false);
      flowInFlightRef.current = false;
      setStatus('done');
      setStatusDetail(null);
    }
  }, [folder, codeFlowLoading, setDiagramAndRecord]);

  const handleRepositoryImplementation = useCallback(async () => {
    if (!folder || codeFlowLoading || flowInFlightRef.current) return;
    flowInFlightRef.current = true;
    setImplLoading(true);
    setStatus('running');
    setStatusDetail('Mapping the repository implementation…');
    clearDrilldownRef.current?.();
    clearAllCodeFlowsRef.current?.();
    setDrilldownActive(false);
    setCodeFlowActive(false);
    setCodeFlowDepth(0);
    setSelectedComponent(null);
    try {
      const result = await window.electronAPI.getRepositoryImplementation();
      if (!result?.ok || !result.mermaid) throw new Error(result?.error || 'No implementation map was returned');
      setDiagramAndRecord({
        pattern: 'Whole repository — Implementation',
        diagrams: { structure: result.mermaid },
        descriptions: result.descriptions ?? {},
      });
      setActiveKind('structure');
      setRenderError(null);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setImplLoading(false);
      flowInFlightRef.current = false;
      setStatus('done');
      setStatusDetail(null);
    }
  }, [folder, codeFlowLoading, setDiagramAndRecord]);

  // The learning path should work for a newcomer before they know which node
  // to select. A selection narrows Story/Implementation to one feature; no
  // selection explains the whole project.
  const canFlow = !!folder && !codeFlowLoading;

  const handleHistoryTabClick = useCallback(async () => {
    // If diagrams are showing, re-open the picker; if already open, do nothing
    if (historyActive) return;
    setHistoryActive(true);
    if (commits.length > 0) return; // already loaded
    setCommitsLoading(true);
    setCommits([]);
    setSelectedCommitHash(null);
    try {
      const result = await window.electronAPI.listGitCommits();
      if (result.ok && result.commits) setCommits(result.commits);
    } finally {
      setCommitsLoading(false);
    }
  }, [historyActive, commits.length]);

  const handleHistoryClear = useCallback(() => {
    setHistoryActive(false);
    setCommits([]);
    setSelectedCommitHash(null);
    clearCommitDiffRef.current?.();
  }, []);

  const handleCommitSelect = useCallback(async (hash: string) => {
    if (commitDiffLoadingRef.current) return;
    setSelectedCommitHash(hash);
    setHistoryActive(false); // close dropdown so canvas is fully visible
    commitDiffLoadingRef.current = true;
    setCommitDiffLoading(true);
    setStatus('running');
    setStatusDetail('Generating commit diagrams…');
    try {
      const result = await window.electronAPI.getCommitDiff(hash);
      if (result.ok) await renderCommitDiffRef.current?.(result as CommitDiffResult);
    } finally {
      commitDiffLoadingRef.current = false;
      setCommitDiffLoading(false);
      setStatus('done');
      setStatusDetail(null);
    }
  }, []);

  // ── Change story handlers ─────────────────────────────────────────────────────

  const openChangeStoryPicker = useCallback(async (mode: 'pr' | 'branch') => {
    setChangeStoryMode(mode);
    setPrActive(true);
    setPrPickerOpen(true);
    setActivePR(null);
    setPrResult(null);
    setPrView('feature');
    handleHistoryClear();
    setPrsLoading(true);
    try {
      const result = await window.electronAPI.listPRs();
      if (result.ok) {
        const all = result.prs as PRInfo[];
        setPrs(all.filter(item => mode === 'pr' ? item.number > 0 : item.number < 0));
      }
    } finally {
      setPrsLoading(false);
    }
  }, []);

  const handlePRClear = useCallback(() => {
    setPrActive(false);
    setPrPickerOpen(false);
    setPrs([]);
    setActivePR(null);
    setPrResult(null);
    setPrView('feature');
  }, []);

  const showPRView = useCallback((view: 'feature' | 'code', result: PRReviewResult, pr: PRInfo) => {
    const flow = view === 'feature' ? result.featureFlow : result.codeFlow;
    if (!flow?.mermaid) return;
    setPrView(view);
    setDiagramAndRecord({
      pattern: `${pr.number > 0 ? `PR #${pr.number}` : `Branch ${pr.branch}`} — ${view === 'feature' ? 'Feature impact' : 'Code story'}`,
      diagrams: { structure: flow.mermaid },
      descriptions: flow.descriptions ?? {},
    });
    setActiveKind('structure');
  }, [setDiagramAndRecord]);

  const handlePRSelect = useCallback(async (pr: PRInfo) => {
    setActivePR(pr);
    setPrPickerOpen(false);
    setPrReviewing(true);
    setStatus('running');
    setStatusDetail(`Mapping changes: ${pr.title}…`);
    try {
      const result = await window.electronAPI.reviewPR(pr) as PRReviewResult;
      setPrResult(result);
      if (result.ok && result.featureFlow?.mermaid) showPRView('feature', result, pr);
      else if (result.ok && result.codeFlow?.mermaid) showPRView('code', result, pr);
      else setRenderError(result.error ?? 'The change story could not be drawn. Try selecting it again.');
    } finally {
      setPrReviewing(false);
      setStatus('done');
      setStatusDetail(null);
    }
  }, [showPRView]);

  const hasPro = debugMode || account?.subscription?.status === 'ACTIVE' || account?.subscription?.status === 'APPROVED';

  return (
    <div
      onClickCapture={(event) => {
        if (hasPro) return;
        const target = event.target as HTMLElement;
        if (target.closest('[data-account-dialog], [data-account-action]')) return;
        event.preventDefault();
        event.stopPropagation();
        setAccountError(null);
        setAccountOpen(true);
      }}
      style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: '#0f0f1a' }}
    >
      <style>{`
        @keyframes slideUpIn { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>

      {accountOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(5, 6, 12, 0.78)', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          <div data-account-dialog role="dialog" aria-modal="true" aria-label="Account and Pro plans" style={{ width: 520, maxWidth: 'calc(100vw - 32px)', background: '#171721', border: '1px solid #45455a', borderRadius: 14, padding: 24, boxShadow: '0 24px 80px rgba(0,0,0,.55)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div><div style={{ color: '#fff', fontSize: 21, fontWeight: 700 }}>Rex Canvas Pro</div><div style={{ color: '#a9a9bb', fontSize: 13, marginTop: 5 }}>Every canvas feature is included with Pro.</div></div>
              <button onClick={() => setAccountOpen(false)} aria-label="Close" style={{ color: '#a9a9bb', background: 'transparent', border: 0, fontSize: 20, cursor: 'pointer' }}>×</button>
            </div>
            {account?.subscription ? (
              <div style={{ marginTop: 20, padding: 14, borderRadius: 9, background: '#10251d', border: '1px solid #2d8a5d', color: '#d7fbe8' }}>
                <div style={{ fontWeight: 700 }}>Pro is active</div>
                <div style={{ fontSize: 12, marginTop: 4, color: '#a9ddbf' }}>{account.subscription.plan === 'monthly' ? '$19 / month' : '$120 / year'} · {account.subscription.status.toLowerCase()}{account.subscription.renewsAt ? ` · renews ${new Date(account.subscription.renewsAt).toLocaleDateString()}` : ''}</div>
              </div>
            ) : (
              <>
                {!account?.user ? (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 13, color: '#d4d4df', marginBottom: 10 }}>Sign in to securely connect your subscription.</div>
                    <button onClick={() => void handleGoogleSignIn()} disabled={accountBusy} style={{ width: '100%', padding: '11px 14px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', color: '#252530', fontWeight: 600, cursor: accountBusy ? 'wait' : 'pointer' }}>{accountBusy ? 'Opening Google…' : 'Continue with Google'}</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 20 }}>
                    <div style={{ color: '#d4d4df', fontSize: 13, marginBottom: 12 }}>Signed in as {account.user.email}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <button onClick={() => void handleSubscribe('monthly')} disabled={accountBusy} style={{ textAlign: 'left', padding: 15, borderRadius: 9, border: '1px solid #55556c', background: '#22222e', color: '#fff', cursor: accountBusy ? 'wait' : 'pointer' }}><div style={{ fontWeight: 700 }}>Monthly</div><div style={{ fontSize: 20, fontWeight: 700, marginTop: 7 }}>$19 <span style={{ fontSize: 12, fontWeight: 400 }}>/ month</span></div></button>
                      <button onClick={() => void handleSubscribe('yearly')} disabled={accountBusy} style={{ textAlign: 'left', padding: 15, borderRadius: 9, border: '1px solid #8070e9', background: '#292447', color: '#fff', cursor: accountBusy ? 'wait' : 'pointer' }}><div style={{ fontWeight: 700 }}>Yearly · Save $108</div><div style={{ fontSize: 20, fontWeight: 700, marginTop: 7 }}>$120 <span style={{ fontSize: 12, fontWeight: 400 }}>/ year</span></div></button>
                    </div>
                    {accountBusy && <div style={{ fontSize: 12, color: '#bcb3ff', marginTop: 12 }}>Complete approval in PayPal. This screen will update automatically.</div>}
                  </div>
                )}
              </>
            )}
            {accountError && <div style={{ marginTop: 14, padding: 10, background: '#351923', border: '1px solid #8f3b50', borderRadius: 7, color: '#ffc2ce', fontSize: 12 }}>{accountError}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 }}>
              <span style={{ color: '#77778c', fontSize: 11 }}>Payments are securely handled by PayPal.</span>
              {account?.user && <button onClick={() => void handleSignOut()} disabled={accountBusy} style={{ color: '#b7b7c6', background: 'transparent', border: 0, fontSize: 12, cursor: 'pointer' }}>Sign out</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', alignContent: 'center', flexWrap: 'wrap', gap: 8,
        padding: '8px 16px', minHeight: 76, boxSizing: 'border-box',
        background: '#15151d', borderBottom: '1px solid #30303b',
        // The Focus menu is an absolutely positioned child of this toolbar.
        // Keeping overflow visible prevents the menu from being clipped below it.
        flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 10,
        // @ts-ignore
        WebkitAppRegion: 'drag',
      }}>
        <div style={{ width: 80, flexShrink: 0 }} />

        <button data-account-action onClick={() => { setAccountError(null); setAccountOpen(true); }} style={{ padding: '6px 11px', background: (debugMode || account?.subscription) ? '#173a2b' : '#322855', border: `1px solid ${(debugMode || account?.subscription) ? '#31855c' : '#7767d9'}`, borderRadius: 6, color: '#f5f3ff', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {debugMode ? 'Debug · Free' : account?.subscription ? '✓ Pro' : 'Upgrade to Pro'}
        </button>

        {/* Open Project */}
        <button onClick={handleOpenFolder} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', background: '#23232d',
          border: '1px solid #484854', borderRadius: 6,
          color: '#ededf2', fontSize: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: 'pointer', flexShrink: 0,
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          <FolderIcon />
          Open Project
        </button>

        <button
          onClick={handleBuildGraphAndAnalyse}
          disabled={!folder || graphBuilding || status === 'running' || status === 'patching'}
          title="Build a local Graphify code graph, then analyse the project with it"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            background: folder && !graphBuilding && status !== 'running' && status !== 'patching' ? '#2b2b36' : '#1b1b24',
            border: '1px solid #51515e', borderRadius: 6, color: '#ededf2', fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif', cursor: folder ? 'pointer' : 'not-allowed', flexShrink: 0,
            opacity: folder ? 1 : 0.45,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          ◈ {graphBuilding ? 'Building graph…' : 'Graphify + Analyse'}
        </button>

        <label title="Choose the AI that handles new analysis and canvas questions" style={{
          display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          color: '#a4a4b0', fontSize: 10, fontFamily: 'system-ui, -apple-system, sans-serif',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          AI
          <select
            value={aiProvider}
            onChange={(event) => {
              const next = event.target.value;
              setAiProvider(next);
              window.electronAPI.setAiProvider(next).then(({ provider, providers }) => {
                setAiProvider(provider);
                setAiProviders(providers);
              }).catch(() => setAiProvider(aiProvider));
            }}
            style={{
              background: '#20202a', border: '1px solid #484854', borderRadius: 5, color: '#ededf2',
              fontSize: 11, padding: '4px 24px 4px 7px', cursor: 'pointer', outline: 'none',
            }}
          >
            {aiProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </label>

        <label title="Controls the detail level for every new user flow, Code Story, implementation map, and answer" style={{
          display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
          color: '#a4a4b0', fontSize: 10, fontFamily: 'system-ui, -apple-system, sans-serif',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          Depth
          <input
            type="range" min="1" max="3" step="1" value={analysisDepth}
            onChange={(event) => {
              const next = Number(event.target.value) as 1 | 2 | 3;
              setAnalysisDepth(next);
              window.electronAPI.setAnalysisDepth(next).then(setAnalysisDepth).catch(() => undefined);
            }}
            style={{ width: 58, accentColor: '#d4d4dc', cursor: 'pointer' }}
          />
          <span style={{ color: '#ededf2', width: 54 }}>
            {analysisDepth === 1 ? 'Overview' : analysisDepth === 2 ? 'Balanced' : 'Deep'}
          </span>
        </label>

        {/* Folder path */}
        <span style={{
          flex: 1, fontSize: 11, fontFamily: 'ui-monospace, monospace',
          color: '#9999a8', overflow: 'hidden', minWidth: 100,
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none',
        }}>
          {folder ?? 'No project open'}
        </span>

        {/* Status dot + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: STATUS_DOT_COLOR[status],
            transition: 'background 0.3s',
          }} />
          {(statusDetail && status === 'running') ? (
            <span style={{ fontSize: 10, color: '#888', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusDetail}
            </span>
          ) : STATUS_LABEL[status] && (
            <span style={{ fontSize: 11, color: '#666688', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>

        {/* Keep project settings separate from the workflow actions below. */}
        <div
          role="toolbar"
          aria-label="Project workflow actions"
          style={{
            flexBasis: '100%', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
            paddingTop: 8, marginTop: 1, borderTop: '1px solid #30303b',
            // @ts-ignore
            WebkitAppRegion: 'drag',
          }}
        >

        {/* Drill button */}
        <button
          onClick={handleDrill}
          disabled={!selectedComponent || drilling}
          title={selectedComponent ? `Drill into ${selectedComponent}` : 'Select a component first'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', background: selectedComponent ? '#2b2b36' : '#1b1b24',
            border: `1px solid ${selectedComponent ? '#51515e' : '#3b3b47'}`, borderRadius: 6,
            color: selectedComponent ? '#ededf2' : '#777782', fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: selectedComponent ? 'pointer' : 'not-allowed',
            opacity: selectedComponent ? 1 : 0.45, flexShrink: 0,
            transition: 'all 0.2s',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <DrillIcon />
          {drilling ? 'Drilling…' : selectedComponent ? `Drill: ${selectedComponent}` : 'Drill'}
        </button>

        {/* Code Story button */}
        <button
          onClick={() => { if (flowInFlightRef.current) return; if (selectedComponent) void handleCodeFlow(); else void handleRepositoryCodeStory(); }}
          disabled={!canFlow}
          title={selectedComponent ? `Explain how ${selectedComponent} works in plain English` : 'Explain how the whole project works in plain English'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px',
            background: canFlow ? '#2b2b36' : '#1b1b24',
            border: `1px solid ${canFlow ? '#51515e' : '#3b3b47'}`, borderRadius: 6,
            color: canFlow ? '#ededf2' : '#777782', fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: canFlow ? 'pointer' : 'not-allowed',
            opacity: canFlow ? 1 : 0.45, flexShrink: 0,
            transition: 'all 0.2s',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <FlowIcon />
          {storyLoading ? 'Explaining…' : selectedComponent ? 'Code Story' : 'Project Code Story'}
        </button>

        <button
          onClick={handleActualCodeFlow}
          disabled={!selectedComponent || codeFlowLoading}
          title={selectedComponent ? `Show source-proven classes, methods, and direct calls for ${selectedComponent}` : 'Select a component first'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            background: selectedComponent && !codeFlowLoading ? '#1e3a8a' : '#1b1b24',
            border: `1px solid ${selectedComponent && !codeFlowLoading ? '#3b82f6' : '#3b3b47'}`, borderRadius: 6,
            color: selectedComponent && !codeFlowLoading ? '#dbeafe' : '#777782', fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: selectedComponent && !codeFlowLoading ? 'pointer' : 'not-allowed', opacity: selectedComponent && !codeFlowLoading ? 1 : 0.45, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <FlowIcon /> View actual code
        </button>

        <button
          onClick={() => { if (!flowInFlightRef.current) void handleImplementation(); }}
          disabled={!selectedComponent || implLoading}
          title={selectedComponent ? `Walk through how ${selectedComponent} works in simple English` : 'Select a component first'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            background: selectedComponent && !implLoading ? '#2b2b36' : '#1b1b24', border: `1px solid ${selectedComponent && !implLoading ? '#51515e' : '#3b3b47'}`, borderRadius: 6,
            color: selectedComponent && !implLoading ? '#ededf2' : '#777782', fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: selectedComponent && !implLoading ? 'pointer' : 'not-allowed', opacity: selectedComponent && !implLoading ? 1 : 0.45, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <FlowIcon /> {implLoading ? 'Explaining…' : 'Code walkthrough'}
        </button>

        <button
          onClick={() => { if (!flowInFlightRef.current) void handleRepositoryImplementation(); }}
          disabled={!canFlow}
          title="Generate a code walkthrough for the whole project in simple English"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            background: canFlow ? '#2b2b36' : '#1b1b24', border: `1px solid ${canFlow ? '#51515e' : '#3b3b47'}`, borderRadius: 6,
            color: canFlow ? '#ededf2' : '#777782', fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: canFlow ? 'pointer' : 'not-allowed', opacity: canFlow ? 1 : 0.45, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <FlowIcon /> {implLoading ? 'Explaining…' : 'Project code walkthrough'}
        </button>

        {/* Walkthrough settings gear button */}
        <div style={{ position: 'relative', flexShrink: 0 }} ref={walkthroughSettingsRef}>
          <button
            onClick={() => setWalkthroughSettingsOpen(o => !o)}
            title="Configure what to focus on in code walkthroughs"
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
              background: walkthroughSettingsOpen ? '#2a2a42' : '#20202a',
              border: `1px solid ${walkthroughSettingsOpen ? '#7c6aed' : activeWalkthroughFocusCount > 0 ? '#7c6aed' : '#484854'}`,
              borderRadius: 6, color: walkthroughSettingsOpen || activeWalkthroughFocusCount > 0 ? '#c4b5fd' : '#c8c8d0',
              fontSize: 11, fontFamily: 'system-ui, -apple-system, sans-serif',
              cursor: 'pointer',
              // @ts-ignore
              WebkitAppRegion: 'no-drag',
            }}
            >
            <GearIcon />
            Focus
            {activeWalkthroughFocusCount > 0 && (
              <span aria-label={`${activeWalkthroughFocusCount} focus areas active`} style={{
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: '#7c6aed', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1,
              }}>{activeWalkthroughFocusCount}</span>
            )}
          </button>

          {walkthroughSettingsOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              width: 340, maxHeight: 540, overflowY: 'auto',
              background: '#1a1a26', border: '1px solid #3a3a58',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
              zIndex: 300, padding: '12px 0',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}>
              <div style={{ padding: '0 14px 8px', borderBottom: '1px solid #2a2a3e', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#ededf2' }}>Walkthrough Focus</div>
                  <div style={{ fontSize: 10, color: '#7777a0', marginTop: 2 }}>Tick what you want the AI to give extra attention to</div>
                </div>
                {Object.values(walkthroughSettings).some(v => v) && (
                  <button
                    onClick={() => {
                      const cleared = Object.fromEntries(Object.keys(walkthroughSettings).map(k => [k, false])) as unknown as WalkthroughSettings;
                      setWalkthroughSettings(cleared);
                      window.electronAPI.setWalkthroughSettings(cleared).catch(() => undefined);
                    }}
                    style={{ fontSize: 10, color: '#9999bb', background: 'transparent', border: '1px solid #3a3a58', borderRadius: 4, padding: '2px 7px', cursor: 'pointer' }}
                  >Clear all</button>
                )}
              </div>

              {[
                { label: 'EXECUTION FLOW', keys: [
                  { key: 'entryPoints', label: 'Entry points and triggers' },
                  { key: 'callChain', label: 'Function call chain' },
                  { key: 'asyncPatterns', label: 'Async and await patterns' },
                  { key: 'branchingLogic', label: 'Branching logic and conditionals' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'DATA', keys: [
                  { key: 'dataFlow', label: 'Data flow and transformations' },
                  { key: 'dataTypes', label: 'Data types and schemas' },
                  { key: 'stateManagement', label: 'State management' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'DATABASE', keys: [
                  { key: 'dbInteractions', label: 'DB reads and writes' },
                  { key: 'dbSchema', label: 'Schema and table structure' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'NETWORK & APIs', keys: [
                  { key: 'restCalls', label: 'REST calls and payloads' },
                  { key: 'graphqlOps', label: 'GraphQL operations' },
                  { key: 'externalIntegrations', label: 'External integrations and SDKs' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'ACCESS CONTROL', keys: [
                  { key: 'authChecks', label: 'Authentication checks' },
                  { key: 'permissions', label: 'Permissions and roles' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'SECURITY', keys: [
                  { key: 'inputValidation', label: 'Input validation and injection risks' },
                  { key: 'sensitiveData', label: 'Sensitive data and PII handling' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'ERROR HANDLING', keys: [
                  { key: 'errorHandling', label: 'Error flows and propagation' },
                  { key: 'fallbacks', label: 'Fallbacks, retries, and timeouts' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'PERFORMANCE', keys: [
                  { key: 'caching', label: 'Caching layers and memoisation' },
                  { key: 'concurrency', label: 'Concurrency and parallelism' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'OBSERVABILITY', keys: [
                  { key: 'logging', label: 'Logging, metrics, and tracing' },
                  { key: 'events', label: 'Events and messaging' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'QUALITY', keys: [
                  { key: 'testCoverage', label: 'Test coverage and mock boundaries' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
                { label: 'ARCHITECTURE', keys: [
                  { key: 'designPatterns', label: 'Design patterns and layer boundaries' },
                  { key: 'businessLogic', label: 'Business logic and domain rules' },
                  { key: 'frameworkUnderstanding', label: 'Framework understanding in plain English' },
                ] as { key: keyof WalkthroughSettings; label: string }[] },
              ].map(group => (
                <div key={group.label} style={{ padding: '0 14px 10px' }}>
                  <div style={{ fontSize: 9, color: '#6666a0', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, marginTop: 4 }}>
                    {group.label}
                  </div>
                  {group.keys.map(({ key, label }) => {
                    const checked = walkthroughSettings[key];
                    return (
                      <label
                        key={key}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 5, cursor: 'pointer', background: checked ? '#23233a' : 'transparent', marginBottom: 2 }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = { ...walkthroughSettings, [key]: !checked };
                            setWalkthroughSettings(next);
                            window.electronAPI.setWalkthroughSettings(next).catch(() => undefined);
                          }}
                          style={{ accentColor: '#7c6aed', width: 13, height: 13, cursor: 'pointer', flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 12, color: checked ? '#c4b5fd' : '#9999bb', userSelect: 'none' }}>{label}</span>
                      </label>
                    );
                  })}
                </div>
              ))}

              <div style={{ padding: '8px 14px 0', borderTop: '1px solid #2a2a3e', marginTop: 4 }}>
                <div style={{ fontSize: 10, color: '#5555a0', lineHeight: 1.4 }}>
                  These settings inject specific focus instructions into the next walkthrough prompt. Cached results are bypassed when focus changes.
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleClearProjectCache}
          disabled={!folder || busy}
          title="Clear this project's saved analysis, drilldowns, stories, and implementation maps"
          style={{
            padding: '6px 10px', background: '#20202a', border: '1px solid #484854', borderRadius: 6,
            color: '#c8c8d0', fontSize: 11, fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: (!folder || busy) ? 'not-allowed' : 'pointer', opacity: (!folder || busy) ? 0.45 : 1, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          Clear cache
        </button>

        <button
          onClick={() => setSelectionQuestionOpen(true)}
          disabled={!folder || busy}
          title={selectedComponent ? 'Ask a question about the selected component or components' : 'Ask a question about this project'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
            background: (!folder || busy) ? '#1b1b24' : '#2b2b36',
            border: `1px solid ${(!folder || busy) ? '#3b3b47' : '#51515e'}`, borderRadius: 6,
            color: (!folder || busy) ? '#777782' : '#ededf2', fontSize: 12,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: (!folder || busy) ? 'not-allowed' : 'pointer', opacity: (!folder || busy) ? 0.45 : 1, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          {selectedComponent ? 'Ask selected' : 'Ask project'}
        </button>

        <button onClick={handleRelationships} disabled={!folder || busy} title="View the locally built file and import relationship graph" style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          background: '#2b2b36', border: '1px solid #51515e', borderRadius: 6, color: '#ededf2',
          fontSize: 12, fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: (!folder || busy) ? 'not-allowed' : 'pointer', opacity: (!folder || busy) ? 0.45 : 1, flexShrink: 0,
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          ⟷ Relationships
        </button>

        {/* Analyse */}
        <button onClick={handleAnalyse} disabled={!folder || busy} title="Show what people can do with this project, in plain language" style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', background: '#32323f',
          border: '1px solid #626270', borderRadius: 6,
          color: '#ffffff', fontSize: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: (!folder || busy) ? 'not-allowed' : 'pointer',
          opacity: (!folder || busy) ? 0.45 : 1, flexShrink: 0,
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
        }}>
          <SparkleIcon />
          {status === 'running' ? 'Finding user flows…' : status === 'patching' ? 'Updating…' : 'Analyse user flow'}
        </button>
        </div>
      </div>

      {/* ── Impact Panel ── */}
      {impactSummary && (impactSummary.changed.length > 0 || impactSummary.impacted.length > 0) && (
        <div style={{
          background: '#0a0b0f', borderTop: '1px solid #2a1a08',
          padding: '10px 16px', flexShrink: 0, maxHeight: 180, overflowY: 'auto',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 10, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {aiProviders.find(provider => provider.id === aiProvider)?.label ?? 'AI'} changed {impactSummary.changed.length} node{impactSummary.changed.length !== 1 ? 's' : ''}
              {impactSummary.impacted.length > 0 && ` · ${impactSummary.impacted.length} impacted`}
            </span>
            <span onClick={() => setImpactSummary(null)} style={{ fontSize: 11, color: '#444466', cursor: 'pointer', lineHeight: 1 }}>✕</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {impactSummary.changed.map((node) => (
              <div key={node.name} style={{ background: '#1a1200', border: '1px solid #d97706', borderRadius: 6, padding: '5px 10px', minWidth: 140, maxWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: '#d97706', textTransform: 'uppercase', background: '#3a2200', padding: '1px 5px', borderRadius: 3 }}>{node.type}</span>
                  <span style={{ fontSize: 11, color: '#fef3c7', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{node.name}</span>
                </div>
                {node.description && <div style={{ fontSize: 10, color: '#a16207', lineHeight: 1.4 }}>{node.description}</div>}
                {node.oldDescription && node.oldDescription !== node.description && (
                  <div style={{ fontSize: 9, color: '#5a4010', lineHeight: 1.3, marginTop: 2 }}>was: {node.oldDescription}</div>
                )}
              </div>
            ))}
            {impactSummary.impacted.map((node) => (
              <div key={node.name} style={{ background: '#130800', border: '1px solid #ea580c', borderRadius: 6, padding: '5px 10px', minWidth: 140, maxWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: '#ea580c', textTransform: 'uppercase', background: '#2a1000', padding: '1px 5px', borderRadius: 3 }}>{node.type}</span>
                  <span style={{ fontSize: 11, color: '#fff7ed', fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{node.name}</span>
                </div>
                <div style={{ fontSize: 9, color: '#9a3412', lineHeight: 1.3 }}>{node.reason}</div>
                {node.description && <div style={{ fontSize: 10, color: '#7c2d12', lineHeight: 1.4, marginTop: 2 }}>{node.description}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Panes ── */}
      <div style={{ display: 'flex', flex: 1, padding: '10px', gap: 10, overflow: 'hidden' }}>

        {/* Canvas */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          background: '#ffffff', borderRadius: 10,
          border: '1px solid #e0e0e8', overflow: 'hidden',
          position: 'relative',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 12px',
            borderBottom: '1px solid #ebebf5',
            flexShrink: 0, userSelect: 'none',
          }}>
            <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center', position: 'relative' }}>
                {drilldownActive && (
                  <button onClick={handleBack} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 10px', fontSize: 11, borderRadius: 5,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    border: '1px solid #1a73b5', background: '#e0f2fe',
                    color: '#0369a1', cursor: 'pointer', flexShrink: 0,
                  }}>
                    ← Drill {drillDepth > 1 ? `(${drillDepth})` : ''}
                  </button>
                )}
                {codeFlowActive && (
                  <button onClick={handleBackFlow} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 10px', fontSize: 11, borderRadius: 5,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    border: '1px solid #16a34a', background: '#dcfce7',
                    color: '#15803d', cursor: 'pointer', flexShrink: 0,
                  }}>
                    ← Flow {codeFlowDepth > 1 ? `(${codeFlowDepth})` : ''}
                  </button>
                )}

                {/* Diagram type picker */}
                <div style={{ position: 'relative' }} ref={typePickerRef}>
                  <button
                    onClick={() => setTypePickerOpen(o => !o)}
                    title="Choose diagram type"
                    style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 5,
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                      border: typePickerOpen ? '1px solid #7c3aed' : '1px solid #e0e0e8',
                      background: typePickerOpen ? '#f5f3ff' : '#fff',
                      color: typePickerOpen ? '#5b21b6' : '#666688',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                    }}
                  >
                    {(() => { const t = DIAGRAM_TYPES.find(d => d.id === preferredDiagramType); return t ? `${t.emoji} ${t.label}` : '⬡ Flow Chart'; })()}
                    <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
                  </button>

                  {typePickerOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', right: 0, marginTop: 4,
                      width: 280, background: '#fff',
                      border: '1px solid #e0e0e8', borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      zIndex: 200, overflow: 'hidden',
                    }}>
                      <div style={{ padding: '8px 12px 4px', borderBottom: '1px solid #f0f0f8' }}>
                        <span style={{ fontSize: 9, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif' }}>
                          Diagram type — the selected AI will use this for the next draw
                        </span>
                      </div>
                      {DIAGRAM_TYPES.map(type => (
                        <div
                          key={type.id}
                          onClick={() => {
                            setPreferredDiagramType(type.id);
                            setTypePickerOpen(false);
                            window.electronAPI.setPreferredDiagramType(type.id);
                            // Draw the template immediately on the canvas
                            const data: DiagramData = { pattern: type.label, diagrams: { structure: type.template }, descriptions: {} };
                            setDiagramAndRecord(data);
                            setActiveKind('structure');
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '7px 12px', cursor: 'pointer',
                            background: preferredDiagramType === type.id ? '#f5f3ff' : 'transparent',
                            borderLeft: `3px solid ${preferredDiagramType === type.id ? '#7c3aed' : 'transparent'}`,
                          }}
                        >
                          <span style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{type.emoji}</span>
                          <div>
                            <div style={{ fontSize: 12, color: '#1f2937', fontWeight: preferredDiagramType === type.id ? 600 : 400, fontFamily: 'system-ui, sans-serif' }}>{type.label}</div>
                            <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'system-ui, sans-serif' }}>{type.description}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {isCodeAnalysisDiagram && DIAGRAM_TABS.map(({ kind, label }) => {
                  const available = !!diagram?.diagrams?.[kind];
                  const active = activeKind === kind && !historyActive;
                  return (
                    <button
                      key={kind}
                      disabled={!available}
                      onClick={() => { handleHistoryClear(); setActiveKind(kind); setRenderError(null); }}
                      style={{
                        padding: '3px 10px', fontSize: 11, borderRadius: 5,
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        border: active ? '1px solid #7c3aed' : '1px solid #e0e0e8',
                        background: active ? '#f5f3ff' : '#ffffff',
                        color: active ? '#5b21b6' : available ? '#666688' : '#c8c8d4',
                        cursor: available ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
                <button
                  disabled={!folder}
                  onClick={handleHistoryTabClick}
                  style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 5,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    border: historyActive ? '1px solid #6d28d9' : '1px solid #e0e0e8',
                    background: historyActive ? '#ede9fe' : '#ffffff',
                    color: historyActive ? '#4c1d95' : folder ? '#666688' : '#c8c8d4',
                    cursor: folder ? 'pointer' : 'not-allowed',
                  }}
                >
                  History
                </button>
                <button
                  disabled={!folder}
                  onClick={() => void openChangeStoryPicker('pr')}
                  style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 5,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    border: '1px solid #0ea5e9', background: '#f0f9ff',
                    color: folder ? '#0369a1' : '#c8c8d4',
                    cursor: folder ? 'pointer' : 'not-allowed',
                  }}
                >
                  PR story
                </button>
                <button
                  disabled={!folder}
                  onClick={() => void openChangeStoryPicker('branch')}
                  style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 5,
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    border: '1px solid #0f766e', background: '#f0fdfa',
                    color: folder ? '#0f766e' : '#c8c8d4', cursor: folder ? 'pointer' : 'not-allowed',
                  }}
                >
                  Branch story
                </button>
                {prActive && (
                  <button
                    onClick={handlePRClear}
                    style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 5,
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                      border: '1px solid #dc2626', background: '#fef2f2', color: '#b91c1c', cursor: 'pointer',
                    }}
                  >
                    Close story ×
                  </button>
                )}
                {canvasHistory.length > 0 && (
                  <button
                    onClick={() => setCanvasHistoryOpen(o => !o)}
                    title={`Canvas history — ${canvasHistory.length} snapshots`}
                    style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 5,
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                      border: canvasHistoryOpen ? '1px solid #0369a1' : '1px solid #e0e0e8',
                      background: canvasHistoryOpen ? '#e0f2fe' : '#ffffff',
                      color: canvasHistoryOpen ? '#0369a1' : '#666688',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    ◷ {canvasHistory.length}
                    {canvasHistoryIndex !== null && (
                      <span style={{ background: '#0369a1', color: '#fff', borderRadius: 3, padding: '0 4px', fontSize: 9 }}>
                        {canvasHistoryIndex + 1}/{canvasHistory.length}
                      </span>
                    )}
                  </button>
                )}
              </div>
          </div>

          {renderError && (
            <div style={{
              padding: '4px 12px', fontSize: 10, color: '#b91c1c', background: '#fef2f2',
              borderBottom: '1px solid #fecaca', fontFamily: 'ui-monospace, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              Diagram render failed: {renderError}
            </div>
          )}

          {/* ── PR picker — floating dropdown ── */}
          {prPickerOpen && (
            <div style={{
              position: 'absolute', top: 38, right: 0,
              width: 600, maxHeight: 320, overflowY: 'auto',
              background: '#ffffff', border: '1px solid #bae6fd',
              borderRadius: '0 0 8px 8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              zIndex: 100,
            }}>
              <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #f0f9ff' }}>
                <span style={{ fontSize: 10, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif' }}>
                  {changeStoryMode === 'pr' ? 'Select a pull request to map' : 'Select a branch to map'}
                </span>
                <span onClick={() => { setPrPickerOpen(false); if (!activePR) setPrActive(false); }} style={{ fontSize: 11, color: '#aaa', cursor: 'pointer' }}>✕</span>
              </div>
              {prsLoading && <div style={{ padding: '10px 14px', fontSize: 11, color: '#888', fontFamily: 'system-ui, sans-serif' }}>Loading…</div>}
              {!prsLoading && prs.length === 0 && (
                <div style={{ padding: '10px 14px', fontSize: 11, color: '#aaa', fontFamily: 'system-ui, sans-serif' }}>
                  {changeStoryMode === 'pr' ? 'No open pull requests found.' : 'No local branches found.'}
                </div>
              )}
              {prs.map(pr => (
                <div
                  key={pr.number}
                  onClick={() => handlePRSelect(pr)}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8,
                    padding: '7px 14px', cursor: 'pointer',
                    background: activePR?.number === pr.number ? '#f0f9ff' : 'transparent',
                    borderLeft: `3px solid ${activePR?.number === pr.number ? '#0369a1' : 'transparent'}`,
                    borderBottom: '1px solid #f5f5f8',
                  }}
                >
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#0369a1', background: '#e0f2fe', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>
                    {pr.number > 0 ? `PR #${pr.number}` : 'Branch'}
                  </span>
                  <span style={{ fontSize: 11, color: '#222', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'system-ui, sans-serif' }}>
                    {pr.number > 0 ? pr.title : pr.branch}
                  </span>
                  {pr.author && <span style={{ fontSize: 10, color: '#999', flexShrink: 0, fontFamily: 'system-ui, sans-serif' }}>{pr.author}</span>}
                  <span style={{ fontSize: 10, color: '#16a34a', flexShrink: 0 }}>+{pr.additions}</span>
                  <span style={{ fontSize: 10, color: '#dc2626', flexShrink: 0 }}>-{pr.deletions}</span>
                  <span style={{ fontSize: 10, color: '#888', flexShrink: 0 }}>{pr.filesChanged} file{pr.filesChanged !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          )}

          {/* ── Commit list — floating dropdown over canvas ── */}
          {historyActive && (
            <div style={{
              position: 'absolute', top: 38, right: 0,
              width: 560, maxHeight: 280, overflowY: 'auto',
              background: '#ffffff', border: '1px solid #d4d4e8',
              borderRadius: '0 0 8px 8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              zIndex: 100, flexShrink: 0,
            }}>
              {commitsLoading && (
                <div style={{ padding: '10px 14px', fontSize: 11, color: '#888', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                  Loading commits…
                </div>
              )}
              {!commitsLoading && commits.length === 0 && (
                <div style={{ padding: '10px 14px', fontSize: 11, color: '#aaa', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                  No commits found (not a git repo or no history)
                </div>
              )}
              {commits.map(c => {
                const isSelected = selectedCommitHash === c.hash;
                return (
                  <div
                    key={c.hash}
                    onClick={() => handleCommitSelect(c.hash)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 8,
                      padding: '6px 14px', cursor: 'pointer',
                      background: isSelected ? '#f5f3ff' : 'transparent',
                      borderLeft: `3px solid ${isSelected ? '#6d28d9' : 'transparent'}`,
                      borderBottom: '1px solid #f5f5f8',
                    }}
                  >
                    <span style={{
                      fontFamily: 'ui-monospace, monospace', fontSize: 10,
                      color: '#6d28d9', background: '#ede9fe',
                      padding: '1px 5px', borderRadius: 3, flexShrink: 0,
                    }}>
                      {c.short}
                    </span>
                    <span style={{
                      fontSize: 11, color: '#333', flex: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                    }}>
                      {c.message}
                    </span>
                    <span style={{ fontSize: 10, color: '#999', flexShrink: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>{c.author}</span>
                    <span style={{ fontSize: 10, color: '#bbb', flexShrink: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>{c.date}</span>
                    {commitDiffLoading && isSelected && (
                      <span style={{ fontSize: 10, color: '#6d28d9', flexShrink: 0 }}>…</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>

            {/* ── Canvas node action bar ── */}
            {selectedComponent && (
              <div style={{
                position: 'absolute', bottom: 16, left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'center', gap: 6,
                background: '#1e1e3a', border: '1px solid #3a3a6a',
                borderRadius: 10, padding: '6px 10px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
                zIndex: 50, animation: 'slideUpIn 0.15s ease',
                fontFamily: 'system-ui, -apple-system, sans-serif',
              }}>
                <span style={{ fontSize: 11, color: '#9999cc', marginRight: 2, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedComponents.length > 1 ? `${selectedComponents.length} selected` : selectedComponent}
                </span>
                <div style={{ width: 1, height: 16, background: '#3a3a6a' }} />
                <button
                  onClick={handleDrill}
                  disabled={drilling}
                  title="Drill into this component's user flow"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', background: drilling ? '#0f3a5a' : '#0f4c75',
                    border: '1px solid #1a73b5', borderRadius: 6,
                    color: '#bae6fd', fontSize: 11, cursor: drilling ? 'not-allowed' : 'pointer',
                  }}
                >
                  <DrillIcon /> {drilling ? 'Drilling…' : 'Drill'}
                </button>
                <button
                  onClick={handleCodeFlow}
                  disabled={codeFlowLoading}
                  title="Explain how this component works"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', background: storyLoading ? '#0f2a0f' : '#1a3a1a',
                    border: '1px solid #16a34a', borderRadius: 6,
                    color: '#86efac', fontSize: 11, cursor: codeFlowLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  <FlowIcon /> {storyLoading ? 'Explaining…' : 'Story'}
                </button>
                <button
                  onClick={handleActualCodeFlow}
                  disabled={codeFlowLoading}
                  title="Open the source code that represents this component"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', background: codeFlowLoading ? '#172554' : '#1e3a8a',
                    border: '1px solid #3b82f6', borderRadius: 6,
                    color: '#bfdbfe', fontSize: 11, cursor: codeFlowLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  <FlowIcon /> View code
                </button>
                <button
                  onClick={handleImplementation}
                  disabled={codeFlowLoading}
                  title="Show a clear guide to how this is built"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
                    background: implLoading ? '#2a1d0b' : '#3b2a14', border: '1px solid #d97706', borderRadius: 6,
                    color: '#fcd34d', fontSize: 11, cursor: codeFlowLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  <FlowIcon /> {implLoading ? 'Explaining…' : 'How it is built'}
                </button>
                <button
                  onClick={() => handleCanvasCommand(`Implement or improve the ${selectedComponent} component`)}
                  disabled={busy}
                  title="Ask Claude to implement or improve this component"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', background: '#3b1d8a',
                    border: '1px solid #7c3aed', borderRadius: 6,
                    color: '#ede9fe', fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.45 : 1,
                  }}
                >
                  <SparkleIcon /> Implement
                </button>
                <button
                  onClick={() => setSelectionQuestionOpen(true)}
                  disabled={busy}
                  title="Ask a question about the selected component or components"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', background: '#1a1a2e',
                    border: '1px solid #4a4a8a', borderRadius: 6,
                    color: '#cdd6f4', fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.45 : 1,
                  }}
                >
                  Ask
                </button>
              </div>
            )}
            {selectionQuestionOpen && (
              <div style={{
                position: 'absolute', bottom: 68, left: '50%', transform: 'translateX(-50%)',
                width: 460, display: 'flex', gap: 8, alignItems: 'center',
                background: '#ffffff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '8px',
                boxShadow: '0 8px 28px rgba(0,0,0,0.22)', zIndex: 51,
              }}>
                <input
                  autoFocus
                  value={selectionQuestion}
                  onChange={(e) => setSelectionQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void askAboutSelection(); if (e.key === 'Escape') setSelectionQuestionOpen(false); }}
                  placeholder={selectedComponents.length === 0
                    ? 'Ask about this project…'
                    : `Ask about ${selectedComponents.length === 1 ? selectedComponents[0] : `${selectedComponents.length} selected components`}…`}
                  style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12, fontFamily: 'system-ui, sans-serif', color: '#1e293b' }}
                />
                <button
                  onClick={() => void askAboutSelection()}
                  disabled={selectionAnswering || !selectionQuestion.trim()}
                  style={{ border: 'none', borderRadius: 6, padding: '5px 10px', background: '#4f46e5', color: '#fff', fontSize: 11, cursor: 'pointer' }}
                >
                  {selectionAnswering ? 'Drawing…' : 'Draw'}
                </button>
              </div>
            )}
            <Canvas
              diagramData={diagram}
              activeKind={activeKind}
              onAPIReady={(api) => { excalidrawAPIRef.current = api; }}
              onRenderError={setRenderError}
              onDrilldownChange={(active) => { setDrilldownActive(active); if (!active) setDrillDepth(0); }}
              onCodeFlowChange={(active) => { setCodeFlowActive(active); if (!active) setCodeFlowDepth(0); }}
              onSelectionChange={handleSelectionChange}
              clearDrilldownRef={clearDrilldownRef}
              clearCodeFlowRef={clearCodeFlowRef}
              clearAllCodeFlowsRef={clearAllCodeFlowsRef}
              renderDrilldownRef={renderDrilldownRef}
              renderCodeFlowRef={renderCodeFlowRef}
              canvasContextRef={canvasContextRef}
              rawElementsRef={rawElementsRef}
              renderCommitDiffRef={renderCommitDiffRef}
              clearCommitDiffRef={clearCommitDiffRef}
              addNoteRef={addNoteRef}
              selectionAnswerRef={selectionAnswerRef}
            />
            </div>

            {sourcePanelOpen && (
              <aside style={{
                width: '38%', minWidth: 360, maxWidth: 720, flexShrink: 0,
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                background: '#101217', borderLeft: '1px solid #303642',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                  background: '#171a21', borderBottom: '1px solid #303642', flexShrink: 0,
                }}>
                  <span style={{ color: '#93c5fd', fontSize: 11, fontFamily: 'system-ui, sans-serif', fontWeight: 700 }}>SOURCE</span>
                  <span style={{ color: '#9ca3af', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {selectedComponent ? `Code for ${selectedComponent}` : 'Select a component'}
                  </span>
                  <button onClick={() => setSourcePanelOpen(false)} title="Close source browser" style={{ background: 'none', border: 0, color: '#9ca3af', cursor: 'pointer', fontSize: 16 }}>×</button>
                </div>
                {!!sourceView?.files?.length && (
                  <div style={{ display: 'flex', gap: 3, overflowX: 'auto', padding: '6px 8px', borderBottom: '1px solid #303642', flexShrink: 0 }}>
                    {sourceView.files.map((file, index) => (
                      <button key={file.path} onClick={() => setSourceFileIndex(index)} title={file.path} style={{
                        padding: '4px 7px', borderRadius: 4, border: '1px solid #334155', whiteSpace: 'nowrap',
                        background: index === sourceFileIndex ? '#1e3a5f' : '#171a21', color: index === sourceFileIndex ? '#dbeafe' : '#94a3b8',
                        fontSize: 10, fontFamily: 'ui-monospace, monospace', cursor: 'pointer',
                      }}>{file.path.split('/').pop()}</button>
                    ))}
                  </div>
                )}
                {sourceView?.graphify && (
                  <div style={{ padding: '6px 10px', borderBottom: '1px solid #303642', color: sourceView.graphify.available ? '#86efac' : '#fbbf24', fontSize: 10, fontFamily: 'system-ui, sans-serif', lineHeight: 1.35 }}>
                    {sourceView.graphify.available
                      ? `Graphify ${sourceView.graphify.confidence ?? 'graph'} match: ${sourceView.graphify.reasons?.[0] ?? 'selected source-proven evidence.'}`
                      : 'Graphify evidence unavailable — files were resolved by source-name matching.'}
                  </div>
                )}
                <div style={{ overflow: 'auto', flex: 1, padding: '10px 0', color: '#d1d5db', fontSize: 12, lineHeight: 1.55 }}>
                  {sourceView?.error ? (
                    <div style={{ padding: '12px', color: '#fca5a5', fontFamily: 'system-ui, sans-serif' }}>{sourceView.error}</div>
                  ) : !sourceView?.files?.[sourceFileIndex]?.content ? (
                    <div style={{ padding: '12px', color: '#9ca3af', fontFamily: 'system-ui, sans-serif' }}>Loading source…</div>
                  ) : sourceView.files[sourceFileIndex].content.split('\n').map((line, index) => {
                    const matches = !!sourceView.files?.[sourceFileIndex]?.highlight && line.toLowerCase().includes(sourceView.files[sourceFileIndex].highlight!.toLowerCase());
                    return (
                      <div key={index} style={{ display: 'flex', background: matches ? '#1e3a5f' : 'transparent', minWidth: 'max-content' }}>
                        <span style={{ width: 48, paddingRight: 12, textAlign: 'right', color: '#64748b', userSelect: 'none' }}>{index + 1}</span>
                        <code style={{ whiteSpace: 'pre', color: matches ? '#fef3c7' : '#d1d5db' }}>{line || ' '}</code>
                      </div>
                    );
                  })}
                </div>
              </aside>
            )}

            {/* ── Canvas history panel ── */}
            {canvasHistoryOpen && canvasHistory.length > 0 && (
              <div style={{
                width: 220, flexShrink: 0, borderLeft: '1px solid #bae6fd',
                display: 'flex', flexDirection: 'column',
                background: '#f0f9ff', overflowY: 'auto',
                animation: 'slideIn 0.15s ease',
              }}>
                <div style={{
                  padding: '8px 12px', borderBottom: '1px solid #bae6fd',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#e0f2fe', flexShrink: 0,
                }}>
                  <span style={{ fontSize: 10, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif', fontWeight: 600 }}>
                    Canvas History
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {canvasHistoryIndex !== null && (
                      <span
                        onClick={() => { setCanvasHistoryIndex(null); setDiagram(canvasHistory[canvasHistory.length - 1].diagram); }}
                        style={{ fontSize: 10, color: '#0369a1', cursor: 'pointer', fontFamily: 'system-ui, sans-serif' }}
                        title="Back to live"
                      >↩ Live</span>
                    )}
                    <span onClick={() => setCanvasHistoryOpen(false)} style={{ fontSize: 11, color: '#aaa', cursor: 'pointer' }}>✕</span>
                  </div>
                </div>
                {[...canvasHistory].reverse().map((entry, i) => {
                  const realIndex = canvasHistory.length - 1 - i;
                  const isActive = canvasHistoryIndex === realIndex;
                  const isLive = canvasHistoryIndex === null && realIndex === canvasHistory.length - 1;
                  const age = Date.now() - entry.timestamp;
                  const timeLabel = age < 60000
                    ? `${Math.round(age / 1000)}s ago`
                    : age < 3600000
                      ? `${Math.round(age / 60000)}m ago`
                      : `${Math.round(age / 3600000)}h ago`;
                  return (
                    <div
                      key={entry.index}
                      onClick={() => {
                        setCanvasHistoryIndex(realIndex);
                        setDiagram(entry.diagram);
                        setActiveKind('structure');
                        setRenderError(null);
                      }}
                      style={{
                        padding: '8px 12px', borderBottom: '1px solid #e0f2fe',
                        cursor: 'pointer', background: isActive || isLive ? '#dbeafe' : 'transparent',
                        borderLeft: `3px solid ${isActive || isLive ? '#0369a1' : 'transparent'}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: '#0369a1', fontFamily: 'ui-monospace, monospace' }}>
                          #{realIndex + 1}
                          {isLive && <span style={{ marginLeft: 4, background: '#16a34a', color: '#fff', borderRadius: 3, padding: '0 4px', fontSize: 8 }}>LIVE</span>}
                        </span>
                        <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'system-ui, sans-serif' }}>{timeLabel}</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#1e3a5f', fontFamily: 'system-ui, sans-serif', fontWeight: isActive || isLive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.diagram.pattern || 'Canvas'}
                      </div>
                      <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'ui-monospace, monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {entry.diagram.diagrams?.structure?.split('\n')[1]?.trim().slice(0, 40) || ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Ambient Change Context panel ── */}
            {changeContextOpen && changeContext && changeContext.length > 0 && (              <div style={{
                width: 280, flexShrink: 0, borderLeft: '1px solid #e8e8f0',
                display: 'flex', flexDirection: 'column',
                background: '#fafafa', overflowY: 'auto',
                animation: 'slideIn 0.2s ease',
              }}>
                <div style={{
                  padding: '8px 12px', borderBottom: '1px solid #e8e8f0',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#fff', flexShrink: 0,
                }}>
                  <span style={{ fontSize: 10, color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif', fontWeight: 600 }}>
                    What just changed
                  </span>
                  <span onClick={() => setChangeContextOpen(false)} style={{ fontSize: 11, color: '#aaa', cursor: 'pointer' }}>✕</span>
                </div>

                {changeContext.map((node, i) => (
                  <div key={i} style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f5', background: '#fff', marginBottom: 4 }}>
                    {/* Node name */}
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#1e1b4b', fontFamily: 'system-ui, sans-serif', marginBottom: 4 }}>
                      {node.node}
                    </div>
                    {/* What it does now */}
                    <div style={{ fontSize: 11, color: '#374151', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5, marginBottom: 8 }}>
                      {node.whatNow}
                    </div>

                    {/* Data flow strip */}
                    <div style={{ background: '#f5f3ff', borderRadius: 6, padding: '6px 8px', marginBottom: 8 }}>
                      <div style={{ fontSize: 9, color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif', marginBottom: 4 }}>Data flow</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, background: '#ede9fe', color: '#5b21b6', padding: '2px 6px', borderRadius: 4, fontFamily: 'ui-monospace, monospace' }}>
                          {node.dataIn || '–'}
                        </span>
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>→</span>
                        <span style={{ fontSize: 10, color: '#4b5563', fontFamily: 'system-ui, sans-serif', flex: 1 }}>
                          {node.transform}
                        </span>
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>→</span>
                        <span style={{ fontSize: 10, background: '#ede9fe', color: '#5b21b6', padding: '2px 6px', borderRadius: 4, fontFamily: 'ui-monospace, monospace' }}>
                          {node.dataOut || '–'}
                        </span>
                      </div>
                    </div>

                    {/* Neighbours */}
                    {node.neighbours && node.neighbours.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif', marginBottom: 3 }}>
                          Connected to
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {node.neighbours.map((n, j) => (
                            <span key={j} style={{ fontSize: 10, background: '#f3f4f6', color: '#374151', padding: '2px 7px', borderRadius: 10, fontFamily: 'system-ui, sans-serif', border: '1px solid #e5e7eb' }}>
                              {n}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── Change story sidebar ── */}
            {prActive && prResult && (
              <div style={{
                width: 300, flexShrink: 0, borderLeft: '1px solid #e0e7ef',
                display: 'flex', flexDirection: 'column',
                background: '#f8fafc', overflowY: 'auto',
              }}>
                {/* Sidebar header */}
                <div style={{
                  padding: '8px 12px', borderBottom: '1px solid #e2e8f0',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#fff', flexShrink: 0,
                }}>
                  <span style={{ fontSize: 10, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'system-ui, sans-serif', fontWeight: 600 }}>
                    Change story
                  </span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {activePR && (
                      <span
                        onClick={() => setPrPickerOpen(p => !p)}
                        style={{ fontSize: 10, color: '#0369a1', cursor: 'pointer', fontFamily: 'system-ui, sans-serif' }}
                        title="Choose another change"
                      >↔ Change</span>
                    )}
                    <span onClick={handlePRClear} style={{ fontSize: 11, color: '#aaa', cursor: 'pointer', lineHeight: 1 }}>✕</span>
                  </div>
                </div>

                {activePR && prResult?.ok && (
                  <div style={{ display: 'flex', gap: 6, padding: '7px 12px', background: '#fff', borderBottom: '1px solid #e2e8f0' }}>
                    {([
                      { id: 'feature' as const, label: 'Feature view', available: !!prResult.featureFlow?.mermaid },
                      { id: 'code' as const, label: 'Code story', available: !!prResult.codeFlow?.mermaid },
                    ]).map(view => (
                      <button
                        key={view.id}
                        disabled={!view.available}
                        onClick={() => showPRView(view.id, prResult, activePR)}
                        style={{
                          flex: 1, padding: '4px 6px', borderRadius: 4, fontSize: 10,
                          fontFamily: 'system-ui, sans-serif',
                          border: prView === view.id ? '1px solid #0369a1' : '1px solid #dbeafe',
                          background: prView === view.id ? '#e0f2fe' : '#fff',
                          color: prView === view.id ? '#0369a1' : view.available ? '#475569' : '#cbd5e1',
                          cursor: view.available ? 'pointer' : 'not-allowed',
                        }}
                      >
                        {view.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* PR meta strip */}
                {activePR && (
                  <div style={{ padding: '6px 12px', background: '#e0f2fe', borderBottom: '1px solid #bae6fd', flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600, fontFamily: 'system-ui, sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {activePR.number > 0 ? `#${activePR.number} · ` : ''}{activePR.title}
                    </div>
                    <div style={{ fontSize: 10, color: '#0284c7', fontFamily: 'system-ui, sans-serif', marginTop: 2 }}>
                      {activePR.filesChanged} files · <span style={{ color: '#16a34a' }}>+{activePR.additions}</span> / <span style={{ color: '#dc2626' }}>-{activePR.deletions}</span>
                      {activePR.author ? ` · ${activePR.author}` : ''}
                    </div>
                  </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {!prResult.ok && (
                    <div style={{ padding: '12px', fontSize: 11, color: '#dc2626', fontFamily: 'system-ui, sans-serif' }}>
                      Could not create the change story: {prResult.error}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Loading overlay while creating a change story */}
            {prReviewing && (
              <div style={{
                position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.7)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 50,
              }}>
                <div style={{ textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
                  <div style={{ fontSize: 13, color: '#0369a1', fontWeight: 600 }}>Creating change story…</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{activePR?.title}</div>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function DrillIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  );
}

function PRIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
