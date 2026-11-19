import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastMessage, readActivity } from '../src/server/claudeRunner';

const line = (event: unknown): string => JSON.stringify(event);

describe('Background Claude Code log', () => {
  it('summarizes what Claude is doing from the stream-json', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qa-run-')), 'run.jsonl');
    writeFileSync(file, [
      line({ type: 'system', subtype: 'init' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opening STG for the smoke.' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://staging.alpinevm.com' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'lots of text' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -X POST …', description: 'Report the result' } }] } }),
      line({ type: 'result', result: 'Smoke GO: 8 of 8 areas OK.' }),
      'zsh: something not JSON',
    ].join('\n'));

    expect(readActivity(file)).toEqual([
      { kind: 'start', text: '' },
      { kind: 'text', text: 'Opening STG for the smoke.' },
      { kind: 'tool', text: 'Chrome · navigate: https://staging.alpinevm.com' },
      { kind: 'tool', text: 'Bash: Report the result' },
      { kind: 'result', text: 'Smoke GO: 8 of 8 areas OK.' },
      { kind: 'error', text: 'zsh: something not JSON' },
    ]);
    expect(lastMessage(file)).toBe('zsh: something not JSON');
    expect(readActivity(path.join(path.dirname(file), 'missing.jsonl'))).toEqual([]);
  });
});
