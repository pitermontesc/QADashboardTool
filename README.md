# QA Dashboard Tool

Aplicación local para registrar los tests del día a día (funcional, exploratorio, re-test…) y las suites grandes (Smoke, Regression), con dashboard de métricas y tickets de Jira cargados como botones.

Escrita en TypeScript de punta a punta: interfaz en React, servidor en Node (Express) y un modelo de dominio compartido entre ambos.

> 📘 **¿Vas a usar la app?** Lee la [guía de uso paso a paso](docs/GUIA-DE-USO.md), con capturas de cada pantalla.

## Requisitos

Node.js 20 o superior.

## Uso

```bash
npm install     # solo la primera vez
npm start       # compila y abre la app en http://127.0.0.1:8765
```

En macOS también sirve el doble clic en `Iniciar QA Dashboard.command` (la primera vez: clic derecho → Abrir).

La app se abre en su propia ventana. Deja la terminal abierta mientras la uses; `Ctrl+C` la cierra.

### App de escritorio

```bash
npm run desktop        # compila y abre la app en una ventana de Electron (sin terminal ni navegador)
npm run desktop:pack   # genera release/mac-*/QA Dashboard.app
```

Atajos (también en el menú de la app):

| Atajo | Acción |
| --- | --- |
| `⌘N` o `N` | Nuevo registro |
| `⌘1` `⌘2` `⌘3` | Dashboard, Registros, Tipos y ajustes |
| `⌘F` o `/` | Buscar registros |
| `⌘R` | Actualizar tickets de Jira |
| `⌘↵` / `Esc` | Guardar / cancelar el formulario |

La ventana recuerda su tamaño y posición. Arrastra `QA Dashboard.app` a `/Applications` y ábrela como cualquier otra app. No está firmada: la primera vez, clic derecho → Abrir. Los enlaces a Jira se abren en el navegador. Si `npm start` ya está corriendo, la app de escritorio reutiliza ese servidor.

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `QA_DASH_PORT` | Puerto del servidor | `8765` |
| `QA_DASH_DATA` | Carpeta de datos | macOS: `~/Library/Application Support/QA Dashboard` |

## Tickets de Jira

En **Tipos y ajustes → Conexión con Jira** indica el sitio (`https://tu-sitio.atlassian.net`), tu email y un API token (id.atlassian.com → Seguridad → API tokens). El JQL por defecto trae los tickets que tuviste asignados en los últimos 14 días:

```
assignee WAS currentUser() AND updated >= -14d ORDER BY updated DESC
```

Para traer los tickets de un **board**, pega su link en el campo *Board* tal como lo copias del navegador, incluido el filtro de personas si lo tiene:

```
https://tu-sitio.atlassian.net/jira/software/projects/ABC/boards/1?filter=assignee+IN+(...)
```

La app toma el sitio y el filtro del link, pide los tickets a la API Agile de Jira y omite los que ya están terminados. El campo JQL pasa a ser un filtro adicional opcional. Los tickets se actualizan solos cada 5 minutos y al volver a la ventana, con aviso cuando entra uno nuevo en On QA u On Staging; **Actualizar desde Jira** en el dashboard vuelve a consultar el board al instante.

Los tickets en **On QA** u **On Staging** tienen el botón **Ejecutar orquestador QA**: abre Terminal con Claude Code ejecutando `/avm-qa-orchestrator <TICKET>` (solo macOS; requiere el comando `claude` y el skill instalado).

La tarjeta de la suite **Smoke** tiene los botones **Smoke en QA** y **Smoke en STG**, que abren Terminal con `/avm-qa-skills:avm-smoke-tester` sobre qa.alpinevm.com o staging.alpinevm.com. La de **Regression** tiene el botón **Ejecutar regresión**: pide el test run de testomat.io y abre Terminal con `/avm-qa-skills:avm-regression-runner`. Toda ejecución lanzada con Claude (orquestador, smoke, regresión) aparece en Registros como «En progreso» desde que se lanza; al terminar, Claude reporta el veredicto a `POST /api/automation/:id/result` y la app completa ese registro y lo muestra en la sección **Ejecuciones con Claude**.

Cada ticket aparece como botón en el dashboard; al pulsarlo se abre un registro nuevo con el ticket y el título ya cargados.

## Datos y seguridad

- Todo se guarda en `qa-tests.json` dentro de la carpeta de datos (ver `QA_DASH_DATA`), fuera del repositorio; el navegador y la app de escritorio comparten el mismo archivo. Ese archivo contiene el API token de Jira y se crea con permisos `0600`.
- El servidor escucha solo en `127.0.0.1` y rechaza peticiones con `Host` u `Origin` externos.
- El token nunca se envía a la interfaz; la API solo informa si hay uno guardado.
- **Tipos y ajustes → Respaldo de datos** exporta JSON o CSV e importa un respaldo JSON.

## Desarrollo

```bash
npm run dev         # servidor con recarga + Vite en http://localhost:5173
npm test            # Vitest: lógica, API e interfaz
npm run typecheck   # TypeScript estricto, cliente y servidor
npm run build       # compila a dist/
```

### Estructura

```
src/
  shared/    Modelo de dominio y lógica pura (tipos, fechas, estadísticas)
  server/    API REST: validación (zod), persistencia, cliente de Jira
  desktop/   Proceso principal de Electron (ventana de escritorio)
  client/    Interfaz React
tests/       Estadísticas, API (servidor real en puerto temporal) e interfaz (jsdom)
```

### Decisiones

- **Persistencia en un archivo JSON** con escritura atómica en lugar de una base de datos: son unos pocos registros por día y así no hay dependencias nativas que compilar. `Store` aísla el acceso por si algún día conviene cambiarlo.
- **Validación en el borde:** toda entrada a la API pasa por esquemas zod; el resto del código trabaja con tipos ya validados.
- **Lógica de métricas pura** en `src/shared/stats.ts`, sin dependencias de React ni de Node, para poder probarla de forma aislada.
- **Jira inyectable:** el servidor recibe la función `fetch`, de modo que los tests simulan Jira sin red.

### API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/state` | Ajustes, registros y estado de Jira |
| POST | `/api/runs` | Crea un registro |
| PUT / DELETE | `/api/runs/:id` | Edita o borra un registro |
| PUT | `/api/settings` | Guarda tipos, ambientes y URL de tickets |
| POST | `/api/import` | Reemplaza los datos con un respaldo |
| PUT | `/api/jira/config` | Guarda la conexión con Jira |
| POST | `/api/jira/refresh` | Recarga los tickets desde Jira |
