# Changelog

Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [1.8.1] - 2026-11-18

### Cambiado
- La cabecera muestra el logo de RAVN junto a «QA Dashboard», en claro y en oscuro.

## [1.8.0] - 2026-11-18

### Agregado
- Toda ejecución lanzada con Claude (orquestador QA, smoke y regresión) se registra en **Registros** desde que se lanza, como «En progreso», y ese registro se completa con el veredicto, los casos y el resumen cuando Claude lo reporta.
- El orquestador QA también reporta su resultado (PASSED, PASSED W/F, FAILED, BLOCKED) y se registra como test Funcional del ticket.
- Smoke y regresión pueden reportar **BLOCKED** cuando no se pudo probar (por ejemplo, sin navegador); antes solo había GO o NO-GO y una ejecución sin probar quedaba como NO-GO.

### Cambiado
- La sección del dashboard pasa a llamarse **Ejecuciones con Claude** e incluye el orquestador. Descartar una ejecución sin terminar quita también su registro «En progreso».

## [1.7.0] - 2026-11-18

### Agregado
- Los resultados de smoke y regresión llegan solos al dashboard: Claude reporta el veredicto (GO / NO-GO), los casos, los bugs y un resumen a la API local al terminar, y la app crea el registro. Nueva sección **Smoke y regresión con Claude** con las ejecuciones en curso y terminadas, y aviso cuando llega un resultado.

### Cambiado
- El icono de la app es ahora el logo de RAVN.

## [1.6.1] - 2026-11-18

### Corregido
- **Smoke en STG** apuntaba a stg.alpinevm.com; ahora usa el dominio correcto, staging.alpinevm.com.

## [1.6.0] - 2026-11-18

### Agregado
- Botones **Smoke en QA** y **Smoke en STG** en la tarjeta de la suite Smoke: abren Terminal con Claude Code ejecutando `/avm-qa-skills:avm-smoke-tester` sobre qa.alpinevm.com o stg.alpinevm.com.
- Los tickets de Jira se actualizan solos cada 5 minutos y al volver a la ventana, y la app avisa (también con notificación del sistema) cuando entra un ticket nuevo en On QA u On Staging.

## [1.5.0] - 2026-11-18

### Agregado
- Botón **Ejecutar regresión** en la tarjeta de la suite Regression: pide el test run de testomat.io (link o ID, opcional) y abre Terminal con Claude Code ejecutando `/avm-qa-skills:avm-regression-runner`.

## [1.4.0] - 2026-11-18

### Agregado
- Botón **Ejecutar orquestador QA** en los tickets On QA y On Staging: abre Terminal con Claude Code ejecutando `/avm-qa-orchestrator` sobre ese ticket, en modo interactivo para aprobar cada cambio en Jira.

## [1.3.0] - 2026-11-18

### Cambiado
- Rediseño de la experiencia de escritorio: barra de título integrada en macOS, icono propio, menú con atajos de teclado (⌘N, ⌘1-3, ⌘F, ⌘R) y la ventana recuerda tamaño y posición.
- El dashboard abre con un saludo y el resumen del día, y pone primero los tickets por probar: tarjetas con estado en color, contador de registros, acceso directo a Jira y buscador.
- Formulario de registro: resultado con botones de color que se ajusta solo según los casos (failed → Failed, blocked → Blocked), contexto del ticket, ⌘↵ para guardar.
- Avisos con tipo (éxito o error, los errores duran más), fechas relativas («actualizado hace 5 min»), fechas en formato dd/mm/aaaa, primeros pasos cuando no hay registros y modo oscuro revisado.

## [1.2.0] - 2026-11-18

### Agregado
- Estado de la conexión con Jira en la tarjeta de tickets (No conectado, Sin probar, Conectando, Conectado, Error de conexión) y aviso cuando la conexión se establece; en la app de escritorio, también como notificación del sistema.
- Tickets desde un board de Jira: se pega el link del board (con su filtro de personas) en *Tipos y ajustes → Conexión con Jira* y la app carga sus tickets abiertos con la API Agile. El JQL pasa a ser un filtro adicional.

## [1.1.0] - 2026-11-17

### Agregado
- App de escritorio con Electron: `npm run desktop` la abre en una ventana propia y `npm run desktop:pack` genera `QA Dashboard.app`.
- Si ya hay un servidor de la app abierto en el puerto, la app de escritorio lo reutiliza.

### Cambiado
- Los datos se guardan en la carpeta de datos de usuario del sistema (macOS: `~/Library/Application Support/QA Dashboard`) en lugar de `./data`, para que navegador y escritorio compartan el mismo archivo. `QA_DASH_DATA` sigue permitiendo otra ruta.

## [1.0.0] - 2026-11-17

### Agregado
- Versión inicial: registro de tests de QA (diarios, Smoke, Regression), dashboard de métricas y tickets de Jira.

[1.3.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.0.0
