import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { createPty, writeToPty, resizePty, killPty, restartPty, runCapture as runProviderCapture, setPtyDataCallback, getPtyCwd, getAiProvider, setAiProvider, AI_PROVIDERS, AiProvider } from './ptyManager';
import { startFileWatcher, stopFileWatcher } from './fileWatcher';
import { extractStructure, toClaudePromptJSON, ExtractedStructure } from './codeExtractor';
import { buildGraphifyIndex, graphifyPromptContext, graphifySourceFiles } from './graphifyContext';
import { startMcpServer, stopMcpServer, recordPtyOutput, updateClaudeJsonMcpConfig } from './mcpServer';
import { listPRs, listLocalBranches, reviewPR, PRInfo } from './prReviewer';

let mainWindow: BrowserWindow | null = null;
let currentFolder: string | null = null;
let currentDiagram: object | null = null;
let currentNodePaths: Record<string, string> = {};
let patchInProgress = false;
let preferredDiagramType = 'flowchart'; // updated by renderer type picker
let analysisDepth: 1 | 2 | 3 = 2; // overview, balanced, deep — set by the user

function analysisDepthGuidance(): string {
  if (analysisDepth === 1) return 'DEPTH: Overview. Show only the 4–6 essential steps, the main success path, and at most one important choice. Prefer a short explanation over completeness.';
  if (analysisDepth === 3) return 'DEPTH: Deep. Show the complete meaningful path, important alternatives/errors, and every proven component or boundary handoff. Explain unfamiliar terms and why each step exists.';
  return 'DEPTH: Balanced. Show 6–10 important steps, the main path, and only the choices or communications needed to understand how it works.';
}

