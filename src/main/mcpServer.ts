import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain, BrowserWindow } from 'electron';

// ── PTY ring buffer ───────────────────────────────────────────────────────────

const MAX_PTY_LINES = 500;
let ptyLines: string[] = [];
let ptyAccumulator = '';

export function recordPtyOutput(data: string): void {
  // Strip ANSI escape sequences before storing
  ptyAccumulator += data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const parts = ptyAccumulator.split('\n');
  ptyAccumulator = parts.pop() ?? '';
  ptyLines.push(...parts);
  if (ptyLines.length > MAX_PTY_LINES) ptyLines = ptyLines.slice(-MAX_PTY_LINES);
}

export function getPtyOutputBuffer(n: number): string {
  return ptyLines.slice(-Math.max(1, n)).join('\n');
}

// ── Deps interface ────────────────────────────────────────────────────────────

interface RawElement {
  id: string; type: string; isDeleted?: boolean; text?: string;
  containerId?: string | null;
  startBinding?: { elementId: string } | null;
  endBinding?:   { elementId: string } | null;
}

export interface McpServerDeps {
  getFolder:           () => string | null;
  getDiagram:          () => object | null;
  getWindow:           () => BrowserWindow | null;
  runAnalysisInternal: () => Promise<{ ok?: boolean; error?: string }>;
  runComponentDetail:  (name: string) => Promise<{ ok?: boolean; error?: string; detail?: unknown }>;
  runComponentDrilldown: (name: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string }>;
  runComponentCodeFlow: (name: string) => Promise<{ ok?: boolean; error?: string; mermaid?: string; happyPath?: string[] }>;
  executeCanvasCommandInternal: (command: string, canvasContext: string, nodeNames: string[]) => Promise<{ ok: boolean; error?: string }>;
  persistDiagram: (diagram: object) => void;
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_canvas_mermaid',
    description: 'Returns the current canvas as a Mermaid diagram string. This is the full design — read it before making any suggestions or changes.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_canvas_mermaid',
    description: 'Replaces the canvas with a new Mermaid diagram. Use for any visual thought — plans, flows, comparisons, explanations, architecture. Pick the right diagram type: flowchart TD for steps/trees, flowchart LR for timelines/sequences, subgraphs for grouping. The canvas updates immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        mermaid: { type: 'string', description: 'Valid Mermaid diagram string. Use \\n for newlines.' },
        title:   { type: 'string', description: 'Optional short label shown in the canvas header, e.g. "Plan: Auth Refactor"' },
      },
      required: ['mermaid'],
    },
  },
  {
    name: 'suggest_canvas_mermaid',
    description: 'Proposes a new Mermaid diagram design on the canvas without permanently overwriting. Use when you want to show a suggestion or alternative architecture.',
    inputSchema: {
      type: 'object',
      properties: {
        mermaid:  { type: 'string', description: 'Mermaid diagram string for the suggested design' },
        message:  { type: 'string', description: 'Short label describing what this suggestion is, e.g. "Suggested: add caching layer"' },
      },
      required: ['mermaid'],
    },
  },
  {
    name: 'add_canvas_note',
    description: 'Places a short sticky-note style text annotation on the canvas. Use for status labels, quick observations, or to annotate an existing diagram without replacing it.',
    inputSchema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'The note text. Keep it short — 1-3 lines max.' },
        color: { type: 'string', description: 'Optional color theme: "yellow" (default), "blue", "green", "red"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'clear_canvas',
    description: 'Clears the canvas completely. Use before starting a new unrelated topic or when the current diagram is no longer relevant.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_component_detail',
    description: 'Returns a plain-English description of a named component: what it does, what it connects to.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact component name as shown on the canvas' } },
      required: ['name'],
    },
  },
  {
    name: 'get_component_drilldown',
    description: 'Returns a detailed user-flow Mermaid diagram for a named component.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Component name' } },
      required: ['name'],
    },
  },
  {
    name: 'get_component_code_flow',
    description: 'Returns the function-level code flow Mermaid diagram and happy path node list for a named component.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Component name' } },
      required: ['name'],
    },
  },
  {
    name: 'run_analysis',
    description: 'Triggers a fresh Claude analysis of the currently open project folder and updates the canvas diagram.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'show_component_drilldown',
    description: 'Tells the canvas to render the drilldown overlay for a named component.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Component name' } },
      required: ['name'],
    },
  },
  {
    name: 'show_component_code_flow',
    description: 'Tells the canvas to render the code flow overlay for a named component.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Component name' } },
      required: ['name'],
    },
  },
  {
    name: 'execute_canvas_command',
    description: 'Runs a natural-language command against the canvas (same as /canvas in the terminal). The canvas context is automatically injected.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Natural-language instruction, e.g. "add error handling to the Auth component"' } },
      required: ['command'],
    },
  },
  {
    name: 'get_open_folder',
    description: 'Returns the currently open project folder path.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_recent_terminal_output',
    description: 'Returns the last N lines of terminal (PTY) output, with ANSI escape codes stripped.',
    inputSchema: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'Number of lines to return (default 50, max 500)' } },
      required: [],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

