import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Automation, QueueItem, TeamMember, TeamQueueItem, TestRun, TestType } from '../shared/types.js';
import { runSchema, storedAutomationSchema } from './schemas.js';

/**
 * The team folder: a folder the team syncs (Google Drive, Dropbox, iCloud, OneDrive). Each app
 * writes only its own file there and reads everyone else's, so two apps never write the same file.
 */
export const TEAM_SUFFIX = '.qa-team.json';
const FORMAT = 'qa-dashboard-team';
/** A file bigger than this is not read (a normal one is a few MB at most). */
const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** What the team sees of a report: no process, log, queue or Jira comment draft (they belong to the Mac that ran it). */
const sharedAutomationSchema = storedAutomationSchema.transform((a) => ({
  ...a,
  queued: null,
  details: a.details && { ...a.details, jiraComment: null },
}));

/** A teammate's file, as read: it comes from another Mac, so it is checked like an import. */
const teamFileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  app: z.string().max(20).default(''),
  member: z.object({ id: z.string().trim().min(8).max(64).regex(/^[\w-]+$/), name: z.string().trim().min(1).max(120) }),
  updatedAt: z.number(),
  // Only to show their test types' names and colors: a bad list is dropped, not the whole file.
  types: z
    .array(z.object({ id: z.string().min(1).max(100), name: z.string().trim().max(80), major: z.boolean().default(false), color: z.string().regex(/^#[0-9a-f]{3,8}$/i) }))
    .max(500)
    .catch([]),
  runs: z.array(runSchema).max(50_000),
  automations: z.array(sharedAutomationSchema).max(10_000),
  // Added in v1.23.0: what waits in their queue. Files from v1.22.0 have none.
  queue: z
    .array(z.object({ kind: z.enum(['orchestrator', 'smoke', 'regression']), target: z.string().trim().min(1).max(500), site: z.string().max(100), addedAt: z.number() }))
    .max(1_000)
    .default([]),
});

export interface TeamFile {
  format: typeof FORMAT;
  version: 1;
  app: string;
  member: { id: string; name: string };
  updatedAt: number;
  types: TestType[];
  runs: TestRun[];
  automations: Automation[];
  queue: TeamQueueItem[];
}

/** `~/Google Drive/QA` → absolute path. */
export function expandHome(folder: string): string {
  const trimmed = folder.trim();
  return trimmed === '~' ? os.homedir() : trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
}

/** `/Users/ana/Google Drive/QA` → `~/Google Drive/QA`. */
export function displayPath(folder: string): string {
  const home = os.homedir();
  return folder === home ? '~' : folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
}

/** The file name: readable in the shared folder, and unique per app even if two people share a name. */
export function teamFileName(member: { id: string; name: string }): string {
  const slug = member.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'qa';
  return `${slug.slice(0, 40)}--${member.id.slice(0, 8)}${TEAM_SUFFIX}`;
}

/**
 * What this app shares: its runs, reports and what waits in its queue; never the Jira connection,
 * the settings or anything about the machine.
 */
export function buildTeamFile(
  member: { id: string; name: string },
  app: string,
  types: TestType[],
  runs: TestRun[],
  automations: Automation[],
  now = Date.now(),
  queue: QueueItem[] = [],
): TeamFile {
  return {
    format: FORMAT,
    version: 1,
    app,
    member,
    updatedAt: now,
    types,
    runs,
    automations: automations.map((a) => ({
      ...a,
      pid: null,
      logFile: '',
      queued: null,
      details: a.details && { ...a.details, jiraComment: null },
    })),
    queue: queue.map(({ kind, target, site, addedAt }) => ({ kind, target, site, addedAt })),
  };
}

/**
 * Writes this app's file (a hidden temporary file, then a rename: sync apps never upload half of it),
 * and removes the files this app wrote under an earlier name.
 */
export function writeTeamFile(folder: string, file: TeamFile): string {
  const name = teamFileName(file.member);
  const tmp = path.join(folder, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, path.join(folder, name));
  const mine = `--${file.member.id.slice(0, 8)}${TEAM_SUFFIX}`;
  for (const other of readdirSync(folder)) {
    if (other !== name && other.endsWith(mine)) {
      try {
        const { member } = JSON.parse(readFileSync(path.join(folder, other), 'utf8')) as { member?: { id?: string } };
        if (member?.id === file.member.id) unlinkSync(path.join(folder, other));
      } catch {
        // Not readable or already gone: leave it.
      }
    }
  }
  return name;
}

/** Removes this app's file (leaving the team): only a file whose member is this app. */
export function removeTeamFile(folder: string, memberId: string): void {
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder).filter((f) => f.endsWith(TEAM_SUFFIX))) {
    try {
      const { member } = JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { member?: { id?: string } };
      if (member?.id === memberId) unlinkSync(path.join(folder, name));
    } catch {
      // Someone else's or unreadable: never touched.
    }
  }
}

