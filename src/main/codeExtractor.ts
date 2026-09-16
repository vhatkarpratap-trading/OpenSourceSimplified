import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodeNode {
  name: string;
  type: 'folder' | 'file' | 'class' | 'component' | 'function' | 'method' | 'interface' | 'enum';
  path: string;
  imports: string[];       // what this file imports
  children: CodeNode[];    // subfolders/files/classes/functions
  loc?: number;            // lines of code (files only)
}

export interface ExtractedStructure {
  root: CodeNode;
  totalFiles: number;
  languages: string[];
  nodePaths: Record<string, string>; // node name → absolute file path
  relationships: CodeRelationship[]; // static dependency graph, backed by source imports
}

export interface CodeRelationship {
  from: string;
  to: string;
  kind: 'local-import' | 'external-import';
}

// ── Config ────────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.dart_tool', '.idea',
  'coverage', '__pycache__', '.gradle', 'Pods', '.expo',
  '.next', '.nuxt', 'out', 'target', 'bin', 'obj', '.vs',
  '.build', 'DerivedData', 'xcuserdata', 'graphify-out',
]);

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts',
  '.dart', '.swift', '.kt', '.java', '.py', '.go', '.rs', '.xml',
  // Common native, JVM/.NET, scripting, functional, web, and configuration
  // formats. Unknown formats still receive the generic import parser below.
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs', '.fs', '.fsx', '.vb',
  '.php', '.rb', '.rake', '.scala', '.sc', '.clj', '.cljs', '.groovy', '.gradle',
  '.hs', '.lua', '.r', '.pl', '.pm', '.ex', '.exs', '.erl', '.hrl', '.zig', '.sol',
  '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.scss', '.less',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.yaml', '.yml', '.json', '.toml',
]);

const MAX_FILES   = 150;
// Android/JVM projects nest source files very deeply (e.g. fenix/app/src/main/java/org/mozilla/fenix/…).
// A low hard limit cuts off real source trees. We cap depth only on low-value branches using the
// directory importance score — high-value dirs (src, app, java, features, …) get unlimited depth.
const MAX_DEPTH        = 12;
const MAX_DEPTH_LOW    = 4;  // stop early inside docs, scripts, infra, test dirs

// Score a file path for importance: lower = more important.
// Used to rank candidates when the project exceeds MAX_FILES.
function fileImportanceScore(filePath: string): number {
  const v = filePath.toLowerCase();
  const base = path.basename(v);
  // Test files always score worst — they duplicate production names but add noise.
  if (/(test|spec|mock|fixture|__tests__)/.test(v) || /test\.[^/]+$/.test(base) || /spec\.[^/]+$/.test(base)) return 7;
  // Entry points / app shells
  if (/^(main|index|app|router|routes|server|application)\.[^/]+$/.test(base)) return 0;
  // Screen / feature / navigation files
  if (/(activity|fragment|screen|page|view|navigation|navigator|route|scene)/.test(v)) return 1;
  // Feature domain files (search, settings, auth, etc.)
  if (/(search|explore|article|readinglist|saved|history|settings|nearby|map|login|edit|auth|home|feed|detail|profile|dashboard|checkout|cart|payment|onboard)/.test(v)) return 2;
  // API / service / repository layer
  if (/(api|service|repository|store|manager|controller|handler|endpoint)/.test(v)) return 3;
  // Models / data
  if (/(model|entity|schema|dto|type|interface)/.test(v)) return 4;
  // Utilities / helpers / config / build scripts — lowest priority
  if (/(util|helper|config|setup|build|gradle|release|generate|upload)/.test(v)) return 6;
  return 5;
}

