import { app, BrowserWindow, ipcMain, dialog } from 'electron/main';
import { shell } from 'electron/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { createPty, writeToPty, resizePty, killPty, restartPty, runCapture as runProviderCapture, runCaptureIsolated, setPtyDataCallback, getPtyCwd, getAiProvider, setAiProvider, AI_PROVIDERS, AiProvider } from './ptyManager';
import { startFileWatcher, stopFileWatcher } from './fileWatcher';
import { extractStructure, toClaudePromptJSON, ExtractedStructure, CodeNode } from './codeExtractor';
import { buildGraphifyIndex, graphifyPromptContext, graphifySourceFiles } from './graphifyContext';
import { startMcpServer, stopMcpServer, recordPtyOutput, updateClaudeJsonMcpConfig } from './mcpServer';
import { listPRs, listLocalBranches, reviewPR, PRInfo } from './prReviewer';
import { AccountService, PlanId } from './accountService';
import { getRepositoryAccess, RepositoryAccess } from './repositoryAccess';
import { deleteAnalysisFromSupabase, loadAnalysisFromSupabase, syncAnalysisToSupabase } from './supabaseSync';

let mainWindow: BrowserWindow | null = null;
let currentFolder: string | null = null;
let currentDiagram: object | null = null;
let currentNodePaths: Record<string, string> = {};
let patchInProgress = false;
let preferredDiagramType = 'flowchart'; // updated by renderer type picker
let analysisDepth: 1 | 2 | 3 = 2; // overview, balanced, deep — set by the user
let accountService: AccountService | null = null;
let currentRepositoryAccess: RepositoryAccess | null = null;
// Electron's did-finish-load fires before React is guaranteed to have attached
// its IPC listeners.  Delay restoration of a cached canvas until the renderer
// explicitly reports that those listeners are ready.
let rendererReadyPromise: Promise<void> | null = null;
let resolveRendererReady: (() => void) | null = null;

function resetRendererReady() {
  rendererReadyPromise = new Promise(resolve => { resolveRendererReady = resolve; });
}

function waitForRendererReady() {
  if (!rendererReadyPromise) resetRendererReady();
  return rendererReadyPromise!;
}
// A background preparation belongs to one analysis snapshot. Incrementing this
// stops any remaining work when the user analyses again or opens another repo.
let componentWarmupGeneration = 0;

function diagramReadabilityGuidance(): string {
  return 'DIAGRAM READABILITY — ADAPTIVE, EVIDENCE-DRIVEN DETAIL: Choose the number of visible nodes from the source-proven story; there is no fixed node limit. First tell one clear primary path, then add a node only when it materially improves understanding of control, data, or outcome. A visible node earns its place when it is an entry point, coordinator/orchestrator, state read or write with a consequence, HTTP/DB/gRPC/IPC/external boundary, meaningful auth/validation/decision/error branch, cross-component handoff, or final outcome. Prioritise nodes that are central to the proven execution path or a selected focus area. Fold trivial helpers, framework plumbing, repeated transforms, getters/setters, logging, and closely coupled local mechanics into the nearest meaningful card. When a story is complex, keep distinct consequential paths visible but group closely related steps under a clear hub rather than flattening every mechanic into the canvas. Keep HTTP/DB/gRPC/auth/error boundaries visible when source-proven, but use one compact contract card per logical boundary rather than separate request plumbing, client wrappers, and response plumbing. Put payload shapes, return values, and implementation detail in descriptions and labelled arrows rather than extra nodes. Every visible node must be source-proven, connected to the story, and concise.';
}

function analysisDepthGuidance(): string {
  if (analysisDepth === 1) return 'DEPTH: Overview. Show the smallest complete source-proven primary story: its entry, consequential boundaries or decisions, and outcomes. Fold supporting mechanics into descriptions.';
  if (analysisDepth === 3) return 'DEPTH: Deep. Show all source-proven paths, alternatives, errors, and boundary contracts that materially change understanding. Group related mechanics instead of omitting consequential steps.';
  return 'DEPTH: Balanced. Show the primary path plus the source-proven choices, communications, and boundaries needed to understand the outcome. Group low-level mechanics into their nearest meaningful step.';
}

// All main-process AI actions inherit the user's selected detail level,
// including focused questions and change/commit explanations.
function runCapture(prompt: string, cwd: string): Promise<string> {
  return runProviderCapture(`${prompt}\n\n${analysisDepthGuidance()}`, cwd);
}

function runIsolatedCapture(prompt: string, cwd: string): Promise<string> {
  return runCaptureIsolated(`${prompt}\n\n${analysisDepthGuidance()}`, cwd);
}

function aiProviderSettingsFile() { return path.join(app.getPath('userData'), 'ai-provider.json'); }

function loadAiProvider(): AiProvider {
  try {
    const { provider } = JSON.parse(fs.readFileSync(aiProviderSettingsFile(), 'utf8')) as { provider?: string };
    return setAiProvider(provider ?? 'claude');
  } catch { return getAiProvider(); }
}

function saveAiProvider(provider: string): AiProvider {
  const selected = setAiProvider(provider);
  try { fs.writeFileSync(aiProviderSettingsFile(), JSON.stringify({ provider: selected }), 'utf8'); } catch {}
  return selected;
}

function providerLabel() {
  return AI_PROVIDERS.find(p => p.id === getAiProvider())?.label ?? 'AI';
}

// ── Diagram cache ─────────────────────────────────────────────────────────────
// The cache belongs to Rex Canvas, never to the opened project. A local SQLite
// database in Electron's user-data directory keeps one record per project path.

interface CodeFlowStep { fn: string; what: string; data: string }
interface DataFlowSnapshot { input: string; output: string; change: string }

interface CommitDiagram {
  featureFlow: { mermaid: string; descriptions?: Record<string, string> };
  codeFlow:    { mermaid: string; happyPath?: string[] };
}

interface SessionPanel { name: string; mode: 'story' | 'implementation' | 'actual' | 'drill' }

interface WalkthroughSettings {
  entryPoints: boolean; callChain: boolean; asyncPatterns: boolean; branchingLogic: boolean;
  dataFlow: boolean; dataTypes: boolean; stateManagement: boolean;
  dbInteractions: boolean; dbSchema: boolean;
  restCalls: boolean; grpcCalls: boolean; graphqlOps: boolean; externalIntegrations: boolean;
  authChecks: boolean; permissions: boolean;
  inputValidation: boolean; sensitiveData: boolean;
  errorHandling: boolean; fallbacks: boolean;
  caching: boolean; concurrency: boolean;
  logging: boolean; events: boolean; testCoverage: boolean;
  designPatterns: boolean; businessLogic: boolean; frameworkUnderstanding: boolean;
}

const DEFAULT_WALKTHROUGH_SETTINGS: WalkthroughSettings = {
  entryPoints: false, callChain: false, asyncPatterns: false, branchingLogic: false,
  dataFlow: false, dataTypes: false, stateManagement: false,
  dbInteractions: false, dbSchema: false,
  restCalls: false, grpcCalls: false, graphqlOps: false, externalIntegrations: false,
  authChecks: false, permissions: false,
  inputValidation: false, sensitiveData: false,
  errorHandling: false, fallbacks: false,
  caching: false, concurrency: false,
  logging: false, events: false, testCoverage: false,
  designPatterns: false, businessLogic: false, frameworkUnderstanding: false,
};

const WALKTHROUGH_SETTING_KEYS = Object.keys(DEFAULT_WALKTHROUGH_SETTINGS) as Array<keyof WalkthroughSettings>;

/** Only accept the known boolean settings from disk or the renderer. */
function normalizeWalkthroughSettings(settings: Partial<WalkthroughSettings> | null | undefined): WalkthroughSettings {
  return WALKTHROUGH_SETTING_KEYS.reduce((result, key) => {
    result[key] = settings?.[key] === true;
    return result;
  }, { ...DEFAULT_WALKTHROUGH_SETTINGS });
}

/** Stable, versioned cache identity for the settings that shape a walkthrough. */
function walkthroughSettingsFingerprint(settings: WalkthroughSettings): string {
  const values = WALKTHROUGH_SETTING_KEYS.map(key => `${key}:${settings[key] ? '1' : '0'}`).join('|');
  return crypto.createHash('sha256').update(`walkthrough-focus-v1|${values}`).digest('hex').slice(0, 12);
}

let walkthroughSettings: WalkthroughSettings = { ...DEFAULT_WALKTHROUGH_SETTINGS };

function walkthroughSettingsFile() { return path.join(app.getPath('userData'), 'walkthrough-settings.json'); }

function loadWalkthroughSettings(): WalkthroughSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(walkthroughSettingsFile(), 'utf8')) as Partial<WalkthroughSettings>;
    return normalizeWalkthroughSettings(raw);
  } catch { return { ...DEFAULT_WALKTHROUGH_SETTINGS }; }
}

function saveWalkthroughSettings(settings: WalkthroughSettings): WalkthroughSettings {
  walkthroughSettings = normalizeWalkthroughSettings(settings);
  try { fs.writeFileSync(walkthroughSettingsFile(), JSON.stringify(walkthroughSettings, null, 2), 'utf8'); } catch {}
  return walkthroughSettings;
}

type WarmupStage = 'detail' | 'drill' | 'story' | 'walkthrough';
type ProjectWarmupStage = 'codeStory' | 'architecture' | 'walkthrough';

interface ComponentWarmupState {
  detail?: boolean;
  drill?: boolean;
  story?: boolean;
  walkthrough?: boolean;
  updatedAt: number;
}

interface ProjectWarmupState {
  codeStory?: boolean;
  architecture?: boolean;
  walkthrough?: boolean;
  updatedAt: number;
}

/** Persisted so a quit/relaunch resumes unfinished component preparation. */
interface ComponentWarmupQueue {
  version: 2;
  analysisHash: string;
  project: ProjectWarmupState;
  components: Record<string, ComponentWarmupState>;
  completed?: boolean;
  updatedAt: number;
}

interface CacheFile {
  structureHash: string;
  provider?: AiProvider;
  diagram: object;
  analysisDiagrams?: Record<string, { diagram: object; savedAt: number }>;
  drilldowns: Record<string, string>;
  codeflows: Record<string, string>;
  commitDiagrams?: Record<string, CommitDiagram>;
  lastSession?: SessionPanel[];
  warmup?: ComponentWarmupQueue;
  /** Options that shaped the cached result, so cache-only viewers can explain it. */
  analysisOptions?: { depth: 1 | 2 | 3; walkthroughSettings: WalkthroughSettings; savedAt: number };
  savedAt: number;
}

interface ArchitectureDocument {
  executiveSummary?: string;
  technologyStack?: string[];
  sections?: Array<{ title: string; content: string; evidence?: string[] }> ;
  unresolved?: string[];
}

interface ArchitectureStoryResult {
  ok?: boolean;
  error?: string;
  mermaid?: string;
  descriptions?: Record<string, string>;
  diagrams?: Record<string, string>;
  document?: ArchitectureDocument;
}

interface CacheDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...parameters: unknown[]): unknown; run(...parameters: unknown[]): unknown };
}

type CacheDatabaseConstructor = new (filename: string) => CacheDatabase;

interface CacheDatabaseRow { cache_json?: string | null; canvas_json?: string | null }

let cacheDatabaseInstance: CacheDatabase | null = null;

function cacheDatabase(): CacheDatabase {
  if (cacheDatabaseInstance) return cacheDatabaseInstance;
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: CacheDatabaseConstructor };
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'rex-canvas-cache.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS project_cache (
      project_path TEXT PRIMARY KEY,
      cache_json TEXT,
      canvas_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  cacheDatabaseInstance = db;
  return db;
}

function cacheProjectPath(folder: string): string {
  return path.resolve(folder);
}

/** Location used by releases before the cache moved into SQLite. */
function legacyCacheFile(folder: string): string {
  const key = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'diagram-cache', `${key}.json`);
}

function hashStructure(structureJson: string): string {
  return crypto.createHash('sha256').update(structureJson).digest('hex').slice(0, 32);
}

function mainAnalysisCacheKey(structureHash: string): string {
  return getAiProvider() + ':' + structureHash;
}

function cachedAnalysis(cache: CacheFile | null, structureHash: string): object | null {
  if (!cache) return null;
  const keyed = cache.analysisDiagrams?.[mainAnalysisCacheKey(structureHash)]?.diagram;
  if (keyed) return keyed;
  // Backward compatibility for caches written before variants were retained.
  return cache.structureHash === structureHash && cache.diagram && (cache.provider ?? 'claude') === getAiProvider()
    ? cache.diagram
    : null;
}

/**
 * Graphify is optional local evidence. Its graph enriches every prompt when an
 * existing graphify-out/graph.json is present, while the native extractor stays
 * the zero-setup fallback.
 */
function groundedStructureJson(folder: string, structure: ExtractedStructure, focus?: string): { json: string; graphify: ReturnType<typeof graphifyPromptContext> } {
  const graphify = graphifyPromptContext(folder, focus);
  return {
    graphify,
    json: graphify.available
      ? `${toClaudePromptJSON(structure)}\n\n${graphify.evidence}`
      : toClaudePromptJSON(structure),
  };
}

/**
 * After Graphify has indexed a project, avoid immediately parsing the entire
 * repository again. This lightweight structure is built from graph-selected
 * source paths; source excerpts are then read only for those evidence paths.
 */
function structureFromGraphify(folder: string): ExtractedStructure | null {
  const graphify = graphifyPromptContext(folder);
  const files = graphify.resolution?.sourceFiles ?? [];
  if (!graphify.available || files.length === 0) return null;
  const root: CodeNode = { name: path.basename(folder), type: 'folder', path: folder, imports: [], children: [] };
  const nodePaths: Record<string, string> = {};
  const languages = new Set<string>();
  files.forEach((relPath, index) => {
    const absolute = path.resolve(folder, relPath);
    if (!absolute.startsWith(path.resolve(folder) + path.sep)) return;
    const base = path.basename(relPath);
    const key = nodePaths[base] ? `${base} #${index + 1}` : base;
    nodePaths[key] = absolute;
    const ext = path.extname(relPath).slice(1); if (ext) languages.add(ext);
    root.children.push({ name: base, type: 'file', path: absolute, imports: [], children: [] });
  });
  return { root, totalFiles: Object.keys(nodePaths).length, languages: [...languages], nodePaths, relationships: [] };
}

/** Keep every analysis entry point on the same cache-key format. */
function analysisCacheHash(structure: ExtractedStructure, folder: string): { structureJson: string; hash: string; graphify: ReturnType<typeof graphifyPromptContext> } {
  const grounded = groundedStructureJson(folder, structure);
  return {
    structureJson: grounded.json,
    graphify: grounded.graphify,
    hash: hashStructure(
      ANALYSIS_SCHEMA_VERSION
      + ':depth-' + analysisDepth
      + ':' + grounded.json
      + ':graphify-' + grounded.graphify.fingerprint,
    ),
  };
}

function cacheRow(folder: string): CacheDatabaseRow | null {
  return cacheDatabase()
    .prepare('SELECT cache_json, canvas_json FROM project_cache WHERE project_path = ?')
    .get(cacheProjectPath(folder)) as CacheDatabaseRow | null;
}

const cacheSyncQueue = new Map<string, Promise<void>>();

/** Serialize remote writes per project so newer drilldowns cannot be overwritten
 * by an older analysis request that happens to finish later. */
function queueCachedAnalysisSync(folder: string, cache: CacheFile) {
  const snapshot = JSON.parse(JSON.stringify(cache)) as CacheFile;
  const previous = cacheSyncQueue.get(folder) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const account = accountService?.getState().user ?? null;
    await syncAnalysisToSupabase({
      folder,
      structureHash: snapshot.structureHash,
      cache: snapshot,
      analysis: snapshot.diagram,
      description: String((snapshot.diagram as { pattern?: unknown }).pattern ?? 'Repository analysis'),
      provider: snapshot.provider ?? getAiProvider(),
      visibility: currentRepositoryAccess?.kind ?? 'private',
      remoteUrl: currentRepositoryAccess?.remoteUrl,
      publishedBy: account,
    });
  });
  cacheSyncQueue.set(folder, next);
  void next.catch(error => console.warn('[supabase] cache sync failed:', error instanceof Error ? error.message : String(error)));
}

function writeCache(folder: string, cache: CacheFile, syncRemote = true) {
  cacheDatabase().prepare(`
    INSERT INTO project_cache (project_path, cache_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET cache_json = excluded.cache_json, updated_at = excluded.updated_at
  `).run(cacheProjectPath(folder), JSON.stringify(cache), cache.savedAt);
  if (syncRemote) queueCachedAnalysisSync(folder, cache);
}

function cacheAnalysisOptions() {
  return {
    depth: analysisDepth,
    walkthroughSettings: { ...walkthroughSettings },
    savedAt: Date.now(),
  };
}

function saveCanvasDiagram(folder: string, diagram: object) {
  cacheDatabase().prepare(`
    INSERT INTO project_cache (project_path, canvas_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET canvas_json = excluded.canvas_json, updated_at = excluded.updated_at
  `).run(cacheProjectPath(folder), JSON.stringify(diagram), Date.now());
}

function migrateLegacyCache(folder: string): CacheFile | null {
  try {
    const legacyPath = legacyCacheFile(folder);
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as CacheFile;
    writeCache(folder, legacy);
    saveCanvasDiagram(folder, legacy.diagram);
    fs.unlinkSync(legacyPath);
    return legacy;
  } catch { return null; }
}

function readCache(folder: string): CacheFile | null {
  const row = cacheRow(folder);
  if (row?.cache_json) return JSON.parse(row.cache_json) as CacheFile;
  return migrateLegacyCache(folder);
}

function cacheError(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const message = 'Cache ' + action + ' failed: ' + detail;
  console.error('[cache]', message);
  return new Error(message);
}

function loadCache(folder: string): CacheFile | null {
  try { return readCache(folder); }
  catch (error) { cacheError('read', error); return null; }
}

function loadCacheForAnalysis(folder: string): CacheFile | null {
  try { return readCache(folder); }
  catch (error) { throw cacheError('read', error); }
}

function loadCanvasDiagram(folder: string): object | null {
  try {
    let row = cacheRow(folder);
    if (!row) { migrateLegacyCache(folder); row = cacheRow(folder); }
    return row?.canvas_json ? JSON.parse(row.canvas_json) as object : null;
  } catch { return null; }
}

/**
 * Local cache wins. If it is absent, hydrate the exact published snapshot once
 * so opening a project on a second Mac is instant and never invokes AI.
 */
async function restoreProjectCache(folder: string, access: RepositoryAccess): Promise<{ cache: CacheFile | null; diagram: object | null }> {
  let cache = loadCache(folder);
  let diagram = loadCanvasDiagram(folder) ?? cache?.diagram ?? null;
  if (diagram) return { cache, diagram };

  try {
    const remote = await loadAnalysisFromSupabase({ folder, visibility: access.kind, remoteUrl: access.remoteUrl });
    if (!remote) return { cache: null, diagram: null };
    const remoteCache = remote.cache as Partial<CacheFile>;
    const remoteDiagram = remoteCache.diagram ?? remote.analysis;
    if (!remoteDiagram || typeof remoteDiagram !== 'object') return { cache: null, diagram: null };
    cache = {
      structureHash: String(remoteCache.structureHash ?? remote.structureHash),
      provider: remoteCache.provider,
      diagram: remoteDiagram,
      analysisDiagrams: remoteCache.analysisDiagrams,
      drilldowns: remoteCache.drilldowns ?? {},
      codeflows: remoteCache.codeflows ?? {},
      commitDiagrams: remoteCache.commitDiagrams ?? {},
      lastSession: remoteCache.lastSession ?? [],
      analysisOptions: remoteCache.analysisOptions,
      savedAt: typeof remoteCache.savedAt === 'number' ? remoteCache.savedAt : Date.now(),
    };
    // Avoid echoing the downloaded cache straight back to Supabase.
    writeCache(folder, cache, false);
    saveCanvasDiagram(folder, remoteDiagram);
    return { cache, diagram: remoteDiagram };
  } catch (error) {
    console.warn('[supabase] cache load failed:', error instanceof Error ? error.message : String(error));
    return { cache: null, diagram: null };
  }
}

function saveCache(folder: string, data: Partial<CacheFile> & { diagram: object; structureHash: string }): boolean {
  try {
    const existing = loadCache(folder);
    const now = Date.now();
    const variants = {
      ...(existing?.analysisDiagrams ?? {}),
      [mainAnalysisCacheKey(data.structureHash)]: { diagram: data.diagram, savedAt: now },
    };
    // Keep several variants (for example, native and Graphify analyses) without
    // letting a project cache grow indefinitely.
    const analysisDiagrams = Object.fromEntries(
      Object.entries(variants)
        .sort(([, a], [, b]) => b.savedAt - a.savedAt)
        .slice(0, 12),
    );
    const merged: CacheFile = {
      structureHash: data.structureHash,
      provider: getAiProvider(),
      diagram: data.diagram,
      analysisDiagrams,
      drilldowns: { ...(existing?.drilldowns ?? {}), ...(data.drilldowns ?? {}) },
      codeflows: { ...(existing?.codeflows ?? {}), ...(data.codeflows ?? {}) },
      commitDiagrams: { ...(existing?.commitDiagrams ?? {}), ...(data.commitDiagrams ?? {}) },
      // Component entries are fingerprinted from their source evidence. Retain
      // them across analyses: stale keys cannot be selected, while unchanged
      // components are immediately reusable.
      warmup: existing?.warmup?.analysisHash === data.structureHash ? existing.warmup : undefined,
      analysisOptions: cacheAnalysisOptions(),
      savedAt: now,
    };
    writeCache(folder, merged);
    saveCanvasDiagram(folder, merged.diagram);
    return true;
  } catch (error) {
    cacheError('write', error);
    return false;
  }
}

function saveDrilldown(folder: string, componentName: string, mermaid: string) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.drilldowns[componentName] = mermaid;
    existing.analysisOptions = cacheAnalysisOptions();
    existing.savedAt = Date.now();
    writeCache(folder, existing);
  } catch { /* ignore */ }
}

function saveCodeFlow(folder: string, componentName: string, mermaid: string) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.codeflows = existing.codeflows ?? {};
    existing.codeflows[componentName] = mermaid;
    existing.analysisOptions = cacheAnalysisOptions();
    existing.savedAt = Date.now();
    writeCache(folder, existing);
  } catch { /* ignore */ }
}

function saveSessionPanels(folder: string, panels: SessionPanel[]) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.lastSession = panels;
    existing.savedAt = Date.now();
    writeCache(folder, existing);
  } catch { /* ignore */ }
}

function clearProjectCache(folder: string): boolean {
  try {
    cacheDatabase().prepare('DELETE FROM project_cache WHERE project_path = ?').run(cacheProjectPath(folder));
    const legacyPath = legacyCacheFile(folder);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    void deleteAnalysisFromSupabase({
      folder, visibility: currentRepositoryAccess?.kind ?? 'private', remoteUrl: currentRepositoryAccess?.remoteUrl,
    }).catch(error => console.warn('[supabase] cache delete sync failed:', error instanceof Error ? error.message : String(error)));
    return true;
  } catch { return false; }
}

function saveCommitDiagram(folder: string, hash: string, diagram: CommitDiagram) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.commitDiagrams = existing.commitDiagrams ?? {};
    existing.commitDiagrams[hash] = diagram;
    existing.savedAt = Date.now();
    writeCache(folder, existing);
  } catch { /* ignore */ }
}

function persistDiagram(diagram: object) {
  currentDiagram = diagram;
  // Store the currently visible canvas independently of analysis results. This
  // lets terminal/MCP diagrams reopen for the same project without making them
  // look like a fresh source analysis.
  if (currentFolder) {
    try { saveCanvasDiagram(currentFolder, diagram); } catch { /* best-effort */ }
  }
}

// ── Last project persistence ──────────────────────────────────────────────────

function lastProjectFile() {
  return path.join(app.getPath('userData'), 'last-project.json');
}

function saveLastProject(folder: string) {
  try { fs.writeFileSync(lastProjectFile(), JSON.stringify({ folder }), 'utf8'); } catch {}
}

function loadLastProject(): string | null {
  try {
    const raw = fs.readFileSync(lastProjectFile(), 'utf8');
    const { folder } = JSON.parse(raw);
    return (folder && fs.existsSync(folder)) ? folder : null;
  } catch { return null; }
}

// ── Project root detection ────────────────────────────────────────────────────

