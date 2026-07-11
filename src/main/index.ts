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

interface CacheFile {
  structureHash: string;           // SHA-256 of structureJson — invalidates when code changes
  diagram: object;                 // full DiagramData returned by Claude
  drilldowns: Record<string, string>;  // componentName → mermaid string
  savedAt: number;                 // Date.now() at write time
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
    "structure": "flowchart TD string — layers as subgraphs, labelled edges",
    "sequence": "flowchart LR string — one request end-to-end",
    "gitDiff": ""
  }
}`;

  return [
    'You are a senior software architect. Identify this project\'s architecture, then draw how DATA FLOWS between its parts (not a folder tree). Output ONLY the JSON below — no fences, no prose.',
    '',
    '1. PATTERN — infer from language, class/folder names, and imports:',
    '   ViewModel/Repository → MVVM · domain/data/presentation → Clean · Controller/Model/View → MVC · store/reducer/action → Redux/Flux · else → Layered.',
    '',
    '2. LAYERS — group key components top→bottom by data flow (UI → ViewModel → Domain → Repository → Network/DB). Use names that fit this project.',
    '',
    '3. structure diagram — 8-16 KEY components (no folders, no config). Use imports to decide edges. Label EVERY edge with the data/reason.',
    '   DO NOT use subgraph — flat flowchart only, no subgraph/end blocks.',
    '',
    '4. sequence diagram — trace ONE user action end-to-end through the layers.',
    '',
    'MERMAID SYNTAX (follow exactly or it will not render):',
    '- Start with `flowchart TD` (structure) or `flowchart LR` (sequence). Never classDiagram/sequenceDiagram/subgraph.',
    '- Node id = letters/digits only (no dots, spaces, slashes). Format: `Id[Label]`.',
    '- Label text: letters, digits, spaces only. NO ( ) / : ; " \' | inside [ ].',
    '- Edge with label: `A -->|gets visit list| B`  ← pipes only around the label, never inside it.',
    '- subgraph: `subgraph Data` … `end`. One node per line. Reuse the same Id everywhere.',
    '',
    'VALID EXAMPLE (copy this shape):',
    'flowchart TD',
    '  subgraph UI',
    '    HomeScreen[HomeScreen]',
    '  end',
    '  subgraph Data',
    '    VisitRepo[VisitRepo]',
    '    ApiClient[ApiClient]',
    '  end',
    '  HomeScreen -->|asks for visits| VisitRepo',
    '  VisitRepo -->|GET visits| ApiClient',
    '  ApiClient -->|visit json| VisitRepo',
    '',
    'Schema:',
    schema,
    '',
    'Each diagrams value is raw Mermaid (newlines as \\n), not fenced.',
    '',
    'Project (folders, files, imports — imports are the edges):',
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
    trafficLightPosition: { x: 16, y: 16 },
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

// ── Component drilldown (double-click: detailed sub-diagram) ─────────────────

function buildDrilldownPrompt(name: string, structureJson: string): string {
  return [
    `You are a senior software architect. Draw a detailed internal diagram of the component "${name}".`,
    'Output ONLY the JSON below — no fences, no prose.',
    '',
    'RULES:',
    '- Show the internal structure: key functions/methods, data it owns, sub-components.',
    '- Show every incoming and outgoing connection to OTHER components in the project.',
    '- Use real names from the project code.',
    '- 6–14 nodes total. Label every edge with what data or call flows across it.',
    '',
    'MERMAID SYNTAX (follow exactly):',
    '- Start with `flowchart TD`.',
    '- Node id = letters/digits/underscore only. Format: `Id[Label]`.',
    '- Label text: letters, digits, spaces only. NO ( ) / : ; " \' | inside [ ].',
    '- Edge with label: `A -->|data or call| B`.',
    '- NO subgraph, NO classDiagram, NO sequenceDiagram.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string with \\n as newlines"}',
    '',
    'Project structure (for context):',
    structureJson,
    '',
    'JSON only.',
  ].join('\n');
}

ipcMain.handle('component:drilldown', async (_e, name: string) => {
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    // Check drilldown cache first
    const cached = loadCache(currentFolder);
    if (cached?.drilldowns?.[name]) {
      return { ok: true, mermaid: cached.drilldowns[name], fromCache: true };
    }

    const structure = extractStructure(currentFolder);
    const prompt = buildDrilldownPrompt(name, toClaudePromptJSON(structure));
    const raw = await runCapture(prompt, currentFolder);
    const parsed = extractJson(raw) as { mermaid?: string } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    // Persist drilldown so repeat double-clicks are instant
    saveDrilldown(currentFolder, name, parsed.mermaid);

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
