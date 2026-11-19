import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './errors.js';
import type { ActivityItem, Lang, ReportTranslation } from '../shared/types.js';
import type { AssistantRunner } from './assistant.js';

/** Carpeta de trabajo de las ejecuciones con Claude; ahí quedan sus reportes y, en `logs/`, su registro. */
export const RUNS_DIR = path.join(os.homedir(), 'qa-dashboard-runs');
export const LOGS_DIR = path.join(RUNS_DIR, 'logs');

/**
 * Claude Code sin ventana ni preguntas: `-p` no espera a nadie (ni el aviso de
 * confianza de la carpeta), el modo `auto` aprueba lo seguro sin preguntar, `--chrome`
 * da el navegador a los skills y `stream-json` deja en el log cada paso.
 */
export const CLAUDE_ARGS = ['-p', '--chrome', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];

/** Si Claude sigue corriendo pasado este tiempo, se detiene. */
const MAX_RUN_MS = 4 * 60 * 60_000;

export interface ClaudeJob {
  id: string;
  prompt: string;
  /** Al terminar el proceso, con su código y el último mensaje de Claude (o del sistema). */
  onExit: (exit: { code: number | null; lastMessage: string }) => void;
}

export interface ClaudeHandle {
  pid: number | null;
  logFile: string;
  stop: () => void;
}

/** Lanza Claude Code en segundo plano; inyectable para probar sin ejecutar nada. */
export type ClaudeLauncher = (job: ClaudeJob) => Promise<ClaudeHandle>;

/** La app de escritorio no hereda el PATH de la terminal: se busca `claude` donde lo deja el instalador. */
function findClaude(): string {
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
    // Último recurso: el PATH de una shell de login interactiva del usuario.
    const shell = process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    const resolved = execFileSync(shell, ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n').at(-1);
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // Sigue abajo con el error claro.
  }
  throw new HttpError(500, 'No se encontró Claude Code (claude) en esta Mac');
}

/** Entorno limpio: sin las marcas de una sesión de Claude o de Electron que haya arrancado la app. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^CLAUDE/.test(key) || key === 'ELECTRON_RUN_AS_NODE') continue;
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
  // El log lo escribe el propio proceso: sigue completo aunque la app se cierre a mitad.
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
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Ya había terminado.
      }
    };
    const limit = setTimeout(stop, MAX_RUN_MS);
    limit.unref();
    child.once('error', (err) => reject(new HttpError(500, `No se pudo iniciar Claude Code: ${err.message}`)));
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

/** Traduce el resumen y el reporte de una ejecución; devuelve el JSON tal cual (se valida al guardarlo). */
export type ReportTranslator = (report: ReportTranslation, lang: Lang) => Promise<unknown>;

const TRANSLATE_MS = 4 * 60_000;
const LANG_NAME: Record<Lang, string> = { es: 'Spanish', en: 'English' };

/**
 * Claude Haiku sin herramientas ni MCP: recibe el reporte por stdin y responde solo
 * con el JSON traducido. Se mantienen claves, estados, números, links, claves de
 * tickets y los nombres de pantallas del producto.
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
      reject(new HttpError(500, `No se pudo traducir el reporte: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(limit);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      try {
        if (code !== 0 || !json) throw new Error(err.trim() || out.trim() || `exit ${code}`);
        resolve(JSON.parse(json));
      } catch (e) {
        reject(new HttpError(502, `No se pudo traducir el reporte: ${short(e instanceof Error ? e.message : String(e), 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(report));
  });
};

const ASSISTANT_MS = 3 * 60_000;

/**
 * Asistente con Claude Code y la sesión del usuario: sin herramientas ni MCP (solo responde),
 * con sus propias instrucciones y la respuesta validada contra un esquema JSON.
 */
export const runAssistant: AssistantRunner = ({ system, prompt, schema }) => {
  const bin = findClaude();
  mkdirSync(RUNS_DIR, { recursive: true });
  const args = [
    '-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
    '--system-prompt', system, '--json-schema', JSON.stringify(schema), 'Responde al último mensaje del usuario.',
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
      reject(new HttpError(500, `No se pudo iniciar Claude Code: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(limit);
      try {
        const result = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
        if (result.is_error) throw new Error(result.result || `exit ${code}`);
        resolve(result.structured_output ?? result.result ?? '');
      } catch (e) {
        const why = e instanceof SyntaxError ? err.trim() || out.trim() || `exit ${code}` : e instanceof Error ? e.message : String(e);
        reject(new HttpError(502, `El asistente no pudo responder: ${short(why, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
};

/** Detiene un proceso por su pid (por ejemplo, de una ejecución lanzada antes de reiniciar la app). */
export function stopPid(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ya no existe.
    }
  }
}

/** Solo el final del log: con `--verbose` puede pesar varios MB. */
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

/** Resumen legible de una llamada a herramienta: el navegador muestra la URL o la acción, Bash el comando. */
function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const [prefix, server, ...rest] = name.split('__');
  const tool = prefix === 'mcp' && server ? `${server === 'claude-in-chrome' ? 'Chrome' : server.replace(/^claude_ai_/, '')} · ${rest.join('__')}` : name;
  const detail = [input?.url, input?.description, input?.command, input?.action, input?.query, input?.skill]
    .find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined;
  return detail ? `${tool}: ${short(detail, 160)}` : tool;
}

/** Lo que va haciendo Claude, a partir del log `stream-json`. */
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

/** Último mensaje de Claude (su respuesta final o un error del sistema), para cerrar una ejecución sin reporte. */
export function lastMessage(file: string): string {
  const items = readActivity(file, 200).filter((i) => i.kind !== 'tool' && i.kind !== 'start');
  return items.at(-1)?.text ?? '';
}