function findProjectRoot(startDir: string): string {
  const markers = [
    'package.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
    'settings.gradle.kts', 'Cargo.toml', 'go.mod', 'pubspec.yaml',
    'pyproject.toml', 'setup.py', 'Podfile', 'Package.swift', 'pom.xml',
    'composer.json', 'Gemfile', 'requirements.txt', 'Pipfile', 'mix.exs',
    'CMakeLists.txt', 'Makefile', 'build.sbt',
  ];
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    for (const m of markers) {
      if (fs.existsSync(path.join(dir, m))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function buildRelationshipGraphMermaid(structure: ExtractedStructure): string {
  // Keep the graph legible on a canvas. Local project links answer "what uses
  // what?" first; package dependencies fill only the remaining space.
  const maxEdges = analysisDepth === 1 ? 15 : analysisDepth === 2 ? 30 : 60;
  const edges = [...structure.relationships]
    .sort((a, b) => Number(a.kind !== 'local-import') - Number(b.kind !== 'local-import'))
    .slice(0, maxEdges);
  const ids = new Map<string, string>();
  let next = 1;
  const idFor = (name: string) => {
    let id = ids.get(name);
    if (!id) { id = `N${next++}`; ids.set(name, id); }
    return id;
  };
  // Mermaid labels must remain conservative; paths are displayed as readable
  // words rather than raw punctuation-heavy module specifiers.
  const label = (value: string) => value.replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().slice(-44);
  const lines = ['flowchart LR'];
  for (const edge of edges) {
    const from = idFor(edge.from);
    const to = idFor(edge.to);
    lines.push(`  ${from}[${label(edge.from)}] -->|${edge.kind === 'local-import' ? 'imports' : 'uses'}| ${to}[${label(edge.to)}]`);
  }
  return lines.join('\n');
}

// ── Claude prompt ─────────────────────────────────────────────────────────────

// Analysis starts with the product experience. Technical detail is deliberately
// deferred to Code Story and Implementation, which are progressive disclosures.
const ANALYSIS_SCHEMA_VERSION = 'user-interaction-map-v14-adaptive-detail';

/** File and symbol names are insufficient to infer product behaviour. */
function buildAnalysisSourceContext(structure: ExtractedStructure): string {
  // Sort files by signal strength so the most important files fill the budget first.
  // The extractor already ranked and capped files, but nodePaths is unordered — re-sort here.
  const files = Object.entries(structure.nodePaths).sort(([, a], [, b]) => {
    const score = (filePath: string) => {
      const v = filePath.toLowerCase();
      const base = path.basename(v);
      if (/^(main|index|app|router|routes|server|application)\.[^/]+$/.test(base)) return 0;
      if (/(activity|fragment|screen|page|view|navigation|navigator|route|scene)/.test(v)) return 1;
      if (/(search|explore|article|readinglist|saved|history|settings|nearby|map|login|edit|auth|home|feed|detail|profile|dashboard|checkout|cart|payment|onboard)/.test(v)) return 2;
      if (/(api|service|repository|store|manager|controller|handler|endpoint)/.test(v)) return 3;
      if (/(model|entity|schema|dto|type|interface)/.test(v)) return 4;
      if (/(util|helper|test|spec|mock|fixture|config|setup|build|gradle|release|generate|upload)/.test(v)) return 6;
      return 5;
    };
    return score(a) - score(b) || a.localeCompare(b);
  });

  const chunks: string[] = [];
  // Doubled budget — large projects need more evidence to get accurate maps.
  let remaining = 100000;
  for (const [, filePath] of files) {
    if (remaining <= 0) break;
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      if (source.includes('\0')) continue;
      const v = filePath.toLowerCase();
      const base = path.basename(v);
      const isEntry        = /^(main|index|app|router|routes|server|application)\.[^/]+$/.test(base);
      const isJourney      = /(activity|fragment|screen|page|view|navigation|navigator|route|scene|search|explore|article|readinglist|saved|history|settings|nearby|map|login|edit|auth|home|feed|detail|profile|dashboard|checkout|cart|payment|onboard)/.test(v);
      const isServiceLayer = /(api|service|repository|store|manager|controller|handler|endpoint)/.test(v);
      const limit = isEntry ? 4000 : isJourney ? 2500 : isServiceLayer ? 1500 : 900;
      const excerpt = source.slice(0, Math.min(limit, remaining));
      chunks.push(`\n// ── ${path.basename(filePath)} ──\n${excerpt}`);
      remaining -= excerpt.length;
    } catch { /* omit unreadable source */ }
  }
  return chunks.join('');
}

function buildClaudePrompt(structure: ExtractedStructure, structureJson: string, sourceContext: string): string {
  const schema = `{
  "pattern": "short product navigation map name evidenced by the repository",
  "diagrams": {
    "structure": "flowchart TD — compact, comprehensive user navigation overview",
    "sequence": "flowchart TD — detailed tap-by-tap exploration flows",
    "gitDiff": ""
  },
  "descriptions": { "NodeLabel": "What the user taps, types, chooses, or sees, and what happens next" }
}`;

  return [
    'Create a comprehensive map of every user-visible way a person can explore and use this app. The repository evidence below is the source of truth.',
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(),
    diagramReadabilityGuidance(),
    '',
    'EVIDENCE RULES:',
    '- Infer only user-visible features and outcomes supported by the supplied evidence.',
    '- Before writing the diagram, systematically inspect the repository for user entry points: activities, fragments, composable screens, navigation destinations, tabs, drawers, menu actions, deep links, search actions, and settings screens. Do not stop after the first feature path found.',
    '- The relationship graph records source-proven imports. Use it to connect related features correctly, but do not show it or technical module names in the user-facing flow.',
    '- If a feature is unclear from the evidence, omit it. Never invent screens, accounts, payments, storage, integrations, or error states.',
    '- This is the FIRST learning level. Do not explain code, architecture, files, classes, functions, APIs, databases, state, requests, or technical layers.',
    '',
    'COMPACT USER MAP RULES for diagrams.structure:',
    '- This is a readable navigation overview, NOT a full interaction trace. It must be legible at a normal canvas zoom, not a wall of parallel boxes. Start at opening the app, then show every independently reachable user area as one clear branch.',
    '- Preserve every evidenced user area, but represent it as an information hierarchy: use as few plain-language journey hubs below the opening node as the evidence allows, then place related actions below each hub. A hub can summarize a closely related set of actions. For example, “Find and read content” can cover search, opening a result, reading, saving, and sharing.',
    '- Let the evidence decide how many branches and actions the overview needs. Prefer a clearer grouping label over a new parallel card when steps share one user goal; keep a distinct card when it represents an independently reachable area, meaningful choice, or outcome. The detailed step-by-step paths belong in diagrams.sequence.',
    '- Include every evidenced user area. Keep a strict tree with one opening node, meaningful action branches, and result nodes where they clarify an outcome.',
    '- Never draw return arrows, cross-links, repeated nodes, or more than two levels below the opening node. Each node must have one parent so the map remains readable.',
    '- Every branch must answer “what can the user do?” Use action-led labels such as “Tap Search”, “Tap Explore”, “Tap Saved articles”, “Open Nearby map”, “Open Games”, or “Open Settings”. Do not use destination-only labels.',
    '- Put detailed sequences, typing, scrolling, save/share choices, loading states, and error branches in diagrams.sequence—not in this overview.',
    "- Labels must be everyday language from the person's point of view. Good: \"Choose a project\", \"See the project map\", \"Read a feature walkthrough\". Bad: \"invoke analysis handler\", \"parse repository\", \"call API\".",
    '- Use "Person" or "User" only as the starting point when it makes the journey clearer.',
    '',
    'DETAIL USER FLOW RULES for diagrams.sequence:',
    '- Show disconnected, tap-by-tap flows for every important exploration route. These belong in the “More User Flows” tab, not the main overview.',
    '- Include every evidenced step needed to explain each flow, for example: “Tap Search” → “Type a topic” → “See matching results” → “Tap an article” → “Read and explore links”.',
    '- Use the same person-first language. Do not expose implementation details as intermediate steps.',
    '',
    'MERMAID RULES:',
    '- Start both diagrams with flowchart TD.',
    '- Use node IDs containing letters, digits, and underscores only.',
    '- Do NOT use subgraph, classDef, style, or click syntax. Use ordinary branch edges from the opening node so the canvas can render every route.',
    '- Keep node labels short. Avoid quotes, parentheses, slashes, colons, semicolons, and pipes in labels.',
    '- Every edge must have a short interaction or outcome label, such as "taps Search", "types a topic", "chooses a result", "swipes", "saves", "opens", "loads", or "nothing found". Never use unlabeled edges.',
    '',
    'Schema:', schema, '',
    'Each diagram is raw Mermaid with newlines, not fenced.',
    '',
    'Repository structure:', structureJson, '',
    'Source excerpts:', sourceContext || '(No readable source excerpts were available.)', '',
    'JSON only.',
  ].join('\n');
}

interface AnalysisDiagram {
  pattern?: string;
  diagrams?: { structure?: string; sequence?: string; gitDiff?: string };
  descriptions?: Record<string, string>;
}

// ── Change context prompt ─────────────────────────────────────────────────────

interface ChangeContextNode {
  node: string;
  whatNow: string;
  dataIn: string;
  transform: string;
  dataOut: string;
  neighbours: string[];
}

function buildChangeContextPrompt(diff: string, nodeNames: string[]): string {
  const schema = `{"nodes":[{"node":"exact name from list","whatNow":"1 sentence: what this part does now, starting with an active verb","dataIn":"what data/input enters this part (real var/type names from the diff)","transform":"the key thing this part does to that data","dataOut":"what comes out the other end (real var/type name)","neighbours":["names of other nodes that call into this or receive from this"]}]}`;

  return [
    'A developer just made code changes. Show them where their change fits in the bigger picture.',
    'Output ONLY the JSON below — no fences, no prose.',
    '',
    'RULES:',
    '- "whatNow": plain English, active voice, what the changed part does NOW. Not what changed — what it does.',
    '- "dataIn": the real variable or type name that enters this part (grep the diff for it). If unknown, "–".',
    '- "transform": the single most important thing this part does to that data. One clause.',
    '- "dataOut": what leaves this part. Real name from the code if possible.',
    '- "neighbours": which other parts in the architecture directly call into this or directly receive its output.',
    `  Use EXACT names from this list: ${nodeNames.length ? nodeNames.join(', ') : '(none)'}`,
    '- Include every node that was actually changed in the diff.',
    '',
    'Schema:',
    schema,
    '',
    'DIFF (focus on + lines):',
    diff.slice(0, 6000),
    '',
    'JSON only.',
  ].join('\n');
}

/**
 * Prompt for EXPLAINING a code change against the EXISTING base diagram.
 * We do NOT regenerate the diagram — we ask Claude which of the known component
 * nodes were touched and for a simple, kid-friendly sentence about each.
 */
function buildExplainPrompt(changedFiles: string, gitDiffSummary: string, nodeNames: string[]): string {
  const schema = `{"changes":[{"node":"exact name from the list","file":"file that changed","explanation":"1-2 simple sentences"}]}`;

  return [
    'Claude just edited this project. Explain each change so a 10-year-old gets it. Output ONLY the JSON below — no fences, no prose.',
    '',
    'RULES:',
    '- Plain words, no tech jargon (no: refactor, async, dependency, API, cache).',
    '- 1-2 short sentences: what happens differently now + why it\'s better.',
    '- Good: "This part now remembers answers it already found, so it replies faster instead of asking again."',
    '- Bad:  "Added memoization to QueryExecutor to reduce lookups."',
    `- "node" MUST be copied exactly from this list: ${nodeNames.length ? nodeNames.join(', ') : '(none — use the file name)'}`,
    '',
    `Changed files: ${changedFiles}`,
    `What changed (git facts): ${gitDiffSummary || '(no diff details available)'}`,
    '',
    'Schema:',
    schema,
    '',
    'JSON only.',
  ].join('\n');
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function getGitChangedFiles(folder: string): string[] {
  try {
    const out = execSync('git status --porcelain', { cwd: folder, encoding: 'utf8', timeout: 5000 });
    return out.split('\n')
      .map(l => l.slice(3).trim().split(' -> ').pop() || '')
      .filter(Boolean)
      .map(rel => path.join(folder, rel));
  } catch {
    return [];
  }
}

function changedNodeNames(changedPaths: string[], nodePaths: Record<string, string>): string[] {
  const changedSet = new Set(changedPaths);
  return Object.entries(nodePaths)
    .filter(([, absPath]) => changedSet.has(absPath))
    .map(([name]) => name);
}

function sendGitStatus(win: BrowserWindow) {
  if (!currentFolder) return;
  const changed = getGitChangedFiles(currentFolder);
  const names = changedNodeNames(changed, currentNodePaths);
  win.webContents.send('canvas:gitStatus', names);
  if (names.length > 0) buildGitAnnotations(currentFolder, changed, currentNodePaths, win);
}

interface GitAnnotation { name: string; summary: string; added: number; removed: number }

function computeGitAnnotations(
  folder: string,
  changedPaths: string[],
  nodePaths: Record<string, string>,
): GitAnnotation[] {
  const annotations: GitAnnotation[] = [];
  const pathToNode = new Map(Object.entries(nodePaths).map(([n, p]) => [p, n]));

  for (const absPath of changedPaths) {
    const nodeName = pathToNode.get(absPath) || path.basename(absPath);

    const relPath = path.relative(folder, absPath);
    let added = 0, removed = 0;
    const addedThings: string[] = [];
    const removedThings: string[] = [];

    try {
      const diff = execSync(`git diff HEAD -- "${relPath}"`, { cwd: folder, encoding: 'utf8', timeout: 5000 });
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          added++;
          const t = line.slice(1).trim();
          if (/^(fun |def |function |class |interface |async |export |public |private |override )/.test(t))
            addedThings.push(t.slice(0, 50));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          removed++;
          const t = line.slice(1).trim();
          if (/^(fun |def |function |class |interface |async |export |public |private |override )/.test(t))
            removedThings.push(t.slice(0, 50));
        }
      }
    } catch {
      try { added = fs.readFileSync(absPath, 'utf8').split('\n').length; } catch { /* ignore */ }
    }

    const parts: string[] = [];
    if (added > 0 && removed === 0) parts.push(`+${added} lines added`);
    else if (removed > 0 && added === 0) parts.push(`-${removed} lines removed`);
    else if (added > 0 || removed > 0) parts.push(`+${added} / -${removed} lines`);
    if (addedThings.length > 0) parts.push(`Added: ${addedThings.slice(0, 2).map(s => s.replace(/[{}()]/g, '').trim()).join(', ')}`);
    if (removedThings.length > 0) parts.push(`Removed: ${removedThings.slice(0, 1).map(s => s.replace(/[{}()]/g, '').trim()).join(', ')}`);
    if (parts.length === 0) parts.push('Modified');

    annotations.push({ name: nodeName, summary: parts.join('\n'), added, removed });
  }

  return annotations;
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };

function computeCommitAnnotations(
  folder: string,
  hash: string,
  changedRelPaths: string[],
  nodePaths: Record<string, string>,
): GitAnnotation[] {
  const pathToNode = new Map(Object.entries(nodePaths).map(([n, p]) => [path.relative(folder, p), n]));
  const statMap = new Map<string, { added: number; removed: number }>();

  try {
    const numstat = execSync(`git --no-pager show --numstat ${hash}`, { cwd: folder, encoding: 'utf8', timeout: 8000, env: GIT_ENV });
    for (const line of numstat.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const added   = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const removed = m[2] === '-' ? 0 : parseInt(m[2], 10);
      statMap.set(m[3].trim(), { added, removed });
    }
  } catch { /* numstat unavailable — proceed with zeros */ }

  return changedRelPaths.map(relPath => {
    const nodeName = pathToNode.get(relPath) || path.basename(relPath);
    const stat = statMap.get(relPath) ?? { added: 0, removed: 0 };
    const { added, removed } = stat;

    const parts: string[] = [];
    if (added > 0 && removed === 0) parts.push(`+${added} lines added`);
    else if (removed > 0 && added === 0) parts.push(`-${removed} lines removed`);
    else if (added > 0 || removed > 0) parts.push(`+${added} / -${removed} lines`);
    if (parts.length === 0) parts.push('Modified');

    return { name: nodeName, summary: parts.join('\n'), added, removed };
  });
}

/** Flatten annotations into a plain-text summary for the change prompt. */
function gitAnnotationsToText(annotations: GitAnnotation[]): string {
  return annotations
    .map(a => `- ${a.name}: ${a.summary.replace(/\n/g, '; ')}`)
    .join('\n');
}

function buildGitAnnotations(
  folder: string,
  changedPaths: string[],
  nodePaths: Record<string, string>,
  win: BrowserWindow,
) {
  const annotations = computeGitAnnotations(folder, changedPaths, nodePaths);

  if (annotations.length > 0 && !win.isDestroyed())
    win.webContents.send('canvas:gitAnnotations', annotations);
}

// ── JSON extraction ───────────────────────────────────────────────────────────

function extractJson(raw: string): object | null {
  const clean = raw
    .replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
    .replace(/\r/g, '')
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '');

  // CLI providers can emit progress/tool JSON before the requested payload.
  // Parse each balanced object rather than greedily taking the first `{` through
  // the last `}`, which made an otherwise valid Mermaid response disappear.
  for (let start = clean.indexOf('{'); start >= 0; start = clean.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < clean.length; end++) {
      const char = clean[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(clean.slice(start, end + 1));
        // Different canvas actions have different response schemas. Analysis
        // returns { diagrams: ... }, while focused flows return { mermaid: ... }
        // and component detail returns { title, summary, ... }. Do not throw a
        // valid analysis response away merely because it is not a flow response.
        if (parsed && typeof parsed === 'object' && (
          'mermaid' in parsed || 'diagram' in parsed || 'diagrams' in parsed || 'title' in parsed || 'detail' in parsed || 'files' in parsed
          // Some providers follow the requested diagram key directly instead
          // of nesting it in diagrams. Keep that otherwise valid response.
          || Object.values(parsed as Record<string, unknown>).some(value => typeof value === 'string' && /^(?:flowchart|graph)\s+/im.test(value.trim()))
        )) return parsed as object;
      } catch { /* try the next balanced object */ }
      break;
    }
  }

  // If a provider ignored the JSON-only instruction but returned valid Mermaid,
  // retain the map instead of leaving the canvas blank.
  const mermaidStart = clean.search(/(?:^|\n)\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|kanban)\b/i);
  if (mermaidStart >= 0) return { mermaid: clean.slice(mermaidStart).trim() };
  return null;
}

/**
 * Providers are not consistent about Mermaid wrapping: some return `graph TD`,
 * while others use a fenced `flowchart TD` block. Normalize those harmless
 * differences before deciding whether an architecture response is usable.
 */
function normalizeFlowchartMermaid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  const mermaid = (fenced?.[1] ?? trimmed).trim();
  return /^(?:flowchart|graph)\s+(?:TD|TB|BT|RL|LR)\b/i.test(mermaid) ? mermaid : undefined;
}

function architectureFlowcharts(parsed: Record<string, unknown> | null): Record<string, string> {
  const source = parsed?.diagrams;
  const entries = source && typeof source === 'object' && !Array.isArray(source)
    ? Object.entries(source as Record<string, unknown>)
    : [];
  const diagrams: Record<string, string> = {};
  for (const [key, value] of entries) {
    const mermaid = normalizeFlowchartMermaid(value);
    if (mermaid) diagrams[key] = mermaid;
  }

  // Accept a valid direct key too. This makes the cache resilient to a model
  // that returns { communicationFlow: "graph TD…" } instead of diagrams.
  for (const key of ['communicationFlow', 'highLevel', 'components', 'diagram', 'mermaid']) {
    const mermaid = normalizeFlowchartMermaid(parsed?.[key]);
    if (mermaid) diagrams[key === 'diagram' || key === 'mermaid' ? 'highLevel' : key] ??= mermaid;
  }
  return diagrams;
}

// ── Auto-update on code change (file watcher) ──────────────────────────────────

/** Pull component node names out of a structure flowchart Mermaid string. */
function extractNodeNames(diagram: object | null): string[] {
  const structure = (diagram as { diagrams?: { structure?: string } } | null)?.diagrams?.structure;
  if (!structure) return [];
  const names = new Set<string>();
  // Match `Id[Label]`, `Id(Label)`, `Id{Label}` and bare ids in edges
  const re = /([A-Za-z0-9_]+)\s*[\[\(\{]([^\]\)\}]+)[\]\)\}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(structure))) {
    names.add(m[2].trim());  // prefer the human label
    names.add(m[1].trim());  // and the id
  }
  return Array.from(names).filter(n => n && !/^(TD|LR|TB|RL|flowchart|classDef|changed)$/i.test(n));
}

interface ChangeExplanation { node: string; file: string; explanation: string }

/** Best-effort match Claude's node name to one that exists in the base diagram. */
function matchNode(claudeNode: string, known: string[]): string {
  const lc = claudeNode.toLowerCase();
  const exact = known.find(k => k.toLowerCase() === lc);
  if (exact) return exact;
  const partial = known.find(k => k.toLowerCase().includes(lc) || lc.includes(k.toLowerCase()));
  return partial || claudeNode;
}

async function runIncrementalPatch(_changedFiles: string) {
  if (!mainWindow || !currentFolder || patchInProgress) return;
  patchInProgress = true;

  const folder = currentFolder;
  const win = mainWindow;

  try {
    const structure = extractStructure(folder);
    currentNodePaths = structure.nodePaths;

    const changedPaths = getGitChangedFiles(folder);
    const annotations = computeGitAnnotations(folder, changedPaths, currentNodePaths);

    // Never let file watching create an AI request. If there is no map yet,
    // leave generation to the explicit Analyse action.
    if (!currentDiagram) {
      win.webContents.send('analysis:statusDetail', 'Source changes detected — run Analyse when you want a map.');
      win.webContents.send('analysis:status', 'done');
      return;
    }

    // ── Case 2: base exists → only explain + highlight the change ──
    // The base diagram is NOT regenerated; we keep it stable and color the changes.
    if (changedPaths.length === 0) { win.webContents.send('analysis:status', 'done'); return; }

    // Watching source files must never create a surprise AI request. Keep the
    // live canvas annotated from git facts; the user can explicitly Analyse
    // when they want an AI-generated map or explanation.
    win.webContents.send('analysis:status', 'patching');
    win.webContents.send('analysis:statusDetail', 'Source changes detected — updated local annotations.');
    const changedNames = annotations.map(a => a.name);
    win.webContents.send('canvas:claudeChanges', { changedNames, impactedNames: [] });
    win.webContents.send('analysis:impactSummary', impactSummaryFromAnnotations(annotations));
    win.webContents.send('canvas:gitAnnotations', annotations);
    win.webContents.send('analysis:status', 'done');
  } catch (error) {
    if (!win.isDestroyed()) {
      win.webContents.send('analysis:statusDetail', error instanceof Error ? error.message : String(error));
      win.webContents.send('analysis:status', 'error');
    }
  } finally {
    patchInProgress = false;
  }
}

