import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings } from '../shared/defaults.js';
import { toYmd } from '../shared/dates.js';
import type {
  Automation, AutomationDetails, AutomationKind, JiraTicket, Lang, ReportModule, ReportTranslation, StepStatus, TestRun, Verdict,
} from '../shared/types.js';
import type { AppOptions } from './app.js';
import { buildTeamFile, writeTeamFile } from './team.js';
import { appVersion } from './updates.js';
import { automationTitle, runText } from './automation.js';
import type { ClaudeLauncher, ReportTranslator } from './claudeRunner.js';
import type { AssistantRunner } from './assistant.js';

/**
 * Demo mode: the app with sample data in a temp folder and everything external
 * simulated (Jira, Claude Code and translation). Nothing leaves the machine: use it
 * to present the tool or try it out without touching real data.
 */

export const DEMO_PORT = 8790;
export const DEMO_SITE = 'https://example.atlassian.net';

/** Demo data folder; emptied every time the demo opens so it always starts the same. */
export const demoDataDir = (port = DEMO_PORT): string => path.join(os.tmpdir(), `qa-dashboard-demo-${port}`);

type Bi = { es: string; en: string };
const bi = (es: string, en: string): Bi => ({ es, en });

/** Every bilingual text in the demo: used to "translate" without calling Claude. */
const dictionary = new Map<string, string>();
const remember = (text: Bi): Bi => {
  dictionary.set(text.es, text.en);
  dictionary.set(text.en, text.es);
  return text;
};

type StepDef = [name: Bi, status: StepStatus, notes?: Bi];
interface ModuleDef { name: Bi; status: StepStatus; minutes: number; notes?: Bi; steps: StepDef[] }
interface BugDef { title: Bi; severity: string; key: string; module: Bi }
interface ReportDef { summary: Bi; build: string; notes: Bi; modules: ModuleDef[]; bugs: BugDef[] }

const ok = (es: string, en: string, notes?: Bi): StepDef => [bi(es, en), 'passed', notes];

const SMOKE_MODULES: ModuleDef[] = [
  { name: bi('Login y Dashboard', 'Login and Dashboard'), status: 'passed', minutes: 1, steps: [
    ok('La página de login carga', 'Login page loads'),
    ok('Iniciar sesión con el usuario QA', 'Sign in with the QA user'),
    ok('El dashboard carga sin errores de consola', 'Dashboard loads with no console errors'),
  ] },
  { name: bi('Navegación (menú lateral)', 'Navigation (sidebar)'), status: 'passed', minutes: 1, steps: [
    ok('El menú lateral abre y cierra', 'Sidebar opens and closes'),
    ok('Las 10 secciones abren con su URL', 'All 10 sections open with their URL'),
  ] },
  { name: bi('Work Orders', 'Work Orders'), status: 'passed', minutes: 1, steps: [
    ok('La lista de WO carga con filas', 'WO list loads with rows'),
    ok('Abrir el detalle de un WO', 'Open a WO detail', bi('W287 abre sin errores', 'W287 opens with no errors')),
    ok('Volver a la lista conserva el filtro', 'Going back keeps the filter'),
  ] },
  { name: bi('Purchase Orders', 'Purchase Orders'), status: 'passed', minutes: 1, steps: [
    ok('La lista de PO carga', 'PO list loads'),
    ok('Abrir el detalle de un PO', 'Open a PO detail'),
  ] },
  { name: bi('Vendors / Customers', 'Vendors / Customers'), status: 'passed', minutes: 1, steps: [
    ok('La lista de Vendors carga', 'Vendors list loads'),
    ok('La lista de Customers carga', 'Customers list loads'),
  ] },
  { name: bi('Reports', 'Reports'), status: 'passed', minutes: 1, steps: [
    ok('Se ven las categorías de reportes', 'Report categories are visible'),
    ok('3 reportes cargan con columnas y datos', '3 reports load with columns and data', bi('Cada uno en menos de 1 s', 'Each one in under 1 s')),
  ] },
  { name: bi('Mass Upload / Mass Update', 'Mass Upload / Mass Update'), status: 'passed', minutes: 1, steps: [
    ok('El paso 1 de ambos wizards abre', 'Step 1 of both wizards opens', bi('No se subió ni actualizó nada', 'Nothing was uploaded or updated')),
  ] },
  { name: bi('Admin', 'Admin'), status: 'passed', minutes: 1, steps: [
    ok('El panel de Admin es accesible', 'Admin panel is reachable'),
    ok('Audit Trail abre en solo lectura', 'Audit Trail opens read-only'),
  ] },
];

const SMOKE_GO: ReportDef = {
  summary: bi(
    'Smoke en STG: GO. Las 8 áreas pasan (17 de 17 pasos), sin errores de consola ni bugs.',
    'Smoke on STG: GO. All 8 areas pass (17 of 17 steps), with no console errors or bugs.',
  ),
  build: 'v1.7.1 (main-4F2A9C1B.js)',
  notes: bi(
    'Modo Full. Solo camino feliz: no se crearon ni modificaron datos. Al terminar se restauró la selección de tiendas.',
    'Full mode. Happy path only: no data was created or changed. The shop selection was restored at the end.',
  ),
  modules: SMOKE_MODULES,
  bugs: [],
};

