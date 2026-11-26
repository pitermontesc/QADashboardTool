import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './errors.js';
import type { ActivityItem, Lang, ReportTranslation } from '../shared/types.js';
import type { AssistantRunner } from './assistant.js';

/** Working folder for Claude runs; their reports end up there and their logs in `logs/`. */
export const RUNS_DIR = path.join(os.homedir(), 'qa-dashboard-runs');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');

/**
 * Claude Code with no window and no questions: `-p` waits for nobody (not even the folder
 * trust prompt), `auto` mode approves safe actions without asking, `--chrome` gives the
 * skills the browser and `stream-json` writes every step to the log.
 */
export const CLAUDE_ARGS = ['-p', '--chrome', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];

/** If Claude is still running after this long, it is stopped. */
export const MAX_RUN_MS = 4 * 60 * 60_000;
/** A stopped process that ignores SIGTERM is killed after this long. */
const KILL_AFTER_MS = 10_000;

export interface ClaudeJob {
  id: string;
  prompt: string;
  /** Called when the process exits, with its code and Claude's (or the system's) last message. */
  onExit: (exit: { code: number | null; lastMessage: string }) => void;
}

export interface ClaudeHandle {
  pid: number | null;
  logFile: string;
  stop: () => void;
}

/** Launches Claude Code in the background; injectable to test without running anything. */
export type ClaudeLauncher = (job: ClaudeJob) => Promise<ClaudeHandle>;

/** The desktop app does not inherit the terminal PATH: look for `claude` where the installer puts it. Null if it is not installed. */
export function claudeBinary(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  const found = candidates.find((file) => existsSync(file));
  if (found) return found;
  try {
    // Last resort: the PATH of the user's interactive login shell.
    const shell = process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    const resolved = execFileSync(shell, ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n').at(-1);
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // Not installed, or the shell failed: the same answer.
  }
  return null;
}

function findClaude(): string {
  const bin = claudeBinary();
  if (!bin) throw new HttpError(500, 'Claude Code (claude) was not found on this Mac');
  return bin;
}

/** Clean environment: without the markers of a Claude or Electron session that started the app. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE') || key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  const home = os.homedir();
  env.PATH = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
  return env;
}

export const launchClaude: ClaudeLauncher = (job) => {
  const bin = findClaude();
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, `${job.id}.jsonl`);
  // The process writes its own log: it stays complete even if the app closes midway.
  const fd = openSync(logFile, 'a', 0o600);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...CLAUDE_ARGS, job.prompt], {
      cwd: RUNS_DIR,
      env: cleanEnv(),
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const stop = (): void => {
      if (child.pid) stopPid(child.pid);
    };
    const limit = setTimeout(stop, MAX_RUN_MS);
    limit.unref();
    child.once('error', (err) => reject(new HttpError(500, `Could not start Claude Code: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid ?? null, logFile, stop });
    });
    child.once('exit', (code) => {
      clearTimeout(limit);
      job.onExit({ code, lastMessage: lastMessage(logFile) });
    });
  });
};

/** Translates a run's summary and report; returns the JSON as is (it is validated when saved). */
export type ReportTranslator = (report: ReportTranslation, lang: Lang) => Promise<unknown>;

const TRANSLATE_MS = 4 * 60_000;
const LANG_NAME: Record<Lang, string> = { es: 'Spanish', en: 'English' };

/**
 * Claude Haiku with no tools or MCP: receives the report on stdin and replies with only
 * the translated JSON. Keys, statuses, numbers, links, ticket keys and the product's
 * screen names are kept.
 */
export const translateReport: ReportTranslator = (report, lang) => {
  const bin = findClaude();
  mkdirSync(RUNS_DIR, { recursive: true });
  const prompt =
    `Translate the JSON QA report on stdin into ${LANG_NAME[lang]}. Reply with only the translated JSON, no code fences or comments.` +
    ' Keep exactly the same keys and structure. Translate every human-readable text value (summary, names, notes, titles, build) completely: no word may stay in the original language except the names below.' +
    ' Do not change keys, status values (passed, failed, blocked, skipped), numbers, URLs, ticket keys (e.g. AVM-123), code, file paths, HTTP codes,' +
    ' product and screen names (e.g. Work Orders, Issue Files, Main Shop) or QA terms (GO, NO-GO, PASSED, FAILED, BLOCKED, smoke, regression).';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text', prompt], {
      cwd: RUNS_DIR,
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const limit = setTimeout(() => child.kill('SIGTERM'), TRANSLATE_MS);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.once('error', (e) => {
      clearTimeout(limit);
      reject(new HttpError(500, `Could not translate the report: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(limit);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      try {
        if (code !== 0 || !json) throw new Error(err.trim() || out.trim() || `exit ${code}`);
        resolve(JSON.parse(json));
      } catch (e) {
        reject(new HttpError(502, `Could not translate the report: ${short(e instanceof Error ? e.message : String(e), 300)}`));
      }
    });
    // If claude exits before reading stdin (EPIPE), 'close' reports the failure; without a listener it would crash the server.
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(report));
  });
};

const ASSISTANT_MS = 3 * 60_000;

/**
 * Assistant with Claude Code and the user's session: no tools or MCP (it only answers),
 * with its own instructions and the reply validated against a JSON schema.
 */
export const runAssistant: AssistantRunner = ({ system, prompt, schema }) => {
  const bin = findClaude();
  mkdirSync(RUNS_DIR, { recursive: true });
  const args = [
    '-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
    '--system-prompt', system, '--json-schema', JSON.stringify(schema), 'Reply to the last user message.',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: RUNS_DIR, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const limit = setTimeout(() => child.kill('SIGTERM'), ASSISTANT_MS);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.once('error', (e) => {
      clearTimeout(limit);
      reject(new HttpError(500, `Could not start Claude Code: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(limit);
      try {
        const result = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
        if (result.is_error) throw new Error(result.result || `exit ${code}`);
        resolve(result.structured_output ?? result.result ?? '');
      } catch (e) {
        const why = e instanceof SyntaxError ? err.trim() || out.trim() || `exit ${code}` : e instanceof Error ? e.message : String(e);
        reject(new HttpError(502, `The assistant could not answer: ${short(why, 300)}`));
      }
    });
    // If claude exits before reading stdin (EPIPE), 'close' reports the failure; without a listener it would crash the server.
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
  });
};

/** Sends a signal to the process group (Claude and the helpers it started), or to the process alone. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false; // It no longer exists.
    }
  }
}

/**
 * Stops a Claude run by its pid (also one launched before the app restarted): SIGTERM first and,
 * if it is still that Claude process after a few seconds, SIGKILL, so a stopped run cannot keep working.
 */
export function stopPid(pid: number): void {
  if (!signal(pid, 'SIGTERM')) return;
  const force = setTimeout(() => {
    if (isClaudeProcess(pid)) signal(pid, 'SIGKILL');
  }, KILL_AFTER_MS);
  force.unref();
}

/** Whether the pid is a running Claude Code process (a saved pid may have been reused by another program). */
export function isClaudeProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
    // Launched as …/bin/claude (a symlink) or by its versioned binary (…/claude/versions/2.1.327).
    return /(^|\/)claude(\s|$)|\/claude\/versions\//.test(command.trim());
  } catch {
    return false;
  }
}

