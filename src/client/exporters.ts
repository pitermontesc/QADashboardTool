import { resultLabel } from '../shared/defaults';
import { toYmd } from '../shared/dates';
import { sortRuns } from '../shared/stats';
import type { AppState, Backup } from '../shared/types';

function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function exportBackup({ settings, runs, automations }: AppState): void {
  const backup: Backup = { ...settings, runs, automations };
  download(`qa-tests-${settings.language === 'en' ? 'backup' : 'respaldo'}-${toYmd(new Date())}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

/**
 * A quoted CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab or CR first,
 * for example a title copied from Jira) gets a leading apostrophe, so it is shown as text.
 */
export const csvCell = (value: string | number | null): string => {
  const text = String(value ?? '');
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function exportCsv({ settings, runs }: AppState): void {
  const typeName = new Map(settings.types.map((t) => [t.id, t.name]));
  const rows: Array<Array<string | number | null>> = [
    settings.language === 'en'
      ? ['Date', 'Type', 'Title', 'Ticket', 'Environment', 'Result', 'Passed', 'Failed', 'Blocked', 'Bugs', 'Minutes', 'Notes']
      : ['Fecha', 'Tipo', 'Titulo', 'Ticket', 'Ambiente', 'Resultado', 'Passed', 'Failed', 'Blocked', 'Bugs', 'Minutos', 'Notas'],
    ...sortRuns(runs).map((r) => [
      r.date, typeName.get(r.typeId) ?? '', r.title, r.ticket, r.env, resultLabel(r.result, settings.language),
      r.passed, r.failed, r.blocked, r.bugs, r.minutes, r.notes,
    ]),
  ];
  // BOM so Excel opens the file as UTF-8.
  download(`qa-tests-${toYmd(new Date())}.csv`, `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`, 'text/csv');
}