const REGRESSION_NOGO: ReportDef = {
  summary: bi(
    'Regresión del test run #b333fb92 en STG: NO-GO. 7 de 10 casos pasan; 2 fallan en Work Orders y Reports y 1 queda bloqueado. Se reportaron 2 bugs.',
    'Regression of test run #b333fb92 on STG: NO-GO. 7 of 10 cases pass; 2 fail in Work Orders and Reports and 1 is blocked. 2 bugs were reported.',
  ),
  build: 'v1.7.0 (main-91C3E0AA.js)',
  notes: bi(
    'El caso de Mass Update quedó bloqueado: necesita una plantilla con más de 500 filas que no existe en STG. Epic de regresión creado en Jira con los 2 bugs.',
    'The Mass Update case was blocked: it needs a template with more than 500 rows that does not exist on STG. Regression epic created in Jira with the 2 bugs.',
  ),
  modules: [
    { name: bi('Work Orders', 'Work Orders'), status: 'failed', minutes: 14, steps: [
      ok('Crear un WO con 3 tareas', 'Create a WO with 3 tasks'),
      [bi('Totales con impuesto por shop', 'Totals with shop-level tax'), 'failed',
        bi('El total ignora el impuesto propio del shop (AVM-7090)', 'The total ignores the shop tax override (AVM-7090)')],
      ok('Cerrar el WO y facturar', 'Close the WO and invoice it'),
    ] },
    { name: bi('Purchase Orders', 'Purchase Orders'), status: 'passed', minutes: 9, steps: [
      ok('Crear un PO para un vendor', 'Create a PO for a vendor'),
      ok('Recibir parcialmente el PO', 'Partially receive the PO'),
    ] },
    { name: bi('Inventario', 'Inventory'), status: 'passed', minutes: 7, steps: [
      ok('Ajustar stock de una parte', 'Adjust the stock of a part'),
      ok('Transferir partes entre shops', 'Transfer parts between shops'),
    ] },
    { name: bi('Reports', 'Reports'), status: 'failed', minutes: 8, steps: [
      ok('Work Order Summary con rango de un mes', 'Work Order Summary for one month'),
      [bi('Fleet report con rango de más de un año', 'Fleet report for more than one year'), 'failed',
        bi('Responde 500 (AVM-7091)', 'Returns 500 (AVM-7091)')],
    ] },
    { name: bi('Mass Update', 'Mass Update'), status: 'blocked', minutes: 3, steps: [
      [bi('Actualizar más de 500 assets', 'Update more than 500 assets'), 'blocked',
        bi('No hay plantilla con ese volumen en STG', 'No template with that volume on STG')],
    ] },
  ],
  bugs: [
    { title: bi('El total del WO ignora el impuesto propio del shop', 'Work order total ignores the shop tax override'), severity: 'High', key: 'AVM-7090', module: bi('Work Orders', 'Work Orders') },
    { title: bi('Fleet report responde 500 con rangos de más de un año', 'Fleet report returns 500 for ranges over one year'), severity: 'Medium', key: 'AVM-7091', module: bi('Reports', 'Reports') },
  ],
};

const ORCHESTRATOR_WF: ReportDef = {
  summary: bi(
    'AVM-7057 PASSED W/F: los clientes multi-shop con contabilidad desactivada ya se pueden editar y guardar. Queda sin probar la regresión con contabilidad activada (no hay un shop así en QA).',
    'AVM-7057 PASSED W/F: multi-shop customers with accounting disabled can now be edited and saved. The regression with accounting enabled is untested (there is no such shop on QA).',
  ),
  build: 'v1.7.1 (main-4F2A9C1B.js)',
  notes: bi(
    'Criterios de aceptación revisados: 3 de 3 cubiertos. Sin cambios de datos fuera del cliente de prueba «QA Demo Customer». El comentario de QA quedó listo para Jira.',
    'Acceptance criteria reviewed: 3 of 3 covered. No data changes outside the test customer “QA Demo Customer”. The QA comment is ready for Jira.',
  ),
  modules: [
    { name: bi('Customers: edición multi-shop', 'Customers: multi-shop editing'), status: 'passed', minutes: 12, steps: [
      ok('Abrir un cliente asignado a 2 shops', 'Open a customer assigned to 2 shops'),
      ok('Editar teléfono y dirección y guardar', 'Edit phone and address and save', bi('Se guarda y se ve tras recargar', 'Saved and visible after reload')),
      ok('Quitar un shop del cliente', 'Remove one shop from the customer'),
      ok('Validación: email inválido muestra error', 'Validation: invalid email shows an error'),
    ] },
    { name: bi('Regresión con contabilidad activada', 'Regression with accounting enabled'), status: 'blocked', minutes: 2, steps: [
      [bi('Editar un cliente con contabilidad activada', 'Edit a customer with accounting enabled'), 'blocked',
        bi('Ningún shop de QA tiene contabilidad activada', 'No QA shop has accounting enabled')],
    ] },
  ],
  bugs: [],
};