let deps: McpServerDeps;

function askRenderer<T>(channel: string, args?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) return reject(new Error('Canvas window not available'));
    const replyChannel = `${channel}:reply:${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const timer = setTimeout(() => reject(new Error('Renderer response timeout')), 5000);
    ipcMain.once(replyChannel, (_e, result: T) => { clearTimeout(timer); resolve(result); });
    win.webContents.send(channel, { replyChannel, ...(args ?? {}) });
  });
}

// Build a mermaid flowchart from raw Excalidraw elements (freehand canvas)
function elementsToMermaid(elements: RawElement[]): string {
  const visible = elements.filter(e => !e.isDeleted);

  // Collect ALL text bound to each container (may be multiline in one element)
  const boundTextLines: Record<string, string[]> = {};
  for (const el of visible) {
    if (el.type === 'text' && el.containerId) {
      const lines = (el.text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length) {
        boundTextLines[el.containerId] = (boundTextLines[el.containerId] ?? []).concat(lines);
      }
    }
  }

  // Also collect standalone text elements not bound to anything
  const standaloneTexts: string[] = [];
  for (const el of visible) {
    if (el.type === 'text' && !el.containerId) {
      const t = (el.text ?? '').trim();
      if (t) standaloneTexts.push(t);
    }
  }

  // Collect shapes — use first text line as node name, rest as description
  const shapeTypes = new Set(['rectangle', 'ellipse', 'diamond']);
  const shapes: { id: string; name: string; detail: string }[] = [];
  for (const el of visible) {
    if (!shapeTypes.has(el.type)) continue;
    const textLines = boundTextLines[el.id] ?? [];
    if (textLines.length === 0) continue;
    const name = textLines[0];
    const detail = textLines.slice(1).join(', ');
    shapes.push({ id: el.id, name, detail });
  }

  if (shapes.length === 0) {
    // No shapes found — return standalone text as a plain description
    return standaloneTexts.length > 0
      ? `Canvas content:\n${standaloneTexts.join('\n')}`
      : '';
  }

  // Build safe mermaid node IDs
  const toId = (label: string) =>
    label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'node';
  const idMap: Record<string, string> = {};
  const usedIds = new Set<string>();
  for (const s of shapes) {
    let id = toId(s.name);
    let n = 1;
    while (usedIds.has(id)) id = toId(s.name) + String(n++);
    idMap[s.id] = id;
    usedIds.add(id);
  }

  // Collect arrow label text
  const arrowLabels: Record<string, string> = {};
  for (const el of visible) {
    if (el.type === 'text' && el.containerId) {
      const container = visible.find(e => e.id === el.containerId);
      if (container?.type === 'arrow') arrowLabels[el.containerId] = (el.text ?? '').trim();
    }
  }

  const lines = ['flowchart TD'];
  for (const s of shapes) {
    // Include detail lines as a label suffix so Claude sees the full content
    const label = s.detail ? `${s.name}\\n${s.detail}` : s.name;
    lines.push(`  ${idMap[s.id]}["${label}"]`);
  }

  for (const el of visible) {
    if (el.type !== 'arrow') continue;
    const fromId = el.startBinding?.elementId ? idMap[el.startBinding.elementId] : undefined;
    const toId2  = el.endBinding?.elementId   ? idMap[el.endBinding.elementId]   : undefined;
    if (!fromId || !toId2) continue;
    const lbl = arrowLabels[el.id];
    lines.push(lbl ? `  ${fromId} -->|${lbl}| ${toId2}` : `  ${fromId} --> ${toId2}`);
  }

  return lines.join('\n');
}

function textResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_canvas_mermaid': {
      const diagram = deps.getDiagram() as { diagrams?: { structure?: string } } | null;
      const mermaid = diagram?.diagrams?.structure;
      if (mermaid) return textResult(mermaid);
      // Fallback: synthesize mermaid from raw Excalidraw elements (freehand canvas)
      try {
        const elements = await askRenderer<RawElement[]>('mcp:getRawElements');
        const built = elementsToMermaid(elements ?? []);
        return textResult(built || '(canvas is empty)');
      } catch {
        return textResult('(canvas is empty)');
      }
    }

    case 'update_canvas_mermaid': {
      const mermaid = String(args.mermaid ?? '').trim();
      if (!mermaid) return errorResult('mermaid string is required');
      const title = String(args.title ?? 'Canvas').trim();
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      const diagramData = { pattern: title, diagrams: { structure: mermaid }, descriptions: {} };
      win.webContents.send('canvas:diagram', diagramData);
      deps.persistDiagram(diagramData);
      return textResult('Canvas updated.');
    }

    case 'suggest_canvas_mermaid': {
      const mermaid = String(args.mermaid ?? '').trim();
      const message = String(args.message ?? 'Claude suggestion');
      if (!mermaid) return errorResult('mermaid string is required');
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      const diagramData = { pattern: message, diagrams: { structure: mermaid }, descriptions: {} };
      win.webContents.send('canvas:diagram', diagramData);
      win.webContents.send('canvas:commandStatus', `💡 ${message}`);
      deps.persistDiagram(diagramData);
      return textResult(`Suggestion shown on canvas: "${message}"`);
    }

    case 'add_canvas_note': {
      const text = String(args.text ?? '').trim();
      if (!text) return errorResult('text is required');
      const color = String(args.color ?? 'yellow').toLowerCase();
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      const palette: Record<string, { bg: string; stroke: string; textColor: string }> = {
        yellow: { bg: '#fef9c3', stroke: '#ca8a04', textColor: '#713f12' },
        blue:   { bg: '#dbeafe', stroke: '#2563eb', textColor: '#1e3a5f' },
        green:  { bg: '#dcfce7', stroke: '#16a34a', textColor: '#14532d' },
        red:    { bg: '#fee2e2', stroke: '#dc2626', textColor: '#7f1d1d' },
      };
      const p = palette[color] ?? palette.yellow;
      win.webContents.send('canvas:addNote', { text, ...p });
      return textResult(`Note added to canvas: "${text.slice(0, 60)}"`);
    }

    case 'clear_canvas': {
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      win.webContents.send('canvas:clear');
      deps.persistDiagram({ pattern: 'Canvas', diagrams: {}, descriptions: {} });
      return textResult('Canvas cleared.');
    }

    case 'get_component_detail': {
      const componentName = String(args.name ?? '');
      if (!componentName) return errorResult('name is required');
      const result = await deps.runComponentDetail(componentName);
      if (result.error) return errorResult(result.error);
      return textResult(JSON.stringify(result.detail, null, 2));
    }

    case 'get_component_drilldown': {
      const componentName = String(args.name ?? '');
      if (!componentName) return errorResult('name is required');
      const result = await deps.runComponentDrilldown(componentName);
      if (result.error) return errorResult(result.error);
      return textResult(result.mermaid ?? '');
    }

    case 'get_component_code_flow': {
      const componentName = String(args.name ?? '');
      if (!componentName) return errorResult('name is required');
      const result = await deps.runComponentCodeFlow(componentName);
      if (result.error) return errorResult(result.error);
      return textResult(JSON.stringify({ mermaid: result.mermaid, happyPath: result.happyPath }, null, 2));
    }

    case 'run_analysis': {
      const result = await deps.runAnalysisInternal();
      if (result.error) return errorResult(result.error);
      return textResult('Analysis triggered successfully. Canvas will update shortly.');
    }

    case 'show_component_drilldown': {
      const componentName = String(args.name ?? '');
      if (!componentName) return errorResult('name is required');
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      win.webContents.send('mcp:showDrilldown', { name: componentName });
      return textResult(`Showing drilldown for "${componentName}" on canvas.`);
    }

    case 'show_component_code_flow': {
      const componentName = String(args.name ?? '');
      if (!componentName) return errorResult('name is required');
      const win = deps.getWindow();
      if (!win || win.isDestroyed()) return errorResult('Canvas window not available');
      win.webContents.send('mcp:showCodeFlow', { name: componentName });
      return textResult(`Showing code flow for "${componentName}" on canvas.`);
    }

    case 'execute_canvas_command': {
      const command = String(args.command ?? '');
      if (!command) return errorResult('command is required');
      const folder = deps.getFolder();
      if (!folder) return errorResult('No folder is open');
      // Provide the current mermaid as canvas context
      const diagram = deps.getDiagram() as { diagrams?: { structure?: string } } | null;
      const canvasContext = diagram?.diagrams?.structure ?? '';
      const result = await deps.executeCanvasCommandInternal(command, canvasContext, []);
      if (!result.ok) return errorResult(result.error ?? 'Command failed');
      return textResult(`Canvas command sent: "${command}"`);
    }

    case 'get_open_folder': {
      const folder = deps.getFolder();
      return textResult(folder ?? '(no folder open)');
    }

    case 'get_recent_terminal_output': {
      const lines = Math.min(Number(args.lines ?? 50), 500);
      return textResult(getPtyOutputBuffer(lines) || '(no terminal output yet)');
    }

    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

// ── Per-connection JSON-RPC handler ───────────────────────────────────────────

function handleConnection(socket: net.Socket) {
  let buf = '';

  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        const errResp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
        socket.write(JSON.stringify(errResp) + '\n');
        continue;
      }

      // Notifications (no id) — no response needed
      if (msg.id === undefined || msg.id === null) continue;

      const id = msg.id as string | number;
      const method = String(msg.method ?? '');

      if (method === 'initialize') {
        const resp = {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'rex-canvas', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        };
        socket.write(JSON.stringify(resp) + '\n');
        continue;
      }

      if (method === 'tools/list') {
        const resp = { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        socket.write(JSON.stringify(resp) + '\n');
        continue;
      }

      if (method === 'tools/call') {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const toolName = String(params.name ?? '');
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

        handleToolCall(toolName, toolArgs).then((result) => {
          const resp = { jsonrpc: '2.0', id, result };
          socket.write(JSON.stringify(resp) + '\n');
        }).catch((err: unknown) => {
          const resp = {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          };
          socket.write(JSON.stringify(resp) + '\n');
        });
        continue;
      }

      // Unknown method
      const resp = {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
      socket.write(JSON.stringify(resp) + '\n');
    }
  });

  socket.on('error', () => { /* ignore disconnects */ });
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

const SOCK_PATH      = `/tmp/rex-canvas-mcp-${process.pid}.sock`;
const SOCK_PATH_FILE = '/tmp/rex-canvas-mcp.sock.path';

let server: net.Server | null = null;

export function startMcpServer(serverDeps: McpServerDeps): void {
  deps = serverDeps;

  // Clean up stale socket from previous run
  try { fs.unlinkSync(SOCK_PATH); } catch {}

  server = net.createServer(handleConnection);

  server.listen(SOCK_PATH, () => {
    try { fs.writeFileSync(SOCK_PATH_FILE, SOCK_PATH, 'utf8'); } catch {}
    console.log(`[mcp] server listening at ${SOCK_PATH}`);
  });

  server.on('error', (err) => {
    console.error('[mcp] server error:', err);
  });

  // Clean up on process exit
  process.on('exit', cleanupMcpFiles);
}

export function stopMcpServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  cleanupMcpFiles();
}

function cleanupMcpFiles(): void {
  try { fs.unlinkSync(SOCK_PATH); } catch {}
  try { fs.unlinkSync(SOCK_PATH_FILE); } catch {}
}

// ── Auto-register in ~/.claude.json ──────────────────────────────────────────

export function updateClaudeJsonMcpConfig(bridgePath: string): void {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let nodeBin = 'node';
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      nodeBin = execSync('which node', {
        encoding: 'utf8',
        env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' },
      }).trim();
    } catch { /* use fallback */ }

    let config: Record<string, unknown> = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>; } catch {}

    const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers['rex-canvas'] = { type: 'stdio', command: nodeBin, args: [bridgePath] };
    config.mcpServers = servers;

    const tmp = claudeJsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, claudeJsonPath);
    console.log(`[mcp] registered rex-canvas MCP server in ${claudeJsonPath}`);
  } catch (e) {
    console.error('[mcp] failed to update .claude.json:', e);
  }
}