/** Build the impact-panel summary directly from git annotation data. */
function impactSummaryFromAnnotations(annotations: GitAnnotation[]): ImpactSummary {
  return {
    changed: annotations.map(a => ({
      name: a.name,
      type: 'file',
      description: a.summary.replace(/\n/g, ' · '),
      oldDescription: '',
    })),
    impacted: [],
  };
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  loadAiProvider();
  walkthroughSettings = loadWalkthroughSettings();
  accountService = new AccountService(app.getPath('userData'), url => shell.openExternal(url));
  resetRendererReady();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.error(`[renderer:${line}] ${message} (${sourceId})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason);
  });
  mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    void (async () => {
      // The renderer registers its event listeners during its first React
      // render. Without this handshake, the initial canvas:diagram event can
      // be lost, leaving a valid cached diagram blank only in Electron.
      await waitForRendererReady();
      if (!mainWindow || mainWindow.isDestroyed()) return;
    createPty(mainWindow);
    setupPtyClaudeDetection();

    startMcpServer({
      getFolder:  () => currentFolder,
      getDiagram: () => currentDiagram,
      getWindow:  () => mainWindow,
      runAnalysisInternal,
      runComponentDetail,
      runComponentDrilldown,
      runComponentCodeFlow,
      executeCanvasCommandInternal,
      persistDiagram,
    });
    updateClaudeJsonMcpConfig(path.join(app.getAppPath(), 'mcp-bridge.js'));

    const last = loadLastProject();
    if (last) {
      void getRepositoryAccess(last).then(async access => {
        if (!mainWindow) return;
        currentRepositoryAccess = access;
        currentFolder = last;
        restartPty(mainWindow, last);

        // Restore the latest canvas for this exact project immediately. The
        // analysis cache is kept separately, so switching providers or changing
        // source files does not make a saved canvas disappear.
        const restored = await restoreProjectCache(last, access);
        const cached = restored.cache;
        const restoredDiagram = restored.diagram;
        if (restoredDiagram) {
          currentDiagram = restoredDiagram;
          mainWindow.webContents.send('canvas:diagram', restoredDiagram);
          mainWindow.webContents.send('folder:restored', { folder: last, hasCachedDiagram: true });
        // Drilldowns are intentionally ephemeral: reopening a project should
        // show its base map, not begin an AI drill automatically.
        const restorablePanels = cached?.lastSession?.filter((panel) => panel.mode !== 'drill') ?? [];
        if (restorablePanels.length) {
          mainWindow.webContents.send('canvas:restoreSession', restorablePanels);
        }
        if (cached) scheduleComponentCacheWarmup(last, restoredDiagram, cached.structureHash);
        } else {
          mainWindow.webContents.send('folder:restored', { folder: last, hasCachedDiagram: false });
        }

        startFileWatcher(last, (changedFiles) => {
          if (mainWindow) sendGitStatus(mainWindow);
          runIncrementalPatch(changedFiles);
        });
      });
    }
    })();
  });

  mainWindow.on('closed', () => {
    componentWarmupGeneration++;
    stopMcpServer();
    stopFileWatcher();
    killPty();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('ai:getProvider', () => ({ provider: getAiProvider(), providers: AI_PROVIDERS }));
ipcMain.handle('ai:setProvider', (_e, provider: string) => ({ provider: saveAiProvider(provider), providers: AI_PROVIDERS }));
ipcMain.handle('analysis:getDepth', () => analysisDepth);
ipcMain.handle('renderer:ready', () => {
  resolveRendererReady?.();
  resolveRendererReady = null;
  return true;
});
ipcMain.handle('walkthrough:getSettings', () => walkthroughSettings);
ipcMain.handle('walkthrough:setSettings', (_e, settings: WalkthroughSettings) => saveWalkthroughSettings(settings));
ipcMain.handle('analysis:setDepth', (_e, depth: number) => {
  analysisDepth = depth === 1 || depth === 3 ? depth : 2;
  return analysisDepth;
});
// Unpackaged Electron runs are developer/debug builds. Subscription checks must
// never block local development, but remain enforced in packaged releases.
ipcMain.handle('app:isDebugMode', () => !app.isPackaged);
ipcMain.handle('account:getState', () => accountService?.getState() ?? { configured: false, user: null, subscription: null });
ipcMain.handle('account:signInGoogle', async () => {
  if (!accountService) throw new Error('Account service is not ready.');
  return accountService.signInWithGoogle();
});
ipcMain.handle('billing:startSubscription', async (_e, plan: PlanId) => {
  if (plan !== 'monthly' && plan !== 'yearly') throw new Error('Invalid subscription plan.');
  if (!accountService) throw new Error('Account service is not ready.');
  return accountService.startSubscription(plan);
});
ipcMain.handle('account:signOut', () => accountService?.signOut() ?? { configured: false, user: null, subscription: null });
ipcMain.handle('project:relationships', () => {
  if (!currentFolder) return { ok: false, error: 'No project is open' };
  const structure = extractStructure(currentFolder);
  return { ok: true, relationships: structure.relationships, mermaid: buildRelationshipGraphMermaid(structure) };
});

async function openProject(folder: string, access: RepositoryAccess) {
  if (!mainWindow) return null;
  componentWarmupGeneration++;
  currentFolder = folder;
  currentRepositoryAccess = access;
  currentDiagram = null;
  currentNodePaths = {};
  saveLastProject(folder);
  stopFileWatcher();

  restartPty(mainWindow, folder);

  // Restore the most recently saved canvas for this project. Analysis will
  // still validate its own source-hash cache when the user runs it again.
  const restored = await restoreProjectCache(folder, access);
  const cached = restored.cache;
  const restoredDiagram = restored.diagram;
  const hasCurrentCachedDiagram = !!restoredDiagram;
  if (restoredDiagram) {
    currentDiagram = restoredDiagram;
    mainWindow.webContents.send('canvas:diagram', restoredDiagram);
    // A drill is an explicit navigation action, never an opening action.
    const restorablePanels = cached?.lastSession?.filter((panel) => panel.mode !== 'drill') ?? [];
    if (restorablePanels.length) {
      mainWindow.webContents.send('canvas:restoreSession', restorablePanels);
    }
    if (cached) scheduleComponentCacheWarmup(folder, restoredDiagram, cached.structureHash);
  }

  startFileWatcher(folder, (changedFiles) => {
    if (mainWindow) sendGitStatus(mainWindow);
    runIncrementalPatch(changedFiles);
  });

  return { opened: true, folder, hasCachedDiagram: hasCurrentCachedDiagram, access };
}

ipcMain.handle('folder:open', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;

  const folder = result.filePaths[0];
  const access = await getRepositoryAccess(folder);
  return openProject(folder, access);
});

ipcMain.on('session:savePanels', (_e, panels: SessionPanel[]) => {
  if (currentFolder) saveSessionPanels(currentFolder, panels);
});

ipcMain.handle('cache:clearProject', () => {
  if (!currentFolder) return { ok: false, error: 'No project is open' };
  const ok = clearProjectCache(currentFolder);
  if (ok) currentDiagram = null;
  return ok ? { ok: true } : { ok: false, error: 'Could not clear the project cache' };
});

/** Explicit user-requested upload of the current project snapshot. */
ipcMain.handle('supabase:syncCurrent', async () => {
  if (!currentFolder) return { ok: false, error: 'No project is open' };
  const cache = loadCache(currentFolder);
  if (!cache?.diagram) return { ok: false, error: 'Run Analyse before pushing this project to Supabase' };
  try {
    const access = currentRepositoryAccess ?? await getRepositoryAccess(currentFolder);
    currentRepositoryAccess = access;
    const account = accountService?.getState().user ?? null;
    await syncAnalysisToSupabase({
      folder: currentFolder,
      structureHash: cache.structureHash,
      cache,
      analysis: cache.diagram,
      description: String((cache.diagram as { pattern?: unknown }).pattern ?? 'Repository analysis'),
      provider: cache.provider ?? getAiProvider(),
      visibility: access.kind,
      remoteUrl: access.remoteUrl,
      publishedBy: account,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

async function runAnalysisInternal(options: { ensureGraphify?: boolean } = {}): Promise<{ ok?: boolean; error?: string; fromCache?: boolean }> {
  if (!mainWindow || !currentFolder) return { error: 'No folder selected' };

  // An explicit Analyse supersedes any preparation for the previous snapshot.
  componentWarmupGeneration++;
  mainWindow.webContents.send('analysis:status', 'running');

  try {
    // The user-flow map is graph-backed whenever Graphify can build an index.
    // Other project-level analyses consume the same evidence in the warmup
    // stages that follow this primary map.
    if (options.ensureGraphify !== false && !graphifyPromptContext(currentFolder).available) {
      mainWindow.webContents.send('analysis:statusDetail', 'Building Graphify code graph…');
      const graphifyResult = await buildGraphifyIndex(currentFolder, detail =>
        mainWindow?.webContents.send('analysis:statusDetail', detail),
      );
      if (!graphifyResult.ok) console.warn('[graphify] index unavailable:', graphifyResult.error ?? 'unknown error');
    }
    mainWindow.webContents.send('analysis:statusDetail', 'Extracting code structure…');
    // Graphify enriches the prompt and its content fingerprint participates in
    // the key, while the native structure stays stable across both Analyse paths.
    const structure = extractStructure(currentFolder);

    if (structure.totalFiles === 0) {
      mainWindow.webContents.send('analysis:statusDetail', 'No source files found in this folder.');
      mainWindow.webContents.send('analysis:status', 'error');
      return { error: 'No source code found in this folder' };
    }

    const { structureJson, hash: structureHash, graphify } = analysisCacheHash(structure, currentFolder);

    // ── Cache hit: structure unchanged since last analysis ──
    const cached = loadCacheForAnalysis(currentFolder);
    const cachedDiagram = cachedAnalysis(cached, structureHash);
    if (cachedDiagram) {
      currentDiagram = cachedDiagram;
      currentNodePaths = structure.nodePaths;
      normalizeDiagramPattern(cachedDiagram as Record<string, unknown>, structure);
      mainWindow.webContents.send('canvas:diagram', cachedDiagram);
      if (cached) queueCachedAnalysisSync(currentFolder, cached);
      mainWindow.webContents.send('analysis:statusDetail', 'Loaded from cache');
      mainWindow.webContents.send('analysis:status', 'done');
      sendGitStatus(mainWindow);
      if (cached) scheduleComponentCacheWarmup(currentFolder, cachedDiagram, structureHash);
      return { ok: true, fromCache: true };
    }

    // ── Cache miss: ask Claude ──
    const graphNote = graphify.available
      ? ` using ${graphify.nodeCount} Graphify nodes`
      : '';
    const graphProvenance = graphify.resolution?.reasons[0]
      ? ` ${graphify.resolution.reasons[0]}`
      : '';
    mainWindow.webContents.send('analysis:statusDetail', `Analysing ${structure.totalFiles} files${graphNote} with ${providerLabel()}…${graphProvenance}`);
    const prompt = buildClaudePrompt(structure, structureJson, buildAnalysisSourceContext(structure));
    const raw = await runCapture(prompt, currentFolder);
    const diagram = extractJson(raw) as AnalysisDiagram | null;

    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'rex-last-analysis.json'),
        JSON.stringify(diagram, null, 2) || raw, 'utf8');
      if (diagram) {
        const d = (diagram as { diagrams?: { structure?: string } }).diagrams?.structure || '';
        console.log('\n===== STRUCTURE MERMAID =====\n' + d + '\n=============================\n');
      }
    } catch { /* ignore */ }

    if (!diagram) {
      mainWindow.webContents.send('analysis:status', 'error');
      return { error: `No JSON found in ${providerLabel()} output` };
    }

    normalizeDiagramPattern(diagram as Record<string, unknown>, structure);

    currentDiagram = diagram;
    currentNodePaths = structure.nodePaths;

    // Component entries are evidence-fingerprinted. Keep reusable entries and
    // let the new queue regenerate only components whose evidence changed.
    const cacheSaved = saveCache(currentFolder, { structureHash, diagram });

    mainWindow.webContents.send('canvas:diagram', diagram);
    if (!cacheSaved) mainWindow.webContents.send('analysis:statusDetail', 'Diagram generated, but it could not be saved to cache.');
    mainWindow.webContents.send('analysis:status', 'done');
    sendGitStatus(mainWindow);
    if (cacheSaved) scheduleComponentCacheWarmup(currentFolder, diagram, structureHash);

    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mainWindow.webContents.send('analysis:statusDetail', message);
    mainWindow.webContents.send('analysis:status', 'error');
    return { error: message };
  }
}

ipcMain.on('canvas:setPreferredDiagramType', (_e, type: string) => {
  preferredDiagramType = String(type || 'flowchart');
});

ipcMain.handle('analysis:run', () => runAnalysisInternal());

// Explicit user action: build only Graphify's deterministic code graph, then
// immediately analyse with that newly-created evidence.
ipcMain.handle('graphify:buildAndAnalyse', async () => {
  if (!mainWindow || !currentFolder) return { ok: false, error: 'No folder selected' };
  mainWindow.webContents.send('analysis:status', 'running');
  try {
    const result = await buildGraphifyIndex(currentFolder, detail =>
      mainWindow?.webContents.send('analysis:statusDetail', detail),
    );
    if (!result.ok) {
      mainWindow.webContents.send('analysis:statusDetail', result.error || 'Graphify index failed');
      mainWindow.webContents.send('analysis:status', 'error');
      return result;
    }
    return { ...result, analysis: await runAnalysisInternal({ ensureGraphify: false }) };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    mainWindow.webContents.send('analysis:statusDetail', error);
    mainWindow.webContents.send('analysis:status', 'error');
    return { ok: false, error };
  }
});

// ── Component detail (click-to-inspect) ─────────────────────────────────────────

function buildComponentDetailPrompt(name: string, nodeNames: string[]): string {
  const schema = `{"title":"${name}","summary":"2-3 simple sentences: what it does and why it matters","does":["3-6 short bullets"],"talksTo":["names it works with"]}`;

  return [
    `Explain the component "${name}" so a 10-year-old understands it. Output ONLY the JSON below — no fences, no prose.`,
    '',
    'RULES:',
    '- Plain words, no tech jargon (no: instantiate, dependency, async, interface, API).',
    '- Short sentences. Compare to real-life things when it helps.',
    '- "does": small plain actions, e.g. "Keeps a list of visits".',
    `- "talksTo": other parts it gives things to or gets things from. Use these exact names when they fit: ${nodeNames.length ? nodeNames.join(', ') : '(none)'}`,
    '',
    'Schema:',
    schema,
    '',
    'JSON only.',
  ].join('\n');
}

async function runComponentDetail(name: string, isolated = false): Promise<{ ok?: boolean; error?: string; detail?: unknown }> {
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const nodeNames = extractNodeNames(currentDiagram);
    const cacheKey = `__detail__:v1:${name}:${hashStructure(JSON.stringify(currentDiagram ?? {}))}`;
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; detail?: unknown };
        if (cached.version === 1 && cached.detail) return { ok: true, detail: cached.detail };
      } catch {
        // Regenerate malformed cache data.
      }
    }
    const prompt = buildComponentDetailPrompt(name, nodeNames);
    const raw = await (isolated ? runIsolatedCapture : runCapture)(prompt, currentFolder);
    const detail = extractJson(raw);
    if (!detail) return { error: 'no detail' };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 1, detail }));
    return { ok: true, detail };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:detail', async (_e, name: string) => runComponentDetail(name));


// ── Component drilldown ───────────────────────────────────────────────────────

/**
 * Find source files relevant to a component name.
 * Scores every source file by name-match + occurrence count. This is the
 * fallback when Graphify cannot provide a source-proven evidence path.
 * Searches the full project tree (not just the 80-file index) so concept-level
 * labels like "SimEngine" that span multiple files are handled correctly.
 * Never returns empty — if nothing scores > 0 returns [] and caller uses
 * project structure as fallback context.
 */
function findSourceFiles(
  name: string,
  nodePaths: Record<string, string>,
  projectRoot: string,
  maxResults?: number,
): { filePath: string; content: string }[] {
  const lc = name.toLowerCase();
  // Graphify's artifacts are prompt evidence, never application source. In
  // particular its AST cache is JSON and can otherwise outscore a real source
  // file during name matching.
  const IGNORE = new Set(['node_modules', 'dist', 'build', '.git', '.dart_tool', 'Pods', '.next', 'out', 'target', '__pycache__', 'coverage', 'graphify-out']);

  // Projects may store their behavior in any text-based format: source code,
  // metadata, rules, templates, configuration, or a domain-specific extension.
  // Read every reasonable text file rather than relying on an extension allow-list.
  const read = (fp: string): string => {
    try {
      if (fs.statSync(fp).size > 2 * 1024 * 1024) return '';
      const content = fs.readFileSync(fp, 'utf8');
      return content.includes('\0') ? '' : content;
    } catch { return ''; }
  };

  const scoreFile = (fileName: string, content: string): number => {
    const fn = fileName.toLowerCase().replace(/\.[^.]+$/, '');
    let s = 0;
    if (fn === lc) s += 100;
    else if (fn.includes(lc) || lc.includes(fn)) s += 50;
    try {
      const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s += Math.min((content.match(re) || []).length * 3, 45);
    } catch { /* ignore invalid regex */ }
    // User-flow labels deliberately use everyday language.  Ignore filler words
    // when translating one back to code, otherwise a documentation file which
    // happens to say "component" can beat the actual Canvas.tsx source.
    const genericWords = new Set([
      'about', 'after', 'before', 'between', 'component', 'components', 'create',
      'data', 'from', 'into', 'place', 'screen', 'show', 'step', 'system',
      'then', 'that', 'the', 'this', 'user', 'users', 'using', 'with',
    ]);
    // Diagram labels often use readable names (for example, "My Schedule")
    // while metadata files use a shorter technical name (for example, Schedule.page).
    for (const word of lc.split(/[^a-z0-9]+/).filter(word => word.length > 2 && !genericWords.has(word))) {
      const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (fn.includes(word)) s += 20;
      s += Math.min((content.match(re) || []).length, 10);
    }
    // The source tree is the product implementation. Documentation and generated
    // assets can describe a feature, but are poor targets for a code hierarchy.
    if (/(^|\/)(src|app|lib|server|client)(\/|$)/i.test(fileName)) s += 8;
    if (/(^|\/)(docs?|dev-docs|storybook|examples?)(\/|$)/i.test(fileName)) s -= 12;
    return s;
  };

  const seen = new Set<string>();
  const results: { filePath: string; content: string; score: number }[] = [];

  const add = (fp: string, fileName: string) => {
    if (seen.has(fp)) return;
    seen.add(fp);
    const content = read(fp);
    const s = scoreFile(fp, content);
    if (s > 0) results.push({ filePath: fp, content, score: s });
  };

  // Score indexed files first (fast)
  for (const [fileName, fp] of Object.entries(nodePaths)) add(fp, fileName);

  // If best score so far is low, walk the full project tree
  const bestSoFar = results.reduce((m, r) => Math.max(m, r.score), 0);
  if (bestSoFar < 20 && fs.existsSync(projectRoot)) {
    const walk = (dir: string, depth: number) => {
      if (depth > 7) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.'))
          walk(path.join(dir, e.name), depth + 1);
        else if (e.isFile())
          add(path.join(dir, e.name), e.name);
      }
    };
    walk(projectRoot, 0);
  }

  results.sort((a, b) => b.score - a.score);

  // A user-flow phrase can legitimately match a small utility such as
  // connections.ts.  That utility may expose helpers but have no execution
  // sequence to draw.  Prefer a similarly relevant source file that actually
  // contains locally provable function-to-function calls, because it gives the
  // editor an honest call path rather than an empty overlay.  This remains
  // entirely static and local.
  const candidates = results.slice(0, 14);
  const callCount = (content: string) => (buildLocalCallHierarchy(content).match(/\|calls\|/g) || []).length;
  candidates.sort((a, b) => (b.score + Math.min(callCount(b.content), 6) * 6) - (a.score + Math.min(callCount(a.content), 6) * 6));
  const ranked = [...candidates, ...results.slice(14)];
  const selected = maxResults === undefined ? ranked : ranked.slice(0, maxResults);
  return selected.filter(r => r.score > 0).map(r => ({ filePath: r.filePath, content: r.content }));
}

/**
 * Source loading follows Graphify's proven relationship path first. There is no
 * arbitrary file limit: every graph-selected, readable source file is returned.
 * Name matching remains a zero-setup fallback when Graphify is unavailable or
 * cannot resolve the selected canvas label.
 */
function graphFirstSourceFiles(
  name: string,
  nodePaths: Record<string, string>,
  projectRoot: string,
): { filePath: string; content: string }[] {
  const root = path.resolve(projectRoot);
  const seen = new Set<string>();
  const fromGraph = graphifySourceFiles(projectRoot, name).flatMap(relPath => {
    const absolute = path.resolve(projectRoot, relPath);
    if (!absolute.startsWith(root + path.sep) || seen.has(absolute)) return [];
    seen.add(absolute);
    try {
      if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 2 * 1024 * 1024) return [];
      const content = fs.readFileSync(absolute, 'utf8');
      return content.includes('\0') ? [] : [{ filePath: absolute, content }];
    } catch { return []; }
  });
  return fromGraph.length ? fromGraph : findSourceFiles(name, nodePaths, projectRoot);
}

interface SelectedHandoff { from: string; to: string; data: string }

/** A selected arrow is encoded as “source → destination · data carried”. */
function parseSelectedHandoff(selection: string): SelectedHandoff | null {
  const [endpoints, ...dataParts] = selection.split(' · ');
  const arrowAt = endpoints.indexOf(' → ');
  if (arrowAt < 0) return null;
  const from = endpoints.slice(0, arrowAt).trim();
  const to = endpoints.slice(arrowAt + 3).trim();
  if (!from || !to) return null;
  return { from, to, data: dataParts.join(' · ').trim() || 'passes control or data' };
}

function sourceNameForHandoffEndpoint(label: string): string {
  return label
    .replace(/^(?:External|Internal):\s*/i, '')
    .split(/\s+[—-]\s+/)[0]
    .trim();
}

/** Resolve both ends of an arrow so a story can explain their real handoff. */
function sourceFilesForSelection(
  selection: string,
  nodePaths: Record<string, string>,
  projectRoot: string,
): { filePath: string; content: string }[] {
  const handoff = parseSelectedHandoff(selection);
  if (!handoff) return graphFirstSourceFiles(selection, nodePaths, projectRoot);

  const seen = new Set<string>();
  const files: { filePath: string; content: string }[] = [];
  for (const endpoint of [handoff.from, handoff.to]) {
    const endpointName = sourceNameForHandoffEndpoint(endpoint);
    for (const file of graphFirstSourceFiles(endpointName, nodePaths, projectRoot)) {
      if (!seen.has(file.filePath)) { seen.add(file.filePath); files.push(file); }
    }
  }
  // External systems often have no local file. The originating component is
  // still the source of truth for the request and response contract.
  return files.length ? files : graphFirstSourceFiles(sourceNameForHandoffEndpoint(handoff.from), nodePaths, projectRoot);
}

/** Cache results against the exact source evidence, not just a canvas label. */
function componentEvidenceFingerprint(name: string, sourceFiles: { filePath: string; content: string }[]): string {
  const evidence = sourceFiles
    .map(({ filePath, content }) => `${filePath}\n${content}`)
    .join('\n\0\n');
  return hashStructure(`${name}\n${evidence}`);
}

/**
 * Small language-neutral fallback for sources that TypeScript ESTree cannot
 * parse (notably Kotlin/Java/Swift). It intentionally proves only declared
 * types, declared functions, and calls whose target is also declared locally.
 */
function buildRegexCallHierarchy(source: string): string {
  type Definition = { key: string; name: string; owner?: string };
  const definitions: Definition[] = [];
  const classes: { name: string; depth: number }[] = [];
  const calls = new Set<string>();
  let braceDepth = 0;
  let currentOwner: string | undefined;

  const methodNames = new Set<string>();
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const typeMatch = line.match(/\b(?:class|interface|object|enum\s+class|struct|protocol)\s+([A-Za-z_]\w*)/);
    if (typeMatch) classes.push({ name: typeMatch[1], depth: braceDepth });

    const methodMatch = line.match(/\b(?:fun|func|function|def)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/)
      ?? line.match(/^\s*(?:(?:public|private|protected|internal|open|override|static|final|async|suspend|abstract)\s+)*(?:[A-Za-z_][\w<>,?\[\] ]*\s+)([A-Za-z_]\w*)\s*\(/);
    if (methodMatch && !/\b(?:if|for|while|switch|catch|when)\s*\(/.test(line)) {
      const owner = classes.length ? classes[classes.length - 1].name : undefined;
      const name = methodMatch[1];
      const key = owner ? `${owner}.${name}` : name;
      definitions.push({ key, name, owner });
      methodNames.add(name);
      currentOwner = key;
    }

    if (currentOwner) {
      for (const match of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const called = match[1];
        if (called !== currentOwner.split('.').pop() && methodNames.has(called)) {
          const target: Definition | undefined = definitions.find(def => def.name === called);
          if (target && target.key !== currentOwner) calls.add(`${currentOwner}|${target.key}`);
        }
      }
    }

    braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    while (classes.length && braceDepth <= classes[classes.length - 1].depth) classes.pop();
    if (braceDepth <= 0) currentOwner = undefined;
  }

  const id = new Map<string, string>();
  let next = 1;
  const nodeId = (key: string) => { if (!id.has(key)) id.set(key, `N${next++}`); return id.get(key)!; };
  const label = (value: string) => value.replace(/[^A-Za-z0-9_. ]/g, ' ').slice(0, 48);
  const output = ['flowchart LR'];
  const edges: Array<{ from: string; to: string; kind: string }> = [];
  for (const definition of definitions) {
    if (definition.owner) edges.push({ from: definition.owner, to: definition.key, kind: 'contains' });
  }
  for (const value of calls) {
    const [from, to] = value.split('|');
    edges.push({ from, to, kind: 'calls' });
  }
  for (const edge of edges) output.push(`  ${nodeId(edge.from)}[${label(edge.from)}] -->|${edge.kind}| ${nodeId(edge.to)}[${label(edge.to)}]`);
  if (edges.length === 0) {
    for (const definition of definitions) output.push(`  ${nodeId(definition.key)}[${label(definition.key)}]`);
  }
  if (output.length === 1) output.push('  A[No locally declared classes or methods found]');
  return output.join('\n');
}

/** Build a local, source-proven class/function hierarchy. No AI inference. */
function buildLocalCallHierarchy(source: string): string {
  type Def = { key: string; label: string; className?: string };
  const definitions = new Map<string, Def>();
  const owns = new Set<string>();
  const calls = new Set<string>();
  const imports = new Set<string>();
  let ast: unknown;
  try { ast = require('@typescript-eslint/typescript-estree').parse(source, { jsx: true, tolerant: true }); } catch { return buildRegexCallHierarchy(source); }

  const walk = (node: unknown, visit: (n: Record<string, unknown>, classes: string[], owner?: string) => void, classes: string[] = [], owner?: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const type = n.type as string | undefined;
    let nextClasses = classes;
    let nextOwner = owner;
    if (type === 'ClassDeclaration') {
      const name = ((n.id as { name?: string } | null)?.name) ?? 'AnonymousClass';
      definitions.set(name, { key: name, label: name });
      nextClasses = [...classes, name];
    }
    const functionName = (() => {
      if (type === 'FunctionDeclaration') return (n.id as { name?: string } | null)?.name;
      if (type === 'VariableDeclarator' && ['ArrowFunctionExpression', 'FunctionExpression'].includes((n.init as { type?: string } | null)?.type ?? '')) return (n.id as { name?: string } | null)?.name;
      if (type === 'MethodDefinition') return (n.key as { name?: string } | null)?.name;
      return undefined;
    })();
    if (functionName) {
      const className = nextClasses[nextClasses.length - 1];
      nextOwner = className ? `${className}.${functionName}` : functionName;
      definitions.set(nextOwner, { key: nextOwner, label: nextOwner, className });
      if (className) owns.add(`${className}|${nextOwner}`);
    }
    visit(n, nextClasses, nextOwner);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, visit, nextClasses, nextOwner));
      else if (value && typeof value === 'object' && (value as Record<string, unknown>).type) walk(value, visit, nextClasses, nextOwner);
    }
  };

  walk(ast, node => {
    if (node.type === 'ImportDeclaration') {
      const sourceName = (node.source as { value?: string } | undefined)?.value;
      if (typeof sourceName === 'string') imports.add(sourceName);
    }
  });
  walk(ast, (node, _classes, owner) => {
    if (node.type !== 'CallExpression' || !owner) return;
    const callee = node.callee as { type?: string; name?: string; property?: { name?: string } } | undefined;
    const called = callee?.type === 'Identifier' ? callee.name : callee?.property?.name;
    if (!called) return;
    const target = [...definitions.values()].find(def => def.key === called || def.key.endsWith(`.${called}`));
    if (target && target.key !== owner) calls.add(`${owner}|${target.key}`);
  });

  const id = new Map<string, string>(); let next = 1;
  const nodeId = (key: string) => { if (!id.has(key)) id.set(key, `N${next++}`); return id.get(key)!; };
  const label = (key: string) => key.replace(/[^A-Za-z0-9_. ]/g, ' ').slice(0, 48);
  const lines = ['flowchart LR'];
  const edges = [...owns].map(value => ({ value, kind: 'contains' })).concat([...calls].map(value => ({ value, kind: 'calls' })));
  for (const edge of edges) {
    const [from, to] = edge.value.split('|');
    lines.push(`  ${nodeId(from)}[${label(from)}] -->|${edge.kind}| ${nodeId(to)}[${label(to)}]`);
  }
  if (edges.length === 0) {
    const fallbackDefs = [...definitions.values()];
    if (fallbackDefs.length) {
      for (const def of fallbackDefs) lines.push(`  ${nodeId(def.key)}[${label(def.label)}]`);
    } else if (imports.size) {
      const module = 'Selected module';
      for (const imported of imports) {
        lines.push(`  ${nodeId(module)}[${module}] -->|imports| ${nodeId(imported)}[${label(imported)}]`);
      }
    } else {
      lines.push('  A[No classes functions or imports found in this local file]');
    }
  }
  return lines.join('\n');
}

/**
 * Give AI requests the same source-proven topology used by the editor.  Keeping
 * it separate from the source text makes relationships explicit without asking
 * the model to rediscover them from a large file.
 */
function buildHierarchyContext(sourceFiles: { filePath: string; content: string }[]): string {
  if (!currentFolder) return '';
  return sourceFiles.slice(0, 6).map(({ filePath, content }) => {
    const hierarchy = buildLocalCallHierarchy(content);
    return `// ── ${path.relative(currentFolder!, filePath)}: local AST hierarchy ──\n${hierarchy}`;
  }).join('\n\n').slice(0, 12000);
}

