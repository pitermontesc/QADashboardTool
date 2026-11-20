import type { Lang } from '../shared/types.js';

/** Turns the " or " joiner of a list built with `orList` into the Spanish " o ". */
const orToSpanish = (list: string): string => {
  const at = list.lastIndexOf(' or ');
  return at === -1 ? list : `${list.slice(0, at)} o ${list.slice(at + 4)}`;
};

/**
 * Error messages are written in English in the code and translated when replying
 * if the app is in Spanish. A message without a translation is returned as is.
 */
const ES: ReadonlyArray<[RegExp, (...groups: string[]) => string]> = [
  [/^Invalid data( \((.+?)\))?: (.*)$/s, (_, field, message) => `Datos inválidos${field ? ` (${field})` : ''}: ${toSpanish(message ?? '')}`],
  [/^Local access only$/, () => 'Solo acceso local'],
  [/^Invalid JSON$/, () => 'JSON inválido'],
  [/^Internal app error$/, () => 'Error interno de la app'],
  [/^Not found$/, () => 'No encontrado'],
  [/^That test run no longer exists$/, () => 'El registro ya no existe'],
  [/^Invalid ticket: (.*)$/s, (key) => `Ticket inválido: ${key}`],
  [/^(.+) is not among the loaded Jira tickets$/, (key) => `${key} no está entre los tickets cargados de Jira`],
  [/^That run does not exist or was dismissed$/, () => 'Esa ejecución no existe o se descartó'],
  [/^That run already has a result$/, () => 'Esa ejecución ya tiene resultado'],
  [/^That run no longer exists$/, () => 'Esa ejecución ya no existe'],
  [/^That run is still in progress$/, () => 'Esa ejecución todavía está en curso'],
  [/^Each bug needs a title$/, () => 'Cada bug necesita un título'],
  [/^Claude Code \(claude\) was not found on this Mac$/, () => 'No se encontró Claude Code (claude) en esta Mac'],
  [/^Could not start Claude Code: (.*)$/s, (why) => `No se pudo iniciar Claude Code: ${why}`],
  [/^Set up Jira \(site, email and API token\) in Types & settings to post comments$/, () => 'Configura Jira (sitio, email y API token) en Tipos y ajustes para publicar comentarios'],
  [/^Jira did not find ticket (.+) \(or you have no access\)$/, (key) => `Jira no encontró el ticket ${key} (o no tienes acceso)`],
  [/^This run has no Jira comment$/, () => 'Esta ejecución no tiene comentario para Jira'],
  [/^That comment is already posted on Jira$/, () => 'Ese comentario ya está publicado en Jira'],
  [/^That comment is dismissed; restore it to post it$/, () => 'Ese comentario está descartado; recupéralo para publicarlo'],
  [/^Could not translate the report: (.*)$/s, (why) => `No se pudo traducir el reporte: ${why}`],
  [/^The Jira ticket key is not valid \(e\.g\. AVM-123\)$/, () => 'La clave del ticket de Jira no es válida (p. ej. AVM-123)'],
  [/^The prompt cannot contain single quotes$/, () => 'El prompt no puede contener comillas simples'],
  [/^Open a terminal and run: (.*)$/s, (command) => `Abre una terminal y ejecuta: ${command}`],
  [/^Could not open Terminal: (.*)$/s, (detail) => `No se pudo abrir Terminal: ${detail}`],
  [/^Set up the Jira site \(https:\/\/your-site\.atlassian\.net\)$/, () => 'Configura el sitio de Jira (https://tu-sitio.atlassian.net)'],
  [/^The Jira email or API token is missing$/, () => 'Falta el email o el API token de Jira'],
  [/^Could not connect to Jira \(check the site and your connection\)$/, () => 'No se pudo conectar con Jira (revisa el sitio y tu conexión)'],
  [/^Jira rejected the credentials \(check the email and API token\)$/, () => 'Jira rechazó las credenciales (revisa email y API token)'],
  [/^Jira could not find the board \(check the link and that you have access\)$/, () => 'Jira no encontró el board (revisa el link y que tengas acceso)'],
  [/^Jira responded (.*)$/s, (rest) => `Jira respondió ${rest}`],
  [/^Must start with http:\/\/ or https:\/\/$/, () => 'Debe empezar con http:// o https://'],
  [/^Invalid date$/, () => 'Fecha inválida'],
  [/^Title is required$/, () => 'El título es obligatorio'],
  [/^Invalid color$/, () => 'Color inválido'],
  [/^At least one test type must remain$/, () => 'Debe quedar al menos un tipo de test'],
  [/^There are repeated test types$/, () => 'Hay tipos de test repetidos'],
  [/^The site id only allows lowercase letters, numbers and hyphens \(e\.g\. stg\)$/, () => 'El id del sitio solo admite minúsculas, números y guiones (p. ej. stg)'],
  [/^The site needs a name$/, () => 'El sitio necesita un nombre'],
  [/^The site name only allows letters, numbers, spaces, dots and hyphens$/, () => 'El nombre del sitio solo admite letras, números, espacios, puntos y guiones'],
  [/^The site URL must be http\(s\):\/\/domain$/, () => 'La URL del sitio tiene que ser http(s)://dominio'],
  [/^The site needs an environment$/, () => 'El sitio necesita un ambiente'],
  [/^A skill starts with \/ and only allows letters, numbers, “:”, “\.”, “_” and “-”$/, () => 'Un skill empieza con / y solo admite letras, números, «:», «.», «_» y «-»'],
  [/^There must be at least one site$/, () => 'Tiene que haber al menos un sitio'],
  [/^Invalid test run domain \(e\.g\. testomat\.io\)$/, () => 'Dominio de test runs inválido (p. ej. testomat.io)'],
  [/^Several sites have the same id$/, () => 'Hay sitios con el mismo id'],
  [/^Two sites cannot use the same Jira status$/, () => 'Dos sitios no pueden usar el mismo estado de Jira'],
  [/^The regression site must be one of the sites$/, () => 'El sitio de la regresión tiene que ser uno de los sitios'],
  [/^That site does not exist: choose (.+)$/, (names) => `Ese sitio no existe: elige ${orToSpanish(names)}`],
  [
    /^Invalid test run: paste its link \((.+)\) or its ID \(e\.g\. #b333fb92\)$/,
    (hosts) => `Test run inválido: pega el link (${hosts === 'no domains configured' ? 'sin dominios configurados' : hosts}) o su ID (p. ej. #b333fb92)`,
  ],
  [/^(.+) is in "(.*)"; the orchestrator is for tickets in (.+)$/, (key, status, ready) => `${key} está en "${status}"; el orquestador es para tickets en ${orToSpanish(ready)}`],
  [/^The backup has runs of test types that do not exist$/, () => 'El respaldo tiene registros de tipos de test que no existen'],
  [/^There is already a run in progress for (.+)$/, (what) => `Ya hay una ejecución en curso de ${what}`],
  [/^The assistant could not answer: (.*)$/s, (why) => `El asistente no pudo responder: ${why === 'empty answer' ? 'respuesta vacía' : why}`],
  [/^The last message must be from the user$/, () => 'El último mensaje tiene que ser del usuario'],
  [/^That test type does not exist$/, () => 'Ese tipo de test no existe'],
  [/^The type “(.+)” has runs and cannot be removed$/, (name) => `El tipo «${name}» tiene registros y no se puede quitar`],
  [/^Verdict (.+) is not valid for this run: use (.+)$/, (v, valid) => `Veredicto ${v} no válido para esta ejecución: usa ${valid}`],
  [/^Not a Jira board link \(…\/boards\/<number>\)$/, () => 'No es un link de board de Jira (…/boards/<número>)'],
  [/^The verdict must be one of: (.*)$/, (list) => `El veredicto debe ser uno de: ${list}`],
  [/^The status must be one of: (.*)$/, (list) => `El status debe ser uno de: ${list}`],
];

function toSpanish(message: string): string {
  for (const [pattern, spanish] of ES) {
    const match = pattern.exec(message);
    if (match) return spanish(...match.slice(1).map((g) => g ?? ''));
  }
  return message;
}

export function translateError(message: string, lang: Lang): string {
  return lang === 'es' ? toSpanish(message) : message;
}
