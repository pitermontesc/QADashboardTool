/**
 * Markdown (como lo redactan los skills de QA) a wiki markup de Jira, el formato que
 * acepta la API REST v2 de comentarios: títulos, tablas, listas, negrita, código y links.
 */

/** Negrita, código y links dentro de una línea. */
function inline(text: string): string {
  const codes: string[] = [];
  // El código se aparta primero para no convertir lo que tenga dentro.
  let out = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '[$1|$2]')
    // Cursiva de Markdown (*texto*) a la de Jira (_texto_); cualquier otro asterisco suelto se escapa,
    // porque en Jira *texto* es negrita (2*3*4 tiene que seguir leyéndose igual).
    .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g, '_$1_')
    .replace(/(?<!\*)\*(?!\*)/g, '\\*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/~~(.+?)~~/g, '-$1-');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `{{${codes[Number(i)]}}}`);
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => inline(cell.trim()) || ' ');

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function markdownToJira(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      out.push(fence[1] ? `{code:${fence[1]}}` : '{code}', ...body, '{code}');
      continue;
    }

    if (isTableRow(line)) {
      // La fila seguida del separador |---| es la cabecera.
      const header = i + 1 < lines.length && isSeparator(lines[i + 1]!);
      out.push(header ? `||${cells(line).join('||')}||` : `|${cells(line).join('|')}|`);
      if (header) i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`h${heading[1]!.length}. ${inline(heading[2]!)}`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${'*'.repeat(Math.floor(bullet[1]!.length / 2) + 1)} ${inline(bullet[2]!)}`);
      continue;
    }

    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${'#'.repeat(Math.floor(numbered[1]!.length / 2) + 1)} ${inline(numbered[2]!)}`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('----');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    out.push(quote ? `bq. ${inline(quote[1]!)}` : inline(line));
  }
  return out.join('\n');
}
