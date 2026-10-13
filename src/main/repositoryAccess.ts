import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export type RepositoryAccessKind = 'open-source' | 'private';
export type RepositoryAccessSource = 'public-remote' | 'open-source-license' | 'private-remote' | 'unverified';

export interface RepositoryAccess {
  kind: RepositoryAccessKind;
  source: RepositoryAccessSource;
  detail: string;
  remoteUrl?: string;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md', 'COPYING.txt'];
const OPEN_SOURCE_LICENSE = /\b(mit license|apache license[ ,]+version 2(?:\.0)?|gnu (?:affero )?(?:lesser )?general public license|mozilla public license|eclipse public license|bsd (?:2|3)-clause|isc license|the unlicense|creative commons zero|cc0)\b/i;

function gitOrigin(folder: string): string | undefined {
  try {
    const remote = execFileSync('git', ['-C', folder, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return remote || undefined;
  } catch { return undefined; }
}

function hasOpenSourceLicense(folder: string): boolean {
  let names = LICENSE_FILES;
  try {
    names = Array.from(new Set([
      ...LICENSE_FILES,
      ...fs.readdirSync(folder).filter(name => /^(license|copying)(?:[._-]|$)/i.test(name)),
    ]));
  } catch { /* use the conventional file names below */ }

  for (const name of names) {
    try {
      const license = fs.readFileSync(path.join(folder, name), 'utf8').slice(0, 32_000);
      if (OPEN_SOURCE_LICENSE.test(license)) return true;
    } catch { /* try the next conventional license file */ }
  }
  return false;
}

function githubRepo(remote: string): string | undefined {
  const match = remote.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i);
  return match ? match[1] + '/' + match[2] : undefined;
}

function gitlabRepo(remote: string): string | undefined {
  const match = remote.match(/(?:gitlab\.com[/:])(.+?)(?:\.git)?$/i);
  return match?.[1];
}

async function isPublicHostedRepository(remote: string): Promise<boolean | undefined> {
  const github = githubRepo(remote);
  const gitlab = gitlabRepo(remote);
  const endpoint = github
    ? 'https://api.github.com/repos/' + github
    : gitlab ? 'https://gitlab.com/api/v4/projects/' + encodeURIComponent(gitlab) : undefined;
  if (!endpoint) return undefined;

  try {
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    // Both APIs return 200 only for a repository visible without credentials.
    if (response.ok) return true;
    if (response.status === 404) return false;
    return undefined; // rate limited or temporarily unavailable — do not mislabel it.
  } catch {
    return undefined;
  }
}

/**
 * Classify a local project conservatively. A repository is free only when it
 * is publicly visible through a supported host or carries a recognised open
 * source licence. Everything else is treated as private until verified.
 */
export async function getRepositoryAccess(folder: string): Promise<RepositoryAccess> {
  const remoteUrl = gitOrigin(folder);
  const hasLicense = hasOpenSourceLicense(folder);

  if (remoteUrl) {
    const publiclyVisible = await isPublicHostedRepository(remoteUrl);
    if (publiclyVisible) {
      return { kind: 'open-source', source: 'public-remote', remoteUrl, detail: 'Public repository.' };
    }
    if (publiclyVisible === false) {
      return { kind: 'private', source: 'private-remote', remoteUrl, detail: 'Private repository — analysis stays local.' };
    }
  }

  if (hasLicense) {
    return { kind: 'open-source', source: 'open-source-license', remoteUrl, detail: 'Recognised open-source licence.' };
  }

  return {
    kind: 'private',
    source: 'unverified',
    remoteUrl,
    detail: remoteUrl
      ? 'Repository visibility could not be verified. Analysis stays local.'
      : 'No public repository or recognised open-source licence was found. Analysis stays local.',
  };
}