function buildDrilldownPrompt(name: string, sourceCode: string, imports: string[], calledBy: string[], hierarchyContext = '', graphEvidence = ''): string {
  return [
    `You are explaining the "${name}" feature to a smart non-engineer. Look at the source code and draw exactly what happens when a user uses this feature — step by step.`,
    'Output ONLY the JSON below — no fences, no prose.',
    analysisDepthGuidance(),
    diagramReadabilityGuidance(),
    '',
    'WHAT TO SHOW:',
    `1. The steps a user goes through inside "${name}" — what they see, what they do, what happens next.`,
    '2. Any validation or error states the user might hit (wrong password, no results, network error, etc).',
    '3. What data the feature reads or saves (but label it as what the user experiences: "saves booking", "loads profile", not "writes to DB").',
    '4. Any other features this one connects to — label the edge with what the user does to get there.',
    '',
    'NODE LABELS: plain English actions or states a user would recognise.',
    '   Good: "Enter Email", "Validate Password", "Show Error", "Load Dashboard", "Save Booking"',
    '   Bad: "AuthViewModel.login()", "apiClient.post()", "useState", "useEffect"',
    '',
    'CANONICAL STEP IDS (required):',
    '- This diagram is the source of truth for all later explanations.',
    '- Number every node in reading order with a stable ID: S1, S2, S3, and so on.',
    '- Use this exact node form: `S1[ S1 - plain English step ]`.',
    '- Reuse a step ID only for the same step. Do not use other node IDs.',
    '',
    'EDGE LABELS: what triggers the transition — user action or outcome.',
    '   Good: "taps submit", "password wrong", "success", "no results found"',
    '   Bad: "calls", "returns Promise", "dispatches"',
    '',
    calledBy.length > 0 ? `This feature is reached from: ${calledBy.join(', ')}` : '',
    hierarchyContext ? [
      '',
      'LOCAL AST EVIDENCE (authoritative):',
      '- This was extracted locally from the supplied files, not inferred by AI.',
      '- Use it to determine the real class/function ownership and call order.',
      '- Do not invent calls, methods, or cross-file relationships not shown here or directly proven by source.',
      hierarchyContext,
    ].join('\n') : '',
    graphEvidence ? ['', graphEvidence].join('\n') : '',
    '',
    'MERMAID SYNTAX (follow exactly):',
    '- Start with `flowchart TD`.',
    '- Node id = letters/digits/underscore only. Format: `Id[Label]`.',
    '- Label: letters, digits, spaces only. NO special chars inside [ ].',
    '- Edge with label: `A -->|taps submit| B`.',
    '- NO subgraph, NO classDiagram, NO sequenceDiagram.',
    '- Include the source-proven steps that change the user-visible state, decision, boundary, or outcome. Fold local implementation mechanics into the closest meaningful step. Every node must be connected.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines"}',
    '',
    `SOURCE CODE of ${name} (use to understand what it does, not to copy class names):`,
    '```',
    sourceCode.slice(0, 7000),
    '```',
    '',
    'JSON only.',
  ].filter(Boolean).join('\n');
}

