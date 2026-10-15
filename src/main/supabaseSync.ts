import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

type RepositoryVisibility = 'open-source' | 'private';

export interface SupabaseAnalysisSnapshot {
  folder: string;
  structureHash: string;
  cache: object;
  analysis: object;
  description: string;
  provider: string;
  visibility: RepositoryVisibility;
  remoteUrl?: string;
  publishedBy?: { name: string; email: string } | null;
}

export interface SupabaseCachedAnalysis {
  structureHash: string;
  cache: object;
  analysis: object;
}

let localEnvironment: Record<string, string> | undefined;

function envFileValues(): Record<string, string> {
  if (localEnvironment) return localEnvironment;
  localEnvironment = {};
  try {
    for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !match[2].startsWith('#')) localEnvironment[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* deployment configuration uses process.env */ }
  return localEnvironment;
}

function value(name: string): string | undefined {
  return process.env[name]?.trim() || envFileValues()[name]?.trim() || undefined;
}

function repositoryAuthor(folder: string): string | null {
  try {
    return execFileSync('git', ['-C', folder, 'log', '-1', '--format=%an <%ae>'], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function supabaseClient() {
  const url = value('NEXT_PUBLIC_SUPABASE_URL') ?? value('SUPABASE_URL');
  const key = value('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ?? value('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Read a previously published analysis when this machine has no local cache.
 * This never starts an AI request and follows the same privacy opt-in as sync.
 */
export async function loadAnalysisFromSupabase(snapshot: Pick<SupabaseAnalysisSnapshot, 'folder' | 'visibility' | 'remoteUrl'>): Promise<SupabaseCachedAnalysis | null> {
  if (snapshot.visibility === 'private' && value('REX_SUPABASE_SYNC_PRIVATE') !== 'true') return null;
  const supabase = supabaseClient();
  if (!supabase) return null;
  const repositoryKey = crypto.createHash('sha256').update(snapshot.remoteUrl || snapshot.folder).digest('hex');
  const { data, error } = await supabase.from('repository_analysis_cache')
    .select('structure_hash, cache_json, analysis_json')
    .eq('repository_key', repositoryKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !data.cache_json || typeof data.cache_json !== 'object') return null;
  return { structureHash: String(data.structure_hash ?? ''), cache: data.cache_json as object, analysis: data.analysis_json as object };
}

/** Sync a completed analysis without making remote availability part of local analysis. */
export async function syncAnalysisToSupabase(snapshot: SupabaseAnalysisSnapshot): Promise<void> {
  if (snapshot.visibility === 'private' && value('REX_SUPABASE_SYNC_PRIVATE') !== 'true') {
    console.info('[supabase] private repository cache remains local');
    return;
  }

  const repositoryKey = crypto.createHash('sha256').update(snapshot.remoteUrl || snapshot.folder).digest('hex');
  const supabase = supabaseClient();
  if (!supabase) return;
  const { error } = await supabase.from('repository_analysis_cache').upsert({
    repository_key: repositoryKey,
    repository_name: snapshot.folder.split(/[\/]/).filter(Boolean).pop() || 'repository',
    repository_description: snapshot.description.slice(0, 500),
    repository_author: repositoryAuthor(snapshot.folder),
    repository_url: snapshot.remoteUrl ?? null,
    repository_visibility: snapshot.visibility,
    published_by_name: snapshot.publishedBy?.name ?? null,
    published_by_email: snapshot.publishedBy?.email ?? null,
    provider: snapshot.provider,
    structure_hash: snapshot.structureHash,
    analysis_json: snapshot.analysis,
    cache_json: snapshot.cache,
    analysed_at: new Date().toISOString(),
  }, { onConflict: 'repository_key' });
  if (error) throw new Error(error.message);
}

/** Remove the remote snapshot when a user clears that same local project cache. */
export async function deleteAnalysisFromSupabase(snapshot: Pick<SupabaseAnalysisSnapshot, 'folder' | 'visibility' | 'remoteUrl'>): Promise<void> {
  if (snapshot.visibility === 'private' && value('REX_SUPABASE_SYNC_PRIVATE') !== 'true') return;
  const repositoryKey = crypto.createHash('sha256').update(snapshot.remoteUrl || snapshot.folder).digest('hex');
  const supabase = supabaseClient();
  if (!supabase) return;
  const { error } = await supabase.from('repository_analysis_cache').delete().eq('repository_key', repositoryKey);
  if (error) throw new Error(error.message);
}