const cache = new Map<string, { mtime: number; size: number; member: TeamMember | null; error: string | null }>();

/**
 * Everyone else's data in the folder. A file that cannot be read is reported, never fatal; if two
 * files claim the same app, the newest wins. Unchanged files are not parsed again.
 */
export function readTeamFolder(folder: string, ownId: string): { members: TeamMember[]; problems: { file: string; error: string }[] } {
  const problems: { file: string; error: string }[] = [];
  const byId = new Map<string, TeamMember>();
  for (const name of readdirSync(folder).filter((f) => f.endsWith(TEAM_SUFFIX) && !f.startsWith('.'))) {
    const full = path.join(folder, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    let entry = cache.get(full);
    if (!entry || entry.mtime !== stat.mtimeMs || entry.size !== stat.size) {
      entry = { mtime: stat.mtimeMs, size: stat.size, member: null, error: null };
      if (stat.size > MAX_FILE_BYTES) entry.error = 'The file is too big';
      else {
        try {
          const parsed = teamFileSchema.safeParse(JSON.parse(readFileSync(full, 'utf8')));
          if (parsed.success) {
            const f = parsed.data;
            entry.member = { id: f.member.id, name: f.member.name, app: f.app, updatedAt: f.updatedAt, file: name, me: false, types: f.types, runs: f.runs, automations: f.automations, queue: f.queue };
          } else {
            const issue = parsed.error.issues[0];
            entry.error = `Not a QA Dashboard team file${issue ? ` (${issue.path.join('.') || 'file'}: ${issue.message})` : ''}`;
          }
        } catch {
          // Often a file the sync app is still downloading.
          entry.error = 'Not valid JSON (it may still be syncing)';
        }
      }
      cache.set(full, entry);
    }
    if (entry.error) problems.push({ file: name, error: entry.error });
    const m = entry.member;
    if (!m || m.id === ownId) continue;
    const known = byId.get(m.id);
    if (!known || known.updatedAt < m.updatedAt) byId.set(m.id, m);
  }
  return { members: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** Synced folders found on this Mac, to suggest where the team folder can go. */
export function syncedFolders(home = os.homedir()): string[] {
  const found: string[] = [];
  const cloud = path.join(home, 'Library', 'CloudStorage');
  try {
    for (const name of readdirSync(cloud)) {
      if (!/^(GoogleDrive|OneDrive|Dropbox|Box)/.test(name)) continue;
      const root = path.join(cloud, name);
      // Google Drive mounts "My Drive" and "Shared drives" inside its folder.
      const inner = ['My Drive', 'Mi unidad', 'Shared drives', 'Unidades compartidas'].map((d) => path.join(root, d)).filter((d) => existsSync(d));
      found.push(...(inner.length ? inner : [root]));
    }
  } catch {
    // No cloud storage.
  }
  for (const candidate of [path.join(home, 'Dropbox'), path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]) {
    if (existsSync(candidate)) found.push(candidate);
  }
  return [...new Set(found)].map(displayPath);
}

/** Checks the folder is usable for the team: absolute (or under ~), and created if its parent exists. */
export function prepareTeamFolder(folder: string): string {
  const full = path.resolve(expandHome(folder));
  if (!path.isAbsolute(expandHome(folder))) throw new Error('The team folder must be a full path (it can start with ~/)');
  if (!existsSync(full)) {
    if (!existsSync(path.dirname(full))) throw new Error(`The folder ${displayPath(path.dirname(full))} does not exist`);
    mkdirSync(full);
  }
  if (!statSync(full).isDirectory()) throw new Error(`${displayPath(full)} is not a folder`);
  return full;
}