async function runComponentDrilldown(rawName: string, isolated = false): Promise<{ ok?: boolean; error?: string; mermaid?: string; fromCache?: boolean }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const structure = extractStructure(currentFolder);
    const sourceFiles = sourceFilesForSelection(name, structure.nodePaths, currentFolder);
    const cacheKey = 'canonical-v7:depth-' + analysisDepth + ':' + name + ':' + componentEvidenceFingerprint(name, sourceFiles);
    const cached = loadCache(currentFolder);
    if (cached?.drilldowns?.[cacheKey]) {
      return { ok: true, mermaid: cached.drilldowns[cacheKey], fromCache: true };
    }

    // Combine source from top matching files (cap at 8000 chars total)
    let sourceCode = '';
    const usedFiles: string[] = [];
    let budget = 8000;
    for (const { filePath, content } of sourceFiles) {
      const rel = path.relative(currentFolder, filePath);
      const chunk = content.slice(0, budget);
      sourceCode += `\n// ── ${rel} ──\n${chunk}`;
      usedFiles.push(rel);
      budget -= chunk.length;
      if (budget <= 0) break;
    }

    // Fall back to project structure when no source found
    const contextForClaude = sourceCode.trim()
      ? sourceCode
      : `// No source file found for "${name}" — using project structure and Graphify evidence when available.\n${groundedStructureJson(currentFolder, structure, name).json.slice(0, 9000)}`;

    // Reverse dependencies: which files mention this component
    const usedSet = new Set(sourceFiles.map(f => f.filePath));
    const calledBy: string[] = [];
    for (const [fname, fp] of Object.entries(structure.nodePaths)) {
      if (usedSet.has(fp)) continue;
      try {
        if (fs.readFileSync(fp, 'utf8').includes(name))
          calledBy.push(fname.replace(/\.[^.]+$/, ''));
      } catch { /* ignore */ }
    }

    const importMatches = sourceCode.match(/import\s+.*?['"][^'"]+['"]/g) || [];
    const imports = [...new Set(importMatches.slice(0, 12)
      .map(m => m.replace(/^import\s+.*?from\s+['"]/, '').replace(/['"].*/, '').split('/').pop() || ''))].filter(Boolean);

    console.log(`[drilldown] "${name}" files:[${usedFiles.join(',')}] calledBy:[${calledBy.slice(0, 5).join(',')}]`);

    const hierarchyContext = buildHierarchyContext(sourceFiles);
    const graphEvidence = graphifyPromptContext(currentFolder, name).evidence;
    const prompt = buildDrilldownPrompt(name, contextForClaude, imports, calledBy.slice(0, 8), hierarchyContext, graphEvidence);
    const raw = await (isolated ? runIsolatedCapture : runCapture)(prompt, currentFolder);
    const parsed = extractJson(raw) as { mermaid?: string } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    saveDrilldown(currentFolder, cacheKey, parsed.mermaid);
    return { ok: true, mermaid: parsed.mermaid };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:drilldown', (_e, rawName: string) => runComponentDrilldown(rawName));

// ── Code flow ─────────────────────────────────────────────────────────────────

function buildCodeFlowPrompt(name: string, sourceCode: string): string {
  return [
    `Produce a focused Mermaid code flow diagram for the "${name}" feature. Use one connected flowchart; give a function node and description note only to functions that materially advance the entry → outcome chain.`,
    'Output ONLY the JSON below — no fences, no prose.',
    diagramReadabilityGuidance(),
    '',
    'FOR EACH SELECTED SIGNIFICANT FUNCTION, create two nodes:',
    '  1. A function node (rectangle):  Id["functionName()\\nkey code line"]',
    '     - Line 1: exact function name with ()',
    '     - Line 2: the single most important line of real code from that function',
    '  2. A description note (stadium shape):  IdDesc(["what this code line does in plain English"])',
    '     - One sentence, active voice: "Fetches all visits with pending changes before sync"',
    '     - Connect it directly below the function node: Id --> IdDesc',
    '',
    'Then connect function nodes to the NEXT function node with a labelled edge:',
    '  IdDesc -->|variableName| NextId',
    '  Edge label = the exact variable or type being passed (e.g. "allPendingVisits", "AuthToken", "mergedDiffMap")',
    '',
    'EXAMPLE (two functions in same class):',
    '  subgraph SyncManager',
    '    A["preProcess()\\nconst visits = await fetchAllWithPending(api)"]',
    '    ADesc(["Loads every offline visit that has uncommitted changes"])',
    '    B["prepareSync()\\nconst diff = mergeAllDiffs(server, client, ids)"]',
    '    BDesc(["Merges server and client diffs into a single conflict-resolved map"])',
    '    A --> ADesc',
    '    ADesc -->|allPendingVisits| B',
    '    B --> BDesc',
    '  end',
    '',
    'MERMAID SYNTAX:',
    '- Start with `flowchart TD`',
    '- Do NOT use subgraph, classDef, style, click, classDiagram, or sequenceDiagram.',
    '- Function node: `Id["fnName()\\ncode line"]`  — double quotes, \\n between lines',
    '- Description node: `IdDesc(["plain sentence"])`  — stadium shape with double quotes',
    '- Node ids: letters/digits/underscore only, unique across all subgraphs',
    '- Cross-class edges go between the description node of one class and the function node of another',
    '- Select only the source-proven functions needed to explain the entry → orchestration → material branch/boundary → outcome chain. Merge local leaf helpers and repeated transforms into their caller description; every visible node must remain connected.',
    '',
    'Also return "happyPath": ordered list of node IDs that form the optimistic success path (no errors, no retries).',
    '  - Include ONLY function node IDs (not description node IDs)',
    '  - List them in reading order: entry point first, final output last',
    '  - Example: ["A", "B", "C", "D"]',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines","happyPath":["nodeId1","nodeId2","nodeId3"]}',
    '',
    `SOURCE CODE of ${name}:`,
    '```',
    sourceCode.slice(0, 8000),
    '```',
    '',
    'JSON only.',
  ].join('\n');
}

function buildCodeStoryPrompt(name: string, sourceCode: string, hierarchyContext = '', settings: WalkthroughSettings = DEFAULT_WALKTHROUGH_SETTINGS): string {
  return [
    'Explain how the selected component, "' + name + '", behaves when its code runs. Create a plain-English Code Story, not a feature map or a user journey.',
    'Output ONLY the JSON below — no fences, no prose.',
    analysisDepthGuidance(),
    diagramReadabilityGuidance(),
    '',
    'HARD RULES:',
    '- Base every step on the supplied source code. Do not invent screens, user journeys, product features, missing-source handling, or hypothetical behaviour.',
    "- Make the component's behaviour explicit: what triggers it or enters it, what input/state it reads, which decisions it makes, which state/external data it changes or requests, and what result it produces.",
    '- Tell the story of this program running: trigger/input → read or prepare data → decision → work or side effect → result. Omit a stage only when the source does not prove it.',
    '- Begin with the real input, state, or response structure, but translate it for a first-time reader. Say what the information MEANS, not its raw field names.',
    '- Then trace that same information through every step: what each operation reads, adds, removes, changes, sends, stores, or returns.',
    '- Do not invent values or fields. If the source only proves a type/shape, explain the role truthfully in plain English rather than displaying symbolic names.',
    '- This is NOT a user journey. Do not use actions such as "tap", "open screen", "browse", or "sign in" unless that exact action is the code operation being explained.',
    '- If the code does not prove a step, leave it out.',
    '- This is a separate view from the user-flow Drilldown. Never copy a Drilldown step, its numbering, user actions, or its branch layout. Begin at the selected component internal entry point and end when it hands off a prepared result.',
    hierarchyContext ? [
      '',
      'LOCAL AST EVIDENCE (authoritative):',
      '- The following hierarchy and call edges are statically extracted from the local source.',
      '- Follow these edges for function sequencing. Do not turn a class-contains-method edge into a runtime call.',
      '- Do not invent a call, method, or ownership relationship that is absent from this evidence and source.',
      hierarchyContext,
    ].join('\n') : '',
    '',
    'WHAT TO SHOW:',
    '- Tell one clear feature story across the supplied files: entry/input → orchestration → material decision or boundary → result. Add only failure, empty, or alternate paths that change the outcome; merge local mechanics into the closest meaningful step.',
    '- Treat every meaningful boundary as a contract, not a black box. When the source shows a call across components, processes, services, repositories, storage, or an external system, say who calls whom, what information crosses the boundary, and what comes back (including a proved failure or empty result).',
    '- For each source-proven REST/HTTP call, show a request and response boundary. Name the method and path, then describe only the proved path/query/header/body fields and response fields, types, status, or errors. Use `unknown` where the source does not prove a detail; never turn “load data” into a vague substitute for an endpoint contract.',
    '- A provider name alone is NOT a contract. Never emit a node such as “Remote recognition API called” without its adjacent request and response details. If a library/SDK hides the HTTP request, state `Endpoint: unknown (provider SDK)` and name the proved SDK operation, input shape, and returned result shape; do not guess the provider endpoint.',
    '- When data is persisted, explain the storage contract: the proven record/entity shape or key, whether it is read, created, updated, or deleted, and the result returned to the caller. Do not infer database tables or columns that are not in the source.',
    '- Use as many connected steps as the source-proven path needs, ordered from top to bottom. Do not stop at the first helper when the supplied source shows what it calls next.',
    '- Every node must stand on its own for a developer seeing this codebase for the first time: write the action, the meaning of the data, and the purpose in everyday language. Good: "Receive the selected visit details", "Find the selected visit in local storage", "Check whether the visit can continue", "Save the completed survey result". Bad: "Action binding received", "selectedVisitODataReadLink", "isSurvey", "visitWithoutCheckin", or any other raw identifier.',
    '- Never put variable names, parameter names, binding names, OData names, field names, acronyms, file paths, class names, or function names in a Mermaid node or edge. Translate them: selectedVisitODataReadLink becomes "the selected visit reference"; isSurvey becomes "whether this action opens a survey". If a code name is necessary for verification, put it only at the end of its description as Evidence: name in file.',
    '- Name conditional behaviour truthfully. If the source branches, show both meaningful outcomes with labels such as "valid data" and "missing data"; do not quietly present only the happy path.',
    '- Do not use function names, class names, variable names, file paths, or source code in the chart.',
    '- Edge labels are the data or decision in plain English: "answers", "missing field", "valid survey".',
    '- Every main-path edge MUST name the data that moves to the next step, not a vague action. Examples: "raw PCM samples", "validated request", "normalized track record", "sync payload".',
    '',
    'DESCRIPTIONS:',
    '- Give every node two short sentences: first, what it means in everyday language; second, why this step is needed before the next one.',
    '- Every description must state the information interaction in this form: "Meaning: [plain-language state before] → [plain-language state after]. Why: [why this read, change, or send is needed]."',
    '- For a boundary node, add `Contract:` after Meaning: identify caller → receiver, transport (direct call, event, IPC, HTTP/REST, repository, or storage), input → result/error. For HTTP include `Endpoint: METHOD /path`, and for storage include `Record: proven key/fields or unknown`. Keep it factual and readable.',
    '- Do not mention code names, file paths, design patterns, or developer terminology in the reader-facing explanation.',
    '',
    'DATA SNAPSHOTS:',
    '- For every main-path node, return dataFlow with a source-proven representative input and output shape plus the transformation. This is a visual before to after trace for a developer.',
    '- Use the real type, serializer, mapper, request model, or fields from source when proven. Show compact JSON-like values, arrays, or typed records in the application format.',
    '- If a field or shape is not proven, write "unknown (not exposed by source)"; never invent IDs, endpoints, field names, values, or payload formats.',
    '- Keep each input/output under 300 characters. Redact secrets and credentials.',
    '',
    'MERMAID:',
    '- Start with flowchart TD.',
    '- Use Id[Plain English Step] node syntax.',
    '- Use fresh neutral IDs such as A, B, C. Do not use Drilldown S-numbers or reproduce its user-facing steps.',
    '- Use A -->|plain English data or decision| B edges.',
    '- No subgraphs, no code snippets, and no technical boilerplate.',
    '',
    'happyPath is the ordered list of node IDs for the main successful path.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines","descriptions":{"Node Label":"Plain-English explanation of this step."},"dataFlow":{"Node Label":{"input":"{...}","output":"{...}","change":"what changed"}},"happyPath":["nodeId1","nodeId2"]}',
    '',
    'SOURCE CODE of ' + name + ':',
    sourceCode.slice(0, 16000),
    '',
    buildWalkthroughFocusSection(settings),
    buildImplementationFocusEvidence(settings),
    '',
    'JSON only.',
  ].join('\n');
}

/** A second pass that reviews the first diagram as a developer new to this codebase. */
function buildCodeStoryNewbieReviewPrompt(
  name: string, sourceCode: string, hierarchyContext: string, candidate: { mermaid?: string; descriptions?: Record<string, string>; dataFlow?: Record<string, DataFlowSnapshot>; happyPath?: string[] }, usesPriorTurn = false,
): string {
  return [
    `You are a senior developer reviewing a "How it works" explanation of "${name}" for a teammate opening this codebase for the first time.`,
    'Improve the candidate diagram rather than giving general feedback. Output ONLY the replacement JSON—no fences or prose.',
    diagramReadabilityGuidance(),
    '',
    'REVIEW STANDARD:',
    '- Preserve only source-proven behavior. Remove guesses; use `unknown` when a contract detail is not in the evidence.',
    '- Make the full runtime path understandable: entry/trigger → data read or preparation → decisions → calls and side effects → returned or visible result.',
    '- Do not leave a boundary as a black box. For each meaningful component/service/repository/storage/IPC/event handoff, describe caller → receiver, transport, input, and return/error.',
    '- For every source-proven HTTP/REST call, describe the request and response contract: METHOD/path, proven path/query/header/body fields, response fields/types/status or `unknown`, and how the result is used.',
    '- For persistence, state the proven record/key and whether it reads, creates, updates, or deletes. For SDKs that hide HTTP, say `Endpoint: unknown (provider SDK)` and identify the proved operation/input/output.',
    '- Add meaningful success, empty, validation, and failure branches when source proves them. Do not add imagined errors.',
    '- Node labels remain short and readable. Put the detailed contract explanation in `descriptions`, one per node.',
    '- Each description must teach a newcomer: Meaning (before → after), Contract (when a boundary exists), and Why (why this step is necessary).',
    '- Ensure every main-path node has a dataFlow entry with compact, source-proven input/output snapshots and a precise transformation. Use "unknown (not exposed by source)" instead of invented fields or values.',
    '- Keep Mermaid nodes connected. Start with `flowchart TD`; use plain IDs and no subgraphs, styles, or code snippets.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string","descriptions":{"Node label":"Meaning: ... Contract: ... Why: ..."},"dataFlow":{"Node label":{"input":"{...}","output":"{...}","change":"..."}},"happyPath":["nodeId"]}',
    '',
    'CANDIDATE TO IMPROVE:', JSON.stringify(candidate),
    '',
    usesPriorTurn
      ? 'SOURCE AND GRAPH EVIDENCE: Use the complete source code and hierarchy/Graphify evidence from the immediately preceding Code Story turn in this same project session. Do not invent details absent from that evidence.'
      : `SOURCE CODE:\n${sourceCode.slice(0, 9000)}`,
    !usesPriorTurn && hierarchyContext ? `\nSOURCE-PROVEN HIERARCHY AND GRAPH EVIDENCE:\n${hierarchyContext.slice(0, 8000)}` : '',
    '',
    'Replacement JSON only.',
  ].join('\n');
}

function shouldRunCodeStoryReview(sourceCode: string, candidate: { mermaid?: string; descriptions?: Record<string, string> }): boolean {
  // Deep mode requests the full newcomer audit. At lower depths, pay for it
  // only when the local evidence crosses a contract boundary worth explaining.
  if (analysisDepth === 3) return true;
  const evidence = `${sourceCode}\n${candidate.mermaid ?? ''}\n${Object.values(candidate.descriptions ?? {}).join(' ')}`;
  return /\b(https?|retrofit|okhttp|api|repository|dao|database|datastore|storage|sharedpreferences|ipc|socket|fetch|axios|service|insert|update|delete|select|emit|event)\b/i.test(evidence);
}

function buildWalkthroughFocusSection(settings: WalkthroughSettings): string {
  const lines: string[] = [];
  if (settings.entryPoints) lines.push('- ENTRY POINTS: Explicitly identify every trigger, entry function, or starting event and explain its real signature.');
  if (settings.callChain) lines.push('- CALL CHAIN: Trace the complete entry → exit chain, but render cards only for functions that cross a meaningful boundary or change control/data/outcome. Fold adjacent local helpers into their caller description.');
  if (settings.asyncPatterns) lines.push('- ASYNC PATTERNS: Surface async/await, Promise chains, and callbacks only where they affect ordering, concurrency, failure, or the returned result. State whether those meaningful operations run sequentially or in parallel.');
  if (settings.branchingLogic) lines.push('- BRANCHING LOGIC: Show if/else, switch/case, and try/catch branches whose outcomes materially differ. Name the condition and meaningful outcome paths; summarise repetitive guards in their parent card.');
  if (settings.dataFlow) lines.push('- DATA FLOW: Trace the data shape at each key step — what enters, what changes, what leaves. Use source-proven field names.');
  if (settings.dataTypes) lines.push('- DATA TYPES: Name proven input/output types, DTOs, and schemas at every boundary. Use "unknown" where the source does not prove it.');
  if (settings.stateManagement) lines.push('- STATE: Show every piece of state the code reads or writes — where it lives, what mutates it, and in what order.');
  if (settings.dbInteractions) lines.push('- DATABASE: For every DB read/write show the operation (SELECT/INSERT/UPDATE/DELETE), the proven table/entity, key fields used, and result shape returned.');
  if (settings.dbSchema) lines.push('- DB SCHEMA: Show proven table/entity structure at each persistence boundary: primary keys, foreign keys, important columns, and relationships.');
  if (settings.restCalls) lines.push('- REST CALLS: This is required output. For every source-proven HTTP call, add one visible compact HTTP contract card (or a separate request/response card only when the transformation itself is important). Include METHOD and path plus proven request fields as symbolic examples like {id}, response shape, status codes, and error cases in its description. Use "unknown" for anything unproven.');
  if (settings.grpcCalls) lines.push('- GRPC CALLS: For every source-proven gRPC call, add one visible compact RPC contract card (or separate request/response cards only when the transformation is important). Include service/RPC, unary/streaming mode, proven request and response fields, status/error details, and use "unknown" for anything unproven.');
  if (settings.graphqlOps) lines.push('- GRAPHQL: For every GraphQL operation show: type (query/mutation/subscription), name, proven arguments, selection fields, and result/error shape.');
  if (settings.externalIntegrations) lines.push('- EXTERNAL INTEGRATIONS: Show every third-party SDK or external service call — input, result, and how it is used. State "Endpoint: unknown (SDK)" when the HTTP layer is hidden.');
  if (settings.authChecks) lines.push('- AUTH: Show exactly where authentication is verified, what credential or token is checked, what roles are required, and the failure path.');
  if (settings.permissions) lines.push('- PERMISSIONS: Show every authorisation gate: roles/scopes required, where in the call chain they are checked, and any paths that bypass them.');
  if (settings.inputValidation) lines.push('- INPUT VALIDATION: Identify every validation/sanitisation point for external input. Flag any input that reaches a database or shell without validation.');
  if (settings.sensitiveData) lines.push('- SENSITIVE DATA: Flag every read/write/log/transmit of PII, passwords, tokens, or secrets. State how each is protected. Flag any leakage into logs or error messages.');
  if (settings.errorHandling) lines.push('- ERROR HANDLING: Show every try/catch and error path — what errors are expected, how they are transformed, and whether they surface to the caller or are swallowed silently.');
  if (settings.fallbacks) lines.push('- FALLBACKS & RETRIES: Show every fallback value, retry loop, circuit breaker, and timeout — what triggers it and what the caller receives when it fires.');
  if (settings.caching) lines.push('- CACHING: Show every cache read/write: key strategy, TTL if proven, what triggers invalidation, and the cache-miss path.');
  if (settings.concurrency) lines.push('- CONCURRENCY: Show parallel operations and shared mutable state. Flag race condition risks and debounce/throttle patterns.');
  if (settings.logging) lines.push('- LOGGING: Show every log write, metric emission, or tracing span. State what data is included and at what level. Flag any sensitive data that could appear in logs.');
  if (settings.events) lines.push('- EVENTS & MESSAGING: Show every event emitted or consumed — name, proven payload shape, transport mechanism, and ordering guarantees.');
  if (settings.testCoverage) lines.push('- TEST COVERAGE: Identify which functions and branches have associated tests. Show mock/stub boundaries. Flag important paths with no proven test coverage.');
  if (settings.designPatterns) lines.push('- DESIGN PATTERNS: Name every design pattern present and every layer boundary. Explain why the pattern is used when the source makes it clear.');
  if (settings.businessLogic) lines.push('- BUSINESS LOGIC: Identify every business rule, domain constraint, and invariant enforced. State each rule in plain English and point to where in the code it is enforced.');
  if (settings.frameworkUnderstanding) lines.push('- FRAMEWORK UNDERSTANDING: Identify the framework and its source-proven conventions used by this feature. Explain each convention in plain English: what the framework does for this code, what the application supplies, and how the request/event/result moves through it.');
  if (lines.length === 0) return '';
  return '\n\nREQUIRED FOCUS AREAS (the user selected these):\n'
    + '- For every selected area that the source proves, add at least one explicit, visible node or branch in the Mermaid diagram and explain it in its matching description. Do not satisfy a selected area only in prose.\n'
    + '- If the supplied source contains no evidence for a selected area, do not invent it; state that it is not evidenced in the relevant description when the diagram has an applicable boundary.\n'
    + lines.join('\n');
}

/** Focus settings need concrete code-card evidence, not a passing mention. */
function buildImplementationFocusEvidence(settings: WalkthroughSettings): string {
  const rules: string[] = [];
  if (settings.restCalls) rules.push('- REST CALLS: when the selected chain reaches a source-proven HTTP boundary, prioritize separate cards for (1) request data-class/DTO construction with its proven fields, (2) the client call with METHOD and path, and (3) response data-class/DTO decoding or consumption with its proven fields. A status code alone is incomplete. If the source does not prove a boundary, field, or endpoint, do not add it.');
  if (settings.grpcCalls) rules.push('- GRPC CALLS: include separate cards for the source-proven service/RPC invocation, request message fields, response or streaming result fields, and the caller that consumes them. Do not infer service methods or message fields.');
  if (settings.graphqlOps) rules.push('- GRAPHQL: include separate cards for the operation definition, proven variables/input fields, and the returned selection/result fields. A bare operation name is incomplete.');
  if (settings.dataFlow || settings.dataTypes) rules.push('- DATA FLOW / TYPES: each important handoff must name the source-proven input shape, fields read or changed, and output shape in its card explanation. Do not replace a data class with a vague word such as payload.');
  if (settings.dbInteractions || settings.dbSchema) rules.push('- DATABASE: show the call that constructs/reads the entity, the repository/DAO operation, and the returned entity/result. Name only fields, keys, and operations proved by the source.');
  if (settings.authChecks || settings.permissions) rules.push('- AUTH / PERMISSIONS: show the exact guard or credential read, the decision it makes, and the failure handoff as distinct cards.');
  if (settings.inputValidation) rules.push('- INPUT VALIDATION: show the input read, the validation condition, and both accepted and rejected outcomes as distinct cards when source-proven.');
  if (settings.errorHandling || settings.fallbacks) rules.push('- ERRORS / FALLBACKS: show the throwing call or failure result, the catch/branch, and what the caller receives next. Do not summarize this as only an error status.');
  if (settings.asyncPatterns || settings.concurrency) rules.push('- ASYNC / CONCURRENCY: show the awaited or parallel call and the point where its result is joined, handled, or returned.');
  if (settings.stateManagement || settings.caching || settings.events) rules.push('- STATE / CACHE / EVENTS: show the exact read, write, emit, or consume operation and the state/value before and after it.');
  if (settings.frameworkUnderstanding) rules.push('- FRAMEWORK UNDERSTANDING: when the selected chain uses a source-proven framework convention, add a dedicated card that shows the relevant framework hook, base-class method, annotation, lifecycle callback, middleware, or injected service. Explain in plain English what the framework invokes automatically, what this application code contributes, and why this convention leads to the next step. Do not name a framework that source evidence does not prove.');
  if (rules.length === 0) return '';
  return '\n\nFOCUS DISCOVERY RULES:\n- Treat selected focus areas as lenses while tracing the source. When the selected chain contains source-proven evidence for one, surface that evidence in dedicated code cards instead of a generic summary, status, or label.\n- Do not invent a focus area, add unrelated calls, or claim missing details just because its setting is selected.\n' + rules.join('\n');
}

function buildImplementationPrompt(name: string, sourceCode: string, hierarchyContext = '', settings: WalkthroughSettings = DEFAULT_WALKTHROUGH_SETTINGS): string {
  return [
    'You are a senior engineer translating the source code of “' + name + '” for a new team member.',
    'Produce a simple-English code walkthrough in flowchart form. Every visible step must be anchored to the real function, method, class, or handler that performs it, so someone can follow the chart and then find that code in the source.',
    'Output ONLY the JSON below — no fences, no prose.',
    analysisDepthGuidance(), '',
    diagramReadabilityGuidance(),
    'YOUR GOAL:',
    'After reading the flowchart, the developer should know which real entry point starts the work, which key functions it calls, what key state or data changes, what material check occurs, and how it finishes. Prefer an understandable chain over a complete call dump; combine nearby local mechanics into the card that owns their outcome.',
    '',
    'DIAGRAM — flowchart TD:',
    '- This is a FOCUSED FUNCTION CHAIN, not a full call dump. Prioritize the entry point, meaningful orchestration, decisions that alter control flow, consequential data reads/writes, cross-component calls, external boundaries, and final result. Merge leaf helpers, adjacent transforms, logging, trivial getters/setters, simple adapters, and boilerplate into the nearest important card.',
    '- SEQUENCE IS THE PRIMARY TEACHING GOAL: number the main chain in execution order. Every main-path node label starts with Step N — followed by its exact source symbol and short explanation, for example Step 1 — MainServlet.service receives request. Use consecutive numbers with no gaps.',
    '- Every arrow represents a real caller → callee relationship in that focused chain. Label it calls functionName() for a direct call, or returns result to functionName() for a meaningful return. Use an explicit source symbol in every call label so a developer can follow the code without guessing.',
    '- On the main chain, every arrow label must start with the destination step number, for example Step 2 — calls requestForTenant(). This makes the reading order unambiguous even when cards are far apart.',
    '- Mermaid node labels must be a single line, maximum 64 characters. Do not put source code or multiline content in Mermaid labels.',
    '- The renderer turns each node into an Excalidraw code card. Put the exact source snippet in its description as specified below; never put code inside Mermaid.',
    '- For branches, label outgoing arrows with the source-proven condition and then the next function, such as tenant exists → calls checkTenant().',
    '- One node per important function or boundary. Each node must contribute a distinct step in the outcome; merge nearby implementation details into the nearest important caller.',
    '- FUNCTION CHAIN IS REQUIRED: draw one clear source-proven caller → callee route from entry point through the important work to the returned result. Do not add disconnected utility functions or alternate paths unless they materially change the result.',
    '- Node syntax: use short safe IDs (A, B, C...) and plain, quoted labels, for example: A["Load the saved project"].',
    '- Draw an arrow from A to B wherever A calls B.',
    '- Use a diamond node only for a source-proven conditional branch whose outcomes materially change the path or result; describe minor guards in the preceding card.',
    '- Represent an external service, storage area, or platform API with a normal plain-English action; do not name its implementation class or provider.',
    '- Edge labels must say the meaning of the information or decision, not its code name or type.',
    '- Include the significant source-proven functions and boundaries in one obvious top-to-bottom numbered chain. Return happyPath as every main-chain node ID in Step order.',
    '',
    'DESCRIPTIONS:',
    '- Every description MUST use this exact layout: Code:\n[one to five exact, consecutive source lines; each line at most 72 characters]\n\nExplanation: [one or two concise sentences explaining the inputs, result/state change, and why this function runs after the preceding step].\nNext: [Step N and its function name, plus why this call happens; or final result].',
    '- Preserve indentation in the Code section. A short method signature plus its key body line is preferred over a long expression. Do not use markdown fences.',
    '- For a request, storage, event, or other boundary, say in ordinary language what is sent and what comes back. Include a method/path only if proven by source, but never raw function, class, variable, type, or provider names.',
    '- Do not use vague wording such as “handles”, “processes”, or “manages”. Say the concrete action instead.',
    '- The description key must match the plain-English node label exactly.',
    '',
    'WHAT TO EXCLUDE:',
    '- No user-journey language (“user taps”, “screen opens”, “user sees”). This is about code execution, not UX.',
    '- No invented behaviour. Only what the source proves.',
    '- No file paths, import statements, or invented code. Every Code section must be copied from the supplied source.',
    '',
    hierarchyContext ? 'CODE STRUCTURE EVIDENCE (authoritative — use for call order and ownership):\n' + hierarchyContext + '\n' : '',
    'Schema:',
    '{“mermaid”:”flowchart TD\\n  A[Read the sign-in details] -->|complete details| B{Are the details complete}\\n  B -->|yes| C[Ask the account service to verify them]\\n  B -->|no| D[Show what needs fixing]”,”descriptions”:{“Read the sign-in details”:”It starts with the sign-in details and prepares them for checking. This is needed before the account can be verified.”},”happyPath”:[“A”,”B”,”C”]}',
    '',
    'SOURCE CODE of ' + name + ':',
    sourceCode.slice(0, 16000),
    '',
    buildWalkthroughFocusSection(settings),
    buildImplementationFocusEvidence(settings),
    '',
    'JSON only.',
  ].join('\n');
}

function buildRepositoryCodeStoryPrompt(projectStructure: string): string {
  return [
    'Create one plain-English Code Story for this entire repository. This is a guided overview for a developer who needs to understand what the application does and how its major parts work together.',
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(),
    diagramReadabilityGuidance(),
    '',
    'WHAT TO SHOW:',
    '- Show the most important responsibilities or feature areas in the order a request or user action moves through the application. Use enough cards to distinguish independent workflows, while grouping related mechanics under their owning responsibility.',
    '- Begin with the app entry or user action and finish with the visible result, stored data, or external effect.',
    '- Combine implementation details into meaningful steps. Do not create one node per file, class, or function.',
    '- If the repository has independent feature areas, show a small set of clear paths from the shared entry point, then their outcomes. Group closely related feature mechanics under the same path.',
    '- Node labels must be plain English: no function names, class names, source code, or folder paths.',
    '- Every edge must say what is passed or decided in plain English.',
    '- Do not hide system boundaries. For every source-proven API, IPC, storage, repository, or inter-component handoff, identify caller → receiver, transport, the meaningful input, and result/error. For HTTP, include METHOD and path plus only proven request/response fields; for persistence, identify the proven record/key and read/write operation. Use `unknown` instead of guessing.',
    '',
    'DESCRIPTIONS:',
    '- Give every node one concise explanation of BOTH how that part works and why it exists.',
    '- Use this exact shape: "How: [the responsibility, data movement, or decision]. Contract: [caller → receiver; transport; input → result/error, or no boundary]. Why: [the purpose] (source references)."',
    '- End each description with one or two relevant source references from the project structure in parentheses, for example: "How: starts the desktop process and opens the workspace window. Why: provides the application entry point (src/main/index.ts)."',
    '',
    'MERMAID:',
    '- Start with flowchart TD.',
    '- Use Id[Plain English Step] nodes and labelled A -->|data or decision| B edges.',
    '- Include only independently important connected responsibilities. No subgraphs, no code snippets, and no technical boilerplate.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string","descriptions":{"Node Label":"How: implementation. Contract: caller → receiver; transport; input → result/error. Why: purpose (path/file.ts)"},"happyPath":["nodeId1","nodeId2"]}',
    '',
    'PROJECT STRUCTURE:',
    projectStructure.slice(0, 18000),
    '',
    'JSON only.',
  ].join('\n');
}

function buildArchitectureStoryPrompt(projectContext: string): string {
  return [
    "Create an architecture explanation a new developer can understand in ten minutes. This is an evidence-based developer orientation package, not a component inventory or an idealised design.",
    'Output ONLY the JSON schema below — no markdown fences or prose outside JSON.',
    analysisDepthGuidance(),
    diagramReadabilityGuidance(),
    '',
    'ANALYSIS RULES:',
    '- Start from actual entry points, then follow imports, calls, configuration, package manifests, tests, and infrastructure definitions in PROJECT CONTEXT.',
    '- Separate confirmed facts, cautious inferences, recommendations, and unknowns. Never invent components, APIs, tables, deployments, credentials, paths, functions, or integrations.',
    '- Cite a relative source path and line number when the context proves it. If a line cannot be determined, cite the path only. Never expose secrets.',
    '- Keep diagrams readable. Omit a diagram only when the repository gives no evidence for that concern; say so in the document.',
    '',
    'DOCUMENT CONTENT — EXPLAIN, DO NOT LIST:',
    '- executiveSummary must say what the software does, who or what triggers it, its primary workflow, and its proven system boundary in 3–5 direct sentences.',
    '- technologyStack must contain only proven language/runtime/framework/build/dependency facts, each with a short source reference.',
    '- sections must use these exact titles where evidence exists: System context; High-level architecture; Component and module breakdown; Critical execution flows; Data and integrations; State, concurrency, and resilience; Security; Infrastructure, build, and testing; Architectural risks and improvement opportunities.',
    '- Each section must explain responsibility, direction of control/data movement, contracts, and why the boundary exists. Cite only the 2–6 most important relevant source paths; do not dump every path.',
    '- Component breakdown must cover only major logical components. For each: responsibility, entry point/symbol, input/output, dependencies, dependents, and source reference. Keep implementation details out of the high-level explanation.',
    '- Risks must be evidence-based and use: observed evidence → likely impact → practical improvement. Do not call a preference a defect.',
    '- End with unresolved questions for information that the repository does not prove.',
    '',
    'DIAGRAMS — EACH ONE ANSWERS A DIFFERENT QUESTION:',
    '- Return concise Mermaid flowchart TD diagrams under these keys when supported by evidence: communicationFlow, systemContext, highLevel, components, criticalFlow, dataFlow, integrations, deployment, dependencies. Do not return two diagrams that say the same thing.',
    '- communicationFlow is mandatory and is the default canvas view. It must explain the whole proven project communication path: trigger/actor → entry point/UI → feature module or class → domain/use case → repository/service → storage and/or external boundary → response/result back to the caller. Group only trivial workers, callbacks, or repeated mechanics when that makes the flow clearer.',
    '- For every proven HTTP/API operation, use ONE short boundary node labelled HTTP METHOD /path between the caller and external system—do not create separate request and response boxes. The card is the contract; the outgoing and return arrows show where the call goes and where its result is used. For every proven database operation, show DB read/write — entity or table and its returned data/result. If a request, response, status, entity, or error is not proven, label it unknown rather than guessing.',
    '- For direct module/class interactions, label each arrow with plain English plus the actual proven contract when useful: `direct call — task details`, `callback — progress update`, `read — cached profile`, `returns — result/error`. Show return/callback arrows for material results and errors; do not draw every helper function.',
    '- Component nodes may use a verified module, class, or interface name when it clarifies the real interaction, followed by a short plain-English responsibility. Examples: `OrderViewModel — owns screen state` or `OrderRepository — reads orders`. Never use a symbol that is not present in the repository.',
    '- systemContext: show actors, this project as one internal system, proven external systems, trust/boundary crossings, and protocols. Do not show internal classes.',
    '- highLevel: use the smallest clear set of major layers and boundaries—typically a compact entry → feature/domain → state/data/integration → external-system path. Add a card only for an independently important boundary or responsibility.',
    '- components: show every major module and its dependency direction. A component node needs a responsibility, not a file list.',
    '- criticalFlow/dataFlow/integrations/deployment/dependencies: include only if source evidence proves them; focus each diagram on its named concern.',
    '- Keep labels short enough to read at a glance. Never put file paths, package names, line numbers, or long explanations inside diagram nodes. Verified class/module names are allowed only in communicationFlow/components; put all source traceability in descriptions and document evidence instead.',
    '- Label arrows with protocol, event, input/output, or responsibility. Distinguish internal vs external with the literal prefixes "Internal: " and "External: " when both appear. Use "unknown" rather than inventing absent layers.',
    '- Use only flowchart TD; no classDef, styles, subgraphs, click handlers, code snippets, or sequenceDiagram.',
    '- Normal-node descriptions use: What: responsibility and data/control relationship. Evidence: path[:line]. For EVERY HTTP boundary node, use this exact multiline contract instead: HTTP Contract:\\nMethod: GET|POST|PUT|PATCH|DELETE|unknown\\nEndpoint: /proven-path or unknown\\nRequest:\\n{ only source-proven fields/types }\\nResponse:\\n{ only source-proven fields/types }\\nEvidence: path[:line]. Use symbolic placeholders such as {id} only when the field is source-proven. This exact format is rendered as a readable API card.',
    '',
    'JSON SCHEMA:',
    '{"diagrams":{"communicationFlow":"flowchart TD...","systemContext":"flowchart TD...","highLevel":"flowchart TD...","components":"flowchart TD...","criticalFlow":"flowchart TD...","dataFlow":"flowchart TD...","integrations":"flowchart TD...","deployment":"flowchart TD...","dependencies":"flowchart TD..."},"descriptions":{"HTTP GET /products":"HTTP Contract:\\nMethod: GET\\nEndpoint: /products\\nRequest:\\n{ id: \\"{id}\\" }\\nResponse:\\n{ name: \\"string\\" }\\nEvidence: src/api.ts:10","Other node":"What: finding. Evidence: path[:line]."},"document":{"executiveSummary":"confirmed project purpose and system boundary","technologyStack":["language/framework (evidence)"],"sections":[{"title":"Component and module breakdown","content":"confirmed findings, data/contracts, dependents, risks or unknowns","evidence":["relative/path:line"]}],"unresolved":["Unknown deployment topology — no infrastructure definition found"]}}',
    '',
    'PROJECT CONTEXT:',
    projectContext.slice(0, 50000),
    '',
    'JSON only.',
  ].join('\n');
}

/**
 * The first pass discovers the architecture. This second pass is deliberately
 * narrower: it audits every boundary against source evidence and the user's
 * selected focus filters, then returns a replacement architecture package.
 */
function buildArchitectureBoundaryReviewPrompt(
  projectContext: string,
  candidate: { diagrams: Record<string, string>; descriptions: Record<string, string>; document?: ArchitectureDocument },
  settings: WalkthroughSettings,
): string {
  return [
    'Review and replace this Technical Architecture package. Treat the candidate as incomplete until every source-proven boundary and every selected focus area has been checked against PROJECT CONTEXT.',
    'Output ONLY replacement JSON using the same schema — no fences, commentary, or review notes.',
    diagramReadabilityGuidance(),
    '',
    'NON-NEGOTIABLE BOUNDARY AUDIT:',
    '- Preserve correct candidate content, remove guesses, and add only source-proven information. Use unknown where the source does not expose a required detail.',
    '- For EVERY proven HTTP or REST call, use exactly one short boundary node labelled HTTP METHOD /path. Do not create separate request and response nodes: its card presents the complete request/response contract, while arrows show the caller, external boundary, and where the result returns.',
    '- EVERY HTTP boundary description must use this exact layout so the canvas can draw an API contract card: HTTP Contract:\\nMethod: GET|POST|PUT|PATCH|DELETE|unknown\\nEndpoint: /proven-path or unknown\\nRequest:\\n{ only source-proven fields/types }\\nResponse:\\n{ only source-proven fields/types }\\nEvidence: path[:line]. Use a symbolic object and unknown for any unproven field, status, header, error, or credential. Never fabricate real values.',
    '- For EVERY proven database or storage call, visibly show the actual operation and target: SQL/DAO/ORM/client method when proven, read/create/update/delete action, proven table/entity/key, and returned result. In descriptions, name the actual call format only when the source proves it, such as SQL SELECT, Room DAO query, Prisma findMany, or Supabase from table select.',
    '- For EVERY proven gRPC call, visibly show service or RPC method, unary or streaming mode when proven, a request step, and a response or stream-result step. Descriptions must include symbolic request/response shapes using only proven fields.',
    '- For GraphQL, SDK, message/event, cache, or other integration boundaries, apply the same rule: show the actual proven operation, source-proven input format, returned data/error, and how the caller uses it. If an SDK hides its endpoint, write Endpoint: unknown provider SDK.',
    '- Component-to-component arrows must identify the source-proven operation and the meaningful input/result. Do not turn tiny helpers into separate nodes.',
    '- Keep diagrams readable: put long sample payloads and contracts in descriptions, not Mermaid labels. Keep all diagrams as flowchart TD with labelled edges.',
    '',
    buildWalkthroughFocusSection(settings) || 'No optional focus filters are selected. The boundary audit above still applies.',
    '',
    'JSON SCHEMA:',
    '{"diagrams":{"communicationFlow":"flowchart TD...","systemContext":"flowchart TD...","highLevel":"flowchart TD...","components":"flowchart TD...","criticalFlow":"flowchart TD...","dataFlow":"flowchart TD...","integrations":"flowchart TD...","deployment":"flowchart TD...","dependencies":"flowchart TD..."},"descriptions":{"HTTP GET /products":"HTTP Contract:\\nMethod: GET\\nEndpoint: /products\\nRequest:\\n{ id: \\"{id}\\" }\\nResponse:\\n{ name: \\"string\\" }\\nEvidence: src/api.ts:10","Other node":"What: responsibility. Evidence: path[:line]."},"document":{"executiveSummary":"...","technologyStack":["..."],"sections":[{"title":"Data and integrations","content":"...","evidence":["path:line"]}],"unresolved":["..."]}}',
    '',
    'CANDIDATE TO RECHECK:', JSON.stringify(candidate),
    '',
    'PROJECT CONTEXT:', projectContext.slice(0, 50000),
    '',
    'Replacement JSON only.',
  ].join('\n');
}

function buildRepositoryImplementationPrompt(projectContext: string, settings: WalkthroughSettings = DEFAULT_WALKTHROUGH_SETTINGS): string {
  return [
    'Create a feature-by-feature “How it builds” map for this repository. Explain how EVERY meaningful feature found in the supplied source is implemented in plain English, so a developer can understand the code flow just by reading the chart.',
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(), '',
    diagramReadabilityGuidance(),
    'WHAT TO SHOW:',
    '- First show the shared startup/entry point. Then create one clearly labelled branch for EACH meaningful, independent feature or workflow found in the source. A feature is a cohesive user or domain capability, not an individual file or helper.',
    '- Treat build scripts, dependency manifests, plugin setup, and generated configuration as infrastructure—not features. Do not devote a feature branch to them unless the repository contains no application or domain feature code.',
    '- For every feature, show its actual implementation path and meaningful component contracts: trigger or entry → important logic/decision → state, data, or API work → result. Group only repeated low-level mechanics when that improves comprehension.',
    '- Cover each independently important feature the supplied source proves. Group closely related minor features and their mechanics under the feature that owns their outcome.',
    '- Node labels must be plain English operations, not raw class, function, variable, or file names.',
    '- Every description appears directly below its chart node. Use one or two short, plain-English sentences (under 260 characters) that explain the input, the work, the result, and why it matters. Do not include raw function, class, variable, type, or file names in it.',
    '- For EVERY communication between components, describe a contract as: caller → receiver → operation/event and source-proven input → source-proven result/error. State its transport: direct call, event/callback, IPC, HTTP/REST, repository, storage, or other proven mechanism.',
    '- For EVERY proved REST/HTTP endpoint, draw one compact request node and one compact response node: `Request — METHOD path` → `REST boundary` → `Response — result or error`. Keep detailed payloads in node descriptions, not node labels.',
    '- REST request descriptions MUST include a symbolic example: `HTTP Request: METHOD /path?key={Type.field}. Headers: [only proven headers]. Body: { only source-proven fields }.` Example values must be placeholders such as `{query}` or `<token>`, never invented real data.',
    '- REST response descriptions MUST include a symbolic example: `HTTP Response: status [only if proven, otherwise unknown]. Body: { only source-proven fields/types }. Error: [only source-proven error/result]`. If a field, status, header, or error is not proven, write `unknown` instead of guessing.',
    '- Include headers/auth only when source proves them. For direct calls, draw a forward arrow with operation/input and a return arrow with result/error.',
    '- Describe each important object with only source-proven fields or shape, and say whether the step reads, validates, creates, updates, stores, sends, or returns it. Never invent fields or response values.',
    '- For a boundary, explain in plain English who gives what information to whom and what comes back. Include HTTP method/path only when source-proven; otherwise do not expose technical identifiers.',
    '- Show framework, runtime, persistence, API, or external integrations only when the supplied context proves them.',
    '- Do not invent missing layers. Say no persistence or integration is evident when appropriate.',
    '- Every edge is labelled with the data, event, or responsibility passed between steps.', '',
    'MERMAID:',
    '- Start with flowchart TD.',
    '- Use plain Id[Plain English operation] nodes with labelled edges. Create branches from the shared entry point; do NOT use subgraph, classDef, style, click, classDiagram, or sequenceDiagram.',
    '- Connect the shared entry point to every feature entry. No code snippets.', '',
    'Schema:',
    '{“mermaid”:”flowchart TD string”,”descriptions”:{“Node Label”:”It starts with the prepared information and sends it to the next part of the app. This is needed so the result can be saved or shown.”},”happyPath”:[“nodeId1”,”nodeId2”]}', '',
    'PROJECT CONTEXT:', projectContext.slice(0, 50000), '',
    buildWalkthroughFocusSection(settings),
    '', 'JSON only.',
  ].join('\n');
}

function architectureStoryContext(folder: string, structure: ExtractedStructure): string {
  const context: string[] = [groundedStructureJson(folder, structure).json];
  const evidenceFiles = [
    'README.md', 'package.json', 'composer.json', 'pyproject.toml', 'requirements.txt', 'Pipfile',
    'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Podfile', 'pubspec.yaml',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile', 'vite.config.ts', 'webpack.config.js',
    'prisma/schema.prisma', 'firebase.json', 'supabase/config.toml',
  ];

  for (const relative of evidenceFiles) {
    const filePath = path.join(folder, relative);
    try {
      if (fs.statSync(filePath).isFile())
        context.push('\n// ── ' + relative + ' ──\n' + fs.readFileSync(filePath, 'utf8').slice(0, 7000));
    } catch { /* optional project evidence */ }
  }

  const architecturePriority = (filePath: string) => {
    const relative = path.relative(folder, filePath).toLowerCase();
    let score = 0;
    if (/(mainactivity|application|app\.|index\.|main\.|bootstrap|entry)/.test(relative)) score += 80;
    if (/(navigation|router|route|presenter|viewmodel|controller|service|usecase|interactor)/.test(relative)) score += 45;
    if (/(repository|database|dao|store|cache|worker|queue|sync|api|client|network|auth)/.test(relative)) score += 35;
    if (/(test|spec|fixture|mock)/.test(relative)) score -= 15;
    return score;
  };
  const sourceEvidence: string[] = [];
  const relevantPaths = Object.values(structure.nodePaths)
    .sort((left, right) => architecturePriority(right) - architecturePriority(left))
    .slice(0, 45);
  for (const filePath of relevantPaths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (architecturePriority(filePath) > 0 || /\b(useState|useReducer|createStore|configureStore|Provider|zustand|redux|mobx|pinia|vuex|Context|Room|SQLite|Realm|prisma|typeorm|mongoose|sequelize|supabase|firebase|fetch\(|axios|graphql)\b/i.test(content)) {
        sourceEvidence.push('\n// ── ' + path.relative(folder, filePath) + ' ──\n' + content.slice(0, 3500));
      }
    } catch { /* source file may no longer exist */ }
    if (sourceEvidence.join('').length > 22000) break;
  }
  return [...context, ...sourceEvidence].join('\n');
}

function repositoryImplementationContext(folder: string, structure: ExtractedStructure): string {
  const context: string[] = [groundedStructureJson(folder, structure).json];
  let remaining = 40000;
  const paths = Object.values(structure.nodePaths);
  const infrastructure = /(?:^|\/)(?:build|dist|config|configs|scripts?|gradle|webpack)(?:\/|$)|(?:^|\/)(?:package|settings|build|webpack|vite|babel|metro|podfile|gradle)\.[^/]+$/i;
  // Feature code goes first: build/config files are useful evidence, but should
  // not crowd out the workflows the repository actually implements.
  const httpSource = (filePath: string) => {
    try { return /@(GET|POST|PUT|PATCH|DELETE|HEAD)\b|\b(fetch|axios|retrofit|okhttp|graphql|HttpClient|Request\(|Response<)\b/i.test(fs.readFileSync(filePath, 'utf8')); }
    catch { return false; }
  };
  // API declarations and request/response models come first so the AI can show
  // actual contracts rather than merely naming a networking layer.
  const apiPaths = paths.filter(httpSource);
  const orderedPaths = [...new Set([...apiPaths, ...paths.filter(p => !infrastructure.test(path.relative(folder, p))), ...paths.filter(p => infrastructure.test(path.relative(folder, p)))])];
  for (const filePath of orderedPaths) {
    if (remaining <= 0) break;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('\0')) continue;
      const isApiSource = apiPaths.includes(filePath);
      const chunk = content.slice(0, Math.min(isApiSource ? 6000 : 1800, remaining));
      context.push('\n// ── ' + path.relative(folder, filePath) + ' ──\n' + chunk);
      remaining -= chunk.length;
    } catch { /* source file may no longer exist */ }
  }
  return context.join('\n');
}

async function runArchitectureStory(isolated = false): Promise<ArchitectureStoryResult> {
  if (!currentFolder) return { error: 'no project folder' };
  const cacheKey = '__architecture_document__:boundary-review-v8:focus-' + walkthroughSettingsFingerprint(walkthroughSettings);
  try {
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string>; diagrams?: Record<string, string>; document?: ArchitectureDocument };
      if (cached.version === 8 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {}, diagrams: cached.diagrams ?? {}, document: cached.document };
    }

    const structure = extractStructure(currentFolder);
    const context = architectureStoryContext(currentFolder, structure);
    const capture = isolated ? runIsolatedCapture : runCapture;
    const raw = await capture(buildArchitectureStoryPrompt(context), currentFolder);
    const parsed = extractJson(raw) as (Record<string, unknown> & { descriptions?: Record<string, string>; document?: ArchitectureDocument }) | null;
    const diagrams = architectureFlowcharts(parsed);
    const mermaid = diagrams.communicationFlow || diagrams.highLevel || Object.values(diagrams)[0];
    if (!mermaid) {
      // Retain the local provider response so a schema change can be diagnosed
      // without asking the user to reproduce the analysis. It is never synced.
      try { fs.writeFileSync(path.join(os.tmpdir(), 'rex-last-architecture-response.txt'), raw, 'utf8'); } catch { /* diagnostic only */ }
      const returnedKeys = parsed ? Object.keys(parsed).join(', ') : 'no JSON payload';
      console.error('[architecture] No usable Mermaid flowchart. Response keys:', returnedKeys);
      return { error: `Architecture response had no usable Mermaid flowchart (returned: ${returnedKeys}). The raw local response was saved for diagnosis.` };
    }

    let reviewedDiagrams = diagrams;
    let reviewedDescriptions = parsed?.descriptions ?? {};
    let reviewedDocument = parsed?.document;
    try {
      const reviewRaw = await capture(buildArchitectureBoundaryReviewPrompt(
        context,
        { diagrams, descriptions: reviewedDescriptions, document: reviewedDocument },
        walkthroughSettings,
      ), currentFolder);
      const review = extractJson(reviewRaw) as (Record<string, unknown> & { descriptions?: Record<string, string>; document?: ArchitectureDocument }) | null;
      const replacementDiagrams = architectureFlowcharts(review);
      if (Object.keys(replacementDiagrams).length > 0) {
        reviewedDiagrams = replacementDiagrams;
        reviewedDescriptions = review?.descriptions ?? reviewedDescriptions;
        reviewedDocument = review?.document ?? reviewedDocument;
      }
    } catch {
      // A usable first-pass architecture is more helpful than failing the
      // entire action when the enrichment pass is interrupted.
    }

    const reviewedMermaid = reviewedDiagrams.communicationFlow || reviewedDiagrams.highLevel || Object.values(reviewedDiagrams)[0];
    if (!reviewedMermaid) return { error: 'Architecture review produced no usable Mermaid flowchart.' };
    const result = { version: 8, mermaid: reviewedMermaid, descriptions: reviewedDescriptions, diagrams: reviewedDiagrams, document: reviewedDocument };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify(result));
    return { ok: true, mermaid: reviewedMermaid, descriptions: reviewedDescriptions, diagrams: reviewedDiagrams, document: reviewedDocument };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runRepositoryImplementation(isolated = false): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> {
  if (!currentFolder) return { error: 'no project folder' };
    const cacheKey = '__repository_implementation__:adaptive-detail-v13:depth-' + analysisDepth + ':focus-' + walkthroughSettingsFingerprint(walkthroughSettings);
  try {
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string> };
      if (cached.version === 13 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {} };
    }
    const structure = extractStructure(currentFolder);
    const parsed = extractJson(await (isolated ? runIsolatedCapture : runCapture)(buildRepositoryImplementationPrompt(repositoryImplementationContext(currentFolder, structure), walkthroughSettings), currentFolder)) as { mermaid?: string; descriptions?: Record<string, string> } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };
    const result = { version: 13, mermaid: parsed.mermaid, descriptions: parsed.descriptions ?? {} };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify(result));
    return { ok: true, mermaid: result.mermaid, descriptions: result.descriptions };
  } catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
}