// All main-process AI actions inherit the user's selected detail level,
// including focused questions and change/commit explanations.
function runCapture(prompt: string, cwd: string): Promise<string> {
  return runProviderCapture(`${prompt}\n\n${analysisDepthGuidance()}`, cwd);
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
// One JSON file per project, keyed by a hash of the extracted structure.
// Drilldown results are cached inside the same file under `drilldowns[name]`.

interface CodeFlowStep { fn: string; what: string; data: string }

interface CommitDiagram {
  featureFlow: { mermaid: string; descriptions?: Record<string, string> };
  codeFlow:    { mermaid: string; happyPath?: string[] };
}

interface CacheFile {
  structureHash: string;
  provider?: AiProvider;
  diagram: object;
  drilldowns: Record<string, string>;
  codeflows: Record<string, string>;
  commitDiagrams?: Record<string, CommitDiagram>;
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
      provider: getAiProvider(),
      diagram: data.diagram,
      drilldowns: { ...(existing?.drilldowns ?? {}), ...(data.drilldowns ?? {}) },
      codeflows: { ...(existing?.codeflows ?? {}), ...(data.codeflows ?? {}) },
      commitDiagrams: { ...(existing?.commitDiagrams ?? {}), ...(data.commitDiagrams ?? {}) },
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

function clearProjectCache(folder: string): boolean {
  try {
    const target = cacheFile(folder);
    if (fs.existsSync(target)) fs.unlinkSync(target);
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
    fs.writeFileSync(cacheFile(folder), JSON.stringify(existing, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function persistDiagram(diagram: object) {
  currentDiagram = diagram;
  // Terminal auto-visualisations are not analysis results.  Storing one in the
  // analysis cache overwrites the valid project map with a hash that can never
  // match, turning the next Analyse into a guaranteed cache miss.
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
const ANALYSIS_SCHEMA_VERSION = 'user-interaction-map-v5';

/** File and symbol names are insufficient to infer product behaviour. */
function buildAnalysisSourceContext(structure: ExtractedStructure): string {
  const files = Object.entries(structure.nodePaths).sort(([a], [b]) => {
    const score = (name: string, filePath: string) => {
      const value = (name + ' ' + filePath).toLowerCase();
      if (/(activity|fragment|screen|navigation|navigator|router|search|explore|article|readinglist|saved|history|settings|nearby|map|login|edit)/.test(value)) return 0;
      if (/^(main|index|app|router|routes|server|api)/i.test(name)) return 1;
      if (/(build|gradle|script|release|generate|upload|testkitchen)/.test(value)) return 4;
      return 2;
    };
    return score(a, structure.nodePaths[a]) - score(b, structure.nodePaths[b]) || a.localeCompare(b);
  });
  const chunks: string[] = [];
  let remaining = 50000;
  for (const [, filePath] of files) {
    if (remaining <= 0) break;
    try {
      const source = fs.readFileSync(filePath, 'utf8');
      if (source.includes('\0')) continue;
      const isEntry = /(?:^|\/)(?:index|main|app|router|routes|server)\./i.test(filePath);
      const isJourneySource = /(activity|fragment|screen|navigation|navigator|router|search|explore|article|readinglist|saved|history|settings|nearby|map|login|edit)/i.test(filePath);
      const excerpt = source.slice(0, Math.min(isEntry ? 2800 : isJourneySource ? 1800 : 900, remaining));
      chunks.push(`\n// ── ${path.basename(filePath)} ──\n${excerpt}`);
      remaining -= excerpt.length;
    } catch { /* omit unreadable source */ }
  }
  return chunks.join('');
}

function buildClaudePrompt(structureJson: string, sourceContext: string): string {
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
    '',
    'EVIDENCE RULES:',
    '- Infer only user-visible features and outcomes supported by the supplied evidence.',
    '- Before writing the diagram, systematically inspect the repository for user entry points: activities, fragments, composable screens, navigation destinations, tabs, drawers, menu actions, deep links, search actions, and settings screens. Do not stop after the first feature path found.',
    '- The relationship graph records source-proven imports. Use it to connect related features correctly, but do not show it or technical module names in the user-facing flow.',
    '- If a feature is unclear from the evidence, omit it. Never invent screens, accounts, payments, storage, integrations, or error states.',
    '- This is the FIRST learning level. Do not explain code, architecture, files, classes, functions, APIs, databases, state, requests, or technical layers.',
    '',
    'COMPACT USER MAP RULES for diagrams.structure:',
    '- This is a readable navigation overview, NOT a full interaction trace. Start at opening the app, then show every independently reachable user area as one clear branch.',
    '- Cover all evidenced areas, but group closely related actions under one user-facing hub. For example, “Tap an article” can cover reading, related links, saving, and sharing; “Tap Search” can cover entering a query and choosing a result.',
    '- Use 6 to 10 nodes at Overview or Balanced depth, and 10 to 14 at Deep. Keep a strict tree: one opening node, 4 to 7 first-level action branches, and at most one result node per branch.',
    '- Never draw return arrows, cross-links, repeated nodes, or more than two levels below the opening node. Each node must have one parent so the map remains readable.',
    '- Every branch must answer “what can the user do?” Use action-led labels such as “Tap Search”, “Tap Explore”, “Tap Saved articles”, “Open Nearby map”, “Open Games”, or “Open Settings”. Do not use destination-only labels.',
    '- Put detailed sequences, typing, scrolling, save/share choices, loading states, and error branches in diagrams.sequence—not in this overview.',
    "- Labels must be everyday language from the person's point of view. Good: \"Choose a project\", \"See the project map\", \"Read a feature walkthrough\". Bad: \"invoke analysis handler\", \"parse repository\", \"call API\".",
    '- Use "Person" or "User" only as the starting point when it makes the journey clearer.',
    '',
    'DETAIL USER FLOW RULES for diagrams.sequence:',
    '- Show 2 or 3 short, disconnected, tap-by-tap flows for the most important exploration routes. These belong in the “More User Flows” tab, not the main overview.',
    '- Each flow may have 4 to 7 nodes, for example: “Tap Search” → “Type a topic” → “See matching results” → “Tap an article” → “Read and explore links”.',
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

function mainMapNodeCount(mermaid: string): number {
  const ids = new Set<string>();
  const matches = mermaid.matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*[\[\(\{]/g);
  for (const match of matches) ids.add(match[1]);
  return ids.size;
}

/** Enforce progressive disclosure when an otherwise useful AI map is too dense. */
async function compactMainUserMap(diagram: AnalysisDiagram, folder: string): Promise<AnalysisDiagram> {
  const structure = diagram.diagrams?.structure;
  if (!structure || mainMapNodeCount(structure) <= 10) return diagram;
  const prompt = [
    'Rewrite the supplied Mermaid user navigation map for a small canvas.',
    'Output ONLY JSON: {"mermaid":"flowchart TD string"}.',
    'Keep EVERY distinct user area, but merge its internal steps into one action-led branch.',
    'The result MUST contain exactly 8 to 10 nodes, have a strict tree layout, no return arrows, no cross-links, no subgraphs, and every edge must have a short tap/action label.',
    'Use detailed interactions only in the branch label; do not list cards, tabs, or secondary options separately.',
    'CURRENT MAP:',
    structure,
  ].join('\n\n');
  const result = extractJson(await runCapture(prompt, folder)) as { mermaid?: string } | null;
  if (!result?.mermaid || mainMapNodeCount(result.mermaid) > 10) return diagram;
  return { ...diagram, diagrams: { ...diagram.diagrams, structure: result.mermaid } };
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
    '- Only include nodes that were actually changed in the diff. 1–4 nodes max.',
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
          'mermaid' in parsed || 'diagrams' in parsed || 'title' in parsed || 'detail' in parsed || 'files' in parsed
        )) return parsed;
      } catch { /* try the next balanced object */ }
      break;
    }
  }

  // If a provider ignored the JSON-only instruction but returned valid Mermaid,
  // retain the map instead of leaving the canvas blank.
  const mermaidStart = clean.search(/(?:^|\n)\s*(?:flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|kanban)\b/i);
  if (mermaidStart >= 0) return { mermaid: clean.slice(mermaidStart).trim() };
  return null;
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

      const { structureJson, hash: structureHash } = analysisCacheHash(structure, folder);

      // Check cache before asking Claude
      const cached = loadCache(folder);
      let base: object | null = null;
      if (cached && cached.structureHash === structureHash && cached.diagram && (cached.provider ?? 'claude') === getAiProvider()) {
        base = cached.diagram;
      } else {
        const raw = await runCapture(buildClaudePrompt(structureJson, buildAnalysisSourceContext(structure)), folder);
        base = extractJson(raw) as AnalysisDiagram | null;
        if (base) base = await compactMainUserMap(base, folder);
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

    // Build the full diff text for the change-context prompt
    let fullDiff = '';
    try {
      fullDiff = execSync('git --no-pager diff HEAD', { cwd: folder, encoding: 'utf8', timeout: 8000, env: GIT_ENV }).slice(0, 6000);
    } catch { /* ignore */ }

    // Run explain + change-context in parallel
    const [raw, ctxRaw] = await Promise.all([
      runCapture(buildExplainPrompt(changedFiles, gitDiffSummary, nodeNames), folder),
      runCapture(buildChangeContextPrompt(fullDiff || gitDiffSummary, nodeNames), folder),
    ]);

    const parsed = extractJson(raw) as { changes?: ChangeExplanation[] } | null;
    const changes = parsed?.changes || [];
    const ctxParsed = extractJson(ctxRaw) as { nodes?: ChangeContextNode[] } | null;

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
      if (ctxParsed?.nodes?.length) {
        win.webContents.send('canvas:changeContext', ctxParsed.nodes);
      }
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
  loadAiProvider();
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
    if (!mainWindow) return;
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
      currentFolder = last;
      restartPty(mainWindow, last);

      // Restore cached diagram immediately — canvas is populated before any analysis
      const cached = loadCache(last);
      if (cached?.diagram && (cached.provider ?? 'claude') === getAiProvider()) {
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
ipcMain.handle('analysis:setDepth', (_e, depth: number) => {
  analysisDepth = depth === 1 || depth === 3 ? depth : 2;
  return analysisDepth;
});
ipcMain.handle('project:relationships', () => {
  if (!currentFolder) return { ok: false, error: 'No project is open' };
  const structure = extractStructure(currentFolder);
  return { ok: true, relationships: structure.relationships, mermaid: buildRelationshipGraphMermaid(structure) };
});

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

  // Restore only a diagram created with the current analysis prompt/schema.
  const cached = loadCache(folder);
  const restoreStructure = extractStructure(folder);
  const { hash: restoreHash } = analysisCacheHash(restoreStructure, folder);
  const hasCurrentCachedDiagram = !!cached?.diagram
    && cached.structureHash === restoreHash
    && (cached.provider ?? 'claude') === getAiProvider();
  if (hasCurrentCachedDiagram && cached?.diagram) {
    currentDiagram = cached.diagram;
    mainWindow.webContents.send('canvas:diagram', cached.diagram);
  }

  startFileWatcher(folder, (changedFiles) => {
    if (mainWindow) sendGitStatus(mainWindow);
    runIncrementalPatch(changedFiles);
  });

  return { folder, hasCachedDiagram: hasCurrentCachedDiagram };
});

ipcMain.handle('cache:clearProject', () => {
  if (!currentFolder) return { ok: false, error: 'No project is open' };
  const ok = clearProjectCache(currentFolder);
  if (ok) currentDiagram = null;
  return ok ? { ok: true } : { ok: false, error: 'Could not clear the project cache' };
});

async function runAnalysisInternal(): Promise<{ ok?: boolean; error?: string; fromCache?: boolean }> {
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

    const { structureJson, hash: structureHash, graphify } = analysisCacheHash(structure, currentFolder);

    // ── Cache hit: structure unchanged since last analysis ──
    const cached = loadCache(currentFolder);
    if (cached && cached.structureHash === structureHash && cached.diagram && (cached.provider ?? 'claude') === getAiProvider()) {
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
    const graphNote = graphify.available
      ? ` using ${graphify.nodeCount} Graphify nodes`
      : '';
    mainWindow.webContents.send('analysis:statusDetail', `Analysing ${structure.totalFiles} files${graphNote} with ${providerLabel()}…`);
    const prompt = buildClaudePrompt(structureJson, buildAnalysisSourceContext(structure));
    const raw = await runCapture(prompt, currentFolder);
    let diagram = extractJson(raw) as AnalysisDiagram | null;
    if (diagram) diagram = await compactMainUserMap(diagram, currentFolder);

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
    return { ...result, analysis: await runAnalysisInternal() };
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

async function runComponentDetail(name: string): Promise<{ ok?: boolean; error?: string; detail?: unknown }> {
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
}

ipcMain.handle('component:detail', async (_e, name: string) => runComponentDetail(name));


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
  maxResults = 3,
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
  return ranked.slice(0, maxResults).filter(r => r.score > 0).map(r => ({ filePath: r.filePath, content: r.content }));
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
  for (const edge of edges.slice(0, 36)) output.push(`  ${nodeId(edge.from)}[${label(edge.from)}] -->|${edge.kind}| ${nodeId(edge.to)}[${label(edge.to)}]`);
  if (edges.length === 0) {
    for (const definition of definitions.slice(0, 12)) output.push(`  ${nodeId(definition.key)}[${label(definition.key)}]`);
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
  const edges = [...owns].map(value => ({ value, kind: 'contains' })).concat([...calls].map(value => ({ value, kind: 'calls' }))).slice(0, 36);
  for (const edge of edges) {
    const [from, to] = edge.value.split('|');
    lines.push(`  ${nodeId(from)}[${label(from)}] -->|${edge.kind}| ${nodeId(to)}[${label(to)}]`);
  }
  if (edges.length === 0) {
    const fallbackDefs = [...definitions.values()].slice(0, 12);
    if (fallbackDefs.length) {
      for (const def of fallbackDefs) lines.push(`  ${nodeId(def.key)}[${label(def.label)}]`);
    } else if (imports.size) {
      const module = 'Selected module';
      for (const imported of [...imports].slice(0, 12)) {
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

async function runComponentDrilldown(rawName: string): Promise<{ ok?: boolean; error?: string; mermaid?: string; fromCache?: boolean }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const cached = loadCache(currentFolder);
    const cacheKey = 'canonical-v4:depth-' + analysisDepth + ':' + name;
    if (cached?.drilldowns?.[cacheKey]) {
      return { ok: true, mermaid: cached.drilldowns[cacheKey], fromCache: true };
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
    const raw = await runCapture(prompt, currentFolder);
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
    `Produce a Mermaid code flow diagram for the "${name}" feature. Use one connected flowchart; each function gets TWO nodes: a function node and a description note below it.`,
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
    '- Do NOT use subgraph, classDef, style, click, classDiagram, or sequenceDiagram.',
    '- Function node: `Id["fnName()\\ncode line"]`  — double quotes, \\n between lines',
    '- Description node: `IdDesc(["plain sentence"])`  — stadium shape with double quotes',
    '- Node ids: letters/digits/underscore only, unique across all subgraphs',
    '- Cross-class edges go between the description node of one class and the function node of another',
    '- 5–12 function nodes total. Every node connected.',
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

function buildCodeStoryPrompt(name: string, sourceCode: string, hierarchyContext = ''): string {
  return [
    'Explain how the selected component, "' + name + '", behaves when its code runs. Create a plain-English Code Story, not a feature map or a user journey.',
    'Output ONLY the JSON below — no fences, no prose.',
    analysisDepthGuidance(),
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
    '- Tell the complete feature story across all supplied files: entry/input → orchestration → every meaningful decision → local/service/storage work → success result and meaningful failure result.',
    '- Treat every meaningful boundary as a contract, not a black box. When the source shows a call across components, processes, services, repositories, storage, or an external system, say who calls whom, what information crosses the boundary, and what comes back (including a proved failure or empty result).',
    '- For each source-proven REST/HTTP call, show a request and response boundary. Name the method and path, then describe only the proved path/query/header/body fields and response fields, types, status, or errors. Use `unknown` where the source does not prove a detail; never turn “load data” into a vague substitute for an endpoint contract.',
    '- A provider name alone is NOT a contract. Never emit a node such as “Remote recognition API called” without its adjacent request and response details. If a library/SDK hides the HTTP request, state `Endpoint: unknown (provider SDK)` and name the proved SDK operation, input shape, and returned result shape; do not guess the provider endpoint.',
    '- When data is persisted, explain the storage contract: the proven record/entity shape or key, whether it is read, created, updated, or deleted, and the result returned to the caller. Do not infer database tables or columns that are not in the source.',
    '- Use 6–12 connected steps, ordered from top to bottom. Do not stop at the first helper when the supplied source shows what it calls next.',
    '- Every node must stand on its own for a developer seeing this codebase for the first time: write the action, the meaning of the data, and the purpose in everyday language. Good: "Receive the selected visit details", "Find the selected visit in local storage", "Check whether the visit can continue", "Save the completed survey result". Bad: "Action binding received", "selectedVisitODataReadLink", "isSurvey", "visitWithoutCheckin", or any other raw identifier.',
    '- Never put variable names, parameter names, binding names, OData names, field names, acronyms, file paths, class names, or function names in a Mermaid node or edge. Translate them: selectedVisitODataReadLink becomes "the selected visit reference"; isSurvey becomes "whether this action opens a survey". If a code name is necessary for verification, put it only at the end of its description as Evidence: name in file.',
    '- Name conditional behaviour truthfully. If the source branches, show both meaningful outcomes with labels such as "valid data" and "missing data"; do not quietly present only the happy path.',
    '- Do not use function names, class names, variable names, file paths, or source code in the chart.',
    '- Edge labels are the data or decision in plain English: "answers", "missing field", "valid survey".',
    '',
    'DESCRIPTIONS:',
    '- Give every node two short sentences: first, what it means in everyday language; second, why this step is needed before the next one.',
    '- Every description must state the information interaction in this form: "Meaning: [plain-language state before] → [plain-language state after]. Why: [why this read, change, or send is needed]."',
    '- For a boundary node, add `Contract:` after Meaning: identify caller → receiver, transport (direct call, event, IPC, HTTP/REST, repository, or storage), input → result/error. For HTTP include `Endpoint: METHOD /path`, and for storage include `Record: proven key/fields or unknown`. Keep it factual and readable.',
    '- Do not mention code names, file paths, design patterns, or developer terminology in the reader-facing explanation.',
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
    '{"mermaid":"flowchart TD string — use \\n for newlines","descriptions":{"Node Label":"Plain-English explanation of this step."},"happyPath":["nodeId1","nodeId2"]}',
    '',
    'SOURCE CODE of ' + name + ':',
    sourceCode.slice(0, 16000),
    '',
    'JSON only.',
  ].join('\n');
}

/** A second pass that reviews the first diagram as a developer new to this codebase. */
function buildCodeStoryNewbieReviewPrompt(
  name: string, sourceCode: string, hierarchyContext: string, candidate: { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }, usesPriorTurn = false,
): string {
  return [
    `You are a senior developer reviewing a "How it works" explanation of "${name}" for a teammate opening this codebase for the first time.`,
    'Improve the candidate diagram rather than giving general feedback. Output ONLY the replacement JSON—no fences or prose.',
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
    '- Keep 6–14 connected Mermaid nodes. Start with `flowchart TD`; use plain IDs and no subgraphs, styles, or code snippets.',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string","descriptions":{"Node label":"Meaning: ... Contract: ... Why: ..."},"happyPath":["nodeId"]}',
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

function buildImplementationPrompt(name: string, sourceCode: string, hierarchyContext = ''): string {
  return [
    'Create an example-led technical story called "How this is built" for the selected feature, "' + name + '". It must let a developer follow one representative piece of data through the real implementation, from trigger to result.',
    'Output ONLY the JSON below — no fences, no prose.',
    analysisDepthGuidance(), '',
    'PRIORITY:',
    '- Clarity beats completeness, but never hide a source-proven HTTP endpoint, request, response, or important data transformation merely to keep the diagram short.',
    '- Start with what this feature enables: the trigger and the useful result it produces. Then show the small number of internal handoffs that make it happen.',
    '- Use everyday labels. Say "Check the saved project", "Ask the project service", "Show the project details"—not class names, architecture patterns, or a line of source code.',
    '- Use 6–14 main nodes. Include an extra node whenever it reveals a real endpoint contract, data transformation, decision, or useful failure outcome.',
    '',
    'TRUTHFULNESS:',
    '- Use only facts proven by the supplied source.',
    '- Treat DRILL FLOW CONTEXT as the feature scope. Preserve proved outcomes and branches, but do not redraw the user journey.',
    '- Combine private helper functions into the component that owns them. Do not invent details, fields, endpoints, or error paths.',
    hierarchyContext ? [
      '',
      'LOCAL AST EVIDENCE (authoritative):',
      '- Use this local class/function hierarchy to identify component ownership and direct calls.',
      '- A `contains` edge means ownership only; a `calls` edge is a source-proven direct call.',
      '- Do not claim an unshown call or cross-component contract.',
      hierarchyContext,
    ].join('\n') : '',
    '',
    'EXAMPLE-LED IMPLEMENTATION STORY:',
    '- Choose one representative input, record, request, or user action that is genuinely evidenced by the supplied source. Introduce it in the first node and follow that SAME example through every later step.',
    '- Explain the sequence as a story: what arrives → what the feature checks → what it asks for → what comes back → how it changes or selects the data → what it finally shows, stores, or hands off.',
    '- If source proves only a type or no concrete field names, use a clearly symbolic example such as "the selected item" or `{selectedId}`. Never make up sample values, endpoint fields, success statuses, or response objects.',
    '- Do not draw a static architecture inventory. Each node must answer: "What happens next to our example?" Keep independent branches only for source-proven outcomes such as empty data, validation failure, or request failure.',
    '- Begin every node description with `In this example:` and explain what happens to the same representative data at that point before giving the technical contract details.',
    '',
    'COMMUNICATION CONTRACTS:',
    '- Show every meaningful handoff between components, layers, processes, services, repositories, storage, or external systems. A tiny private helper does not need its own contract.',
    '- Make each handoff easy to read: `Caller -->|what it asks for and key input| Receiver` followed by `Receiver -->|what comes back or fails| Caller`.',
    '- For EVERY source-proven REST/HTTP call, always draw all three parts: `Request — METHOD path and key input` → `Service — REST call` → `Response — status and result`. Do not collapse an endpoint into a vague “load data” or “call service” step.',
    '- The REST request description MUST say: `Endpoint: METHOD /path. Request data: query, path, header, and body fields proven by source (or none/unknown).` Use placeholders such as `{visitId}`; never invent values or fields.',
    '- The REST response description MUST say: `Response data: source-proven status, fields/types, and error behaviour (or unknown). Used by: exactly how this component reads, filters, transforms, stores, or displays that data.`',
    '- A provider name is never enough. When an SDK hides HTTP, show two explicit nodes: `Send audio/data to provider SDK` and `Receive provider result`. Their descriptions MUST say `Endpoint: unknown (provider SDK)` plus the proved SDK operation, input fields/types, output fields/types, and error result; do not invent a URL.',
    '- Follow returned data until its next meaningful use. If the code maps a response to view data, filters a list, chooses an item, saves it, or passes it to another component, show that handoff and describe the before → after data shape in plain English.',
    '- For IPC, storage, repositories, and events use the same idea: show who asks, what they send, who handles it, and what returns. Do not create a separate node for request and response when an arrow label makes the contract clear.',
    '- For a source-proven database or persistent store, state the storage contract: entity/table/collection or record key when proven, the fields or types that cross the boundary, and whether the operation reads, creates, updates, or deletes. If the schema is not present in the supplied source, say `schema unknown`; never infer it from a name.',
    '- EVERY node description must teach the reader, not merely cite the code. Use this exact reader-friendly order: `In this example: [what happens to the representative input/data]. Data: [what comes in → what leaves, including fields/types when source proves them]. Communication: [endpoint/caller/receiver and request or response when applicable]. Why it happens: [why this step is needed for the feature to work].`',
    '- Explain unfamiliar terms where they appear. For example: `What it means: Streaming links are optional saved web addresses for music services. Why it happens: Empty addresses cannot open a service, so the app keeps only usable links. Communication: The screen receives the usable list and creates one button for each link.`',
    '- Keep descriptions free of source paths, function names, class names, and framework jargon. The chart should read like a guided explanation, not a code review.',
    '',
    'DIAGRAM:',
    '- Use flowchart TD. Rectangles are steps; diamonds are only for important decisions; database/cloud shapes are only for proven storage/external systems.',
    '- Use short, plain-English node labels and short arrow labels. Keep source-level names in descriptions only.',
    '- Show meaningful success and failure/empty outcomes, but merge low-level errors that lead to the same result.',
    '- Never expose secrets.', '',
    'Schema:',
    '{"mermaid":"flowchart TD string — use \n for newlines","descriptions":{"Node Label":"In this example: ... Data: input → output. Communication: Endpoint: METHOD /path; Request data: ...; Response data: ...; Used by: ... Why it happens: ..."},"happyPath":["nodeId1","nodeId2"]}', '',
    'SOURCE CODE of ' + name + ':', sourceCode.slice(0, 16000), '', 'JSON only.',
  ].join('\n');
}

function buildRepositoryCodeStoryPrompt(projectStructure: string): string {
  return [
    'Create one plain-English Code Story for this entire repository. This is a guided overview for a developer who needs to understand what the application does and how its major parts work together.',
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(),
    '',
    'WHAT TO SHOW:',
    '- Show the 5–10 most important responsibilities or feature areas, in the order a request or user action moves through the application.',
    '- Begin with the app entry or user action and finish with the visible result, stored data, or external effect.',
    '- Combine implementation details into meaningful steps. Do not create one node per file, class, or function.',
    '- If the repository has independent feature areas, show the shared entry point splitting into no more than 3 clear paths, then their outcomes.',
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
    '- 6–12 connected nodes total. No subgraphs, no code snippets, and no technical boilerplate.',
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
    "Create an evidence-based Architecture Story for this repository. This is separate from a code-flow story: it explains the project's technical shape so a developer can orient themselves before tracing a feature.",
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(),
    '',
    'WHAT TO EXPLAIN:',
    '- Runtime and framework: name the framework, language, package manager, and app/runtime type only when the supplied files prove them.',
    '- Architectural pattern: identify the closest pattern actually present, such as layered, MVC, MVVM, feature-based, client-server, or modular. State when it is mixed or unclear.',
    '- State management: explain where UI, domain, or shared state lives and how it changes. If there is no dedicated state library, say so and describe the local mechanism found.',
    '- Data and integrations: identify database, ORM, API, file storage, auth, or external services. If none are evident, explicitly say "No persistence layer detected" rather than inventing one.',
    '- Main boundaries: show how the entry point, UI, business logic, and data/integration layers connect.',
    '',
    'EVIDENCE RULES:',
    '- Every claim must be supported by a package manifest, config file, import, or source reference in PROJECT CONTEXT.',
    '- Do not infer a database from a model name or an architectural pattern from folder names alone.',
    '- Put specific findings in the node labels and supporting evidence in descriptions.',
    '',
    'MERMAID:',
    '- Start with flowchart TD.',
    '- Use 5–8 connected Id[Label] nodes. Include nodes for Runtime and architecture, then state and data when relevant.',
    '- Use short technical labels; framework and pattern names are welcome.',
    '- Every edge must explain the responsibility or data passed between the layers.',
    '- No subgraphs, code snippets, or guesses.',
    '',
    'DESCRIPTIONS:',
    '- Give every node one concise explanation in this exact shape: "What: [finding]. Evidence: [specific files or imports]."',
    '',
    'Schema:',
    '{"mermaid":"flowchart TD string","descriptions":{"Node Label":"What: finding. Evidence: path/file"}}',
    '',
    'PROJECT CONTEXT:',
    projectContext.slice(0, 28000),
    '',
    'JSON only.',
  ].join('\n');
}

function buildRepositoryImplementationPrompt(projectContext: string): string {
  return [
    'Create a feature-by-feature Implementation Map for this repository. Explain how EVERY meaningful feature found in the supplied source is implemented, in plain language for a developer.',
    'Output ONLY the JSON below — no fences or prose.',
    analysisDepthGuidance(), '',
    'WHAT TO SHOW:',
    '- First show the shared startup/entry point. Then create one clearly labelled branch for EACH meaningful, independent feature or workflow found in the source. A feature is a cohesive user or domain capability, not an individual file or helper.',
    '- Treat build scripts, dependency manifests, plugin setup, and generated configuration as infrastructure—not features. Do not devote a feature branch to them unless the repository contains no application or domain feature code.',
    '- For every feature, show its actual implementation path and every meaningful component contract: trigger or entry → important logic/decision → state, data, or API work → result. Use as many contract nodes as needed; do not hide a component-to-component handoff to stay compact.',
    '- Cover all meaningful features the supplied source proves, up to 8 feature branches and 24 nodes total. If there are more, combine closely related minor features and state that in the description.',
    '- Node labels must be plain English operations, not raw class, function, variable, or file names.',
    '- Every description explains concrete implementation details in plain language: request/input, important function calls, object/data movement, response or side effect, conditions, and source evidence in parentheses.',
    '- For EVERY communication between components, describe a contract as: caller → receiver → operation/event and source-proven input → source-proven result/error. State its transport: direct call, event/callback, IPC, HTTP/REST, repository, storage, or other proven mechanism.',
    '- For EVERY proved REST/HTTP endpoint, draw one compact request node and one compact response node: `Request — METHOD path` → `REST boundary` → `Response — result or error`. Keep detailed payloads in node descriptions, not node labels.',
    '- REST request descriptions MUST include a symbolic example: `HTTP Request: METHOD /path?key={Type.field}. Headers: [only proven headers]. Body: { only source-proven fields }.` Example values must be placeholders such as `{query}` or `<token>`, never invented real data.',
    '- REST response descriptions MUST include a symbolic example: `HTTP Response: status [only if proven, otherwise unknown]. Body: { only source-proven fields/types }. Error: [only source-proven error/result]`. If a field, status, header, or error is not proven, write `unknown` instead of guessing.',
    '- Include headers/auth only when source proves them. For direct calls, draw a forward arrow with operation/input and a return arrow with result/error.',
    '- Describe each important object with only source-proven fields or shape, and say whether the step reads, validates, creates, updates, stores, sends, or returns it. Never invent fields or response values.',
    '- Use this exact description order: "Request/Input: [...]. Transport: [...]. Contract: [caller → receiver → operation]. HTTP Request: [... when applicable]. HTTP Response: [... when applicable]. Object: [before] → [after]. Response/Effect: [...]. Evidence: (path/file)."',
    '- Show framework, runtime, persistence, API, or external integrations only when the supplied context proves them.',
    '- Do not invent missing layers. Say no persistence or integration is evident when appropriate.',
    '- Every edge is labelled with the data, event, or responsibility passed between steps.', '',
    'MERMAID:',
    '- Start with flowchart TD.',
    '- Use plain Id[Plain English operation] nodes with labelled edges. Create branches from the shared entry point; do NOT use subgraph, classDef, style, click, classDiagram, or sequenceDiagram.',
    '- Connect the shared entry point to every feature entry. No code snippets.', '',
    'Schema:',
    '{"mermaid":"flowchart TD string","descriptions":{"Node Label":"Request/Input: ... Transport: ... Contract: ... HTTP Request: METHOD /path?field={value}. HTTP Response: status/body/error. Object: ... → ... Response/Effect: ... Evidence: (path/file)"},"happyPath":["nodeId1","nodeId2"]}', '',
    'PROJECT CONTEXT:', projectContext.slice(0, 50000), '', 'JSON only.',
  ].join('\n');
}

function architectureStoryContext(folder: string, structure: ExtractedStructure): string {
  const context: string[] = [groundedStructureJson(folder, structure).json];
  const evidenceFiles = [
    'package.json', 'composer.json', 'pyproject.toml', 'requirements.txt', 'Pipfile',
    'build.gradle', 'build.gradle.kts', 'settings.gradle', 'Podfile', 'pubspec.yaml',
    'docker-compose.yml', 'docker-compose.yaml', 'prisma/schema.prisma',
  ];

  for (const relative of evidenceFiles) {
    const filePath = path.join(folder, relative);
    try {
      if (fs.statSync(filePath).isFile())
        context.push('\n// ── ' + relative + ' ──\n' + fs.readFileSync(filePath, 'utf8').slice(0, 7000));
    } catch { /* optional project evidence */ }
  }

  const sourceEvidence: string[] = [];
  for (const filePath of Object.values(structure.nodePaths).slice(0, 30)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (/\b(useState|useReducer|createStore|configureStore|Provider|zustand|redux|mobx|pinia|vuex|Context|Room|SQLite|Realm|prisma|typeorm|mongoose|sequelize|supabase|firebase|fetch\(|axios|graphql)\b/i.test(content)) {
        sourceEvidence.push('\n// ── ' + path.relative(folder, filePath) + ' ──\n' + content.slice(0, 3500));
      }
    } catch { /* source file may no longer exist */ }
    if (sourceEvidence.join('').length > 14000) break;
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

async function runArchitectureStory(): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> {
  if (!currentFolder) return { error: 'no project folder' };
  const cacheKey = '__architecture_story__';
  try {
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string> };
      if (cached.version === 1 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {} };
    }

    const structure = extractStructure(currentFolder);
    const raw = await runCapture(buildArchitectureStoryPrompt(architectureStoryContext(currentFolder, structure)), currentFolder);
    const parsed = extractJson(raw) as { mermaid?: string; descriptions?: Record<string, string> } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };
    const descriptions = parsed.descriptions ?? {};
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 1, mermaid: parsed.mermaid, descriptions }));
    return { ok: true, mermaid: parsed.mermaid, descriptions };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runRepositoryImplementation(): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string> }> {
  if (!currentFolder) return { error: 'no project folder' };
    const cacheKey = '__repository_implementation__:depth-' + analysisDepth;
  try {
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string> };
      if (cached.version === 7 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {} };
    }
    const structure = extractStructure(currentFolder);
    const parsed = extractJson(await runCapture(buildRepositoryImplementationPrompt(repositoryImplementationContext(currentFolder, structure)), currentFolder)) as { mermaid?: string; descriptions?: Record<string, string> } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };
    const result = { version: 7, mermaid: parsed.mermaid, descriptions: parsed.descriptions ?? {} };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify(result));
    return { ok: true, mermaid: result.mermaid, descriptions: result.descriptions };
  } catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
}

async function runComponentCodeFlow(rawName: string, _drillMermaid = ''): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[]; fromCache?: boolean }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const cached = loadCache(currentFolder);
    const cacheKey = `depth-${analysisDepth}:${name}`;
    const cachedValue = cached?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const p = JSON.parse(cachedValue) as { version?: number; mermaid: string; descriptions?: Record<string, string>; happyPath: string[] };
        // Version 16 makes Code Story an independent internal explanation while grounding
        // the story in the locally extracted AST hierarchy and Graphify slice.
        // as well as source text, preventing inferred function relationships.
        // behaviour (inputs, decisions, effects, and results), rather than a
        // broad feature or user-flow map.
        if (p?.version === 18 && p.mermaid) return { ok: true, mermaid: p.mermaid, descriptions: p.descriptions ?? {}, happyPath: p.happyPath ?? [], fromCache: true };
      } catch {
        // Older raw-Mermaid entries were generated as user journeys, not code stories.
        // Ignore them so they are recreated with the current Code Story rules.
      }
    }

    const structure = extractStructure(currentFolder);
    if (name === '__whole_repo__') {
      const raw = await runCapture(buildRepositoryCodeStoryPrompt(groundedStructureJson(currentFolder, structure).json), currentFolder);
      const parsed = extractJson(raw) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
      if (!parsed?.mermaid) return { error: 'no mermaid in response' };
      const happyPath = parsed.happyPath ?? [];
      const descriptions = parsed.descriptions ?? {};
      saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 3, mermaid: parsed.mermaid, descriptions, happyPath }));
      return { ok: true, mermaid: parsed.mermaid, descriptions, happyPath };
    }

    const sourceFiles = findSourceFiles(name, structure.nodePaths, currentFolder, 3);

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

    const hierarchyContext = [buildHierarchyContext(sourceFiles), graphifyPromptContext(currentFolder, name).evidence].filter(Boolean).join('\n\n');
    const raw = await runCapture(buildCodeStoryPrompt(
      name,
      sourceCode,
      hierarchyContext,
    ), currentFolder);
    let parsed = extractJson(raw) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };

    // The first pass establishes the flow; this second pass fills in contracts
    // that a newcomer needs to follow the implementation with confidence.
    if (shouldRunCodeStoryReview(sourceCode, parsed)) try {
      const reviewed = extractJson(await runCapture(
        buildCodeStoryNewbieReviewPrompt(name, sourceCode, hierarchyContext, parsed, getAiProvider() === 'claude'),
        currentFolder,
      )) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
      if (reviewed?.mermaid) {
        parsed = {
          ...parsed,
          ...reviewed,
          descriptions: reviewed.descriptions ?? parsed.descriptions,
          happyPath: reviewed.happyPath ?? parsed.happyPath,
        };
      }
    } catch {
      // The initial, source-grounded story is still useful if the review call fails.
    }

    const happyPath = parsed.happyPath ?? [];
    const descriptions = parsed.descriptions ?? {};
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 18, mermaid: parsed.mermaid, descriptions, happyPath }));
    return { ok: true, mermaid: parsed.mermaid, descriptions, happyPath };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:codeflow', (_e, rawName: string, drillMermaid?: string) => runComponentCodeFlow(rawName, drillMermaid));