const JIRA_COMMENT = `**⚠️ QA Verdict: PASSED W/F**

**Environment:** \`qa.alpinevm.com\` | Main Shop | build v1.7.1

### Results
| # | Test | Result | Notes |
|---|---|---|---|
| 1 | Open a customer assigned to 2 shops | ✅ PASS | |
| 2 | Edit phone and address and save | ✅ PASS | Saved and visible after reload |
| 3 | Remove one shop from the customer | ✅ PASS | |
| 4 | Invalid email shows an error | ✅ PASS | |
| 5 | Edit a customer with accounting enabled | ⛔ BLOCKED | No QA shop has accounting enabled |

### Not covered
- ⚠️ Regression with accounting enabled: needs a shop with accounting on QA or STG.`;

for (const def of [SMOKE_GO, REGRESSION_NOGO, ORCHESTRATOR_WF]) {
  remember(def.summary);
  remember(def.notes);
  for (const m of def.modules) {
    remember(m.name);
    if (m.notes) remember(m.notes);
    for (const [name, , notes] of m.steps) {
      remember(name);
      if (notes) remember(notes);
    }
  }
  for (const b of def.bugs) {
    remember(b.title);
    remember(b.module);
  }
}

function details(def: ReportDef, lang: Lang, jiraComment: AutomationDetails['jiraComment'] = null): AutomationDetails {
  return {
    build: def.build,
    notes: def.notes[lang],
    modules: def.modules.map(
      (m): ReportModule => ({
        name: m.name[lang],
        status: m.status,
        minutes: m.minutes,
        notes: m.notes?.[lang] ?? '',
        steps: m.steps.map(([name, status, notes]) => ({ name: name[lang], status, notes: notes?.[lang] ?? '' })),
      }),
    ),
    bugs: def.bugs.map((b) => ({ title: b.title[lang], severity: b.severity, key: b.key, link: `${DEMO_SITE}/browse/${b.key}`, module: b.module[lang] })),
    jiraComment,
  };
}

const counts = (def: ReportDef) => {
  const steps = def.modules.flatMap((m) => m.steps);
  const of = (s: StepStatus) => steps.filter(([, status]) => status === s).length;
  return { passed: of('passed'), failed: of('failed'), blocked: of('blocked'), bugs: def.bugs.length };
};

/** Demo tickets; `created` is how many days before "now" each one was created. */
const DEMO_TICKET_DEFS: Array<Omit<JiraTicket, 'created' | 'epic' | 'blockedBy'> & Partial<Pick<JiraTicket, 'epic' | 'blockedBy'>> & { ageDays: number }> = [
  { key: 'AVM-7057', summary: 'Multi-shop customers with accounting disabled are unable to edit customers', status: 'On QA', type: 'Bug', priority: 'High', ageDays: 9, epic: 'AVM-7000' },
  { key: 'AVM-7061', summary: 'Work order totals ignore shop-level tax overrides', status: 'On QA', type: 'Story', priority: 'Medium', ageDays: 14, epic: 'AVM-7000' },
  { key: 'AVM-7064', summary: 'Vendor import keeps duplicated contacts after mass update', status: 'On Staging', type: 'Story', priority: 'Medium', ageDays: 21 },
  { key: 'AVM-7068', summary: 'Purchase order PDF misses the vendor address', status: 'On QA', type: 'Bug', priority: 'Highest', ageDays: 3 },
  { key: 'AVM-7072', summary: 'PM schedule shows the wrong next due date for hour meters', status: 'Test', type: 'Bug', priority: 'Low', ageDays: 6 },
];
const demoTickets = (now: number): JiraTicket[] =>
  DEMO_TICKET_DEFS.map(({ ageDays, ...t }) => ({ epic: '', blockedBy: [], ...t, created: now - ageDays * 24 * 60 * 60_000 }));

