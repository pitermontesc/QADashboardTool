import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/** Past this size the log moves to `app.log.1` (the one before is dropped): at most ~2 MB on disk. */
const MAX_BYTES = 1024 * 1024;

type Level = 'INFO' | 'WARN' | 'ERROR';
type Fields = Record<string, string | number | boolean | null | undefined>;

/** Local time with its offset, as the user reads it: "2026-11-24 13:20:01.123 -05:00". */
function stamp(date = new Date()): string {
  const pad = (n: number, size = 2) => String(Math.abs(n)).padStart(size, '0');
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ` +
    `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** `key=value`, quoted when the value has spaces or quotes; one line, at most 500 characters per value. */
function format(fields: Fields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => {
      const text = String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
      return `${key}=${/[\s"=]/.test(text) || text === '' ? JSON.stringify(text) : text}`;
    })
    .join(' ');
}

/**
 * The app's own log (`logs/app.log` in the data folder): what it launched, queued, skipped or paused,
 * and the errors it hit, so a problem can be traced after the fact. Secrets never reach it: the Jira
 * token is replaced wherever it appears, and so are report keys and authorization headers.
 * Writing the log never fails the action being logged.
 */
export class AppLog {
  private secrets = new Set<string>();

  constructor(readonly file: string, private readonly echo = false) {}

  /** A value (the Jira token) that must never be written, whatever message it ends up in. */
  hide(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret);
  }

  info(event: string, fields: Fields = {}): void {
    this.write('INFO', event, fields);
  }

  warn(event: string, fields: Fields = {}): void {
    this.write('WARN', event, fields);
  }

  /** An unexpected failure, with its stack (indented under the line). */
  error(event: string, err: unknown, fields: Fields = {}): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n  ${err.stack.split('\n').slice(1, 8).map((l) => l.trim()).join('\n  ')}` : '';
    this.write('ERROR', event, { ...fields, error: message }, stack);
  }

  /** The last lines, newest last (for "Copy recent log"). */
  tail(lines = 300): string[] {
    const read = (file: string): string => {
      if (!existsSync(file)) return '';
      const fd = openSync(file, 'r');
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, 256 * 1024);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    };
    const current = read(this.file);
    let text = current;
    // Just after a rotation the current file is short: the end of the previous one comes first.
    if (current.split('\n').length <= lines) text = read(`${this.file}.1`) + current;
    const all = text.split('\n').filter((l) => l !== '');
    // A cut at the start of the buffer may leave half a line: it is dropped.
    if (text.length >= 256 * 1024) all.shift();
    return all.slice(-lines);
  }

  private redact(text: string): string {
    let out = text
      .replace(/(\/result\/)[0-9a-f]{16,}/gi, '$1<key>')
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/g, '$1 <hidden>');
    for (const secret of this.secrets) out = out.split(secret).join('<hidden>');
    return out;
  }

  private write(level: Level, event: string, fields: Fields, extra = ''): void {
    const line = this.redact(`${stamp()} ${level.padEnd(5)} ${event}${Object.keys(fields).length ? ` ${format(fields)}` : ''}${extra}`);
    if (this.echo) (level === 'INFO' ? console.log : console.error)(line);
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // A full disk or a read-only folder must not stop the app.
    }
  }
}

const logs = new Map<string, AppLog>();

/** One log per data folder, shared by the server and the desktop app's main process. */
export function appLog(dataDir: string, echo = false): AppLog {
  const file = path.join(dataDir, 'logs', 'app.log');
  let log = logs.get(file);
  if (!log) logs.set(file, (log = new AppLog(file, echo)));
  return log;
}