/** Have the selected AI resolve a product-facing node to real local source files. */
async function runComponentSource(rawName: string): Promise<{ ok: boolean; error?: string; files?: Array<{ path: string; content: string; highlight?: string }> }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { ok: false, error: 'No component selected' };
  try {
    const structure = extractStructure(currentFolder);
    const graphify = graphifyPromptContext(currentFolder, name);
    const sourceHash = hashStructure(toClaudePromptJSON(structure) + ':graphify:' + graphify.fingerprint);
    const cacheKey = `__source_browser__:v4:${name}:${sourceHash}`;
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
      })
      .slice(0, 180);
    const availableSet = new Set(availableFiles);
    let paths: string[] = [];
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; files?: string[] };
        if (cached.version === 4 && Array.isArray(cached.files)) paths = cached.files.filter(isImplementationPath);
      } catch { /* resolve again */ }
    }

    if (paths.length === 0) {
      // Graphify is a local, source-proven index. Prefer it before spending an
      // AI request on a filename inference.
      paths = graphifySourceFiles(currentFolder, name, 4).filter(candidate => availableSet.has(candidate));
    }

    if (paths.length === 0) {
      const description = (currentDiagram as { descriptions?: Record<string, string> } | null)?.descriptions?.[name] ?? '';
      const prompt = [
        'Identify the real source files that implement the selected product component. Do not edit anything.',
        `Selected canvas component: ${name}`,
        description ? `Canvas description: ${description}` : '',
        'Inspect the repository if needed. Return 1 to 4 implementation files only, ordered most relevant first.',
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
      if (paths.length === 0) paths = findSourceFiles(name, structure.nodePaths, currentFolder, 12)
        .map(source => path.relative(currentFolder!, source.filePath))
        .filter(isImplementationPath)
        .slice(0, 4);
    }
    // Persist both local Graphify resolutions and AI fallbacks.
    if (paths.length > 0) saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 4, files: paths }));

    const root = path.resolve(currentFolder);
    const files = paths.slice(0, 4).flatMap(relPath => {
      const absolute = path.resolve(currentFolder!, relPath);
      if (!absolute.startsWith(root + path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return [];
      try {
        const content = fs.readFileSync(absolute, 'utf8');
        return content.includes('\0') ? [] : [{ path: path.relative(currentFolder!, absolute), content, highlight: name }];
      } catch { return []; }
    });
    if (files.length === 0) return { ok: false, error: `No readable source files were identified for "${name}".` };
    return { ok: true, files };
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
    const cacheKey = `__actual_codeflow__:v2:${name}:${hashStructure(source.content)}`;
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      try {
        const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string };
        if (cached.version === 2 && cached.mermaid) return { ok: true, mermaid: cached.mermaid };
      } catch { /* regenerate malformed legacy entry */ }
    }

    const mermaid = buildLocalCallHierarchy(source.content);
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify({ version: 2, mermaid }));
    return { ok: true, mermaid };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