/** Manual runs from the last few weeks: [days ago, type, title, ticket, env, result, passed, failed, blocked, bugs, minutes]. */
const MANUAL_RUNS: Array<[number, string, string, string, string, TestRun['result'], number, number, number, number, number]> = [
  [0, 't2', 'Vendor import keeps duplicated contacts after mass update', 'AVM-7064', 'STG', 'passed', 6, 0, 0, 0, 35],
  [0, 't3', 'Exploratory: purchase orders with partial receipts', '', 'QA', 'passed', 9, 0, 0, 0, 40],
  [1, 't2', 'Purchase order PDF misses the vendor address', 'AVM-7068', 'QA', 'failed', 3, 1, 0, 1, 25],
  [1, 't4', 'Re-test: PM due date for mileage meters', 'AVM-7031', 'QA', 'passed', 4, 0, 0, 0, 15],
  [2, 't8', 'API: work order export endpoint', 'AVM-7044', 'QA', 'passed', 12, 0, 0, 0, 30],
  [3, 't2', 'Customer portal shows invoices of other shops', 'AVM-7039', 'QA', 'passed', 7, 0, 0, 0, 45],
  [3, 't5', 'Sanity after hotfix v1.7.0.1', '', 'PROD', 'passed', 8, 0, 0, 0, 20],
  [4, 't6', 'Integration: QuickBooks invoice sync', 'AVM-7022', 'STG', 'blocked', 2, 0, 3, 0, 30],
  [6, 't2', 'Mass update wizard keeps the template columns', 'AVM-7018', 'QA', 'passed', 5, 0, 0, 0, 30],
  [7, 't3', 'Exploratory: technician time clock', '', 'QA', 'failed', 6, 2, 0, 2, 60],
  [8, 't4', 'Re-test: fleet report filters', 'AVM-7011', 'QA', 'passed', 3, 0, 0, 0, 10],
  [9, 't2', 'Assets list sorts by next PM date', 'AVM-7006', 'QA', 'passed', 6, 0, 0, 0, 25],
  [10, 't12', 'Accessibility: work order form with keyboard only', '', 'QA', 'failed', 10, 3, 0, 2, 50],
  [12, 't2', 'Parts inventory transfer between shops', 'AVM-6994', 'STG', 'passed', 8, 0, 0, 0, 40],
  [13, 't8', 'API: vendors search pagination', 'AVM-6990', 'QA', 'passed', 9, 0, 0, 0, 20],
  [14, 't5', 'Sanity after release v1.7.0', '', 'PROD', 'passed', 10, 0, 0, 0, 25],
  [15, 't2', 'Warranty claims attach photos', 'AVM-6981', 'QA', 'failed', 4, 1, 0, 1, 35],
  [17, 't4', 'Re-test: warranty claims attach photos', 'AVM-6981', 'QA', 'passed', 5, 0, 0, 0, 15],
  [18, 't3', 'Exploratory: estimates to work order', '', 'QA', 'passed', 7, 0, 0, 0, 45],
  [20, 't2', 'Shop selector remembers the last shop', 'AVM-6970', 'QA', 'passed', 4, 0, 0, 0, 20],
  [21, 't6', 'Integration: Samsara odometer readings', 'AVM-6962', 'STG', 'passed', 6, 0, 0, 0, 40],
  [24, 't2', 'Customers export to CSV with custom fields', 'AVM-6955', 'QA', 'passed', 5, 0, 0, 0, 25],
  [26, 't9', 'Performance: work orders list with 10k rows', '', 'STG', 'failed', 2, 1, 0, 1, 60],
];

/** A finished Claude run, with its test run record and its report in both languages. */
function seededAutomation(
  lang: Lang, kind: AutomationKind, target: string, env: string, verdict: Verdict, def: ReportDef | null, startedAt: number, minutes: number,
  extra: {
    subject?: string; link?: string; summary?: Bi; jiraComment?: AutomationDetails['jiraComment']; typeId: string;
    dryRun?: boolean; counts?: { passed: number; failed: number; blocked: number; bugs: number };
  },
): { automation: Automation; run: TestRun } {
  const other: Lang = lang === 'es' ? 'en' : 'es';
  const summary = def?.summary ?? extra.summary ?? bi('', '');
  const automation: Automation = {
    id: randomUUID(), kind, target, env, title: automationTitle(kind, target, lang, extra.subject, extra.dryRun), startedAt,
    finishedAt: startedAt + minutes * 60_000, verdict, summary: summary[lang], link: extra.link ?? '',
    details: def ? details(def, lang, extra.jiraComment ?? null) : null, runId: null, pid: null, logFile: '', lang,
    translations: { [other]: { summary: summary[other], details: def ? details(def, other) : null } satisfies ReportTranslation },
    dryRun: extra.dryRun ?? false,
    fullCoverage: false,
    site: '',
    ticketType: kind === 'orchestrator' ? (DEMO_TICKET_DEFS.find((t) => t.key === target)?.type ?? '') : '',
    queued: null,
  };
  const c = extra.counts ?? (def ? counts(def) : { passed: 0, failed: 0, blocked: 8, bugs: 0 });
  const run: TestRun = {
    id: randomUUID(), createdAt: startedAt, date: toYmd(new Date(startedAt)), typeId: extra.typeId,
    ticket: kind === 'orchestrator' ? target : '', env,
    result: verdict === 'GO' || verdict === 'PASSED' || verdict === 'PASSED W/F' ? 'passed' : verdict === 'BLOCKED' ? 'blocked' : 'failed',
    ...c, minutes,
    ...runText(automation, lang, summary[lang], true),
    testMode: automation.dryRun,
  };
  automation.runId = run.id;
  return { automation, run };
}

