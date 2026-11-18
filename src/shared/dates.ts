/** Utilidades de fecha sobre días locales en formato YYYY-MM-DD (sin zonas horarias). */

const pad = (n: number): string => String(n).padStart(2, '0');

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function startOfDay(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** 2026-11-17 → 17/11/2026 */
export function formatDmy(s: string): string {
  const d = parseYmd(s);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function shortLabel(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function relativeDay(s: string, today: Date): string {
  const days = Math.round((startOfDay(today).getTime() - parseYmd(s).getTime()) / 86_400_000);
  if (days <= 0) return 'hoy';
  return days === 1 ? 'ayer' : `hace ${days} días`;
}

/** Marca de tiempo → "hace un momento", "hace 5 min", "hace 2 h", "ayer a las 9:54"… */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const d = new Date(timestamp);
  const time = `${d.getHours()}:${pad(d.getMinutes())}`;
  return hours < 48 ? `ayer a las ${time}` : `${formatDmy(toYmd(d))} ${time}`;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "martes 18 de noviembre" */
export function longDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

export function greeting(d: Date): string {
  const h = d.getHours();
  return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}
