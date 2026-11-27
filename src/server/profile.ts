import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { QaPerson, QaProfile } from '../shared/types.js';

/** The QA profile the AVM skills read to assign tickets and sign reports. */
export const PROFILE_FILE = path.join(os.homedir(), '.config', 'avm-qa', 'profile.json');

const personSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Jira Cloud accountIds look like "712020:7439f202-…" or a 24-character hex id.
  accountId: z.string().trim().regex(/^[A-Za-z0-9:_-]{6,128}$/, 'not a Jira accountId'),
});

/** What the profile card saves: the tester, and the TC executor or none (the [TC] items then stay with the tester). */
export const profileInputSchema = z.object({
  tester: personSchema,
  tcExecutor: personSchema.nullable(),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

const display = (file: string): string => {
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
};

const personOf = (value: unknown): QaPerson | null => {
  const parsed = personSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Reads the profile; a missing or unreadable file is an empty profile, never an error. */
export function readQaProfile(file = PROFILE_FILE): QaProfile {
  const base = { file: display(file), exists: existsSync(file), unreadable: false, tester: null, tcExecutor: null };
  if (!base.exists) return base;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ...base, unreadable: true };
    return { ...base, tester: personOf(data.tester), tcExecutor: personOf(data.tcExecutor) };
  } catch {
    return { ...base, unreadable: true };
  }
}

/**
 * Saves the tester and the TC executor. Other keys the file has (the skills may read more) are kept;
 * an unreadable file is replaced. Written to a temporary file and renamed, so it is never half-written.
 */
export function writeQaProfile(input: ProfileInput, file = PROFILE_FILE): QaProfile {
  let data: Record<string, unknown> = {};
  try {
    const current = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) data = current as Record<string, unknown>;
  } catch {
    // Missing or unreadable: start from an empty profile.
  }
  data.tester = input.tester;
  if (input.tcExecutor) data.tcExecutor = input.tcExecutor;
  else delete data.tcExecutor;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return readQaProfile(file);
}