/** Writes the demo data (relative to today) into an empty folder. */
export function seedDemoData(dataDir: string, lang: Lang = 'es', now = Date.now()): string {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const day = 24 * 60 * 60_000;
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(now - daysAgo * day);
    d.setHours(hour, 15, 0, 0);
    return Math.min(d.getTime(), now - 30 * 60_000);
  };
  const settings = { ...defaultSettings(lang), ticketBase: `${DEMO_SITE}/browse/` };
  const runs: TestRun[] = MANUAL_RUNS.map(([ago, typeId, title, ticket, env, result, passed, failed, blocked, bugs, minutes], i) => ({
    id: randomUUID(), createdAt: at(ago, 9 + (i % 7)), date: toYmd(new Date(at(ago, 9 + (i % 7)))), typeId, title, ticket, env, result,
    passed, failed, blocked, bugs, minutes, notes: '', testMode: false,
  }));
  const seeded = [
    seededAutomation(lang, 'orchestrator', 'AVM-7057', 'QA', 'PASSED W/F', ORCHESTRATOR_WF, now - 75 * 60_000, 32, {
      subject: DEMO_TICKET_DEFS[0]!.summary, link: `${DEMO_SITE}/browse/AVM-7057`, typeId: 't2',
      jiraComment: { key: 'AVM-7057', body: JIRA_COMMENT, posted: false, url: '', dismissed: false },
    }),
    seededAutomation(lang, 'smoke', 'STG', 'STG', 'GO', SMOKE_GO, at(2, 8), 6, { typeId: 't0' }),
    seededAutomation(lang, 'regression', '#b333fb92', 'STG', 'NO-GO', REGRESSION_NOGO, at(5, 10), 74, {
      link: 'https://app.testomat.io/projects/avm/runs/b333fb92', typeId: 't1',
    }),
    // A rehearsal: listed with its report, but left out of the dashboard's numbers.
    seededAutomation(lang, 'regression', '#c41d2e07', 'STG', 'NO-GO', null, at(3, 14), 41, {
      link: 'https://app.testomat.io/projects/avm/runs/c41d2e07', typeId: 't1', dryRun: true,
      counts: { passed: 38, failed: 2, blocked: 112, bugs: 2 },
      summary: remember(bi(
        'Regresión del test run #c41d2e07 en STG en modo prueba: NO-GO. 38 casos pasan y 2 fallan; los otros 112 no se ejecutaron (la prueba cubrió solo Work Orders). No se creó ni se marcó nada en Jira ni en testomat.io.',
        'Regression of test run #c41d2e07 on STG in test mode: NO-GO. 38 cases pass and 2 fail; the other 112 were not run (the rehearsal only covered Work Orders). Nothing was created or marked in Jira or testomat.io.',
      )),
    }),
    seededAutomation(lang, 'smoke', 'QA', 'QA', 'BLOCKED', null, at(11, 8), 2, {
      typeId: 't0',
      summary: remember(bi(
        'Smoke en QA bloqueado: Claude in Chrome no estaba conectado, así que no se probó ninguna área.',
        'Smoke on QA blocked: Claude in Chrome was not connected, so no area was tested.',
      )),
    }),
  ];
  const data = {
    version: 1,
    settings,
    runs: [...runs, ...seeded.map((s) => s.run)].sort((a, b) => a.createdAt - b.createdAt),
    jira: { site: DEMO_SITE, email: 'qa@example.com', board: '', jql: 'status in ("On QA", "On Staging", "Test")', token: 'demo' },
    jiraCache: { tickets: demoTickets(now), fetchedAt: now, ok: true, error: null },
    automations: seeded.map((s) => s.automation),
  };
  // The team view: the demo user and two teammates in a team folder of its own.
  const teamFolder = path.join(dataDir, 'team');
  mkdirSync(teamFolder, { recursive: true });
  const automations = seeded.map((s) => s.automation);
  const copyRuns = (every: number, shift: number, flip: number) =>
    runs
      .filter((_, i) => i % every === 0)
      .map((r, i) => {
        const createdAt = r.createdAt - shift * day;
        const failedNow = i % flip === flip - 1;
        return {
          ...r, id: randomUUID(), createdAt, date: toYmd(new Date(createdAt)),
          result: failedNow ? ('failed' as const) : r.result, failed: failedNow ? Math.max(1, r.failed ?? 0) : r.failed, bugs: failedNow ? Math.max(1, r.bugs ?? 0) : r.bugs,
        };
      });
  const orchestrator = automations.find((a) => a.kind === 'orchestrator')!;
  const regression = automations.find((a) => a.kind === 'regression' && !a.dryRun)!;
  const [, luis, marta] = DEMO_PEOPLE;
  /** The orchestrator's title for another demo ticket: its key and its own summary. */
  const titleFor = (key: string) => {
    const from = DEMO_TICKET_DEFS[0]!;
    const to = DEMO_TICKET_DEFS.find((d) => d.key === key) ?? from;
    return orchestrator.title.replace(from.key, key).replace(from.summary, to.summary);
  };
  writeTeamFile(teamFolder, buildTeamFile({ id: 'demo-luis-0000-0001', name: luis!.displayName }, appVersion(), settings.types, copyRuns(2, 1, 4), [
    { ...regression, id: randomUUID(), runId: null, startedAt: regression.startedAt - day, finishedAt: (regression.finishedAt ?? now) - day },
    // Running now on Luis's Mac.
    { ...orchestrator, id: randomUUID(), runId: null, target: 'AVM-7068', title: titleFor('AVM-7068'), startedAt: now - 12 * 60_000, finishedAt: null, verdict: null, summary: '', details: null },
  ], now - 5 * 60_000));
  writeTeamFile(teamFolder, buildTeamFile({ id: 'demo-marta-0000-0002', name: marta!.displayName }, appVersion(), settings.types, copyRuns(3, 2, 3), [
    {
      ...orchestrator, id: randomUUID(), runId: null, target: 'AVM-7064', title: titleFor('AVM-7064'), verdict: 'PASSED',
      startedAt: orchestrator.startedAt - 2 * day, finishedAt: (orchestrator.finishedAt ?? now) - 2 * day, translations: {},
      summary: lang === 'en' ? 'AVM-7064 PASSED: the 5 criteria work on STG, with no bugs.' : 'AVM-7064 PASSED: los 5 criterios funcionan en STG, sin bugs.',
      details: orchestrator.details && { ...orchestrator.details, bugs: [], notes: '', jiraComment: null },
    },
  ], now - 2 * 60 * 60_000));
  const file = path.join(dataDir, 'qa-tests.json');
  writeFileSync(file, JSON.stringify({ ...data, team: { folder: teamFolder, name: DEMO_PEOPLE[0]!.displayName, memberId: 'demo-ana-0000-0000' } }, null, 2));
  return file;
}

