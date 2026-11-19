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
  [/^Esa ejecución no existe o se descartó$/, () => 'That run does not exist or was dismissed'],
  [/^Esa ejecución ya tiene resultado$/, () => 'That run already has a result'],
  [/^Esa ejecución ya no existe$/, () => 'That run no longer exists'],
  [/^No se encontró Claude Code \(claude\) en esta Mac$/, () => 'Claude Code (claude) was not found on this Mac'],
  [/^No se pudo iniciar Claude Code: (.*)$/s, (why) => `Could not start Claude Code: ${why}`],
  [/^Configura Jira \(sitio, email y API token\) en Tipos y ajustes para publicar comentarios$/, () => 'Set up Jira (site, email and API token) in Types & settings to post comments'],
  [/^Jira no encontró el ticket (.+) \(o no tienes acceso\)$/, (key) => `Jira did not find ticket ${key} (or you have no access)`],
  [/^Esta ejecución no tiene comentario para Jira$/, () => 'This run has no Jira comment'],
  [/^Ese comentario ya está publicado en Jira$/, () => 'That comment is already posted on Jira'],
  [/^Ese comentario está descartado; recupéralo para publicarlo$/, () => 'That comment is dismissed; restore it to post it'],
  [/^No se pudo traducir el reporte: (.*)$/s, (why) => `Could not translate the report: ${why}`],
  [/^La clave del ticket de Jira no es válida \(p\. ej\. AVM-123\)$/, () => 'The Jira ticket key is not valid (e.g. AVM-123)'],
  [/^El prompt no puede contener comillas simples$/, () => 'The prompt cannot contain single quotes'],
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
  [/^Hay tipos de test repetidos$/, () => 'There are repeated test types'],
  [/^El id del sitio solo admite minúsculas, números y guiones \(p\. ej\. stg\)$/, () => 'The site id only allows lowercase letters, numbers and hyphens (e.g. stg)'],
  [/^El sitio necesita un nombre$/, () => 'The site needs a name'],
  [/^El nombre del sitio solo admite letras, números, espacios, puntos y guiones$/, () => 'The site name only allows letters, numbers, spaces, dots and hyphens'],
  [/^La URL del sitio tiene que ser http\(s\):\/\/dominio$/, () => 'The site URL must be http(s)://domain'],
  [/^El sitio necesita un ambiente$/, () => 'The site needs an environment'],
  [/^Un skill empieza con \/ y solo admite letras, números, «:», «\.», «_» y «-»$/, () => 'A skill starts with / and only allows letters, numbers, “:”, “.”, “_” and “-”'],
  [/^Tiene que haber al menos un sitio$/, () => 'There must be at least one site'],
  [/^Dominio de test runs inválido \(p\. ej\. testomat\.io\)$/, () => 'Invalid test run domain (e.g. testomat.io)'],
  [/^Hay sitios con el mismo id$/, () => 'Several sites have the same id'],
  [/^Dos sitios no pueden usar el mismo estado de Jira$/, () => 'Two sites cannot use the same Jira status'],
  [/^El sitio de la regresión tiene que ser uno de los sitios$/, () => 'The regression site must be one of the sites'],
  [/^Ese sitio no existe: elige (.+)$/, (names) => `That site does not exist: choose ${names.replace(/ o /g, ' or ')}`],
  [/^Test run inválido: pega el link \((.+)\) o su ID \(p\. ej\. #b333fb92\)$/, (hosts) => `Invalid test run: paste its link (${hosts}) or its ID (e.g. #b333fb92)`],
  [/^(.+) está en "(.*)"; el orquestador es para tickets en (.+)$/, (key, status, ready) => `${key} is in "${status}"; the orchestrator is for tickets in ${ready.replace(/ o /g, ' or ')}`],
  [/^El respaldo tiene registros de tipos de test que no existen$/, () => 'The backup has runs of test types that do not exist'],
  [/^Ya hay una ejecución en curso de (.+)$/, (what) => `There is already a run in progress for ${what}`],
  [/^El asistente no pudo responder: (.*)$/s, (why) => `The assistant could not answer: ${why === 'respuesta vacía' ? 'empty answer' : why}`],
  [/^El último mensaje tiene que ser del usuario$/, () => 'The last message must be from the user'],
  [/^Ese tipo de test no existe$/, () => 'That test type does not exist'],
  [/^El tipo «(.+)» tiene registros y no se puede quitar$/, (name) => `The type “${name}” has runs and cannot be removed`],
  [/^Veredicto (.+) no válido para esta ejecución: usa (.+)$/, (v, valid) => `Verdict ${v} is not valid for this run: use ${valid}`],
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