// Score a directory name for how likely it is to contain high-value source.
// Lower = descend first. Used to prioritise traversal in monorepos.
function dirImportanceScore(dirName: string): number {
  const v = dirName.toLowerCase();
  // Canonical source roots
  if (/^(src|app|lib|source|sources)$/.test(v)) return 0;
  // Language-specific source layouts
  if (/^(java|kotlin|swift|dart|python)$/.test(v)) return 1;
  if (/^(main|fenix|components|features|modules|packages|core|ui|pages|screens|views|routes|navigation)$/.test(v)) return 2;
  // Common feature folders
  if (/(activity|fragment|screen|feature|service|repository|store|controller|handler|browser|home|search|settings|auth|login|profile|onboard)/.test(v)) return 3;
  // Docs, scripts, infra, tests — traverse last
  if (/^(docs?|doc|test|tests|spec|specs|__tests__|scripts?|tools?|infra|ci|taskcluster|automation|build|gradle|vendor|third.?party|examples?|sample|demo|mock|fixture|release|deploy|publish)$/.test(v)) return 8;
  return 5;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function extractStructure(projectPath: string): ExtractedStructure {
  const languages = new Set<string>();
  const nodePaths: Record<string, string> = {}; // name → absolute path

  // Phase 1: discover all candidate files up to a generous ceiling.
  // Directories are sorted by importance before recursing so high-value
  // source trees (src/, app/, fenix/app/src/main/java/…) are visited
  // before docs, scripts, and infra — critical for monorepos.
  const DISCOVERY_CAP = 3000;
  const allCandidates: { filePath: string; name: string; ext: string; score: number }[] = [];

  function walkDir(dir: string, depth: number, lowValueDepth: number) {
    if (depth > MAX_DEPTH || lowValueDepth > MAX_DEPTH_LOW || allCandidates.length >= DISCOVERY_CAP) return;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    const folders = entries
      .filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => dirImportanceScore(a.name) - dirImportanceScore(b.name) || a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase()));

    // Recurse into folders before collecting files at this level so we reach
    // deep source trees (e.g. fenix/app/src/main/java/…) early.
    for (const folder of folders) {
      if (allCandidates.length >= DISCOVERY_CAP) break;
      const ds = dirImportanceScore(folder.name);
      const nextLowDepth = ds >= 8 ? lowValueDepth + 1 : lowValueDepth;
      walkDir(path.join(dir, folder.name), depth + 1, nextLowDepth);
    }

    for (const file of files) {
      if (allCandidates.length >= DISCOVERY_CAP) break;
      const filePath = path.join(dir, file.name);
      const ext = path.extname(file.name).toLowerCase();
      allCandidates.push({ filePath, name: file.name, ext, score: fileImportanceScore(filePath) });
    }
  }

  walkDir(projectPath, 0, 0);

  // Phase 2: sort by importance and keep only MAX_FILES of the best candidates.
  allCandidates.sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath));
  const selected = allCandidates.slice(0, MAX_FILES);

  const root: CodeNode = {
    name: path.basename(projectPath),
    type: 'folder',
    path: projectPath,
    imports: [],
    children: [],
  };

  // Phase 3: parse selected files and reconstruct the folder tree.
  // We insert each file into the correct folder node, creating intermediate
  // folder nodes on demand so the tree reflects the actual directory layout.
  const folderNodes = new Map<string, CodeNode>();
  folderNodes.set(projectPath, root);

  function getOrCreateFolder(dir: string): CodeNode {
    const existing = folderNodes.get(dir);
    if (existing) return existing;
    const parentNode = getOrCreateFolder(path.dirname(dir));
    const node: CodeNode = { name: path.basename(dir), type: 'folder', path: dir, imports: [], children: [] };
    parentNode.children.push(node);
    folderNodes.set(dir, node);
    return node;
  }

  let totalFiles = 0;
  for (const { filePath, name, ext } of selected) {
    totalFiles++;
    languages.add(ext.slice(1));
    const fileNode = parseFile(filePath, name);
    nodePaths[name] = filePath;
    const parentNode = getOrCreateFolder(path.dirname(filePath));
    parentNode.children.push(fileNode);
  }

  // Build a relationship graph after parsing. This is deliberately evidence-led:
  // an edge exists only when a source file imports another module/package.
  const fileNodes: CodeNode[] = [];
  const collectFiles = (node: CodeNode) => {
    if (node.type === 'file') fileNodes.push(node);
    node.children.forEach(collectFiles);
  };
  collectFiles(root);
  const byStem = new Map<string, CodeNode[]>();
  for (const file of fileNodes) {
    const stem = path.basename(file.path, path.extname(file.path)).toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
  }
  const seen = new Set<string>();
  const relationships: CodeRelationship[] = [];
  for (const file of fileNodes) {
    const from = path.relative(projectPath, file.path);
    for (const imported of file.imports) {
      const matches = byStem.get(imported.toLowerCase()) ?? [];
      const targets = matches.length ? matches.slice(0, 2).map(m => path.relative(projectPath, m.path)) : [imported];
      for (const to of targets) {
        const kind: CodeRelationship['kind'] = matches.length ? 'local-import' : 'external-import';
        const key = `${from}|${kind}|${to}`;
        if (!seen.has(key) && relationships.length < 400) {
          seen.add(key);
          relationships.push({ from, to, kind });
        }
      }
    }
  }

  return { root, totalFiles, languages: Array.from(languages), nodePaths, relationships };
}

