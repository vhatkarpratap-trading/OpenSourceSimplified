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
  '.build', 'DerivedData', 'xcuserdata',
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

const MAX_FILES   = 80;
const MAX_DEPTH   = 4;

// ── Entry point ───────────────────────────────────────────────────────────────

export function extractStructure(projectPath: string): ExtractedStructure {
  let totalFiles = 0;
  const languages = new Set<string>();
  const nodePaths: Record<string, string> = {}; // name → absolute path

  const root: CodeNode = {
    name: path.basename(projectPath),
    type: 'folder',
    path: projectPath,
    imports: [],
    children: [],
  };

  function walkDir(dir: string, node: CodeNode, depth: number) {
    if (depth > MAX_DEPTH || totalFiles >= MAX_FILES) return;

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    // Folders first, then files
    const folders = entries.filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'));
    const files   = entries.filter(e => e.isFile() && SOURCE_EXTS.has(path.extname(e.name).toLowerCase()));

    for (const folder of folders) {
      if (totalFiles >= MAX_FILES) break;
      const folderNode: CodeNode = {
        name: folder.name,
        type: 'folder',
        path: path.join(dir, folder.name),
        imports: [],
        children: [],
      };
      walkDir(path.join(dir, folder.name), folderNode, depth + 1);
      if (folderNode.children.length > 0) {
        node.children.push(folderNode);
      }
    }

    for (const file of files) {
      if (totalFiles >= MAX_FILES) break;
      totalFiles++;
      const ext = path.extname(file.name).toLowerCase();
      languages.add(ext.slice(1));

      const filePath = path.join(dir, file.name);
      const fileNode = parseFile(filePath, file.name);
      nodePaths[file.name] = filePath; // map filename → absolute path
      node.children.push(fileNode);
    }
  }

  walkDir(projectPath, root, 0);

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
        if (!seen.has(key) && relationships.length < 240) {
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
    relationships: structure.relationships.slice(0, 180),
  }, null, 1);
}
