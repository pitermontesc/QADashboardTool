import { describe, expect, it } from 'vitest';
import { parseJiraBoardUrl } from '../src/shared/jiraBoard';

describe('parseJiraBoardUrl', () => {
  it('reads site, board and filter from a link copied from Jira', () => {
    const url =
      'https://alpinedatasolutions.atlassian.net/jira/software/projects/AVM/boards/1?filter=assignee+IN+%28712020%3A67c12c9b-24a2-498f-a637-2c3e36d18ff4%2C+618b0da4fba4d0006aca9029%2C+empty%29&groupBy=none';
    expect(parseJiraBoardUrl(url)).toEqual({
      site: 'https://alpinedatasolutions.atlassian.net',
      boardId: 1,
      filter: 'assignee IN (712020:67c12c9b-24a2-498f-a637-2c3e36d18ff4, 618b0da4fba4d0006aca9029, empty)',
    });
  });

  it('accepts boards without a filter and rejects other links', () => {
    expect(parseJiraBoardUrl('https://x.atlassian.net/jira/software/c/projects/ABC/boards/12/backlog')).toMatchObject({ boardId: 12, filter: '' });
    expect(parseJiraBoardUrl('https://x.atlassian.net/browse/ABC-1')).toBeNull();
    expect(parseJiraBoardUrl('not a link')).toBeNull();
  });
});