/** People in the simulated Jira: the first one is the demo's own user. */
const DEMO_PEOPLE = [
  { displayName: 'Ana Ríos', accountId: '712020:0d3m0-ana-r10s' },
  { displayName: 'Luis Torres', accountId: '712020:0d3m0-luis-t0rres' },
  { displayName: 'Marta Gómez', accountId: '712020:0d3m0-marta-g0mez' },
];

/** Simulated Jira: returns the demo tickets and people, and accepts comments without posting them anywhere. */
export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === '/rest/api/3/myself') return Response.json({ ...DEMO_PEOPLE[0], accountType: 'atlassian', active: true });
  if (url.pathname === '/rest/api/3/user/search') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    return Response.json(DEMO_PEOPLE.filter((p) => p.displayName.toLowerCase().includes(query)).map((p) => ({ ...p, accountType: 'atlassian', active: true })));
  }
  if (init?.method === 'POST' && /\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(url.pathname)) {
    return Response.json({ id: String(Math.floor(Math.random() * 90000) + 10000) }, { status: 201 });
  }
  const issues = demoTickets(Date.now()).map((t) => ({
    key: t.key,
    fields: {
      summary: t.summary, status: { name: t.status }, issuetype: { name: t.type }, priority: { name: t.priority }, created: new Date(t.created!).toISOString(),
      parent: t.epic ? { key: t.epic } : null,
      issuelinks: t.blockedBy.map((key) => ({ type: { name: 'Blocks', inward: 'is blocked by' }, inwardIssue: { key } })),
    },
  }));
  return Response.json({ issues, total: issues.length });
};

/** "Translates" with the demo dictionary: the sample texts are written in both languages. */
export const demoTranslate: ReportTranslator = async (report) => {
  const tr = (text: string) => dictionary.get(text) ?? text;
  const d = report.details;
  return {
    summary: tr(report.summary),
    details: d && {
      ...d,
      notes: tr(d.notes),
      modules: d.modules.map((m) => ({ ...m, name: tr(m.name), notes: tr(m.notes), steps: m.steps.map((s) => ({ ...s, name: tr(s.name), notes: tr(s.notes) })) })),
      bugs: d.bugs.map((b) => ({ ...b, title: tr(b.title), module: tr(b.module) })),
    },
  };
};

/** What Claude "does" in each simulated run: [text or action, is a tool call]. */
const SCRIPT: Record<AutomationKind, Array<[Bi, boolean]>> = {
  smoke: [
    [bi('Abro el sitio en Chrome y compruebo la sesión.', 'Opening the site in Chrome and checking the session.'), false],
    [bi('navigate: /login', 'navigate: /login'), true],
    [bi('Login y dashboard OK, sin errores de consola. Sigo con la navegación.', 'Login and dashboard OK, no console errors. Moving on to navigation.'), false],
    [bi('navigate: /work-orders', 'navigate: /work-orders'), true],
    [bi('Work Orders OK: lista, detalle y filtro. Ahora Purchase Orders y Vendors.', 'Work Orders OK: list, detail and filter. Now Purchase Orders and Vendors.'), false],
    [bi('navigate: /reports', 'navigate: /reports'), true],
    [bi('Reports carga los 3 reportes. Reviso los wizards y Admin.', 'Reports loads all 3 reports. Checking the wizards and Admin.'), false],
    [bi('Recorrido completo: 8 de 8 áreas pasan. Envío el reporte al dashboard.', 'Run complete: 8 of 8 areas pass. Sending the report to the dashboard.'), false],
  ],
  regression: [
    [bi('Leo los casos del test run en testomat.io.', 'Reading the test run cases from testomat.io.'), false],
    [bi('navigate: /work-orders/new', 'navigate: /work-orders/new'), true],
    [bi('Work Orders: el total ignora el impuesto del shop. Documento el bug.', 'Work Orders: the total ignores the shop tax. Documenting the bug.'), false],
    [bi('navigate: /purchase-orders', 'navigate: /purchase-orders'), true],
    [bi('Purchase Orders e Inventario pasan. Sigo con Reports.', 'Purchase Orders and Inventory pass. Moving on to Reports.'), false],
    [bi('navigate: /reports/fleet', 'navigate: /reports/fleet'), true],
    [bi('Fleet report responde 500 con rangos largos. Creo el epic con los bugs y envío el reporte.', 'Fleet report returns 500 for long ranges. Creating the epic with the bugs and sending the report.'), false],
  ],
  orchestrator: [
    [bi('Leo el ticket y sus criterios de aceptación.', 'Reading the ticket and its acceptance criteria.'), false],
    [bi('Plan: 4 casos del fix y 1 de regresión.', 'Plan: 4 cases for the fix and 1 regression case.'), false],
    [bi('navigate: /customers', 'navigate: /customers'), true],
    [bi('Edición multi-shop OK: se guarda y se ve tras recargar.', 'Multi-shop editing OK: saved and visible after reload.'), false],
    [bi('La regresión con contabilidad activada queda bloqueada: no hay un shop así en QA.', 'The regression with accounting enabled is blocked: there is no such shop on QA.'), false],
    [bi('Redacto el comentario de QA y envío el reporte al dashboard.', 'Writing the QA comment and sending the report to the dashboard.'), false],
  ],
};
for (const steps of Object.values(SCRIPT)) for (const [text] of steps) remember(text);