async function runComponentCodeFlow(rawName: string, _drillMermaid = '', isolated = false): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; dataFlow?: Record<string, DataFlowSnapshot>; happyPath?: string[]; fromCache?: boolean }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const structure = extractStructure(currentFolder);
    if (name === '__whole_repo__') {
      const cacheKey = `v24:adaptive-detail:depth-${analysisDepth}:${name}:${hashStructure(groundedStructureJson(currentFolder, structure).json)}`;
      const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
      if (typeof cachedValue === 'string') {
        try {
          const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] };
          if (cached.version === 24 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {}, happyPath: cached.happyPath ?? [], fromCache: true };
        } catch {
          // Regenerate malformed cache data.
        }
      }
      const raw = await (isolated ? runIsolatedCapture : runCapture)(buildRepositoryCodeStoryPrompt(groundedStructureJson(currentFolder, structure).json), currentFolder);
      const parsed = extractJson(raw) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
      if (!parsed?.mermaid) return { error: 'no mermaid in response' };
      const happyPath = parsed.happyPath ?? [];
      const descriptions = parsed.descriptions ?? {};
      saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 24, mermaid: parsed.mermaid, descriptions, happyPath }));
      return { ok: true, mermaid: parsed.mermaid, descriptions, happyPath };
    }

    const sourceFiles = sourceFilesForSelection(name, structure.nodePaths, currentFolder);
    const cacheKey = `v24:adaptive-detail:depth-${analysisDepth}:focus-${walkthroughSettingsFingerprint(walkthroughSettings)}:${name}:${componentEvidenceFingerprint(name, sourceFiles)}`;
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const p = JSON.parse(cachedValue) as { version?: number; mermaid: string; descriptions?: Record<string, string>; dataFlow?: Record<string, DataFlowSnapshot>; happyPath: string[] };
        if (p?.version === 24 && p.mermaid) return { ok: true, mermaid: p.mermaid, descriptions: p.descriptions ?? {}, dataFlow: p.dataFlow ?? {}, happyPath: p.happyPath ?? [], fromCache: true };
      } catch {
        // Ignore malformed or legacy entries and regenerate from current source.
      }
    }

    let sourceCode = '';
    let budget = 9000;
    for (const { filePath, content } of sourceFiles) {
      const rel = path.relative(currentFolder, filePath);
      const chunk = content.slice(0, budget);
      sourceCode += `\n// ── ${rel} ──\n${chunk}`;
      budget -= chunk.length;
      if (budget <= 0) break;
    }

    if (!sourceCode.trim()) {
      return { error: `No source code was found for "${name}". Select a code component to create a Code Story.` };
    }

    const handoff = parseSelectedHandoff(name);
    const handoffContext = handoff
      ? `SELECTED CONNECTION (explain this handoff, not either endpoint in isolation): ${handoff.from} → ${handoff.to}. Data or action carried: ${handoff.data}.\n\n`
      : '';
    const hierarchyContext = [buildHierarchyContext(sourceFiles), graphifyPromptContext(currentFolder, name).evidence].filter(Boolean).join('\n\n');
    const capture = isolated ? runIsolatedCapture : runCapture;
    const raw = await capture(buildCodeStoryPrompt(
      name,
      handoffContext + sourceCode,
      hierarchyContext,
      walkthroughSettings,
    ), currentFolder);
    let parsed = extractJson(raw) as { mermaid?: string; descriptions?: Record<string, string>; dataFlow?: Record<string, DataFlowSnapshot>; happyPath?: string[] } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    // The first pass establishes the flow; this second pass fills in contracts
    // that a newcomer needs to follow the implementation with confidence.
    if (shouldRunCodeStoryReview(sourceCode, parsed)) try {
      const reviewed = extractJson(await capture(
        buildCodeStoryNewbieReviewPrompt(name, sourceCode, hierarchyContext, parsed, getAiProvider() === 'claude'),
        currentFolder,
      )) as { mermaid?: string; descriptions?: Record<string, string>; dataFlow?: Record<string, DataFlowSnapshot>; happyPath?: string[] } | null;
      if (reviewed?.mermaid) {
        parsed = {
          ...parsed,
          ...reviewed,
          descriptions: reviewed.descriptions ?? parsed.descriptions,
          dataFlow: reviewed.dataFlow ?? parsed.dataFlow,
          happyPath: reviewed.happyPath ?? parsed.happyPath,
        };
      }
    } catch {
      // The initial, source-grounded story is still useful if the review call fails.
    }

    const happyPath = parsed.happyPath ?? [];
    const descriptions = parsed.descriptions ?? {};
    const dataFlow = parsed.dataFlow ?? {};
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 24, mermaid: parsed.mermaid, descriptions, dataFlow, happyPath }));
    return { ok: true, mermaid: parsed.mermaid, descriptions, dataFlow, happyPath };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:codeflow', (_e, rawName: string, drillMermaid?: string) => runComponentCodeFlow(rawName, drillMermaid));

/** Have the selected AI resolve a product-facing node to real local source files. */
async function runComponentSource(rawName: string): Promise<{ ok: boolean; error?: string; files?: Array<{ path: string; content: string; highlight?: string }>; graphify?: { available: boolean; confidence?: string; matchKind?: string; reasons?: string[] } }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { ok: false, error: 'No component selected' };
  try {
    const structure = extractStructure(currentFolder);
    const graphify = graphifyPromptContext(currentFolder, name);
    const handoff = parseSelectedHandoff(name);
    if (handoff) {
      const handoffFiles = sourceFilesForSelection(name, structure.nodePaths, currentFolder);
      if (handoffFiles.length === 0) return { ok: false, error: `No local source was found for the ${handoff.from} → ${handoff.to} handoff.` };
      return {
        ok: true,
        files: handoffFiles.map(file => ({ path: path.relative(currentFolder!, file.filePath), content: file.content, highlight: handoff.data })),
        graphify: { available: graphify.available, confidence: graphify.resolution?.confidence, matchKind: graphify.resolution?.matchKind, reasons: graphify.resolution?.reasons },
      };
    }
    const sourceHash = hashStructure(toClaudePromptJSON(structure) + ':graphify:' + graphify.fingerprint);
    const cacheKey = `__source_browser__:v5:${name}:${sourceHash}`;
    const isImplementationPath = (relPath: string) => {
      const normalized = relPath.replace(/\\/g, '/');
      return /\.(?:kt|kts|java|swift|m|mm|ts|tsx|js|jsx|dart|py|go|rs|cs|cpp|c|h)$/i.test(normalized)
        && !/(^|\/)(?:test|androidTest|build-logic|node_modules|dist|build|generated)(\/|$)/i.test(normalized);
    };
    const queryTerms = name.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3);
    const availableFiles = Array.from(new Set(Object.values(structure.nodePaths)
      .map(filePath => path.relative(currentFolder!, filePath))
      .filter(isImplementationPath)))
      .sort((a, b) => {
        const score = (value: string) => {
          const lower = value.toLowerCase();
          return (/(^|\/)(?:app|feature)(\/|$)/.test(value) ? 10 : /(^|\/)core(\/|$)/.test(value) ? 4 : 0)
            + queryTerms.filter(term => lower.includes(term)).length * 20;
        };
        return score(b) - score(a) || a.localeCompare(b);
      });
    const availableSet = new Set(availableFiles);
    let paths: string[] = [];
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; files?: string[] };
        if (cached.version === 5 && Array.isArray(cached.files)) paths = cached.files.filter(isImplementationPath);
      } catch { /* resolve again */ }
    }

    if (paths.length === 0) {
      // Graphify is a local, source-proven index. Prefer it before spending an
      // AI request on a filename inference.
      paths = graphifySourceFiles(currentFolder, name).filter(candidate => availableSet.has(candidate));
    }

    if (paths.length === 0) {
      const description = (currentDiagram as { descriptions?: Record<string, string> } | null)?.descriptions?.[name] ?? '';
      const prompt = [
        'Identify the real source files that implement the selected product component. Do not edit anything.',
        `Selected canvas component: ${name}`,
        description ? `Canvas description: ${description}` : '',
        'Inspect the repository if needed. Return every implementation file required to establish the feature behaviour, ordered by graph relevance. Do not omit a required file merely to meet a count.',
        'Choose only application implementation code: screens, navigation, view models, repositories, or domain logic. Never choose JSON, XML/resources, Gradle/build logic, generated code, tests, documentation, or dependency metadata.',
        graphify.available
          ? 'Use the supplied Graphify JSON as the strongest source-relationship evidence. Prefer its source_file values and follow EXTRACTED edges from the selected feature into its implementation.'
          : 'Graphify JSON is not available; infer only from the implementation paths and repository source.',
        'Every path must exactly match one of the available project-relative paths below.',
        'Output ONLY JSON: {"files":["relative/path.ext"]}.',
        'AVAILABLE IMPLEMENTATION PATHS:', availableFiles.join('\n'),
        graphify.available ? graphify.evidence : '',
      ].filter(Boolean).join('\n\n');
      const parsed = extractJson(await runCapture(prompt, currentFolder)) as { files?: unknown } | null;
      if (Array.isArray(parsed?.files)) paths = parsed.files.filter((value): value is string => typeof value === 'string' && availableSet.has(value));
      if (paths.length === 0) paths = graphFirstSourceFiles(name, structure.nodePaths, currentFolder)
        .map(source => path.relative(currentFolder!, source.filePath))
        .filter(isImplementationPath);
    }
    // Persist both local Graphify resolutions and AI fallbacks.
    if (paths.length > 0) saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 5, files: paths }));

    const root = path.resolve(currentFolder);
    const files = paths.flatMap(relPath => {
      const absolute = path.resolve(currentFolder!, relPath);
      if (!absolute.startsWith(root + path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return [];
      try {
        const content = fs.readFileSync(absolute, 'utf8');
        return content.includes('\0') ? [] : [{ path: path.relative(currentFolder!, absolute), content, highlight: name }];
      } catch { return []; }
    });
    if (files.length === 0) return { ok: false, error: `No readable source files were identified for "${name}".` };
    return {
      ok: true,
      files,
      graphify: graphify.available ? {
        available: true,
        confidence: graphify.resolution?.confidence,
        matchKind: graphify.resolution?.matchKind,
        reasons: graphify.resolution?.reasons,
      } : { available: false },
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:source', (_e, rawName: string) => runComponentSource(rawName));

// Source-proven flow: classes, methods, and direct calls from the selected file.
// This is deliberately local/static so it remains available when an AI response
// cannot be converted into Mermaid.
async function runActualCodeFlow(rawName: string): Promise<{ ok: boolean; error?: string; mermaid?: string }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { ok: false, error: 'No component selected' };
  try {
    const structure = extractStructure(currentFolder);
    const source = findSourceFiles(name, structure.nodePaths, currentFolder, 1)[0];
    if (!source?.content.trim()) {
      return { ok: false, error: `No source code was found for "${name}". Select a class, method, or code component.` };
    }
    // Cache against the source itself. A renamed/reselected component can reuse
    // the graph, while any source edit naturally produces a new entry.
    const cacheKey = `__actual_codeflow__:v3:${name}:${hashStructure(source.content)}`;
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string };
        if (cached.version === 3 && cached.mermaid) return { ok: true, mermaid: cached.mermaid };
      } catch { /* regenerate malformed legacy entry */ }
    }

    const mermaid = buildLocalCallHierarchy(source.content);
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 3, mermaid }));
    return { ok: true, mermaid };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:actualCodeFlow', (_e, rawName: string) => runActualCodeFlow(rawName));

