# QA Dashboard Tool

Aplicación local para registrar los tests del día a día (funcional, exploratorio, re-test…) y las suites grandes (Smoke, Regression), con dashboard de métricas y tickets de Jira cargados como botones.

Escrita en TypeScript de punta a punta: interfaz en React, servidor en Node (Express) y un modelo de dominio compartido entre ambos.

## Requisitos

Node.js 20 o superior.

## Uso

```bash
npm install     # solo la primera vez
npm start       # compila y abre la app en http://127.0.0.1:8765
```

En macOS también sirve el doble clic en `Iniciar QA Dashboard.command` (la primera vez: clic derecho → Abrir).

La app se abre en su propia ventana. Deja la terminal abierta mientras la uses; `Ctrl+C` la cierra.

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `QA_DASH_PORT` | Puerto del servidor | `8765` |
| `QA_DASH_DATA` | Carpeta de datos | `./data` |

## Tickets de Jira

En **Tipos y ajustes → Conexión con Jira** indica el sitio (`https://tu-sitio.atlassian.net`), tu email y un API token (id.atlassian.com → Seguridad → API tokens). El JQL por defecto trae los tickets que tuviste asignados en los últimos 14 días:

```
assignee WAS currentUser() AND updated >= -14d ORDER BY updated DESC
```

Cada ticket aparece como botón en el dashboard; al pulsarlo se abre un registro nuevo con el ticket y el título ya cargados.

## Datos y seguridad

- Todo se guarda en `data/qa-tests.json`, fuera del repositorio (`.gitignore`). Ese archivo contiene el API token de Jira y se crea con permisos `0600`.
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