/** Result Claude "reports" in a simulated run, as the real skill would. */
function simulatedResult(kind: AutomationKind, target: string, lang: Lang, minutes: number) {
  if (kind === 'smoke') {
    const def = { ...SMOKE_GO, summary: remember(bi(
      `Smoke en ${target}: GO. Las 8 áreas pasan (17 de 17 pasos), sin errores de consola ni bugs.`,
      `Smoke on ${target}: GO. All 8 areas pass (17 of 17 steps), with no console errors or bugs.`,
    )) };
    return { verdict: 'GO', ...counts(def), minutes, summary: def.summary[lang], details: details(def, lang) };
  }
  if (kind === 'regression') {
    return { verdict: 'NO-GO', ...counts(REGRESSION_NOGO), minutes, summary: REGRESSION_NOGO.summary[lang], link: 'https://app.testomat.io/projects/avm/runs/b333fb92', details: details(REGRESSION_NOGO, lang) };
  }
  const def = { ...ORCHESTRATOR_WF, summary: remember(bi(
    `${target} PASSED W/F: el fix funciona en los 4 casos probados; la regresión con contabilidad activada queda bloqueada (no hay un shop así en QA).`,
    `${target} PASSED W/F: the fix works in the 4 tested cases; the regression with accounting enabled is blocked (there is no such shop on QA).`,
  )) };
  return {
    verdict: 'PASSED W/F', ...counts(def), minutes, summary: def.summary[lang], link: `${DEMO_SITE}/browse/${target}`,
    details: details(def, lang, { key: target, body: JIRA_COMMENT, posted: false, url: '', dismissed: false }),
  };
}

/**
 * Simulated Claude: writes its activity to the log step by step (same `stream-json`
 * format as Claude Code) and reports the result to the local API at the end.
 */
export function demoLauncher(dataDir: string, stepMs = 4000): ClaudeLauncher {
  return async (job) => {
    const logFile = path.join(dataDir, 'logs', `${job.id}.jsonl`);
    mkdirSync(path.dirname(logFile), { recursive: true });
    const write = (event: unknown) => appendFileSync(logFile, `${JSON.stringify(event)}\n`);
    const lang: Lang = /Write summary and details in English/.test(job.prompt) ? 'en' : 'es';
    // The kind comes from the skill that starts the prompt: the orchestrator's full-coverage
    // instructions name the regression runner too.
    const skill = job.prompt.split(/\s/, 1)[0] ?? '';
    const kind: AutomationKind = /smoke/i.test(skill) ? 'smoke' : /regression/i.test(skill) ? 'regression' : 'orchestrator';
    const target = kind === 'smoke' ? (/run smoke on (\w+)/.exec(job.prompt)?.[1] ?? 'STG') : (/[A-Z][A-Z0-9]+-\d+/.exec(job.prompt)?.[0] ?? '');
    const reportUrl = /http:\/\/127\.0\.0\.1:\d+\/api\/automation\/[\w-]+\/result(\/[0-9a-f]+)?/.exec(job.prompt)?.[0];
    // The smoke prompt carries the configured site URL; the other kinds use a sample site.
    const siteUrl = (/\((https?:\/\/[^)\s]+)\)/.exec(job.prompt)?.[1] ?? 'https://staging.alpinevm.com').replace(/\/+$/, '');
    const steps = SCRIPT[kind];
    let i = 0;
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (code: number, lastMessage: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      job.onExit({ code, lastMessage });
    };
    write({ type: 'system', subtype: 'init' });
    const next = (): void => {
      const step = steps[i++];
      if (step) {
        const [text, tool] = step;
        write({
          type: 'assistant',
          message: { content: [tool
            ? { type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: `${siteUrl}${text.en.replace('navigate: ', '')}` } }
            : { type: 'text', text: text[lang] }] },
        });
        timer = setTimeout(next, stepMs);
        return;
      }
      const result = simulatedResult(kind, target, lang, Math.max(1, Math.round((steps.length * stepMs) / 60_000)));
      const final = result.summary;
      void (reportUrl
        ? fetch(reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) })
        : Promise.resolve()
      )
        .catch(() => undefined)
        .then(() => {
          write({ type: 'result', subtype: 'success', result: final });
          finish(0, final);
        });
    };
    timer = setTimeout(next, stepMs / 2);
    return { pid: null, logFile, stop: () => finish(143, '') };
  };
}

/**
 * Simulated assistant: recognizes a few typical requests (in Spanish or English) and
 * answers with the demo data, like the real assistant (text plus actions to confirm).
 */