async function runComponentImplementation(rawName: string, drillMermaid = '', isolated = false): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const structure = extractStructure(currentFolder);
    const sourceFiles = sourceFilesForSelection(name, structure.nodePaths, currentFolder);
    const cacheKey = '__implementation__:adaptive-detail-v39:depth-' + analysisDepth + ':focus-' + walkthroughSettingsFingerprint(walkthroughSettings) + ':' + name + ':' + componentEvidenceFingerprint(name, sourceFiles);
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] };
      if (!drillMermaid && cached.version === 39 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {}, happyPath: cached.happyPath ?? [] };
    }
    let sourceCode = '';
    let budget = 16000;
    for (const { filePath, content } of sourceFiles) {
      const chunk = content.slice(0, budget);
      sourceCode += '\n// ── ' + path.relative(currentFolder, filePath) + ' ──\n' + chunk;
      budget -= chunk.length;
      if (budget <= 0) break;
    }
    if (!sourceCode.trim()) return { error: `No source code was found for "${name}". Select a code component to explain its implementation.` };
    const handoff = parseSelectedHandoff(name);
    const handoffScope = handoff
      ? `\n\nSELECTED CONNECTION — explain the source-proven handoff from ${handoff.from} to ${handoff.to}. The arrow carries: ${handoff.data}. Focus the walkthrough on how that input is prepared, sent or called, received, and turned into the result.\n`
      : '';
    const scope = drillMermaid
      ? '\n\nFEATURE SCOPE ONLY — this is a user-facing flow. Use it only to identify the feature and its outcomes. Do NOT repeat, paraphrase, or draw its user steps. Explain the source-proven component contracts that make those outcomes happen instead:\n' + drillMermaid
      : '';
    const hierarchyContext = [buildHierarchyContext(sourceFiles), graphifyPromptContext(currentFolder, name).evidence].filter(Boolean).join('\n\n');
    const parsed = extractJson(await (isolated ? runIsolatedCapture : runCapture)(buildImplementationPrompt(name, sourceCode + handoffScope + scope, hierarchyContext, walkthroughSettings), currentFolder)) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };
    const result = { version: 39, mermaid: parsed.mermaid, descriptions: parsed.descriptions ?? {}, happyPath: parsed.happyPath ?? [] };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify(result));
    return { ok: true, mermaid: result.mermaid, descriptions: result.descriptions, happyPath: result.happyPath };
  } catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
}

ipcMain.handle('component:implementation', (_e, rawName: string, drillMermaid?: string) => runComponentImplementation(rawName, drillMermaid));
ipcMain.handle('project:architectureStory', () => runArchitectureStory());
ipcMain.handle('project:implementation', () => runRepositoryImplementation());

/**
 * Return the human labels from the primary analysis map. These are the same
 * first-level components a person can select on the canvas; Mermaid IDs (A,
 * B, and so on) are deliberately excluded so each component is prepared once.
 */
function componentLabelsForWarmup(diagram: object): string[] {
  const structure = (diagram as { diagrams?: { structure?: unknown } }).diagrams?.structure;
  if (typeof structure !== 'string') return [];
  const labelsById = new Map<string, string>();
  const declarationOrder = new Map<string, number>();
  const node = /([A-Za-z][A-Za-z0-9_]*)\s*\[\s*(?:"([^"]+)"|([^\]]+))\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = node.exec(structure))) {
    const label = String(match[2] ?? match[3] ?? '')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || labelsById.has(match[1])) continue;
    labelsById.set(match[1], label);
    declarationOrder.set(match[1], declarationOrder.size);
  }
  if (labelsById.size === 0) return [];

  // People most often inspect the high-level hubs directly below an entry
  // point. Rank those first, then their broad downstream branches. This uses
  // only the source-backed analysis map and never asks the model to guess.
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  const edge = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(?:-->|==>|-\.->|---)\s*(?:\|[^|]*\|\s*)?([A-Za-z][A-Za-z0-9_]*)/;
  for (const line of structure.split('\n')) {
    const pair = line.match(edge);
    if (!pair || !labelsById.has(pair[1]) || !labelsById.has(pair[2])) continue;
    const targets = outgoing.get(pair[1]) ?? new Set<string>();
    targets.add(pair[2]);
    outgoing.set(pair[1], targets);
    incoming.add(pair[2]);
  }

  const roots = [...labelsById.keys()].filter(id => !incoming.has(id));
  const depth = new Map<string, number>();
  const frontier = roots.map(id => ({ id, depth: 0 }));
  while (frontier.length) {
    const current = frontier.shift()!;
    if ((depth.get(current.id) ?? Infinity) <= current.depth) continue;
    depth.set(current.id, current.depth);
    for (const target of outgoing.get(current.id) ?? []) frontier.push({ id: target, depth: current.depth + 1 });
  }

  const descendants = (id: string) => {
    const seen = new Set<string>();
    const visit = (value: string) => {
      for (const next of outgoing.get(value) ?? []) if (!seen.has(next)) { seen.add(next); visit(next); }
    };
    visit(id);
    return seen.size;
  };

  return [...labelsById.keys()]
    .sort((a, b) => {
      const score = (id: string) => {
        const d = depth.get(id) ?? 9;
        const level = d === 1 ? 1200 : d === 2 ? 800 : d === 0 ? 500 : Math.max(0, 500 - d * 60);
        return level + descendants(id) * 25 + (outgoing.get(id)?.size ?? 0) * 80;
      };
      return score(b) - score(a) || (declarationOrder.get(a)! - declarationOrder.get(b)!);
    })
    .map(id => labelsById.get(id)!);
}

function initialiseWarmupQueue(folder: string, analysisHash: string, components: string[]): ComponentWarmupQueue | null {
  const cache = loadCache(folder);
  if (!cache) return null;
  const existing = cache.warmup;
  const componentsState: Record<string, ComponentWarmupState> =
    existing?.version === 2 && existing.analysisHash === analysisHash ? { ...existing.components } : {};
  const now = Date.now();
  for (const name of components) componentsState[name] ??= { updatedAt: now };
  for (const name of Object.keys(componentsState)) if (!components.includes(name)) delete componentsState[name];
  const project = existing?.version === 2 && existing.analysisHash === analysisHash
    ? { ...existing.project }
    : { updatedAt: now };
  const queue: ComponentWarmupQueue = {
    version: 2, analysisHash, project, components: componentsState,
    completed: !!project.codeStory && !!project.architecture && !!project.walkthrough && components.every(name => {
      const state = componentsState[name];
      return !!state?.detail && !!state?.drill && !!state?.story && !!state?.walkthrough;
    }),
    updatedAt: now,
  };
  cache.warmup = queue;
  cache.savedAt = now;
  writeCache(folder, cache);
  return queue;
}

function warmupState(folder: string, analysisHash: string, name: string): ComponentWarmupState | null {
  const queue = loadCache(folder)?.warmup;
  return queue?.version === 2 && queue.analysisHash === analysisHash ? (queue.components[name] ?? null) : null;
}

function recordWarmupStage(folder: string, analysisHash: string, name: string, stage: WarmupStage) {
  const cache = loadCache(folder);
  const queue = cache?.warmup;
  if (!cache || !queue || queue.version !== 2 || queue.analysisHash !== analysisHash) return;
  const now = Date.now();
  queue.components[name] = { ...(queue.components[name] ?? { updatedAt: now }), [stage]: true, updatedAt: now };
  queue.completed = !!queue.project.codeStory && !!queue.project.architecture && !!queue.project.walkthrough
    && Object.values(queue.components).every(state => !!state.detail && !!state.drill && !!state.story && !!state.walkthrough);
  queue.updatedAt = now;
  cache.savedAt = now;
  writeCache(folder, cache);
}

function recordProjectWarmupStage(folder: string, analysisHash: string, stage: ProjectWarmupStage) {
  const cache = loadCache(folder);
  const queue = cache?.warmup;
  if (!cache || !queue || queue.version !== 2 || queue.analysisHash !== analysisHash) return;
  const now = Date.now();
  queue.project = { ...queue.project, [stage]: true, updatedAt: now };
  queue.completed = !!queue.project.codeStory && !!queue.project.architecture && !!queue.project.walkthrough
    && Object.values(queue.components).every(state => !!state.detail && !!state.drill && !!state.story && !!state.walkthrough);
  queue.updatedAt = now;
  cache.savedAt = now;
  writeCache(folder, cache);
}

/**
 * Prepare the project in the order people explore it: the Graphify-backed
 * user flow is the base diagram, followed by project-level views and then one
 * component layer. Component requests use isolated, evidence-rich prompts in
 * a bounded worker pool.
 */
function scheduleComponentCacheWarmup(folder: string, diagram: object, analysisHash: string) {
  const generation = ++componentWarmupGeneration;
  const components = componentLabelsForWarmup(diagram);
  const queue = initialiseWarmupQueue(folder, analysisHash, components);
  if (!queue || queue.completed) return;

  void (async () => {
    const isCurrent = () => generation === componentWarmupGeneration && currentFolder === folder && currentDiagram === diagram;
    const runProjectStage = async (stage: ProjectWarmupStage, label: string, work: () => Promise<{ ok?: boolean; error?: string }>) => {
      if (!isCurrent()) return;
      const state = loadCache(folder)?.warmup;
      if (state?.version === 2 && state.project[stage]) return;
      console.log(`[cache-warmup] ${label}`);
      const result = await work();
      if (result.ok) recordProjectWarmupStage(folder, analysisHash, stage);
      else console.warn(`[cache-warmup] ${label} skipped: ${result.error ?? 'no result'}`);
    };

    await runProjectStage('codeStory', 'Whole-project Code Story', () => runComponentCodeFlow('__whole_repo__', '', true));
    await runProjectStage('architecture', 'Technical Architecture', () => runArchitectureStory(true));
    await runProjectStage('walkthrough', 'Whole-project Code Walkthrough', () => runRepositoryImplementation(true));
    if (!isCurrent()) return;

    let nextComponent = 0;
    const worker = async () => {
      while (isCurrent()) {
        const index = nextComponent++;
        const name = components[index];
        if (!name) return;
        const prefix = `[cache-warmup] ${index + 1}/${components.length} ${name}`;
        const prepare = async (stage: WarmupStage, label: string, work: () => Promise<{ ok?: boolean; error?: string }>) => {
          if (!isCurrent() || warmupState(folder, analysisHash, name)?.[stage]) return;
          console.log(`${prefix} — ${label}`);
          const result = await work();
          if (result.ok) recordWarmupStage(folder, analysisHash, name, stage);
          else console.warn(`${prefix} — ${label} skipped: ${result.error ?? 'no result'}`);
        };
        await prepare('detail', 'Component Detail', () => runComponentDetail(name, true));
        await prepare('drill', 'Drill', () => runComponentDrilldown(name, true));
        await prepare('story', 'Code Story', () => runComponentCodeFlow(name, '', true));
        await prepare('walkthrough', 'Code Walkthrough', () => runComponentImplementation(name, '', true));
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, components.length) }, worker));
    if (generation === componentWarmupGeneration && currentFolder === folder && currentDiagram === diagram) {
      console.log('[cache-warmup] project and first-level component preparation complete');
    }
  })().catch(error => console.error('[cache-warmup] failed:', error instanceof Error ? error.message : String(error)));
}

// ── Git history ───────────────────────────────────────────────────────────────

function buildCommitFeatureFlowPrompt(commitMsg: string, diffSource: string): string {
  return [
    `This git commit was just made: "${commitMsg}"`,
    'Look at the diff below and draw a user-facing feature flow diagram showing WHAT CHANGED for the user.',
    'Output ONLY the JSON below — no fences, no prose.',
    diagramReadabilityGuidance(),
    '',
    'WHAT TO SHOW:',
    '1. The features or user-facing behaviours that changed in this commit.',
    '2. How the user experience is different now vs before.',
    '3. Any new steps, screens, or error states added.',
    '4. Connections to other features that were affected.',
    '',
    'NODE LABELS: plain English actions or states a user would recognise.',
    '   Good: "Enter Email", "Validate Password", "Show Error", "Save Booking"',
    '   Bad: "AuthViewModel.login()", "apiClient.post()", "useState"',
    '',
    'EDGE LABELS: what triggers the transition.',
    '   Good: "taps submit", "password wrong", "success"',
    '   Bad: "calls", "returns Promise", "dispatches"',
    '',
    'MERMAID SYNTAX (follow exactly):',
    '- Start with `flowchart TD`.',
    '- Node id = letters/digits/underscore only. Format: `Id[Label]`.',
    '- Label: letters, digits, spaces only. NO special chars inside [ ].',
    '- Edge with label: `A -->|taps submit| B`.',
    '- NO subgraph, NO classDiagram, NO sequenceDiagram.',
    '- Include every changed user-facing step. Every node must be connected.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines","descriptions":{"NodeLabel":"1 sentence starting with Lets the user or Shows the user"}}',
    '',
    'DIFF:',
    diffSource.slice(0, 6000),
    '',
    'JSON only.',
  ].join('\n');
}

function buildCommitCodeFlowPrompt(commitMsg: string, diffSource: string): string {
  // Extract only added lines from the diff to keep focus tight
  const addedLines = diffSource.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n')
    .slice(0, 3000);

  return [
    `This git commit was just made: "${commitMsg}"`,
    'Look at the diff and draw a code flow for ONLY the functions that were directly added or modified by this commit.',
    'DO NOT include helper functions or callers that were not changed. Focus on what is NEW or DIFFERENT.',
    'Output ONLY the JSON below — no fences, no prose.',
    diagramReadabilityGuidance(),
    '',
    'FOR EACH CHANGED FUNCTION, create two nodes:',
    '  1. A function node (rectangle):  Id["functionName()\\nmost important NEW line"]',
    '     - Line 1: function name with ()',
    '     - Line 2: the single most important ADDED line (starts with + in the diff)',
    '  2. A description note (stadium shape):  IdDesc(["what this specific change does"])',
    '     - One sentence: what is different now vs before',
    '     - Connect directly below: Id --> IdDesc',
    '',
    'Connect function nodes in the order they call each other:',
    '  IdDesc -->|param or return value| NextId',
    '',
    'Group by file using subgraphs: `subgraph FileName\\n  ...\\nend`',
    '',
    'happyPath = the ordered node IDs of the main changed flow (entry → exit, no errors).',
    '',
    'RULES:',
    '- ONLY functions that appear in the + lines of the diff',
    '- Include every directly added or modified function that contributes to the changed flow',
    '- No unchanged helper functions, no boilerplate',
    '',
    'MERMAID SYNTAX:',
    '- Start with `flowchart TD`',
    '- Node ids: letters/digits/underscore only, unique',
    '- Function node: `Id["fnName()\\ncode line"]` (double quotes, \\n between lines)',
    '- Description node: `IdDesc(["plain sentence"])`',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines","happyPath":["nodeId1","nodeId2"]}',
    '',
    'ADDED LINES FROM DIFF:',
    addedLines,
    '',
    'FULL DIFF (for context):',
    diffSource.slice(0, 3000),
    '',
    'JSON only.',
  ].join('\n');
}