ipcMain.handle('component:actualCodeFlow', (_e, rawName: string) => runActualCodeFlow(rawName));

async function runComponentImplementation(rawName: string, drillMermaid = ''): Promise<{ ok?: boolean; error?: string; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] }> {
  const name = rawName.trim();
  if (!currentFolder || !name) return { error: 'no component' };
  try {
    const cacheKey = '__implementation__:depth-' + analysisDepth + ':' + name;
    const cachedValue = loadCache(currentFolder)?.codeflows?.[cacheKey];
    if (typeof cachedValue === 'string') {
      const cached = JSON.parse(cachedValue) as { version?: number; mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] };
      if (!drillMermaid && cached.version === 19 && cached.mermaid) return { ok: true, mermaid: cached.mermaid, descriptions: cached.descriptions ?? {}, happyPath: cached.happyPath ?? [] };
    }
    const structure = extractStructure(currentFolder);
    const sourceFiles = findSourceFiles(name, structure.nodePaths, currentFolder, 6);
    let sourceCode = '';
    let budget = 16000;
    for (const { filePath, content } of sourceFiles) {
      const chunk = content.slice(0, budget);
      sourceCode += '\n// ── ' + path.relative(currentFolder, filePath) + ' ──\n' + chunk;
      budget -= chunk.length;
      if (budget <= 0) break;
    }
    if (!sourceCode.trim()) return { error: `No source code was found for "${name}". Select a code component to explain its implementation.` };
    const scope = drillMermaid
      ? '\n\nFEATURE SCOPE ONLY — this is a user-facing flow. Use it only to identify the feature and its outcomes. Do NOT repeat, paraphrase, or draw its user steps. Explain the source-proven component contracts that make those outcomes happen instead:\n' + drillMermaid
      : '';
    const hierarchyContext = [buildHierarchyContext(sourceFiles), graphifyPromptContext(currentFolder, name).evidence].filter(Boolean).join('\n\n');
    const parsed = extractJson(await runCapture(buildImplementationPrompt(name, sourceCode + scope, hierarchyContext), currentFolder)) as { mermaid?: string; descriptions?: Record<string, string>; happyPath?: string[] } | null;
    if (!parsed?.mermaid) return { error: 'no mermaid in response' };
    const result = { version: 19, mermaid: parsed.mermaid, descriptions: parsed.descriptions ?? {}, happyPath: parsed.happyPath ?? [] };
    saveCodeFlow(currentFolder, cacheKey, JSON.stringify(result));
    return { ok: true, mermaid: result.mermaid, descriptions: result.descriptions, happyPath: result.happyPath };
  } catch (err: unknown) { return { error: err instanceof Error ? err.message : String(err) }; }
}

