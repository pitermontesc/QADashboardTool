/**
 * Prints a version's CHANGELOG section: the notes of its GitHub release.
 *   npx tsx scripts/release-notes.ts 1.21.0 > release-notes.md
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The body of `## [version]` in a Keep a Changelog file, without its heading; null if it is not there. */
export function releaseNotes(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  const notes = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version || '(no version given)'}`);
    process.exit(1);
  }
  console.log(notes);
}
