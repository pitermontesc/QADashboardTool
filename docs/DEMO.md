# Guion de la demo de QA Dashboard

*English version: [DEMO.en.md](DEMO.en.md).*

Para presentar la herramienta al equipo en unos 10 minutos, con la demo: datos de ejemplo, y Jira y Claude simulados. Nada de lo que hagas en la demo toca tus datos ni publica en Jira.

## Antes de empezar

1. Abre la demo:
   - En la app: **Ayuda → Abrir demo (datos de ejemplo)**. Se abre en otra ventana.
   - Con el código: `npm run demo` (o `npm run demo:en` para presentarla en inglés). Abre `http://127.0.0.1:8790`.
2. Comprueba que la cabecera muestra la marca **DEMO**.
3. La demo empieza siempre igual: cerrarla y volver a abrirla la deja como nueva. Si ensayaste antes, reiníciala.

Datos de la demo: 5 tickets de Jira (4 en On QA u On Staging y 1 en Test), 23 registros del último mes y 4 ejecuciones de QA automatizadas ya terminadas, con su reporte: orquestador AVM-7057 (PASSED W/F, con comentario de Jira pendiente), smoke STG (GO), regresión #b333fb92 (NO-GO, 2 bugs) y smoke QA (BLOCKED).

## Guion

| Min | Qué haces | Qué cuentas |
| --- | --- | --- |
| 0:00 | Muestra el dashboard arriba. | «Es el panel del día de QA: los tickets de Jira que tengo por probar y un resumen de lo que llevo.» |
| 0:45 | Señala **Tickets por probar** y el indicador **Conectado**. | «Los tickets salen del board de Jira y se actualizan solos cada 5 minutos. Avisa cuando entra uno nuevo en On QA.» |
| 1:30 | Pulsa la tarjeta **AVM-7068**. Llena 4 passed, 1 failed, 1 bug y 30 minutos. | «Registrar un test lleva segundos: el título y el ticket ya vienen; el resultado se pone en Failed solo porque hay un caso fallido.» Guarda con `⌘↵`. |
| 2:30 | Baja al **Resumen** y cambia entre 7 y 30 días. | «Ejecuciones, casos, pass rate, bugs y tiempo del período. El pass rate se colorea: verde desde 90 %.» |
| 3:15 | En la tarjeta **Smoke**, pulsa **Smoke en QA**. | «Desde aquí se lanza el smoke con Claude. Corre en segundo plano, en Chrome, sin Terminal ni preguntas.» |
| 3:45 | Señala **Running** en la cabecera y en la tarjeta, y púlsalo. | «Mientras corre, veo qué está haciendo: cada página que abre y lo que va encontrando. Puedo detenerlo.» Deja la ventana abierta unos segundos. |
| 4:30 | Cierra la ventana y sigue; en unos 40 segundos llega el aviso del resultado. | «Al terminar, Claude manda el veredicto y el reporte completo, y queda como registro.» |
| 5:00 | Abre el smoke recién terminado en **Ejecuciones de QA automatizadas**. | «El reporte QA: veredicto, tiempos, cada módulo con sus pasos.» |
| 5:45 | Abre la **regresión #b333fb92** (NO-GO). | «Cuando algo falla, el módulo se abre solo con el paso que falló y la nota, y abajo están los bugs con su link a Jira.» |
| 6:45 | Abre el **orquestador AVM-7057** y baja a **Comentario de QA para AVM-7057**. | «El orquestador valida un ticket de punta a punta y redacta el comentario de QA. Si no pudo publicarlo, lo reviso aquí y lo publico con un clic, o lo descarto si ya publiqué otro.» Pulsa **Publicar en AVM-7057** dos veces (la segunda confirma): en la demo no se publica nada real. |
| 8:00 | Pulsa **EN** en la cabecera. | «La app funciona en inglés o en español; también traduce los reportes de Claude.» Abre la regresión otra vez para mostrarla en inglés y vuelve a **ES**. |
| 8:45 | Ve a **Registros** (`⌘2`) y busca «AVM-7068». | «Todo queda en el historial: se busca, se filtra, se edita o se duplica para un re-test.» |
| 9:30 | Ve a **Tipos y ajustes** (`⌘3`). | «Tipos de test, ambientes, Jira, idioma y respaldo en JSON o CSV. Los datos se quedan en mi Mac.» |

## Preguntas frecuentes

- **¿Claude publica en Jira por su cuenta?** En una ejecución real, Claude decide con el criterio de cada skill y puede crear bugs o comentar. Si la herramienta de Jira pide aprobación, deja el comentario en el reporte para publicarlo con un clic.
- **¿Qué necesito para usarla de verdad?** La app, Claude Code con sesión iniciada, y Chrome con la extensión Claude in Chrome conectada. Para los tickets, un API token de Jira.
- **¿Dónde están mis datos?** En `~/Library/Application Support/QA Dashboard/qa-tests.json`, solo en tu Mac. La guía de uso completa está en [GUIA-DE-USO.md](GUIA-DE-USO.md).
