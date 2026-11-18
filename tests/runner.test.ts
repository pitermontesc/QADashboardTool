import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastMessage, readActivity } from '../src/server/claudeRunner';

const line = (event: unknown): string => JSON.stringify(event);

describe('Log de Claude Code en segundo plano', () => {
  it('resume lo que va haciendo Claude a partir del stream-json', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-run-')), 'run.jsonl');
    writeFileSync(file, [
      line({ type: 'system', subtype: 'init' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Abro STG para el smoke.' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://staging.alpinevm.com' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'mucho texto' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -X POST …', description: 'Reporta el resultado' } }] } }),
      line({ type: 'result', result: 'Smoke GO: 8 de 8 áreas OK.' }),
      'zsh: algo no JSON',
    ].join('\n'));

    expect(readActivity(file)).toEqual([
      { kind: 'start', text: '' },
      { kind: 'text', text: 'Abro STG para el smoke.' },
      { kind: 'tool', text: 'Chrome · navigate: https://staging.alpinevm.com' },
      { kind: 'tool', text: 'Bash: Reporta el resultado' },
      { kind: 'result', text: 'Smoke GO: 8 de 8 áreas OK.' },
      { kind: 'error', text: 'zsh: algo no JSON' },
    ]);
    expect(lastMessage(file)).toBe('zsh: algo no JSON');
    expect(readActivity(path.join(path.dirname(file), 'no-existe.jsonl'))).toEqual([]);
  });
});