/** Only the end of the log: with `--verbose` it can weigh several MB. */
function tail(file: string, bytes = 512 * 1024): string {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}


const short = (text: string, max = 400): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Readable summary of a tool call: the browser shows the URL or action, Bash the command. */
function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const [prefix, server, ...rest] = name.split('__');
  const tool = prefix === 'mcp' && server ? `${server === 'claude-in-chrome' ? 'Chrome' : server.replace(/^claude_ai_/, '')} · ${rest.join('__')}` : name;
  const detail = [input?.url, input?.description, input?.command, input?.action, input?.query, input?.skill]
    .find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined;
  return detail ? `${tool}: ${short(detail, 160)}` : tool;
}

/** What Claude is doing, from the `stream-json` log. */
export function readActivity(file: string, max = 40): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const line of tail(file).split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; subtype?: string; result?: unknown; message?: { content?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      items.push({ kind: 'error', text: short(line) });
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') items.push({ kind: 'start', text: '' });
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
        if (part.type === 'text' && part.text?.trim()) items.push({ kind: 'text', text: short(part.text.trim()) });
        if (part.type === 'tool_use' && part.name) items.push({ kind: 'tool', text: describeTool(part.name, part.input) });
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') items.push({ kind: 'result', text: short(event.result, 2000) });
  }
  return items.slice(-max);
}

/** Claude's last message (its final answer or a system error), to close a run that did not report. */
export function lastMessage(file: string): string {
  const items = readActivity(file, 200).filter((i) => i.kind !== 'tool' && i.kind !== 'start');
  return items.at(-1)?.text ?? '';
}