export const demoAssistant: AssistantRunner = async ({ context, messages, lang }) => {
  const en = lang === 'en';
  const ask = (messages.at(-1)?.text ?? '').toLowerCase();
  // The keyword patterns below match both Spanish and English requests.
  const wants = /lanz|corr|ejecut|run|launch|start|valid/.test(ask);
  const key = /[a-z][a-z0-9]+-\d+/i.exec(ask)?.[0]?.toUpperCase();
  const latest = context.claudeRuns.find((a) => a.status === 'finished');

  if (wants && /smoke/.test(ask)) {
    // The site named in the request (by name or id); if none is named, the regression site.
    const named = context.sites.find((s) => new RegExp(`\\b(${s.id}|${s.name.toLowerCase()})\\b`).test(ask));
    const site = named ?? context.sites.find((s) => s.id === context.regressionSite) ?? context.sites[0];
    if (!site) return { reply: en ? 'There are no sites configured.' : 'No hay sitios configurados.', actions: [] };
    return {
      reply: en ? `I'll launch the smoke test on ${site.name}. Confirm it below.` : `Lanzo el smoke en ${site.name}. Confírmalo abajo.`,
      actions: [{ type: 'run_smoke', site: site.id }],
    };
  }
  if (wants && /regres/.test(ask)) {
    return { reply: en ? 'I\'ll launch the regression. Confirm it below.' : 'Lanzo la regresión. Confírmala abajo.', actions: [{ type: 'run_regression', run: '' }] };
  }
  if (key && (wants || /orquest|orchestr/.test(ask))) {
    return {
      reply: en ? `I'll run the QA orchestrator on ${key}. Confirm it below.` : `Ejecuto el orquestador QA sobre ${key}. Confírmalo abajo.`,
      actions: [{ type: 'run_orchestrator', key }],
    };
  }
  if (/publica|post/.test(ask) && /jira|coment|comment/.test(ask)) {
    const pending = context.claudeRuns.find((a) => a.jiraComment?.state === 'pending');
    return pending
      ? {
          reply: en ? `The QA comment for ${pending.jiraComment!.ticket} is pending. Confirm below to post it.` : `El comentario de QA de ${pending.jiraComment!.ticket} está pendiente. Confirma abajo para publicarlo.`,
          actions: [{ type: 'post_jira_comment', automationId: pending.automationId }],
        }
      : { reply: en ? 'There is no pending Jira comment.' : 'No hay ningún comentario de Jira pendiente.', actions: [] };
  }
  if (/fall|fail|bug|error/.test(ask)) {
    const failed = context.runs.filter((r) => r.result === 'failed').slice(0, 5);
    const bugs = context.claudeRuns.flatMap((a) => a.bugs);
    const lines = failed.map((r) => `- ${r.date} · **${r.title}**${r.ticket ? ` (${r.ticket})` : ''}`);
    const bugLines = bugs.map((b) => `- **${b.key}** ${b.title} (${b.severity})`);
    return {
      reply: en
        ? `Recent failed runs:\n${lines.join('\n')}\n\nBugs from automated QA runs:\n${bugLines.join('\n') || '- None'}`
        : `Registros fallidos recientes:\n${lines.join('\n')}\n\nBugs de las ejecuciones de QA automatizadas:\n${bugLines.join('\n') || '- Ninguno'}`,
      actions: [],
    };
  }
  if (/ticket/.test(ask)) {
    const lines = context.jira.tickets.map((t) => `- **${t.key}** (${t.status}) ${t.summary}`);
    return { reply: `${en ? 'Tickets to test' : 'Tickets por probar'}:\n${lines.join('\n')}`, actions: [] };
  }
  if (latest && /report|resum|summar|últim|ultim|last/.test(ask)) {
    return {
      reply: `**${latest.kind} ${latest.target} · ${latest.verdict}**\n${latest.summary}`,
      actions: [{ type: 'open_report', automationId: latest.automationId }],
    };
  }
  return {
    reply: en
      ? 'In this demo I can: summarize the latest report, list failures and bugs, list the tickets to test, launch a smoke test or regression, run the orchestrator on a ticket, and post the pending Jira comment.'
      : 'En esta demo puedo: resumir el último reporte, listar fallos y bugs, mostrar los tickets por probar, lanzar un smoke o una regresión, ejecutar el orquestador sobre un ticket y publicar el comentario de Jira pendiente.',
    actions: [],
  };
};

/** API options for demo mode: everything external is simulated. */
export function demoAppOptions(dataDir: string, stepMs?: number): Pick<AppOptions, 'fetchImpl' | 'launchClaude' | 'translateReport' | 'assistant' | 'demo' | 'laneGapMs' | 'profileFile'> {
  // A short pause between queued runs, so the queue can be shown in a few minutes.
  // The demo's QA profile lives in its own folder: it never touches the tester's real one.
  return {
    fetchImpl: demoFetch, launchClaude: demoLauncher(dataDir, stepMs), translateReport: demoTranslate, assistant: demoAssistant, demo: true, laneGapMs: 5_000,
    profileFile: path.join(dataDir, 'avm-qa-profile.json'),
  };
}
