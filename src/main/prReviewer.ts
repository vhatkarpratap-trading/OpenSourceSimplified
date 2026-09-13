import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runCapture } from './ptyManager';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };

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

function extractJson(raw: string): unknown {
  const clean = raw
    .replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
    .replace(/\r/g, '')
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '');
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ── GitHub CLI: list open PRs ──────────────────────────────────────────────────

export function listPRs(folder: string): PRInfo[] {
  try {
    const out = execSync(
      'gh pr list --state open --json number,title,author,headRefName,baseRefName,additions,deletions,changedFiles,url --limit 20',
      { cwd: folder, encoding: 'utf8', timeout: 10000 },
    );
    const items = JSON.parse(out) as Array<{
      number: number; title: string;
      author: { login: string };
      headRefName: string; baseRefName: string;
      additions: number; deletions: number;
      changedFiles: number; url: string;
    }>;
    return items.map(i => ({
      number:       i.number,
      title:        i.title,
      author:       i.author?.login ?? '',
      branch:       i.headRefName,
      baseBranch:   i.baseRefName,
      filesChanged: i.changedFiles,
      additions:    i.additions,
      deletions:    i.deletions,
      url:          i.url,
    }));
  } catch {
    return [];
  }
}

// ── Fallback: local branches vs main/master ────────────────────────────────────

export function listLocalBranches(folder: string): PRInfo[] {
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: folder, encoding: 'utf8', timeout: 5000 }).trim();
    const allBranches = execSync('git --no-pager branch --format="%(refname:short)"', { cwd: folder, encoding: 'utf8', timeout: 5000 })
      .trim().split('\n').filter(b => b && b !== currentBranch && !/^(main|master)$/.test(b));

    const baseBranch = (() => {
      try { execSync('git rev-parse --verify main', { cwd: folder, timeout: 3000 }); return 'main'; } catch {}
      try { execSync('git rev-parse --verify master', { cwd: folder, timeout: 3000 }); return 'master'; } catch {}
      return 'HEAD';
    })();

    const branches = [currentBranch, ...allBranches].filter(Boolean).slice(0, 15);

    return branches.map((branch, i) => {
      let filesChanged = 0, additions = 0, deletions = 0;
      try {
        const stat = execSync(`git --no-pager diff --shortstat ${baseBranch}...${branch}`, { cwd: folder, encoding: 'utf8', timeout: 5000, env: GIT_ENV });
        const fm = stat.match(/(\d+) file/); if (fm) filesChanged = parseInt(fm[1], 10);
        const am = stat.match(/(\d+) insertion/); if (am) additions = parseInt(am[1], 10);
        const dm = stat.match(/(\d+) deletion/); if (dm) deletions = parseInt(dm[1], 10);
      } catch { /* skip */ }
      return {
        number:     -(i + 1),
        title:      branch,
        author:     '',
        branch,
        baseBranch,
        filesChanged,
        additions,
        deletions,
      };
    });
  } catch {
    return [];
  }
}

// ── Fetch the full diff for a PR/branch ───────────────────────────────────────

export function fetchPRDiff(folder: string, prNumber: number, branch: string, baseBranch: string): { diff: string; changedFiles: string[] } {
  let diff = '';
  let changedFiles: string[] = [];

  if (prNumber > 0) {
    // Real GitHub PR — use gh to fetch
    try {
      diff = execSync(`gh pr diff ${prNumber}`, { cwd: folder, encoding: 'utf8', timeout: 15000 });
    } catch { /* fall through to git diff */ }

    try {
      const names = execSync(`gh pr view ${prNumber} --json files --jq '.files[].path'`, { cwd: folder, encoding: 'utf8', timeout: 8000 });
      changedFiles = names.trim().split('\n').filter(Boolean);
    } catch { /* fall through */ }
  }

  if (!diff) {
    // Local branch diff
    try {
      diff = execSync(`git --no-pager diff ${baseBranch}...${branch}`, { cwd: folder, encoding: 'utf8', timeout: 15000, env: GIT_ENV });
    } catch { /* ignore */ }
  }

  if (changedFiles.length === 0) {
    try {
      const names = execSync(`git --no-pager diff --name-only ${baseBranch}...${branch}`, { cwd: folder, encoding: 'utf8', timeout: 8000, env: GIT_ENV });
      changedFiles = names.trim().split('\n').filter(Boolean);
    } catch { /* ignore */ }
  }

  return { diff: diff.slice(0, 24000), changedFiles };
}

