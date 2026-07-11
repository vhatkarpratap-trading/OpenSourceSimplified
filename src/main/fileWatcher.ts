import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'build', '.dart_tool', '.idea', 'coverage', '__pycache__']);
const IGNORE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.map', '.lock']);
const CACHE_FILE = '.rex-canvas.json';

type PatchCallback = (changedFile: string) => void;

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFiles = new Set<string>();

export function startFileWatcher(folder: string, onFileChanged: PatchCallback) {
  stopFileWatcher();

  // Ignore events for the first 5s after starting — avoid startup noise
  const startTime = Date.now();

  try {
    watcher = fs.watch(folder, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (Date.now() - startTime < 5000) return; // warmup period

      const rel = filename.replace(/\\/g, '/');

      // Ignore cache file itself, hidden dirs, ignored dirs, ignored extensions
      if (rel.includes(CACHE_FILE)) return;
      const parts = rel.split('/');
      if (parts.some(p => IGNORE_DIRS.has(p) || p.startsWith('.'))) return;
      const ext = path.extname(rel).toLowerCase();
      if (IGNORE_EXTS.has(ext)) return;

      pendingFiles.add(rel);

      // Debounce — collect all changes within 2s into one patch call
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const files = Array.from(pendingFiles);
        pendingFiles.clear();
        // Report the most recently changed files (up to 5)
        onFileChanged(files.slice(0, 5).join(', '));
      }, 2000);
    });
  } catch {
    // fs.watch can fail on some filesystems — silently ignore
  }
}

export function stopFileWatcher() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { watcher.close(); watcher = null; }
  pendingFiles.clear();
}
