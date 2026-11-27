import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationKind, JiraState, QaConfig, SetupCheck, SetupState, SetupStatus, SkillCheck } from '../shared/types.js';
import { RUNS_DIR, claudeBinary, cleanEnv } from './claudeRunner.js';
import { PROFILE_FILE, readQaProfile } from './profile.js';

/** What was found on this Mac; `null` where it could not be checked. */
export interface SetupFacts {
  claude: { version: string } | null;
  loggedIn: boolean | null;
  /** Installed skill names: `plugin:skill` for a plugin's, the bare name for a personal or project one. */
  skills: InstalledSkill[] | null;
  chrome: boolean | null;
  profile: { status: 'ok'; tester: string } | { status: 'missing' | 'invalid' };
}

export interface InstalledSkill {
  /** As it is typed after the slash: `avm-qa-skills:avm-qa-orchestrator` or `my-skill`. */
  name: string;
  /** From an installed plugin: its name is certain, so the app can switch a configured name to it. */
  plugin: boolean;
}

/** Checks this Mac; injectable so tests and the demo do not run the real Claude. */
export type SetupProbe = () => Promise<SetupFacts>;

/** Where Claude Code registers the Claude in Chrome connection, per Chromium browser. */
const CHROME_HOST = 'NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json';
const BROWSER_DIRS = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium'];

/** A Mac where everything is in place: for the demo and for tests that do not check the setup. */
export const readyFacts = (skills: string[] = []): SetupFacts => ({
  claude: { version: 'simulated' },
  loggedIn: true,
  skills: skills.map((name) => ({ name, plugin: true })),
  chrome: true,
  profile: { status: 'ok', tester: 'QA' },
});

/** `claude auth status` prints JSON even when signed out (and then exits with 1). */
export function parseAuthStatus(stdout: string): boolean | null {
  try {
    const { loggedIn } = JSON.parse(stdout) as { loggedIn?: unknown };
    return typeof loggedIn === 'boolean' ? loggedIn : null;
  } catch {
    return null;
  }
}

/** `claude plugin list --json`: the enabled plugins and where they are installed. */
export function parsePluginList(stdout: string): { name: string; dir: string }[] | null {
  try {
    const list = JSON.parse(stdout) as unknown;
    if (!Array.isArray(list)) return null;
    return list.flatMap((p: { id?: unknown; enabled?: unknown; installPath?: unknown }) =>
      typeof p.id === 'string' && typeof p.installPath === 'string' && p.enabled !== false ? [{ name: p.id.split('@')[0]!, dir: p.installPath }] : [],
    );
  } catch {
    return null;
  }
}

/** The skills in a folder of skill folders: each one's `name:` in its SKILL.md, or its folder's name. */
function skillsIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry, 'SKILL.md');
    if (!existsSync(file)) return [];
    const named = /^name:\s*["']?([\w.-]+)["']?\s*$/m.exec(readFileSync(file, 'utf8').slice(0, 2000))?.[1];
    return [named ?? entry];
  });
}

/**
 * Every skill Claude Code can run from the runs folder: the installed plugins' (with their prefix),
 * the personal ones in `~/.claude/skills`, the ones the organization syncs and the runs folder's own.
 */
export function installedSkills(plugins: { name: string; dir: string }[], home = os.homedir(), runsDir = RUNS_DIR): InstalledSkill[] {
  const found: InstalledSkill[] = plugins.flatMap((p) => skillsIn(path.join(p.dir, 'skills')).map((s) => ({ name: `${p.name}:${s}`, plugin: true })));
  const bare = [path.join(home, '.claude', 'skills'), path.join(runsDir, '.claude', 'skills')].flatMap(skillsIn);
  // Skills the organization syncs live one folder down per organization.
  const synced = path.join(home, '.claude', 'skills', 'synced');
  let orgs: string[] = [];
  try {
    orgs = readdirSync(synced);
  } catch {
    // None synced.
  }
  const org = orgs.flatMap((o) => skillsIn(path.join(synced, o)));
  for (const name of [...bare, ...org]) found.push({ name, plugin: false });
  return found;
}

