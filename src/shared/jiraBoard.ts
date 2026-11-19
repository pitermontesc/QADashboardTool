export interface JiraBoardRef {
  /** Site origin, e.g. https://your-site.atlassian.net */
  site: string;
  boardId: number;
  /** Quick filter carried by the board link (`filter` parameter), in JQL; empty if none. */
  filter: string;
}

/**
 * Parses a Jira Software board link as copied from the browser:
 * https://site.atlassian.net/jira/software/projects/AVM/boards/1?filter=assignee+IN+(...)
 * Returns null if the text is not a board link.
 */
export function parseJiraBoardUrl(text: string): JiraBoardRef | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const match = /\/boards\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  return {
    site: url.origin,
    boardId: Number(match[1]),
    filter: (url.searchParams.get('filter') ?? url.searchParams.get('jql') ?? '').trim(),
  };
}
