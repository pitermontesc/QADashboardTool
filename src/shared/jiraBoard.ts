export interface JiraBoardRef {
  /** Origen del sitio, p. ej. https://tu-sitio.atlassian.net */
  site: string;
  boardId: number;
  /** Filtro rápido que trae el link del board (parámetro `filter`), en JQL; vacío si no tiene. */
  filter: string;
}

/**
 * Interpreta el link de un board de Jira Software tal como se copia del navegador:
 * https://sitio.atlassian.net/jira/software/projects/AVM/boards/1?filter=assignee+IN+(...)
 * Devuelve null si el texto no es un link de board.
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