ipcMain.handle('component:implementation', (_e, rawName: string, drillMermaid?: string) => runComponentImplementation(rawName, drillMermaid));
ipcMain.handle('project:architectureStory', () => runArchitectureStory());
ipcMain.handle('project:implementation', () => runRepositoryImplementation());

// ── Git history ───────────────────────────────────────────────────────────────

function buildCommitFeatureFlowPrompt(commitMsg: string, diffSource: string): string {
  return [
    `This git commit was just made: "${commitMsg}"`,
    'Look at the diff below and draw a user-facing feature flow diagram showing WHAT CHANGED for the user.',
    'Output ONLY the JSON below — no fences, no prose.',
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
    '- 6–14 nodes. Every node must be connected.',
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
    '- 3–8 function nodes max — be selective, not exhaustive',
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
    const cached = loadCache(folder);
    if (cached?.commitDiagrams?.[hash]) {
      const cd = cached.commitDiagrams[hash];
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
      saveCommitDiagram(folder, hash, { featureFlow, codeFlow });
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
  if (!currentFolder || !req.question.trim() || req.components.length === 0) return { ok: false, error: 'Select at least one component and enter a question' };
  try {
    const question = req.question.trim();
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
    let remaining = 9000;
    for (const component of req.components.slice(0, 8)) {
      for (const { filePath, content } of findSourceFiles(component, structure.nodePaths, currentFolder)) {
        if (remaining <= 0) break;
        const chunk = content.slice(0, remaining);
        sourceChunks.push('// ' + path.relative(currentFolder, filePath) + '\n' + chunk);
        remaining -= chunk.length;
      }
    }
    const prompt = [
      'Answer a developer question about selected components as a clear Mermaid flowchart.',
      'Output ONLY JSON. Do not edit files. Do not give prose outside JSON.',
      '', 'QUESTION:', question, 'SELECTED COMPONENTS:', req.components.join(', '), '',
      'ANSWER MODE:', answerMode, '',
      'RULES:', '- Make the diagram directly answer the question. Do not replace it with a generic request lifecycle.',
      '- First node must state the direct answer in plain English.',
      '- If the question asks about a response, payload, output, JSON, fields, headers, or data shape: diagram the concrete response structure (status, headers, body and known fields), not the request-processing steps.',
      '- If the question asks how something works (including just "How?"): diagram the real process in order. Each description must say HOW the code does that step: operation, data/state change, and decision/condition.',
      '- If the question asks why (including just "Why?"): diagram the purpose and reasoning, not a generic process. Each description must say WHY that step or decision exists and what problem it prevents or solves.',
      '- If it asks both how and why, every description must use this format: "How: … Why: … (source reference)".',
      '- Use only facts supported by the provided source/context. Say "not defined here" rather than inventing fields.',
      '- Use 4–10 short plain-English nodes. Explain behavior before implementation details.',
      '- Include only the selected components and directly relevant connections.',
      '- Put real function/file references in descriptions, not node labels. For a How or Why answer, descriptions must contain the requested explanation, not only the reference.',
      '- Start Mermaid with flowchart TD.', '', 'Schema:',
      '{"pattern":"short answer title","diagrams":{"structure":"flowchart TD string"},"descriptions":{"Node Label":"How: concrete implementation. Why: purpose (function in file.ts)"}}',
      '', 'CANVAS CONTEXT:', req.canvasContext.slice(0, 5000),
      '', 'RELEVANT SOURCE:', sourceChunks.join('\n\n').slice(0, 9000), '', 'JSON only.',
    ].join('\n');
    const parsed = extractJson(await runCapture(prompt, currentFolder)) as { pattern?: string; diagrams?: { structure?: string }; descriptions?: Record<string, string> } | null;
    if (!parsed?.diagrams?.structure) return { ok: false, error: 'Could not create an answer flowchart' };
    return { ok: true, diagram: { pattern: parsed.pattern || 'Selected components', diagrams: { structure: parsed.diagrams.structure }, descriptions: parsed.descriptions ?? {} } };
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

  if (nodes.length < 3) return '';

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

  if (items.length < 3) return '';

  const out = [`mindmap`, `  root((${title.slice(0, 30)}))`];
  for (const item of items.slice(0, 12)) {
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