// ── Claude: PR review prompt ───────────────────────────────────────────────────

function buildPRReviewPrompt(pr: PRInfo, diff: string, changedFiles: string[], nodeNames: string[]): string {
  const schema = `{
  "featureFlow": {
    "mermaid": "flowchart TD string — what the user experiences after this PR",
    "descriptions": { "NodeLabel": "1 sentence starting with Lets the user or Shows the user" }
  },
  "codeFlow": {
    "mermaid": "flowchart TD string — a plain-English story of how this PR works internally",
    "descriptions": { "NodeLabel": "What this step changes, why it exists, and the source function/file in parentheses" }
  }
}`;

  return [
    `Explain the changes in ${pr.number > 0 ? `PR #${pr.number}` : `branch ${pr.branch}`}: "${pr.title}". This is a change story, not a code review.`,
    'Output ONLY the JSON below — no fences, no prose.',
    '',
    '══ FEATURE FLOW RULES ══',
    '- Draw what the USER experiences after this PR merges.',
    '- Plain English nodes: what they see/do. 6-12 nodes.',
    '- flowchart TD, Id[Label] format, edges with |labels|.',
    '',
    '══ CODE STORY RULES ══',
    '- Explain HOW the changed code works as a story a developer can understand on first read.',
    '- Each node must use plain-English behavior, never a function name. Good: "Check reset link", "Block expired link", "Save new password".',
    '- Each edge must state the data or decision: "reset token", "link expired", "valid password".',
    '- Use only important changed code. Show: input → decision → result → user effect.',
    '- Make changed system boundaries explicit. For every source-proven call between components, processes, services, storage, or external systems, state caller → receiver, transport, meaningful input, and result/error. For REST/HTTP, include METHOD and path plus only proved request/response fields; for persistence, include the proved record/key and read/write operation. Say `unknown` for missing detail rather than guessing.',
    '- Put the real source reference in descriptions, in this format: "How: checks … Why: prevents … (validateToken in auth.ts)".',
    '- Every description must say what changed, HOW the implementation performs it, the relevant contract when it crosses a boundary, WHY it exists, and include that source reference.',
    '- flowchart TD, 4-8 connected nodes. Do not include unchanged implementation details or technical boilerplate.',
    '',
    'Schema:',
    schema,
    '',
    `Changed files (${changedFiles.length}): ${changedFiles.join(', ')}`,
    '',
    'DIFF:',
    diff.slice(0, 20000),
    '',
    'JSON only.',
  ].join('\n');
}

// ── Main review entry point ────────────────────────────────────────────────────

export async function reviewPR(
  folder: string,
  pr: PRInfo,
  nodeNames: string[],
): Promise<PRReviewResult> {
  try {
    const { diff, changedFiles } = fetchPRDiff(folder, pr.number, pr.branch, pr.baseBranch);
    if (!diff) return { ok: false, error: 'Could not fetch diff for this PR' };

    // Inject current file content for top 3 changed files (gives Claude more context)
    let fileContext = '';
    for (const rel of changedFiles.slice(0, 3)) {
      const abs = path.join(folder, rel);
      try {
        const content = fs.readFileSync(abs, 'utf8').slice(0, 1500);
        fileContext += `\n// ── ${rel} (current) ──\n${content}`;
      } catch { /* skip */ }
    }

    const fullDiff = (diff + fileContext).slice(0, 22000);
    const raw = await runCapture(buildPRReviewPrompt(pr, fullDiff, changedFiles, nodeNames), folder);
    const parsed = extractJson(raw) as {
      featureFlow?: { mermaid: string; descriptions?: Record<string, string> };
      codeFlow?: { mermaid: string; descriptions?: Record<string, string> };
    } | null;

    if (!parsed) return { ok: false, error: 'No structured response from Claude', diff, changedFiles };

    return {
      ok:          true,
      pr,
      diff,
      changedFiles,
      featureFlow: parsed.featureFlow ?? undefined,
      codeFlow:    parsed.codeFlow ?? undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
