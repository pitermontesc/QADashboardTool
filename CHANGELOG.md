# Changelog

Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

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

[1.2.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pitermontesc/QADashboardTool/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/pitermontesc/QADashboardTool/releases/tag/v1.0.0
