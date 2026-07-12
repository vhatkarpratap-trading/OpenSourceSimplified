import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { createPty, writeToPty, resizePty, killPty, restartPty, runCapture, setPtyDataCallback, getPtyCwd } from './ptyManager';
import { startFileWatcher, stopFileWatcher } from './fileWatcher';
import { extractStructure, toClaudePromptJSON, ExtractedStructure } from './codeExtractor';

let mainWindow: BrowserWindow | null = null;
let currentFolder: string | null = null;
let currentDiagram: object | null = null;
let currentNodePaths: Record<string, string> = {};
let patchInProgress = false;

// ── Diagram cache ─────────────────────────────────────────────────────────────
// One JSON file per project, keyed by a hash of the extracted structure.
// Drilldown results are cached inside the same file under `drilldowns[name]`.

interface CodeFlowStep { fn: string; what: string; data: string }

interface CacheFile {
  structureHash: string;
  diagram: object;
  drilldowns: Record<string, string>;
  codeflows: Record<string, string>;
  savedAt: number;
}

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'diagram-cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheFile(folder: string): string {
  const key = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16);
  return path.join(cacheDir(), `${key}.json`);
}

function hashStructure(structureJson: string): string {
  return crypto.createHash('sha256').update(structureJson).digest('hex').slice(0, 32);
}