ipcMain.handle('git:listCommits', async () => {
  if (!currentFolder) return { ok: false, error: 'no folder' };
  try {
    const out = execSync(
      'git --no-pager log --format="%H|%s|%an|%ad" --date=short -20',
      { cwd: currentFolder, encoding: 'utf8', timeout: 8000, env: GIT_ENV },
    );
    const commits = out.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, author, date] = line.split('|');
      return {
        hash:    hash?.trim()    ?? '',
        short:   hash?.trim().slice(0, 7) ?? '',
        message: message?.trim() ?? '',
        author:  author?.trim()  ?? '',
        date:    date?.trim()    ?? '',
      };
    });
    return { ok: true, commits };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('git:commitDiff', async (_e, hash: string) => {
  if (!currentFolder || !hash) return { ok: false, error: 'no folder or hash' };
  const folder = currentFolder;
  try {
    // ── 1. Changed file list ──
    let changedRelPaths: string[] = [];
    try {
      const nameOnly = execSync(
        `git --no-pager diff --name-only "${hash}^..${hash}"`,
        { cwd: folder, encoding: 'utf8', timeout: 8000, env: GIT_ENV },
      );
      changedRelPaths = nameOnly.trim().split('\n').filter(Boolean);
    } catch {
      const showOut = execSync(
        `git --no-pager show --name-only --format= ${hash}`,
        { cwd: folder, encoding: 'utf8', timeout: 8000, env: GIT_ENV },
      );
      changedRelPaths = showOut.trim().split('\n').filter(Boolean);
    }

    // ── 2. Commit metadata ──
    const meta = execSync(
      `git --no-pager log -1 --format="%s|%an|%ad" --date=short ${hash}`,
      { cwd: folder, encoding: 'utf8', timeout: 5000, env: GIT_ENV },
    ).trim();
    const [message, author, date] = meta.split('|');
    const commitMsg = message?.trim() ?? '';

    // ── 3. Cache check ──
    const commitDiagramCacheKey = `adaptive-detail-v3:${hash}`;
    const cached = loadCache(folder);
    if (cached?.commitDiagrams?.[commitDiagramCacheKey]) {
      const cd = cached.commitDiagrams[commitDiagramCacheKey];
      const changedAbsPaths = changedRelPaths.map(r => path.join(folder, r));
      return {
        ok: true,
        changedFiles:     changedRelPaths,
        changedNodeNames: changedNodeNames(changedAbsPaths, currentNodePaths),
        annotations:      computeCommitAnnotations(folder, hash, changedRelPaths, currentNodePaths),
        commitInfo: { hash, short: hash.slice(0, 7), message: commitMsg, author: author?.trim() ?? '', date: date?.trim() ?? '', filesChanged: changedRelPaths.length },
        featureFlow: cd.featureFlow,
        codeFlow:    cd.codeFlow,
        fromCache:   true,
      };
    }

    // ── 4. Diff source for Claude ──
    let diffSource = '';
    try {
      diffSource = execSync(
        `git --no-pager show -p --stat ${hash}`,
        { cwd: folder, encoding: 'utf8', timeout: 10000, env: GIT_ENV },
      ).slice(0, 6000);
    } catch { /* use empty diff */ }

    // Also include current file content for context (up to 3 files, 2000 chars each)
    let fileContext = '';
    for (const relPath of changedRelPaths.slice(0, 3)) {
      try {
        const absPath = path.join(folder, relPath);
        const content = fs.readFileSync(absPath, 'utf8').slice(0, 2000);
        fileContext += `\n// ── ${relPath} (current) ──\n${content}`;
      } catch { /* skip unreadable */ }
    }
    const fullSource = (diffSource + fileContext).slice(0, 8000);

    // ── 5. Two Claude calls in parallel ──
    const [featureRaw, codeRaw] = await Promise.all([
      runCapture(buildCommitFeatureFlowPrompt(commitMsg, fullSource), folder),
      runCapture(buildCommitCodeFlowPrompt(commitMsg, fullSource), folder),
    ]);

    const featureParsed = extractJson(featureRaw) as { mermaid?: string; descriptions?: Record<string, string> } | null;
    const codeParsed    = extractJson(codeRaw)    as { mermaid?: string; happyPath?: string[] }               | null;

    const featureFlow = featureParsed?.mermaid
      ? { mermaid: featureParsed.mermaid, descriptions: featureParsed.descriptions ?? {} }
      : null;
    const codeFlow = codeParsed?.mermaid
      ? { mermaid: codeParsed.mermaid, happyPath: codeParsed.happyPath ?? [] }
      : null;

    // ── 6. Cache ──
    if (featureFlow && codeFlow) {
      saveCommitDiagram(folder, commitDiagramCacheKey, { featureFlow, codeFlow });
    }

    const changedAbsPaths = changedRelPaths.map(r => path.join(folder, r));
    return {
      ok: true,
      changedFiles:     changedRelPaths,
      changedNodeNames: changedNodeNames(changedAbsPaths, currentNodePaths),
      annotations:      computeCommitAnnotations(folder, hash, changedRelPaths, currentNodePaths),
      commitInfo: {
        hash,
        short:        hash.slice(0, 7),
        message:      commitMsg,
        author:       author?.trim()  ?? '',
        date:         date?.trim()    ?? '',
        filesChanged: changedRelPaths.length,
      },
      featureFlow,
      codeFlow,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function normalizeDiagramPattern(diagram: Record<string, unknown>, structure: ExtractedStructure) {
  const pat = (diagram.pattern as string | undefined) || '';
  const weak = !pat || pat.toLowerCase() === 'unknown' || pat.toLowerCase() === 'n/a' || pat.trim() === '';
  if (!weak) return;

  const langs = structure.languages;
  let inferred = 'Layered Architecture';
  if (langs.includes('kt') || langs.includes('java')) inferred = 'Android App';
  else if (langs.includes('swift')) inferred = 'iOS App';
  else if (langs.includes('dart')) inferred = 'Flutter App';
  else if (langs.includes('py')) inferred = 'Python Project';
  else if (langs.includes('go')) inferred = 'Go Service';
  else if (langs.includes('rs')) inferred = 'Rust Project';
  else if (langs.includes('ts') || langs.includes('tsx')) inferred = 'TypeScript App';
  else if (langs.includes('cs') || langs.includes('fs')) inferred = '.NET Project';
  else if (langs.includes('php')) inferred = 'PHP Project';
  else if (langs.includes('rb')) inferred = 'Ruby Project';
  else if (langs.includes('cpp') || langs.includes('c') || langs.includes('h')) inferred = 'Native Application';

  diagram.pattern = inferred;
}

// ── Canvas-aware terminal command ─────────────────────────────────────────────

function buildCanvasCommandText(req: { command: string; canvasContext: string; nodeNames: string[] }): string {
  const namesStr = req.nodeNames.join(', ');
  const contextBlock = req.canvasContext
    ? `The user has drawn the following system design on their visual architecture canvas:\n\n${req.canvasContext}\n\nUse this as your implementation blueprint.`
    : '';
  return [
    `You are a software engineer working on this codebase. Write code to fulfil the following request:`,
    '',
    `"${req.command}"`,
    '',
    contextBlock,
    namesStr ? `Known component names from the design: ${namesStr}` : '',
    `Implement the code directly — create or edit the necessary files. Do not just describe what to do.`,
  ].filter(Boolean).join('\n').trim();
}

async function executeCanvasCommandInternal(command: string, canvasContext: string, nodeNames: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!mainWindow) return { ok: false, error: 'no window' };
  if (!currentFolder) return { ok: false, error: 'no folder open' };
  if (summaryPending) return { ok: false, error: `${providerLabel()} is already running — please wait` };
  try {
    const ctxFile = path.join(os.tmpdir(), `rex-canvas-ctx-${Date.now()}.txt`);
    fs.writeFileSync(ctxFile, buildCanvasCommandText({ command, canvasContext, nodeNames }), 'utf8');
    const quotedFile = `'${ctxFile.replace(/'/g, "'\\''")}'`;
    const provider = getAiProvider();
    const cliCommand = provider === 'claude'
      ? `claude --dangerously-skip-permissions "$(cat ${quotedFile})"`
      : provider === 'codex'
        ? `codex --full-auto --skip-git-repo-check "$(cat ${quotedFile})"`
        : `gemini --yolo -p "$(cat ${quotedFile})"`;
    writeToPty(`${cliCommand}\r`);
    mainWindow.webContents.send('canvas:commandStatus', `Running with ${providerLabel()}: ${command}`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('canvas:command', async (_e, req: { command: string; canvasContext: string; nodeNames: string[]; folder: string }) => {
  if (!req.folder) return { ok: false, error: 'no folder open' };
  const result = await executeCanvasCommandInternal(req.command, req.canvasContext, req.nodeNames);
  return result.ok ? { ok: true, statusMessage: `Sent to ${providerLabel()}: ${req.command}` } : result;
});

ipcMain.handle('selection:ask', async (_e, req: { question: string; components: string[]; canvasContext: string; folder: string }) => {
  if (!currentFolder || !req.question.trim()) return { ok: false, error: 'Open a project and enter a question' };
  try {
    const question = req.question.trim();
    const components = req.components ?? [];
    const asksAboutSelection = components.length > 0;
    const normalizedQuestion = question.toLowerCase();
    const asksHow = /\bhow\b/.test(normalizedQuestion);
    const asksWhy = /\bwhy\b|\bpurpose\b|\breason\b/.test(normalizedQuestion);
    const answerMode = asksHow && asksWhy
      ? 'Explain BOTH how it works and why it exists.'
      : asksWhy
        ? 'Explain WHY it exists: its purpose, the problem it prevents or solves, and why the decisions in the code are needed.'
        : asksHow
          ? 'Explain HOW it works: the actual operations, data/state changes, and decisions in order.'
          : 'Choose the explanation style that directly answers the question.';
    const structure = extractStructure(currentFolder);
    const sourceChunks: string[] = [];
    if (asksAboutSelection) {
      let remaining = 9000;
      for (const component of components.slice(0, 8)) {
        for (const { filePath, content } of graphFirstSourceFiles(component, structure.nodePaths, currentFolder)) {
          if (remaining <= 0) break;
          const chunk = content.slice(0, remaining);
          sourceChunks.push('// ' + path.relative(currentFolder, filePath) + '\n' + chunk);
          remaining -= chunk.length;
        }
      }
    } else {
      sourceChunks.push(architectureStoryContext(currentFolder, structure).slice(0, 16000));
    }
    // Questions are read-only, so identical questions with the same selected
    // evidence and canvas state should be served without another AI call.
    const questionCacheKey = '__selection_answer__:v2:' + hashStructure([
      question,
      components.join('\n'),
      req.canvasContext.slice(0, 5000),
      sourceChunks.join('\n\0\n'),
      `depth:${analysisDepth}`,
      `provider:${getAiProvider()}`,
    ].join('\n---\n'));
    const cachedValue = loadCache(currentFolder)?.codeflows?.[questionCacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; diagram?: unknown };
        if (cached.version === 2 && cached.diagram) return { ok: true, diagram: cached.diagram };
      } catch {
        // Regenerate malformed cache data.
      }
    }
    // Questions run with the opened project's cwd, so that project's instructions
    // do not necessarily include this app's CLAUDE.md. Make the canvas read an
    // explicit, per-request requirement instead. The final response remains JSON;
    // the MCP call happens before it is composed.
    const canvasMcpRequirement = getAiProvider() === 'claude'
      ? 'Before doing any analysis, you MUST call mcp__rex-canvas__get_canvas_mermaid exactly once to read the live canvas. This is mandatory even though a canvas-context snapshot is supplied below. Treat the tool result as the authoritative canvas state. Do not delegate this call. After the tool result, return only the JSON requested below.'
      : '';
    const prompt = [
      asksAboutSelection
        ? 'Answer a developer question about selected components as a clear Mermaid flowchart.'
        : 'Answer a developer question about the whole project as a clear Mermaid flowchart.',
      canvasMcpRequirement,
      'Output ONLY JSON. Do not edit files. Do not give prose outside JSON.',
      '', 'QUESTION:', question, asksAboutSelection ? 'SELECTED COMPONENTS: ' + components.join(', ') : 'SCOPE: whole project (no components selected)', '',
      'ANSWER MODE:', answerMode, '',
      'RULES:', '- Make the diagram directly answer the question. Do not replace it with a generic request lifecycle.',
      '- First node must state the direct answer in plain English.',
      '- If the question asks about a response, payload, output, JSON, fields, headers, or data shape: diagram the concrete response structure (status, headers, body and known fields), not the request-processing steps.',
      '- If the question asks how something works (including just "How?"): diagram the real process in order. Each description must say HOW the code does that step: operation, data/state change, and decision/condition.',
      '- If the question asks why (including just "Why?"): diagram the purpose and reasoning, not a generic process. Each description must say WHY that step or decision exists and what problem it prevents or solves.',
      '- If it asks both how and why, every description must use this format: "How: … Why: … (source reference)".',
      '- Use only facts supported by the provided source/context. Say "not defined here" rather than inventing fields.',
      '- Include every short plain-English step needed to answer the question. Explain behavior before implementation details.',
      asksAboutSelection
        ? '- Include only the selected components and directly relevant connections.'
        : '- Include only the project areas and connections needed to answer the question. Start from the project-level architecture when useful.',
      '- Put real function/file references in descriptions, not node labels. For a How or Why answer, descriptions must contain the requested explanation, not only the reference.',
      '- Start Mermaid with flowchart TD.', '', 'Schema:',
      '{"pattern":"short answer title","diagrams":{"structure":"flowchart TD string"},"descriptions":{"Node Label":"How: concrete implementation. Why: purpose (function in file.ts)"}}',
      '', 'CANVAS CONTEXT:', req.canvasContext.slice(0, 5000),
      '', 'RELEVANT SOURCE:', sourceChunks.join('\n\n').slice(0, 9000), '', 'JSON only.',
    ].join('\n');
    const parsed = extractJson(await runCapture(prompt, currentFolder)) as { pattern?: string; diagrams?: { structure?: string }; descriptions?: Record<string, string> } | null;
    if (!parsed?.diagrams?.structure) return { ok: false, error: 'Could not create an answer flowchart' };
    const diagram = { pattern: parsed.pattern || (asksAboutSelection ? 'Selected components' : 'Project question'), diagrams: { structure: parsed.diagrams.structure }, descriptions: parsed.descriptions ?? {} };
    saveCodeFlow(currentFolder, questionCacheKey, JSON.stringify({ version: 2, diagram }));
    return { ok: true, diagram };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Impact summary ────────────────────────────────────────────────────────────

interface ImpactSummary {
  changed: { name: string; type: string; description: string; oldDescription: string }[];
  impacted: { name: string; type: string; description: string; reason: string }[];
}

// ── Completed response: convert Claude's final text into a diagram ─────────────

interface StreamNode { id: string; label: string; parent?: string; kind: 'step' | 'option' | 'section' | 'detail' }

function safeId(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'node';
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

// ── Detect what diagram type fits the content ─────────────────────────────────

function detectDiagramType(text: string, preferred: string): string {
  const t = text.toLowerCase();

  // Explicit sequence signals
  if (/\b(sends?|receives?|calls?|requests?|responds?|replies?|messages?|notifies?)\b.*\b(to|from|the|with)\b/i.test(text) &&
      /\b(user|client|server|api|service|browser|app|backend|frontend)\b/i.test(text)) return 'sequenceDiagram';

  // Timeline signals: dates, phases, chronological language
  if (/\b(phase|week|month|quarter|january|february|march|april|may|june|july|august|q[1-4]|2024|2025|2026)\b/i.test(text) &&
      /\b(then|after|next|before|during|milestone|release|launch|deadline)\b/i.test(text)) return 'timeline';

  // Mindmap signals: brainstorm, ideas, topics, categories
  if (/\b(idea|concept|topic|category|aspect|area|dimension|theme|branch)\b/i.test(t) &&
      text.split('\n').filter(l => /^\s{2,}/.test(l)).length > 2) return 'mindmap';

  // Class diagram signals: classes, methods, inheritance
  if (/\b(class|interface|extends|implements|inherits|method|property|field|object|instance)\b/i.test(t) &&
      /\b(has|contains|references|uses|depends)\b/i.test(t)) return 'classDiagram';

  // Git graph signals: branches, commits, merge
  if (/\b(branch|commit|merge|checkout|main|master|feature|hotfix|release)\b/i.test(t) &&
      /\b(git|pr|pull request|push)\b/i.test(t)) return 'gitGraph';

  // Gantt signals: schedule, tasks, duration
  if (/\b(gantt|schedule|sprint|duration|deadline|milestone|task)\b/i.test(t) &&
      /\b(days?|weeks?|hours?)\b/i.test(t)) return 'gantt';

  // ER diagram signals: tables, foreign keys, database
  if (/\b(table|foreign key|primary key|relation|entity|database|schema|column|row)\b/i.test(t)) return 'erDiagram';

  // Pie chart signals: percentages, distribution, proportions
  if (/\b(\d+)%/.test(text) && /\b(distribution|breakdown|split|proportion|share)\b/i.test(t)) return 'pie';

  // Default: if user picked something specific, use that; otherwise flowchart
  if (preferred && preferred !== 'flowchart') return preferred;
  return 'flowchart';
}

// ── Build mermaid for each diagram type from parsed content ───────────────────

function buildFlowchart(lines: string[], title: string): string {
  const nodes: StreamNode[] = [];
  let nodeIndex = 0;
  let lastParent: string | undefined;

  for (const raw of lines) {
    const line = stripAnsi(raw).trimEnd();

    const stepMatch = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (stepMatch) {
      const label = stepMatch[2].replace(/\*\*/g, '').trim().slice(0, 50);
      if (label.length < 3) continue;
      const id = `S${nodeIndex}_${safeId(label)}`;
      const node: StreamNode = { id, label, kind: 'step', parent: lastParent };
      if (nodes.length > 0 && nodes[nodes.length - 1].kind === 'step') {
        node.parent = nodes[nodes.length - 1].id;
      } else {
        node.parent = undefined;
      }
      nodes.push(node);
      lastParent = id;
      nodeIndex++;
      continue;
    }

    const headerMatch = line.match(/^\s*(?:\*\*(.+?)\*\*|#{1,3}\s+(.+))$/);
    const headerText = headerMatch?.[1] || headerMatch?.[2];
    if (headerText && headerText.length < 60) {
      const label = headerText.trim();
      const id = `H${nodeIndex}_${safeId(label)}`;
      const isOption = /^(option|approach|way|method|alternative|solution)\s*[a-z\d]/i.test(label);
      nodes.push({ id, label, kind: isOption ? 'option' : 'section' });
      lastParent = id;
      nodeIndex++;
      continue;
    }

    const bulletMatch = line.match(/^\s*[-•*]\s+(.+)$/);
    if (bulletMatch) {
      const label = bulletMatch[1].replace(/\*\*/g, '').trim().slice(0, 50);
      if (label.length < 4 || label.split(' ').length < 2) continue;
      const id = `B${nodeIndex}_${safeId(label)}`;
      nodes.push({ id, label, kind: 'detail', parent: lastParent });
      nodeIndex++;
      continue;
    }
  }

  if (nodes.length === 0) return '';

  const hasOptions = nodes.some(n => n.kind === 'option');
  const layout = hasOptions ? 'LR' : 'TD';
  const out = [`flowchart ${layout}`];

  for (const n of nodes) {
    const lbl = n.label.replace(/"/g, "'");
    if (n.kind === 'section' || n.kind === 'option') out.push(`  ${n.id}["**${lbl}**"]`);
    else if (n.kind === 'detail') out.push(`  ${n.id}("${lbl}")`);
    else out.push(`  ${n.id}["${lbl}"]`);
  }

  const withParents = nodes.filter(n => n.parent);
  if (withParents.length > 0) {
    for (const n of withParents) out.push(`  ${n.parent} --> ${n.id}`);
    const roots = nodes.filter(n => !n.parent);
    for (let i = 1; i < roots.length; i++) out.push(`  ${roots[i-1].id} --> ${roots[i].id}`);
  } else {
    for (let i = 1; i < nodes.length; i++) out.push(`  ${nodes[i-1].id} --> ${nodes[i].id}`);
  }

  return out.join('\n');
}

function buildSequenceDiagram(lines: string[], title: string): string {
  const actors = new Set<string>();
  const messages: string[] = [];
  const ACTOR_RE = /\b(user|client|server|api|service|browser|app|backend|frontend|database|db|system|claude|assistant)\b/gi;

  for (const raw of lines) {
    const line = stripAnsi(raw).replace(/\*\*/g, '').trim();
    if (line.length < 5) continue;

    const found = line.match(ACTOR_RE);
    if (found) found.forEach(a => actors.add(a.charAt(0).toUpperCase() + a.slice(1).toLowerCase()));

    // "X sends Y to Z" or "X calls Y" patterns
    const sendMatch = line.match(/\b(\w+)\s+(?:sends?|calls?|requests?|asks?)\s+(.+?)\s+(?:to|from)\s+(\w+)/i);
    if (sendMatch) {
      const from = sendMatch[1].charAt(0).toUpperCase() + sendMatch[1].slice(1);
      const msg  = sendMatch[2].slice(0, 40);
      const to   = sendMatch[3].charAt(0).toUpperCase() + sendMatch[3].slice(1);
      actors.add(from); actors.add(to);
      messages.push(`  ${from}->>${to}: ${msg}`);
    }

    // "X responds/returns Y" patterns
    const replyMatch = line.match(/\b(\w+)\s+(?:responds?|returns?|replies?|sends back)\s+(.+)/i);
    if (replyMatch) {
      const from = replyMatch[1].charAt(0).toUpperCase() + replyMatch[1].slice(1);
      const msg  = replyMatch[2].slice(0, 40);
      if (actors.size > 0) {
        const to = [...actors].find(a => a !== from) || 'Client';
        messages.push(`  ${from}-->>${to}: ${msg}`);
      }
    }
  }

  // If no messages parsed, build generic sequence from bullet/numbered items
  if (messages.length === 0) {
    const steps = lines
      .map(l => stripAnsi(l).replace(/^\s*[\d.)\-•*]+\s*/, '').replace(/\*\*/g, '').trim())
      .filter(l => l.length > 4 && l.length < 60)
      .slice(0, 8);
    if (steps.length < 2) return '';
    const actorList = actors.size >= 2 ? [...actors].slice(0, 3) : ['User', 'System'];
    steps.forEach((step, i) => {
      const from = actorList[i % 2];
      const to   = actorList[(i + 1) % 2];
      messages.push(`  ${from}->>${to}: ${step}`);
    });
    actorList.forEach(a => actors.add(a));
  }

  if (messages.length < 2) return '';
  const actorDefs = [...actors].slice(0, 4).map(a => `  participant ${a}`).join('\n');
  return `sequenceDiagram\n${actorDefs}\n${messages.join('\n')}`;
}

function buildMindmap(lines: string[], title: string): string {
  const items: { text: string; depth: number }[] = [];

  for (const raw of lines) {
    const line = stripAnsi(raw).trimEnd();
    const clean = line.replace(/^\s*[-•*\d.)]+\s*/, '').replace(/\*\*/g, '').trim();
    if (clean.length < 3 || clean.length > 50) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const depth = Math.floor(indent / 2);
    items.push({ text: clean, depth });
  }

  if (items.length === 0) return '';

  const out = [`mindmap`, `  root((${title.slice(0, 30)}))`];
  for (const item of items) {
    const pad = '  '.repeat(item.depth + 2);
    out.push(`${pad}${item.text}`);
  }
  return out.join('\n');
}

function buildTimeline(lines: string[], title: string): string {
  const events: { time: string; event: string }[] = [];
  const TIME_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week\s*\d+|phase\s*\d+|q[1-4]|step\s*\d+|\d{4})/i;

  for (const raw of lines) {
    const line = stripAnsi(raw).replace(/\*\*/g, '').trim();
    if (line.length < 4) continue;
    const timeMatch = line.match(TIME_RE);
    const clean = line.replace(/^\s*[-•*\d.)]+\s*/, '').trim().slice(0, 50);
    if (timeMatch) {
      events.push({ time: timeMatch[0], event: clean.replace(timeMatch[0], '').replace(/^[:\s-]+/, '').trim() || clean });
    } else if (/^\s*[-•*\d.)]+\s+/.test(raw)) {
      events.push({ time: `Step ${events.length + 1}`, event: clean });
    }
  }

  if (events.length < 2) return '';
  const out = [`timeline`, `  title ${title.slice(0, 50)}`];
  events.slice(0, 8).forEach(e => out.push(`  ${e.time} : ${e.event}`));
  return out.join('\n');
}

function parseResponseDiagram(text: string, preferred: string): { mermaid: string; title: string; type: string } | null {
  const lines = text.split('\n').map(l => stripAnsi(l).trimEnd());

  // Extract title from first bold line or first substantive line
  let title = 'Claude';
  for (const line of lines.slice(0, 8)) {
    const bold = line.match(/\*\*(.+?)\*\*/);
    if (bold && bold[1].length < 60) { title = bold[1]; break; }
    const clean = line.replace(/[#*`]/g, '').trim();
    if (clean.length > 8 && clean.length < 80 && !/^[-•\d]/.test(clean)) { title = clean.slice(0, 60); break; }
  }

  const type = detectDiagramType(text, preferred);
  let mermaid = '';

  if (type === 'sequenceDiagram') mermaid = buildSequenceDiagram(lines, title);
  else if (type === 'mindmap')      mermaid = buildMindmap(lines, title);
  else if (type === 'timeline')     mermaid = buildTimeline(lines, title);
  else                              mermaid = buildFlowchart(lines, title);

  if (!mermaid) return null;
  return { mermaid, title, type };
}

let lastResponseBuffer = '';

function tryAutoVisualize(folder: string, win: BrowserWindow) {
  void folder;
  if (!lastResponseBuffer.trim() || lastResponseBuffer.trim().split(/\s+/).length < 20) {
    lastResponseBuffer = '';
    return;
  }
  const text = lastResponseBuffer;
  lastResponseBuffer = '';
  const parsed = parseResponseDiagram(text, preferredDiagramType);
  if (parsed) {
    const diagramData = { pattern: parsed.title, diagrams: { structure: parsed.mermaid }, descriptions: {} };
    win.webContents.send('canvas:diagram', diagramData);
    persistDiagram(diagramData);
  }
}

// ── Terminal error detection ──────────────────────────────────────────────────

// Patterns that indicate a build/test failure and capture a location hint
const ERROR_PATTERNS = [
  // TypeScript / tsc
  /([^(\s]+\.tsx?)\((\d+),\d+\):\s+error\s+TS\d+:\s*(.+)/,
  // ESLint
  /([^:\s]+\.[jt]sx?)\s*\n?\s*\d+:\d+\s+error\s+(.+)/,
  // Jest / Vitest: ● Test name
  /●\s+(.+)/,
  // Node.js runtime error
  /at\s+\S+\s+\(([^)]+\.tsx?):(\d+):\d+\)/,
  // Generic "Error:" line
  /(?:^|\s)(Error|FAILED|FAIL):\s*(.+)/m,
  // Cargo / Rust
  /error\[E\d+\]:\s*(.+)/,
  // Python
  /File "([^"]+\.py)", line (\d+)/,
  // Go
  /([^:\s]+\.go):(\d+):\d+:\s+(.+)/,
];

function detectErrors(text: string, nodePaths: Record<string, string>, folder: string): { node: string; error: string }[] {
  const results: { node: string; error: string }[] = [];
  const seen = new Set<string>();

  // Build a reverse map: relative path fragment → node name
  const pathToNode = new Map<string, string>();
  for (const [name, absPath] of Object.entries(nodePaths)) {
    const rel = folder ? absPath.replace(folder + '/', '') : absPath;
    pathToNode.set(rel, name);
    pathToNode.set(absPath, name);
    // also index by basename
    const base = absPath.split('/').pop() ?? '';
    if (!pathToNode.has(base)) pathToNode.set(base, name);
  }

  for (const pattern of ERROR_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;

    // First capture group is usually the file path or test name
    const hint = m[1]?.trim() ?? '';
    const message = (m[3] ?? m[2] ?? m[1] ?? '').trim().slice(0, 120);
    if (!message) continue;

    // Try to map hint to a known node
    let node = '';
    for (const [key, name] of pathToNode.entries()) {
      if (hint && key.includes(hint.split('/').pop() ?? hint)) {
        node = name;
        break;
      }
    }
    if (!node) node = hint.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Unknown';

    const key = `${node}:${message.slice(0, 40)}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ node, error: message });
    }
  }

  return results.slice(0, 6);
}

let summaryPending = false;
let claudeContextInjected = false;
let claudeStartDebounce: ReturnType<typeof setTimeout> | null = null;
let errorDebounce: ReturnType<typeof setTimeout> | null = null;

function setupPtyClaudeDetection() {
  let buffer = '';
  let claudeResponseBuffer = '';
  let inClaudeSession = false; // true once Claude Code is running, stays true until shell $ returns

  setPtyDataCallback((data: string) => {
    recordPtyOutput(data);
    buffer += data;
    if (buffer.length > 8000) buffer = buffer.slice(-4000);

    const cleanData = data
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\r/g, '');

    // Detect Claude Code startup
    if (!inClaudeSession && /Welcome to Claude|claude-sonnet|claude-opus|claude-haiku|claude-fable/i.test(cleanData)) {
      inClaudeSession = true;
      claudeResponseBuffer = '';
      if (!claudeContextInjected) {
        claudeContextInjected = true;
        if (claudeStartDebounce) clearTimeout(claudeStartDebounce);
        claudeStartDebounce = setTimeout(() => {
          const mermaid = (currentDiagram as { diagrams?: { structure?: string } } | null)?.diagrams?.structure;
          if (mermaid && currentFolder) {
            const folderName = path.basename(currentFolder);
            const ctx = `\r\n\x1b[2m[Canvas: ${folderName}]\x1b[0m\r\n\x1b[2m\`\`\`mermaid\r\n${mermaid}\r\n\`\`\`\x1b[0m\r\n`;
            writeToPty(ctx);
          }
        }, 1500);
      }
    }

    // New user turn: Claude prints "> " or "? " as the input prompt between turns
    // Reset the response buffer so we only show the current answer
    if (inClaudeSession && /^\s*[>?]\s/.test(cleanData.trim())) {
      claudeResponseBuffer = '';
    }

    // Accumulate Claude's response — skip tool call / UI chrome lines
    if (inClaudeSession) {
      const lines = cleanData.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // Skip Claude Code UI chrome: spinner frames, tool blocks, box-drawing chars
        if (/^[⏺✓✗⟳◆│╭╰·]/.test(t)) continue;
        if (/^(Tool:|<tool_use|"type"\s*:|"tool_use"|Bash|Read|Write|Edit)\b/.test(t)) continue;
        if (/^\s*[┌┐└┘├┤┬┴┼─│]/.test(line)) continue;
        claudeResponseBuffer += line + '\n';
      }
      if (claudeResponseBuffer.length > 6000) claudeResponseBuffer = claudeResponseBuffer.slice(-4000);
    }

    // ── Error detection ──
    const looksLikeError = /\b(error|FAILED|FAIL|TypeError|SyntaxError)\b/i.test(data);
    if (looksLikeError && currentFolder) {
      if (errorDebounce) clearTimeout(errorDebounce);
      errorDebounce = setTimeout(() => {
        const errors = detectErrors(buffer.slice(-4000), currentNodePaths, currentFolder!);
        if (errors.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('canvas:errorAnnotations', errors);
        }
      }, 600);
    }

    // Claude exits back to shell
    if (inClaudeSession && /\$\s*$/.test(buffer.slice(-20))) {
      inClaudeSession = false;
      claudeContextInjected = false;
    }

    // Claude finished a response turn
    const done = /\b(?:Worked|Baked|Cooked|Cogitated|Processed|Computed|Thought|Reasoned|Analysed|Analyzed|Simulated|Crafted|Pondered|Simmered|Calculated|Deliberated|Churned|Digested|Mulled|Ruminated)\s+for\s+\d/i.test(buffer);
    if (done && mainWindow && !summaryPending) {
      summaryPending = true;

      lastResponseBuffer = claudeResponseBuffer;
      claudeResponseBuffer = '';
      buffer = '';

      const ptyCwd = getPtyCwd();
      const rawFolder = ptyCwd || currentFolder || os.homedir();
      const folder = findProjectRoot(rawFolder);
      const win = mainWindow;

      if (folder !== currentFolder && fs.existsSync(folder)) {
        componentWarmupGeneration++;
        currentFolder = folder;
        saveLastProject(folder);
        win.webContents.send('folder:restored', { folder, hasCachedDiagram: false });
        stopFileWatcher();
        startFileWatcher(folder, (changedFiles) => {
          if (mainWindow) sendGitStatus(mainWindow);
          runIncrementalPatch(changedFiles);
        });
      }

      tryAutoVisualize(folder, win);

      setTimeout(() => {
        runPostClaudeUpdate(folder, win).finally(() => { summaryPending = false; });
      }, 2000);
    }
  });
}

/**
 * Fired when the PTY detector sees Claude finish ("Worked for Ns"). The file
 * watcher usually already caught the edit; this is a backup trigger. Both funnel
 * into runIncrementalPatch, which is guarded by `patchInProgress` so only one
 * update runs per change.
 */
async function runPostClaudeUpdate(folder: string, win: BrowserWindow) {
  if (!fs.existsSync(folder)) return;
  void win;
  const changedPaths = getGitChangedFiles(folder);
  const changedFiles = changedPaths.map(p => path.relative(folder, p)).join(', ');
  await runIncrementalPatch(changedFiles || 'recent changes');
}

// ── PR Review ─────────────────────────────────────────────────────────────────

ipcMain.handle('pr:list', () => {
  if (!currentFolder) return { ok: false, error: 'no folder', prs: [] };
  const ghPrs = listPRs(currentFolder);
  const branches = listLocalBranches(currentFolder);
  return { ok: true, prs: [...ghPrs, ...branches] };
});

ipcMain.handle('pr:review', async (_e, pr: PRInfo) => {
  if (!currentFolder) return { ok: false, error: 'no folder open' };
  if (!mainWindow) return { ok: false, error: 'no window' };

  mainWindow.webContents.send('analysis:status', 'running');
  mainWindow.webContents.send('analysis:statusDetail', `Reviewing PR: ${pr.title}…`);

  try {
    const nodeNames = extractNodeNames(currentDiagram);
    const result = await reviewPR(currentFolder, pr, nodeNames);
    mainWindow.webContents.send('analysis:status', result.ok ? 'done' : 'error');
    return result;
  } catch (err) {
    mainWindow.webContents.send('analysis:status', 'error');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
