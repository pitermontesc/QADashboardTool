/** Utilidades de fecha sobre días locales en formato YYYY-MM-DD (sin zonas horarias). */
import type { Lang } from './types.js';

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

/** 2026-11-17 → 17/11/2026 (es) o 11/17/2026 (en). */
export function formatDmy(s: string, lang: Lang = 'es'): string {
  const d = parseYmd(s);
  const [day, month] = [pad(d.getDate()), pad(d.getMonth() + 1)];
  return lang === 'en' ? `${month}/${day}/${d.getFullYear()}` : `${day}/${month}/${d.getFullYear()}`;
}

export function shortLabel(d: Date, lang: Lang = 'es'): string {
  return lang === 'en' ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getDate()}/${d.getMonth() + 1}`;
}

export function relativeDay(s: string, today: Date, lang: Lang = 'es'): string {
  const days = Math.round((startOfDay(today).getTime() - parseYmd(s).getTime()) / 86_400_000);
  if (lang === 'en') {
    if (days <= 0) return 'today';
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  if (days <= 0) return 'hoy';
  return days === 1 ? 'ayer' : `hace ${days} días`;
}

/** Marca de tiempo → "hace un momento", "hace 5 min", "hace 2 h", "ayer a las 9:54"… */
export function relativeTime(timestamp: number, now: number = Date.now(), lang: Lang = 'es'): string {
  const en = lang === 'en';
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return en ? 'just now' : 'hace un momento';
  if (minutes < 60) return en ? `${minutes} min ago` : `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return en ? `${hours} h ago` : `hace ${hours} h`;
  const d = new Date(timestamp);
  const time = `${d.getHours()}:${pad(d.getMinutes())}`;
  if (hours < 48) return en ? `yesterday at ${time}` : `ayer a las ${time}`;
  return `${formatDmy(toYmd(d), lang)} ${time}`;
}

/** Fecha y hora completas: "18/11/2026, 15:26" (es) o "11/18/2026, 3:26 PM" (en). */
export function dateTime(timestamp: number, lang: Lang = 'es'): string {
  return new Date(timestamp).toLocaleString(lang === 'en' ? 'en-US' : 'es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const WEEKDAYS = {
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
const MONTHS = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** "martes 18 de noviembre" / "Tuesday, November 18" */
export function longDate(d: Date, lang: Lang = 'es'): string {
  const [weekday, month] = [WEEKDAYS[lang][d.getDay()], MONTHS[lang][d.getMonth()]];
  return lang === 'en' ? `${weekday}, ${month} ${d.getDate()}` : `${weekday} ${d.getDate()} de ${month}`;
}

export function greeting(d: Date, lang: Lang = 'es'): string {
  const h = d.getHours();
  if (lang === 'en') return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}