// ── File parser ───────────────────────────────────────────────────────────────

function parseFile(filePath: string, fileName: string): CodeNode {
  const ext = path.extname(fileName).toLowerCase();
  let content = '';
  let loc = 0;

  try {
    content = fs.readFileSync(filePath, 'utf8');
    loc = content.split('\n').length;
  } catch {
    return { name: fileName, type: 'file', path: filePath, imports: [], children: [], loc: 0 };
  }

  const fileNode: CodeNode = {
    name: fileName,
    type: 'file',
    path: filePath,
    imports: [],
    children: [],
    loc,
  };

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mts') {
    parseTS(content, fileNode);
  } else if (ext === '.dart') {
    parseDart(content, fileNode);
  } else if (ext === '.swift') {
    parseSwift(content, fileNode);
  } else if (ext === '.kt') {
    parseKotlin(content, fileNode);
  } else if (ext === '.java') {
    parseJava(content, fileNode);
  } else if (ext === '.py') {
    parsePython(content, fileNode);
  } else {
    // Generic: just extract imports via regex
    fileNode.imports = extractImportsGeneric(content);
  }

  return fileNode;
}

// ── TypeScript / JavaScript parser ───────────────────────────────────────────

function parseTS(content: string, fileNode: CodeNode) {
  // Imports
  const importRe = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;
  let m;
  const importSet = new Set<string>();
  while ((m = importRe.exec(content))  !== null) importSet.add(path.basename(m[1]).replace(/\.[^.]+$/, ''));
  while ((m = requireRe.exec(content)) !== null) importSet.add(path.basename(m[1]).replace(/\.[^.]+$/, ''));
  fileNode.imports = Array.from(importSet).filter(i => !i.startsWith('@') && i.length > 0);

  // Try AST parse for classes/functions
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require('@typescript-eslint/typescript-estree');
    const ast = parse(content, { jsx: true, tolerant: true, range: false, loc: false });
    extractFromAST(ast.body || [], fileNode);
  } catch {
    // Fallback: regex extraction
    extractTSRegex(content, fileNode);
  }
}

function extractFromAST(nodes: unknown[], parent: CodeNode) {
  for (const node of nodes) {
    const n = node as Record<string, unknown>;
    if (!n || typeof n !== 'object') continue;

    const type = n.type as string;

    if (type === 'ClassDeclaration' || type === 'ClassExpression') {
      const id = n.id as { name?: string } | null;
      const name = id?.name || 'AnonymousClass';
      const classNode: CodeNode = { name, type: 'class', path: parent.path, imports: [], children: [] };
      extractFromAST((n.body as { body?: unknown[] })?.body || [], classNode);
      parent.children.push(classNode);

    } else if (type === 'FunctionDeclaration' || type === 'TSDeclareFunction') {
      const id = n.id as { name?: string } | null;
      if (id?.name) {
        parent.children.push({ name: id.name, type: 'function', path: parent.path, imports: [], children: [] });
      }

    } else if (type === 'VariableDeclaration') {
      for (const decl of (n.declarations as unknown[]) || []) {
        const d = decl as Record<string, unknown>;
        const init = d.init as Record<string, unknown> | null;
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          const id = d.id as { name?: string } | null;
          if (id?.name) {
            parent.children.push({ name: id.name, type: 'function', path: parent.path, imports: [], children: [] });
          }
        }
      }

    } else if (type === 'ExportNamedDeclaration' || type === 'ExportDefaultDeclaration') {
      const decl = n.declaration;
      if (decl) extractFromAST([decl], parent);

    } else if (type === 'MethodDefinition' || type === 'TSMethodSignature') {
      const key = n.key as { name?: string } | null;
      if (key?.name && key.name !== 'constructor') {
        parent.children.push({ name: key.name, type: 'method', path: parent.path, imports: [], children: [] });
      }

    } else if (type === 'TSInterfaceDeclaration') {
      const id = n.id as { name?: string } | null;
      if (id?.name) {
        parent.children.push({ name: id.name, type: 'interface', path: parent.path, imports: [], children: [] });
      }

    } else if (type === 'TSEnumDeclaration') {
      const id = n.id as { name?: string } | null;
      if (id?.name) {
        parent.children.push({ name: id.name, type: 'enum', path: parent.path, imports: [], children: [] });
      }
    }
  }
}