function loadCache(folder: string): CacheFile | null {
  try {
    const raw = fs.readFileSync(cacheFile(folder), 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch { return null; }
}

function saveCache(folder: string, data: Partial<CacheFile> & { diagram: object; structureHash: string }) {
  try {
    const existing = loadCache(folder);
    const merged: CacheFile = {
      structureHash: data.structureHash,
      diagram: data.diagram,
      drilldowns: { ...(existing?.drilldowns ?? {}), ...(data.drilldowns ?? {}) },
      codeflows: { ...(existing?.codeflows ?? {}), ...(data.codeflows ?? {}) },
      savedAt: Date.now(),
    };
    fs.writeFileSync(cacheFile(folder), JSON.stringify(merged, null, 2), 'utf8');
  } catch { /* ignore — cache is best-effort */ }
}

function saveDrilldown(folder: string, componentName: string, mermaid: string) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.drilldowns[componentName] = mermaid;
    existing.savedAt = Date.now();
    fs.writeFileSync(cacheFile(folder), JSON.stringify(existing, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function invalidateDrilldowns(folder: string) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.drilldowns = {};
    existing.codeflows = {};
    existing.savedAt = Date.now();
    fs.writeFileSync(cacheFile(folder), JSON.stringify(existing, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function saveCodeFlow(folder: string, componentName: string, mermaid: string) {
  try {
    const existing = loadCache(folder);
    if (!existing) return;
    existing.codeflows = existing.codeflows ?? {};
    existing.codeflows[componentName] = mermaid;
    existing.savedAt = Date.now();
    fs.writeFileSync(cacheFile(folder), JSON.stringify(existing, null, 2), 'utf8');
  } catch { /* ignore */ }
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

// ── Claude prompt ─────────────────────────────────────────────────────────────

function buildClaudePrompt(structureJson: string): string {
  const schema = `{
  "pattern": "e.g. MVVM, Clean Architecture, MVC, Redux/Flux, Layered, Hexagonal, Microservices, Event-Driven",
  "diagrams": {
    "structure": "flowchart TD string — feature-first, plain English nodes, labelled edges",
    "sequence": "flowchart LR string — one key user journey end-to-end",
    "gitDiff": ""
  },
  "descriptions": {
    "NodeLabel": "1 sentence — what the user experiences or gets from this feature, in plain English"
  }
}`;

  return [
    'You are explaining this app to a smart non-engineer. Look at the code and produce a diagram that shows WHAT THE APP DOES for its users — not how the code is structured internally.',
    'Output ONLY the JSON below — no fences, no prose.',
    '',
    '══ STRUCTURE DIAGRAM RULES ══',
    '',
    '1. NODES = user-facing features and actions, NOT file names or class names.',
    '   Good node labels: "Login", "Search Properties", "Book Appointment", "Live Chat", "Payment", "Dashboard"',
    '   Bad node labels: "AuthViewModel", "ApiClient", "index.ts", "useEffect"',
    '   Each node answers: "What can the user DO or SEE here?"',
    '',
    '2. EDGES = what triggers the next step or what the user gets.',
    '   Good edge labels: "taps Login", "enters search query", "booking confirmed", "payment processed"',
    '   Bad edge labels: "calls", "returns", "imports", "renders"',
    '',
    '3. FLOW direction: top = what the user starts with, bottom = what they end up with.',
    '   Group by USER JOURNEY not by technical layer.',
    '   8–14 nodes total. Every node must have at least one edge.',
    '',
    '4. DESCRIPTIONS = for each node, one sentence starting with "Lets the user…" or "Shows the user…" or "Handles…".',
    '   Max 12 words. Plain English. No class names, no file names, no technical terms.',
    '',
    '══ SEQUENCE DIAGRAM RULES ══',
    '',
    '  Pick the single most important user journey (e.g. "User books a service", "User logs in and sees dashboard").',
    '  Show it as a flowchart LR with steps the user takes and what they see at each step.',
    '  Node labels = plain English actions or screens. Edge labels = what happens next.',
    '',
    '══ MERMAID SYNTAX (follow exactly) ══',
    '',
    '- Start structure with `flowchart TD`, sequence with `flowchart LR`.',
    '- Node id = letters/digits/underscore only. Format: `Id[Label]`.',
    '- Label: letters, digits, spaces only. NO ( ) / : ; " \' | inside [ ].',
    '- Edge with label: `A -->|taps login| B`.',
    '- NO subgraph, NO classDiagram, NO sequenceDiagram.',
    '',
    'EXAMPLE of a good structure diagram (booking app):',
    'flowchart TD',
    '  Home[Home Screen]',
    '  Search[Search Services]',
    '  ServiceDetail[Service Details]',
    '  Booking[Book Appointment]',
    '  Payment[Pay]',
    '  Confirmation[Booking Confirmed]',
    '  Profile[My Bookings]',
    '  Home -->|browse services| Search',
    '  Search -->|select service| ServiceDetail',
    '  ServiceDetail -->|choose slot| Booking',
    '  Booking -->|confirm| Payment',
    '  Payment -->|success| Confirmation',
    '  Confirmation -->|view history| Profile',
    '',
    'Schema:',
    schema,
    '',
    'Each diagrams value is raw Mermaid (newlines as \\n), not fenced.',
    '',
    'Project code (use this to infer what features exist — ignore file/class names when labelling nodes):',
    structureJson,
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
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
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

async function runIncrementalPatch(changedFiles: string) {
  if (!mainWindow || !currentFolder || patchInProgress) return;
  patchInProgress = true;

  const folder = currentFolder;
  const win = mainWindow;

  try {
    const structure = extractStructure(folder);
    currentNodePaths = structure.nodePaths;

    const changedPaths = getGitChangedFiles(folder);
    const annotations = computeGitAnnotations(folder, changedPaths, currentNodePaths);
    const gitDiffSummary = gitAnnotationsToText(annotations);

    // ── Case 1: no base diagram yet → build the base structure once ──
    if (!currentDiagram) {
      win.webContents.send('analysis:status', 'running');
      win.webContents.send('analysis:statusDetail', 'Drawing the project map…');

      const structureJson = toClaudePromptJSON(structure);
      const structureHash = hashStructure(structureJson);

      // Check cache before asking Claude
      const cached = loadCache(folder);
      let base: object | null = null;
      if (cached && cached.structureHash === structureHash && cached.diagram) {
        base = cached.diagram;
      } else {
        const raw = await runCapture(buildClaudePrompt(structureJson), folder);
        base = extractJson(raw);
        if (base) {
          // New diagram = stale drilldowns; wipe them
          saveCache(folder, { structureHash, diagram: base });
          invalidateDrilldowns(folder);
        }
      }

      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'rex-last-analysis.json'), (JSON.stringify(base, null, 2) || ''), 'utf8');
        const d = (base as { diagrams?: { structure?: string } } | null)?.diagrams?.structure || '';
        console.log('\n===== STRUCTURE MERMAID (auto) =====\n' + d + '\n====================================\n');
      } catch { /* ignore */ }
      if (base && !win.isDestroyed()) {
        normalizeDiagramPattern(base as Record<string, unknown>, structure);
        currentDiagram = base;
        win.webContents.send('canvas:diagram', base);
      }
      win.webContents.send('analysis:status', 'done');
      return;
    }

    // ── Case 2: base exists → only explain + highlight the change ──
    // The base diagram is NOT regenerated; we keep it stable and color the changes.
    if (changedPaths.length === 0) { win.webContents.send('analysis:status', 'done'); return; }

    win.webContents.send('analysis:status', 'patching');
    win.webContents.send('analysis:statusDetail', 'Explaining what changed…');

    const nodeNames = extractNodeNames(currentDiagram);
    const raw = await runCapture(buildExplainPrompt(changedFiles, gitDiffSummary, nodeNames), folder);
    const parsed = extractJson(raw) as { changes?: ChangeExplanation[] } | null;
    const changes = parsed?.changes || [];

    if (win.isDestroyed()) return;

    if (changes.length > 0) {
      const changedNames = changes.map(c => matchNode(c.node, nodeNames));
      // Human-readable impact summary (kid-friendly sentences from Claude)
      const summary: ImpactSummary = {
        changed: changes.map((c, i) => ({
          name: changedNames[i],
          type: 'file',
          description: c.explanation,
          oldDescription: '',
        })),
        impacted: [],
      };
      // On-canvas badges use the same simple sentences
      const badges = changes.map((c, i) => ({
        name: changedNames[i],
        summary: c.explanation,
        added: 0,
        removed: 0,
      }));
      win.webContents.send('canvas:claudeChanges', { changedNames, impactedNames: [] });
      win.webContents.send('analysis:impactSummary', summary);
      win.webContents.send('canvas:gitAnnotations', badges);
    } else if (annotations.length > 0) {
      // Fallback: no explanation parsed, still highlight from git facts
      const changedNames = annotations.map(a => a.name);
      win.webContents.send('canvas:claudeChanges', { changedNames, impactedNames: [] });
      win.webContents.send('analysis:impactSummary', impactSummaryFromAnnotations(annotations));
      win.webContents.send('canvas:gitAnnotations', annotations);
    }
    win.webContents.send('analysis:status', 'done');
  } catch {
    if (!win.isDestroyed()) win.webContents.send('analysis:status', 'done');
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

  mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) return;
    createPty(mainWindow);
    setupPtyClaudeDetection();

    const last = loadLastProject();
    if (last) {
      currentFolder = last;
      restartPty(mainWindow, last);

      // Restore cached diagram immediately — canvas is populated before any analysis
      const cached = loadCache(last);
      if (cached?.diagram) {
        currentDiagram = cached.diagram;
        mainWindow.webContents.send('canvas:diagram', cached.diagram);
        mainWindow.webContents.send('folder:restored', { folder: last, hasCachedDiagram: true });
      } else {
        mainWindow.webContents.send('folder:restored', { folder: last, hasCachedDiagram: false });
      }

      startFileWatcher(last, (changedFiles) => {
        if (mainWindow) sendGitStatus(mainWindow);
        runIncrementalPatch(changedFiles);
      });
    }
  });

  mainWindow.on('closed', () => {
    stopFileWatcher();
    killPty();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.on('pty:write', (_e, data: string) => writeToPty(data));
ipcMain.on('pty:resize', (_e, cols: number, rows: number) => resizePty(cols, rows));

ipcMain.handle('folder:open', async () => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;

  const folder = result.filePaths[0];
  currentFolder = folder;
  currentDiagram = null;
  currentNodePaths = {};
  saveLastProject(folder);
  stopFileWatcher();

  restartPty(mainWindow, folder);

  // Restore cached diagram for this project if one exists
  const cached = loadCache(folder);
  if (cached?.diagram) {
    currentDiagram = cached.diagram;
    mainWindow.webContents.send('canvas:diagram', cached.diagram);
  }

  startFileWatcher(folder, (changedFiles) => {
    if (mainWindow) sendGitStatus(mainWindow);
    runIncrementalPatch(changedFiles);
  });

  return { folder, hasCachedDiagram: !!cached?.diagram };
});

ipcMain.handle('analysis:run', async () => {
  if (!mainWindow || !currentFolder) return { error: 'No folder selected' };

  mainWindow.webContents.send('analysis:status', 'running');

  try {
    mainWindow.webContents.send('analysis:statusDetail', 'Extracting code structure…');
    const structure = extractStructure(currentFolder);

    if (structure.totalFiles === 0) {
      mainWindow.webContents.send('analysis:statusDetail', 'No source files found in this folder.');
      mainWindow.webContents.send('analysis:status', 'error');
      return { error: 'No source code found in this folder' };
    }

    const structureJson = toClaudePromptJSON(structure);
    const structureHash = hashStructure(structureJson);

    // ── Cache hit: structure unchanged since last analysis ──
    const cached = loadCache(currentFolder);
    if (cached && cached.structureHash === structureHash && cached.diagram) {
      currentDiagram = cached.diagram;
      currentNodePaths = structure.nodePaths;
      normalizeDiagramPattern(cached.diagram as Record<string, unknown>, structure);
      mainWindow.webContents.send('canvas:diagram', cached.diagram);
      mainWindow.webContents.send('analysis:statusDetail', 'Loaded from cache');
      mainWindow.webContents.send('analysis:status', 'done');
      sendGitStatus(mainWindow);
      return { ok: true, fromCache: true };
    }

    // ── Cache miss: ask Claude ──
    mainWindow.webContents.send('analysis:statusDetail', `Analysing ${structure.totalFiles} files with Claude…`);
    const prompt = buildClaudePrompt(structureJson);
    const raw = await runCapture(prompt, currentFolder);
    const diagram = extractJson(raw);

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
      return { error: 'No JSON found in Claude output' };
    }

    normalizeDiagramPattern(diagram as Record<string, unknown>, structure);

    currentDiagram = diagram;
    currentNodePaths = structure.nodePaths;

    // Persist to cache; structure changed so drilldowns are stale — wipe them
    saveCache(currentFolder, { structureHash, diagram });

    mainWindow.webContents.send('canvas:diagram', diagram);
    mainWindow.webContents.send('analysis:status', 'done');
    sendGitStatus(mainWindow);

    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    mainWindow.webContents.send('analysis:status', 'error');
    return { error: message };
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

ipcMain.handle('component:detail', async (_e, name: string) => {
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const nodeNames = extractNodeNames(currentDiagram);
    const prompt = buildComponentDetailPrompt(name, nodeNames);
    const raw = await runCapture(prompt, currentFolder);
    const detail = extractJson(raw);
    if (!detail) return { error: 'no detail' };
    return { ok: true, detail };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Component drilldown ───────────────────────────────────────────────────────

/**
 * Find source files relevant to a component name.
 * Scores every source file by name-match + occurrence count, returns top 3.
 * Searches the full project tree (not just the 80-file index) so concept-level
 * labels like "SimEngine" that span multiple files are handled correctly.
 * Never returns empty — if nothing scores > 0 returns [] and caller uses
 * project structure as fallback context.
 */
function findSourceFiles(
  name: string,
  nodePaths: Record<string, string>,
  projectRoot: string,
): { filePath: string; content: string }[] {
  const lc = name.toLowerCase();
  const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.kt', '.java', '.py', '.swift', '.dart', '.go', '.rs', '.vue', '.cs']);
  const IGNORE = new Set(['node_modules', 'dist', 'build', '.git', '.dart_tool', 'Pods', '.next', 'out', 'target', '__pycache__', 'coverage']);

  const read = (fp: string): string => { try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; } };

  const scoreFile = (fileName: string, content: string): number => {
    const fn = fileName.toLowerCase().replace(/\.[^.]+$/, '');
    let s = 0;
    if (fn === lc) s += 100;
    else if (fn.includes(lc) || lc.includes(fn)) s += 50;
    try {
      const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      s += Math.min((content.match(re) || []).length * 3, 45);
    } catch { /* ignore invalid regex */ }
    return s;
  };

  const seen = new Set<string>();
  const results: { filePath: string; content: string; score: number }[] = [];

  const add = (fp: string, fileName: string) => {
    if (seen.has(fp)) return;
    seen.add(fp);
    const content = read(fp);
    const s = scoreFile(fileName, content);
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
        else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase()))
          add(path.join(dir, e.name), e.name);
      }
    };
    walk(projectRoot, 0);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3).filter(r => r.score > 0).map(r => ({ filePath: r.filePath, content: r.content }));
}

function buildDrilldownPrompt(name: string, sourceCode: string, imports: string[], calledBy: string[]): string {
  return [
    `You are explaining the "${name}" feature to a smart non-engineer. Look at the source code and draw exactly what happens when a user uses this feature — step by step.`,
    'Output ONLY the JSON below — no fences, no prose.',
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
    'EDGE LABELS: what triggers the transition — user action or outcome.',
    '   Good: "taps submit", "password wrong", "success", "no results found"',
    '   Bad: "calls", "returns Promise", "dispatches"',
    '',
    calledBy.length > 0 ? `This feature is reached from: ${calledBy.join(', ')}` : '',
    '',
    'MERMAID SYNTAX (follow exactly):',
    '- Start with `flowchart TD`.',
    '- Node id = letters/digits/underscore only. Format: `Id[Label]`.',
    '- Label: letters, digits, spaces only. NO special chars inside [ ].',
    '- Edge with label: `A -->|taps submit| B`.',
    '- NO subgraph, NO classDiagram, NO sequenceDiagram.',
    '- 8–16 nodes. Every node must be connected.',
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

ipcMain.handle('component:drilldown', async (_e, rawName: string) => {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const cached = loadCache(currentFolder);
    if (cached?.drilldowns?.[name]) {
      return { ok: true, mermaid: cached.drilldowns[name], fromCache: true };
    }

    const structure = extractStructure(currentFolder);
    const sourceFiles = findSourceFiles(name, structure.nodePaths, currentFolder);

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
      : `// No source file found for "${name}" — using project structure for context.\n${toClaudePromptJSON(structure).slice(0, 4000)}`;

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

    const prompt = buildDrilldownPrompt(name, contextForClaude, imports, calledBy.slice(0, 8));
    const raw = await runCapture(prompt, currentFolder);
    const parsed = extractJson(raw) as { mermaid?: string } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    saveDrilldown(currentFolder, name, parsed.mermaid);
    return { ok: true, mermaid: parsed.mermaid };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Code flow ─────────────────────────────────────────────────────────────────

function buildCodeFlowPrompt(name: string, sourceCode: string): string {
  return [
    `Produce a code flow diagram for the "${name}" feature. Group functions by class using subgraphs. Each function gets TWO nodes: a function node and a description note below it.`,
    'Output ONLY the JSON below — no fences, no prose.',
    '',
    'FOR EACH FUNCTION, create two nodes:',
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
    '- Subgraph per class: `subgraph ClassName\\n  ...\\nend`',
    '- Function node: `Id["fnName()\\ncode line"]`  — double quotes, \\n between lines',
    '- Description node: `IdDesc(["plain sentence"])`  — stadium shape with double quotes',
    '- Node ids: letters/digits/underscore only, unique across all subgraphs',
    '- Cross-class edges go between the description node of one class and the function node of another',
    '- 5–12 function nodes total. Every node connected.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \\n for newlines"}',
    '',
    `SOURCE CODE of ${name}:`,
    '```',
    sourceCode.slice(0, 8000),
    '```',
    '',
    'JSON only.',
  ].join('\n');
}

ipcMain.handle('component:codeflow', async (_e, rawName: string) => {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const cached = loadCache(currentFolder);
    const cachedValue = cached?.codeflows?.[name];
    if (typeof cachedValue === 'string' && cachedValue.includes('flowchart')) {
      return { ok: true, mermaid: cachedValue, fromCache: true };
    }

    const structure = extractStructure(currentFolder);
    const sourceFiles = findSourceFiles(name, structure.nodePaths, currentFolder);

    let sourceCode = '';
    let budget = 8000;
    for (const { filePath, content } of sourceFiles) {
      const rel = path.relative(currentFolder, filePath);
      const chunk = content.slice(0, budget);
      sourceCode += `\n// ── ${rel} ──\n${chunk}`;
      budget -= chunk.length;
      if (budget <= 0) break;
    }

    const context = sourceCode.trim()
      ? sourceCode
      : `// No source file found for "${name}" — using project structure.\n${toClaudePromptJSON(structure).slice(0, 4000)}`;

    const raw = await runCapture(buildCodeFlowPrompt(name, context), currentFolder);
    const parsed = extractJson(raw) as { mermaid?: string } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    saveCodeFlow(currentFolder, name, parsed.mermaid);
    return { ok: true, mermaid: parsed.mermaid };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

function normalizeDiagramPattern(diagram: Record<string, unknown>, structure: ExtractedStructure) {
  const pat = (diagram.pattern as string | undefined) || '';
  const weak = !pat || pat.toLowerCase() === 'unknown' || pat.toLowerCase() === 'n/a' || pat.trim() === '';
  if (!weak) return;

  const langs = structure.languages;
  let inferred = 'Layered Architecture';
  if (langs.includes('.kt') || langs.includes('.java')) inferred = 'Android App';
  else if (langs.includes('.swift')) inferred = 'iOS App';
  else if (langs.includes('.dart')) inferred = 'Flutter App';
  else if (langs.includes('.py')) inferred = 'Python Project';
  else if (langs.includes('.go')) inferred = 'Go Service';
  else if (langs.includes('.rs')) inferred = 'Rust Project';
  else if (langs.includes('.ts') || langs.includes('.tsx')) inferred = 'TypeScript App';

  diagram.pattern = inferred;
}

// ── Impact summary ────────────────────────────────────────────────────────────

interface ImpactSummary {
  changed: { name: string; type: string; description: string; oldDescription: string }[];
  impacted: { name: string; type: string; description: string; reason: string }[];
}

// ── PTY Claude detection ──────────────────────────────────────────────────────

let summaryPending = false;

function setupPtyClaudeDetection() {
  let buffer = '';

  setPtyDataCallback((data: string) => {
    buffer += data;
    if (buffer.length > 8000) buffer = buffer.slice(-4000);

    const done = /\b(?:Worked|Baked|Cooked|Cogitated|Processed|Computed|Thought|Reasoned|Analysed|Analyzed|Simulated|Crafted|Pondered|Simmered|Calculated|Deliberated|Churned|Digested|Mulled|Ruminated)\s+for\s+\d/i.test(buffer);
    if (done && mainWindow && !summaryPending) {
      summaryPending = true;
      buffer = '';
      const ptyCwd = getPtyCwd();
      const rawFolder = ptyCwd || currentFolder || os.homedir();
      const folder = findProjectRoot(rawFolder);
      const win = mainWindow;
      if (folder !== currentFolder && fs.existsSync(folder)) {
        currentFolder = folder;
        saveLastProject(folder);
        win.webContents.send('folder:restored', { folder, hasCachedDiagram: false });
        stopFileWatcher();
        startFileWatcher(folder, (changedFiles) => {
          if (mainWindow) sendGitStatus(mainWindow);
          runIncrementalPatch(changedFiles);
        });
      }
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
