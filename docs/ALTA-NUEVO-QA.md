# Checklist: dar de alta a un QA nuevo

Para que otra persona del equipo use QA Dashboard y los skills de QA de AVM con su propia cuenta. Hay dos partes: lo que prepara quien la invita y lo que hace el QA nuevo en su Mac. Al final, una prueba que confirma que todo quedó bien.

## 1. Quien invita

- [ ] **Skills publicados en la organización.** El plugin `avm-qa-skills` 2.0.0 (incluye el orquestador) ya no tiene a nadie fijo: cada QA usa su perfil. Si todavía no está en la biblioteca de la organización en claude.ai, publícalo primero.
- [ ] **App.** Pásale `QA Dashboard.app` (solo Mac con Apple Silicon por ahora) o el acceso al repositorio.
- [ ] **Guía de uso.** Comparte la guía publicada desde su menú **Share** (en español o en inglés).
- [ ] **Datos que va a necesitar:**
  - el link del board de Jira del equipo;
  - quién ejecuta los TCs cuando un ticket pasa QA (el «ejecutor de TCs», hoy Paulo Sanchez), con su accountId de Jira;
  - los usuarios de prueba de QA y STG que puede usar.

## 2. El QA nuevo, en su Mac

### Instalación

- [ ] **App.** Arrastra `QA Dashboard.app` a **Aplicaciones** y ábrela la primera vez con **clic derecho → Abrir** (no está firmada).
- [ ] **Claude Code.** Instálalo, ejecuta `claude` una vez en Terminal e inicia sesión con tu cuenta. Las ejecuciones consumen de **tu** plan.
- [ ] **Chrome y Claude in Chrome.** Instala la extensión, conéctala a tu cuenta de Claude e inicia sesión con **tu usuario** en `qa.alpinevm.com`, `staging.alpinevm.com` y `app.testomat.io`. Sin esto, las ejecuciones terminan en BLOCKED.
- [ ] **Skills.** Elige una de las dos formas de instalarlos:
  - desde la biblioteca de la organización en claude.ai (plugin `avm-qa-skills`);
  - o con `bash install.sh` desde la carpeta del plugin.

  Comprueba con `/skills` en Claude Code que aparecen `avm-qa-orchestrator`, `avm-smoke-tester`, `avm-regression-runner`, `avm-qa-validator` y el resto.
- [ ] **Conector de Atlassian en Claude.** Conéctalo en claude.ai → Connectors. Si la organización exige aprobación para publicar en Jira, Claude no podrá comentar desde una ejecución en segundo plano; la app lo deja listo para publicar con un clic.

### Tu perfil de QA

Los skills asignan los tickets y firman los reportes con el nombre de quien los ejecuta. Lo leen de este archivo:

- [ ] Crea `~/.config/avm-qa/profile.json`:

  ```json
  {
    "tester": { "name": "Tu Nombre", "accountId": "<tu accountId de Jira>" },
    "tcExecutor": { "name": "Paulo Sanchez", "accountId": "712020:7439f202-d2d1-4c3e-ad76-338d4b912816" }
  }
  ```

  - **Tu accountId:** abre tu perfil en Jira (la URL termina en él) o pregúntale a Claude «¿cuál es mi accountId de Jira?».
  - **Sin el archivo:** los skills usan la cuenta con la que tienes sesión en Jira, y los items `[TC]` se quedan contigo (el reporte lo avisa).

### Configurar la app

- [ ] **Jira.** En **Tipos y ajustes → Conexión con Jira**: tu email, **tu propio API token** y el link del board. Si el board tiene filtro de personas, revisa que te incluya.
- [ ] **Sitios y skills.** En **Tipos y ajustes → Sitios y skills**, revisa:
  - Los sitios QA y STG, sus estados de Jira y los dominios de test runs. Por defecto son los de AVM.
  - Los nombres de los skills. Si instalaste el plugin desde la organización, Claude Code los muestra con su prefijo (por ejemplo `/avm-qa-skills:avm-qa-orchestrator`); usa exactamente el nombre que ves en `/skills`.
- [ ] **Idioma y tema** a tu gusto.

## 3. Antes de empezar, conviene saber

- **La app no te pregunta nada.** Las ejecuciones corren solas y en modo `auto`: Claude crea bugs, comenta y mueve tickets **en tu nombre**, con el criterio de cada skill. Revisa sus decisiones en las observaciones de cada reporte.
- **Tus datos son tuyos.** Quedan solo en tu Mac (`~/Library/Application Support/QA Dashboard/`). No hay vista de equipo.
  - Para pasar registros a otra persona, usa **Exportar respaldo**. Importar **reemplaza** los datos de quien importa.
  - Nunca compartas `qa-tests.json`: contiene tu API token de Jira.
- **Para practicar sin riesgo:** **Ayuda → Abrir demo** tiene datos de ejemplo, y ahí Jira y Claude están simulados.
- **Actualizaciones.** La app no se actualiza sola: cuando haya una versión nueva, reemplaza el `.app`.

## 4. Prueba final

- [ ] **Demo:** abre **Ayuda → Abrir demo**, lanza el smoke en QA y abre su reporte.
- [ ] **App real:** pulsa **Actualizar desde Jira** y comprueba que aparecen tus tickets.
- [ ] **Smoke real en QA:** lánzalo desde la tarjeta Smoke y comprueba que:
  - aparece **Running** con la actividad en vivo;
  - termina en GO, NO-GO o BLOCKED;
  - el reporte dice **Tester: tu nombre**.
- [ ] **Orquestador sobre un ticket tuyo en On QA:** comprueba que:
  - el ticket se te asigna a ti, no a otra persona;
  - el comentario de QA va firmado con tu nombre;
  - los items `[TC]` pasan al ejecutor de TCs cuando el ticket pasa QA.