function extractTSRegex(content: string, fileNode: CodeNode) {
  const classRe = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
  const funcRe  = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  const arrowRe = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
  let m;
  while ((m = classRe.exec(content)) !== null)
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });
  while ((m = funcRe.exec(content)) !== null)
    fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
  while ((m = arrowRe.exec(content)) !== null)
    fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
}

// ── Language-specific parsers (regex-based) ───────────────────────────────────

function parseDart(content: string, fileNode: CodeNode) {
  fileNode.imports = [...content.matchAll(/import\s+['"]([^'"]+)['"]/g)]
    .map(m => path.basename(m[1]).replace(/\.dart$/, ''));

  for (const m of content.matchAll(/(?:class|mixin|extension)\s+(\w+)/g))
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });

  // Methods inside the file (top-level functions)
  for (const m of content.matchAll(/^\s*(?:Future|void|String|int|bool|dynamic|\w+)\s+(\w+)\s*\(/gm)) {
    if (!['if', 'while', 'for', 'switch', 'catch'].includes(m[1]))
      fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
  }
}

function parseSwift(content: string, fileNode: CodeNode) {
  fileNode.imports = [...content.matchAll(/import\s+(\w+)/g)].map(m => m[1]);

  for (const m of content.matchAll(/(?:class|struct|protocol|enum|extension|actor)\s+(\w+)/g))
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });

  for (const m of content.matchAll(/(?:func)\s+(\w+)\s*\(/g))
    fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
}

function parseKotlin(content: string, fileNode: CodeNode) {
  fileNode.imports = [...content.matchAll(/import\s+([\w.]+)/g)]
    .map(m => m[1].split('.').pop() || m[1]);

  for (const m of content.matchAll(/(?:class|object|interface|data class|sealed class)\s+(\w+)/g))
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });

  for (const m of content.matchAll(/fun\s+(\w+)\s*\(/g))
    fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
}

function parseJava(content: string, fileNode: CodeNode) {
  fileNode.imports = [...content.matchAll(/import\s+([\w.]+);/g)]
    .map(m => m[1].split('.').pop() || m[1]);

  for (const m of content.matchAll(/(?:public|private|protected|abstract)?\s*(?:class|interface|enum)\s+(\w+)/g))
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });

  for (const m of content.matchAll(/(?:public|private|protected|static|final)*\s+\w+\s+(\w+)\s*\(/g)) {
    if (!['if', 'while', 'for', 'switch'].includes(m[1]))
      fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
  }
}

function parsePython(content: string, fileNode: CodeNode) {
  fileNode.imports = [
    ...[...content.matchAll(/^from\s+([\w.]+)\s+import/gm)].map(m => m[1].split('.').pop() || m[1]),
    ...[...content.matchAll(/^import\s+([\w.]+)/gm)].map(m => m[1].split('.').pop() || m[1]),
  ];

  for (const m of content.matchAll(/^class\s+(\w+)/gm))
    fileNode.children.push({ name: m[1], type: 'class', path: fileNode.path, imports: [], children: [] });

  for (const m of content.matchAll(/^def\s+(\w+)/gm))
    fileNode.children.push({ name: m[1], type: 'function', path: fileNode.path, imports: [], children: [] });
}

function extractImportsGeneric(content: string): string[] {
  return [...content.matchAll(/(?:import|include|require|use)\s+['"]?([^\s'";<]+)/g)]
    .map(m => path.basename(m[1]).replace(/\.[^.]+$/, ''));
}

// ── Convert extracted structure to compact JSON for Claude ───────────────────

export function toClaudePromptJSON(structure: ExtractedStructure): string {
  function compact(node: CodeNode, depth = 0): unknown {
    const out: Record<string, unknown> = {
      name: node.name,
      type: node.type,
    };
    if (node.imports.length) out.imports = node.imports.slice(0, 8);

    // Only include children up to depth 2 (folders → files → classes)
    // Functions at depth 3 are listed as names only to keep prompt small
    if (node.children.length && depth <= 2) {
      if (depth === 2) {
        // At file level: just list child names (classes/functions) without recursing
        out.exports = node.children.slice(0, 15).map(c => `${c.type}:${c.name}`);
      } else {
        out.children = node.children.slice(0, 20).map(c => compact(c, depth + 1));
      }
    }
    return out;
  }

  return JSON.stringify({
    project: compact(structure.root),
    // This graph helps follow relationships across folders even when filenames
    // alone are ambiguous. It is static evidence, not a claim of runtime calls.
    relationships: structure.relationships.slice(0, 360),
  }, null, 1);
}
