import type { Lang } from '../shared/types.js';

/**
 * Los mensajes de error se escriben en español en el código y se traducen al
 * responder si la app está en inglés. Un mensaje sin traducción sale tal cual.
 */
const EN: ReadonlyArray<[RegExp, (...groups: string[]) => string]> = [
  [/^Datos inválidos( \((.+)\))?: (.*)$/s, (_, field, message) => `Invalid data${field ? ` (${field})` : ''}: ${toEnglish(message ?? '')}`],
  [/^Solo acceso local$/, () => 'Local access only'],
  [/^JSON inválido$/, () => 'Invalid JSON'],
  [/^Error interno de la app$/, () => 'Internal app error'],
  [/^No encontrado$/, () => 'Not found'],
  [/^El registro ya no existe$/, () => 'That run no longer exists'],
  [/^Ticket inválido: (.*)$/s, (key) => `Invalid ticket: ${key}`],
  [/^(.+) no está entre los tickets cargados de Jira$/, (key) => `${key} is not among the loaded Jira tickets`],
  [/^(.+) está en "(.*)"; el orquestador es para tickets On QA u On Staging$/, (key, status) => `${key} is in "${status}"; the orchestrator is for On QA or On Staging tickets`],
  [/^Elige el sitio del smoke: QA o STG$/, () => 'Choose the smoke site: QA or STG'],
  [/^Esa ejecución no existe o se descartó$/, () => 'That run does not exist or was dismissed'],
  [/^Esa ejecución ya tiene resultado$/, () => 'That run already has a result'],
  [/^Esa ejecución ya no existe$/, () => 'That run no longer exists'],
  [/^Configura Jira \(sitio, email y API token\) en Tipos y ajustes para publicar comentarios$/, () => 'Set up Jira (site, email and API token) in Types & settings to post comments'],
  [/^Jira no encontró el ticket (.+) \(o no tienes acceso\)$/, (key) => `Jira did not find ticket ${key} (or you have no access)`],
  [/^Esta ejecución no tiene comentario para Jira$/, () => 'This run has no Jira comment'],
  [/^Ese comentario ya está publicado en Jira$/, () => 'That comment is already posted on Jira'],
  [/^Ese comentario está descartado; recupéralo para publicarlo$/, () => 'That comment is dismissed; restore it to post it'],
  [/^No se pudo traducir el reporte: (.*)$/s, (why) => `Could not translate the report: ${why}`],
  [/^La clave del ticket de Jira no es válida \(p\. ej\. AVM-123\)$/, () => 'The Jira ticket key is not valid (e.g. AVM-123)'],
  [/^El prompt no puede contener comillas simples$/, () => 'The prompt cannot contain single quotes'],
  [/^Test run inválido: .*$/s, () => 'Invalid test run: paste the testomat.io link or its ID (e.g. #b333fb92)'],
  [/^Abre una terminal y ejecuta: (.*)$/s, (command) => `Open a terminal and run: ${command}`],
  [/^No se pudo abrir Terminal: (.*)$/s, (detail) => `Could not open Terminal: ${detail}`],
  [/^Configura el sitio de Jira .*$/, () => 'Set up the Jira site (https://your-site.atlassian.net)'],
  [/^Falta el email o el API token de Jira$/, () => 'The Jira email or API token is missing'],
  [/^No se pudo conectar con Jira .*$/, () => 'Could not connect to Jira (check the site and your connection)'],
  [/^Jira rechazó las credenciales .*$/, () => 'Jira rejected the credentials (check the email and API token)'],
  [/^Jira no encontró el board .*$/, () => 'Jira could not find the board (check the link and that you have access)'],
  [/^Jira respondió (.*)$/s, (rest) => `Jira responded ${rest}`],
  [/^Debe empezar con http:\/\/ o https:\/\/$/, () => 'Must start with http:// or https://'],
  [/^Fecha inválida$/, () => 'Invalid date'],
  [/^El título es obligatorio$/, () => 'Title is required'],
  [/^Color inválido$/, () => 'Invalid color'],
  [/^Debe quedar al menos un tipo de test$/, () => 'At least one test type must remain'],
  [/^No es un link de board de Jira .*$/, () => 'Not a Jira board link (…/boards/<number>)'],
  [/^El veredicto debe ser uno de: (.*)$/, (list) => `The verdict must be one of: ${list}`],
  [/^El status debe ser uno de: (.*)$/, (list) => `The status must be one of: ${list}`],
];

function toEnglish(message: string): string {
  for (const [pattern, english] of EN) {
    const match = pattern.exec(message);
    if (match) return english(...match.slice(1).map((g) => g ?? ''));
  }
  return message;
}

export function translateError(message: string, lang: Lang): string {
  return lang === 'en' ? toEnglish(message) : message;
}