/** The skill a configured command calls: `/avm-qa-skills:avm-smoke-tester run…` → `avm-qa-skills:avm-smoke-tester`. */
export const skillOf = (command: string): string => command.trim().replace(/^\//, '').split(/\s/, 1)[0] ?? '';
const baseOf = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/**
 * Whether Claude Code has a configured skill. A prefixed name must match exactly; a bare one
 * matches any skill with that name. When it is missing and exactly one installed plugin has a skill
 * with the same name, that one is suggested (the app switches to it).
 */
export function checkSkill(command: string, installed: InstalledSkill[] | null): { status: SetupStatus; suggestion?: string } {
  if (installed === null) return { status: 'unknown' };
  const name = skillOf(command);
  const has = name.includes(':') ? installed.some((s) => s.name === name) : installed.some((s) => baseOf(s.name) === name);
  if (has) return { status: 'ok' };
  const same = [...new Set(installed.filter((s) => s.plugin && baseOf(s.name) === baseOf(name)).map((s) => s.name))];
  return same.length === 1 ? { status: 'missing', suggestion: `/${same[0]}` } : { status: 'missing' };
}

export const SKILL_KINDS: AutomationKind[] = ['orchestrator', 'smoke', 'regression'];

/** A configured skill the app switched to the name Claude Code has. */
export interface SkillRename {
  from: string;
  to: string;
}

/** The state the UI shows, from what was found, the settings and Jira. */
export function setupState(facts: SetupFacts, qa: QaConfig, jira: JiraState, renamed: Partial<Record<AutomationKind, SkillRename>>, checkedAt: number): SetupState {
  const skills: SkillCheck[] = SKILL_KINDS.map((kind) => ({
    kind,
    name: qa.skills[kind],
    status: facts.claude ? checkSkill(qa.skills[kind], facts.skills).status : 'unknown',
    // Shown while the name is still the one the app chose.
    ...(renamed[kind]?.to === qa.skills[kind] ? { renamedFrom: renamed[kind].from } : {}),
  }));
  const missingSkills = skills.filter((s) => s.status === 'missing');
  const status = (value: boolean | null): SetupStatus => (value === null ? 'unknown' : value ? 'ok' : 'missing');
  const checks: SetupCheck[] = [
    { id: 'claude', status: facts.claude ? 'ok' : 'missing', required: true, detail: facts.claude?.version ?? '' },
    { id: 'login', status: facts.claude ? status(facts.loggedIn) : 'unknown', required: true, detail: '' },
    {
      id: 'skills',
      status: missingSkills.length ? 'missing' : skills.every((s) => s.status === 'ok') ? 'ok' : 'unknown',
      required: true,
      detail: (missingSkills.length ? missingSkills : skills).map((s) => skillOf(s.name)).join(', '),
    },
    { id: 'chrome', status: status(facts.chrome), required: false, detail: '' },
    { id: 'profile', status: facts.profile.status, required: false, detail: facts.profile.status === 'ok' ? facts.profile.tester : '' },
    { id: 'jira', status: jira.connection === 'connected' ? 'ok' : 'missing', required: false, detail: jira.site.replace(/^https?:\/\//, '') },
  ];
  return { checkedAt, ready: checks.every((c) => !c.required || c.status !== 'missing'), checks, skills };
}

/**
 * Why a run of this kind cannot launch, or null if it can. Only what is certainly missing
 * stops it: a check that could not be done lets the run try.
 */
export function launchBlocker(facts: SetupFacts, qa: QaConfig, kind: AutomationKind): string | null {
  if (!facts.claude) return 'Claude Code is not installed on this Mac. See Types & settings → Set up this Mac';
  if (facts.loggedIn === false) return 'Claude Code is not signed in on this Mac. See Types & settings → Set up this Mac';
  if (checkSkill(qa.skills[kind], facts.skills).status === 'missing') {
    return `Claude Code does not have the skill ${skillOf(qa.skills[kind])}. See Types & settings → Set up this Mac`;
  }
  return null;
}

/** Runs a Claude Code command and returns what it printed, whatever its exit code. */
function claudeOutput(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: RUNS_DIR, env: cleanEnv(), timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/** The QA profile as the setup check sees it: the tester's name, or why it is not usable. */
export function profileFacts(file = PROFILE_FILE): SetupFacts['profile'] {
  const profile = readQaProfile(file);
  if (!profile.exists) return { status: 'missing' };
  return profile.tester ? { status: 'ok', tester: profile.tester.name } : { status: 'invalid' };
}

function chromeConnected(home = os.homedir()): boolean | null {
  if (process.platform !== 'darwin') return null;
  return BROWSER_DIRS.some((dir) => existsSync(path.join(home, 'Library', 'Application Support', dir, CHROME_HOST)));
}

/** Checks the real Mac: about a second (three quick Claude Code commands). */
export const probeSetup = async (profileFile = PROFILE_FILE): Promise<SetupFacts> => {
  const bin = claudeBinary();
  const base = { chrome: chromeConnected(), profile: profileFacts(profileFile) };
  if (!bin) return { claude: null, loggedIn: null, skills: null, ...base };
  mkdirSync(RUNS_DIR, { recursive: true });
  const [version, auth, plugins] = await Promise.all([
    claudeOutput(bin, ['--version']),
    claudeOutput(bin, ['auth', 'status', '--json']),
    claudeOutput(bin, ['plugin', 'list', '--json']),
  ]);
  const list = parsePluginList(plugins);
  return {
    claude: { version: /\d+\.\d+\.\d+/.exec(version)?.[0] ?? (version.trim() || '?') },
    loggedIn: parseAuthStatus(auth),
    skills: list && installedSkills(list),
    ...base,
  };
};
