import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { DEFAULT_JQL, colorForIndex } from '../../shared/defaults';
import { parseJiraBoardUrl } from '../../shared/jiraBoard';
import { LANGUAGES, type AppState, type Backup, type JiraConfigInput, type Lang, type Settings } from '../../shared/types';
import { useLang, useText } from '../i18n';
import { exportBackup, exportCsv } from '../exporters';
import { Icon } from './icons';
import { JiraStatus } from './ui';

interface SettingsViewProps {
  state: AppState;
  jiraLoading: boolean;
  onSaveSettings: (settings: Settings) => void;
  onSaveJira: (config: JiraConfigInput) => void;
  onImport: (backup: Backup) => void;
  onError: (message: string) => void;
}

const LANGUAGE_NAMES: Record<Lang, string> = { es: 'Español', en: 'English' };

const TEXT = {
  es: {
    exists: 'Ese tipo ya existe', badBackup: 'El archivo no es un respaldo válido',
    types: 'Tipos de test',
    typesHint: 'Marca con ★ las suites grandes (Smoke, Regression…): aparecen destacadas en el dashboard con su última ejecución.',
    name: 'Nombre', runs: 'Registros', markMajor: 'Marcar como suite grande', inUse: 'en uso', remove: 'Quitar',
    newType: 'Nuevo tipo de test, p. ej. Migración de datos', add: 'Agregar',
    envs: 'Ambientes', noEnvs: 'Sin ambientes', newEnv: 'Nuevo ambiente',
    language: 'Idioma', languageHint: 'Idioma de la app y de los reportes que escribe Claude.',
    jira: 'Conexión con Jira', jiraHint: 'Tus tickets aparecen como tarjetas en el dashboard. El API token se guarda solo en esta máquina.',
    board: 'Board (opcional: pega el link del board, con o sin filtro)',
    boardPh: 'https://tu-sitio.atlassian.net/jira/software/projects/ABC/boards/1?filter=…',
    boardInvalid: 'Ese link no es de un board (debe contener …/boards/<número>).',
    boardInfo: (id: string, filter: string) => `Board ${id}${filter ? ` con filtro: ${filter}` : ' sin filtro'}. Se omiten los tickets terminados.`,
    site: 'Sitio', sitePh: 'https://tu-sitio.atlassian.net', email: 'Email de Atlassian',
    tokenSaved: '•••••••• (guardado — escribe para cambiarlo)', tokenPh: 'Pega aquí tu API token',
    hideToken: 'Ocultar token', showToken: 'Mostrar token', createToken: 'Crear un API token en Atlassian',
    jqlBoard: 'JQL adicional (opcional, se suma al filtro del board)', jql: 'JQL (qué tickets cargar)',
    connecting: 'Conectando…', saveReload: 'Guardar y recargar tickets', connectLoad: 'Conectar y cargar tickets',
    ticketLink: 'Enlace de tickets', baseUrl: 'URL base (el ticket se agrega al final)', baseUrlPh: 'https://tu-sitio.atlassian.net/browse/',
    backup: 'Respaldo de datos',
    backupHint: 'Los datos se guardan en qa-tests.json, en la carpeta de datos de usuario del sistema (en macOS: ~/Library/Application Support/QA Dashboard). Importar un respaldo reemplaza los datos actuales.',
    exportJson: 'Exportar respaldo (JSON)', exportCsv: 'Exportar CSV', import: 'Importar respaldo',
  },
  en: {
    exists: 'That type already exists', badBackup: 'The file is not a valid backup',
    types: 'Test types',
    typesHint: 'Star (★) the large suites (Smoke, Regression…): they are highlighted on the dashboard with their latest run.',
    name: 'Name', runs: 'Runs', markMajor: 'Mark as a large suite', inUse: 'in use', remove: 'Remove',
    newType: 'New test type, e.g. Data migration', add: 'Add',
    envs: 'Environments', noEnvs: 'No environments', newEnv: 'New environment',
    language: 'Language', languageHint: 'Language of the app and of the reports Claude writes.',
    jira: 'Jira connection', jiraHint: 'Your tickets show up as cards on the dashboard. The API token is stored only on this machine.',
    board: 'Board (optional: paste the board link, with or without a filter)',
    boardPh: 'https://your-site.atlassian.net/jira/software/projects/ABC/boards/1?filter=…',
    boardInvalid: 'That link is not a board (it must contain …/boards/<number>).',
    boardInfo: (id: string, filter: string) => `Board ${id}${filter ? ` with filter: ${filter}` : ' without a filter'}. Done tickets are left out.`,
    site: 'Site', sitePh: 'https://your-site.atlassian.net', email: 'Atlassian email',
    tokenSaved: '•••••••• (saved — type to change it)', tokenPh: 'Paste your API token here',
    hideToken: 'Hide token', showToken: 'Show token', createToken: 'Create an API token in Atlassian',
    jqlBoard: 'Extra JQL (optional, added to the board filter)', jql: 'JQL (which tickets to load)',
    connecting: 'Connecting…', saveReload: 'Save and reload tickets', connectLoad: 'Connect and load tickets',
    ticketLink: 'Ticket links', baseUrl: 'Base URL (the ticket key is appended)', baseUrlPh: 'https://your-site.atlassian.net/browse/',
    backup: 'Data backup',
    backupHint: 'Data is stored in qa-tests.json, in the system user data folder (on macOS: ~/Library/Application Support/QA Dashboard). Importing a backup replaces the current data.',
    exportJson: 'Export backup (JSON)', exportCsv: 'Export CSV', import: 'Import backup',
  },
};

const onEnter = (action: () => void) => (event: KeyboardEvent): void => {
  if (event.key === 'Enter') action();
};

export function SettingsView({ state, jiraLoading, onSaveSettings, onSaveJira, onImport, onError }: SettingsViewProps) {
  const { settings, runs, jira } = state;
  const lang = useLang();
  const t = useText(TEXT);
  const [newType, setNewType] = useState('');
  const [newEnv, setNewEnv] = useState('');
  const [ticketBase, setTicketBase] = useState(settings.ticketBase);
  const [jiraForm, setJiraForm] = useState({ site: jira.site, email: jira.email, board: jira.board, jql: jira.jql, token: '' });
  const [showToken, setShowToken] = useState(false);
  const boardRef = parseJiraBoardUrl(jiraForm.board);
  const boardInvalid = jiraForm.board.trim() !== '' && !boardRef;

  /** Al pegar un link de board se toma su sitio y el JQL pasa a ser solo un filtro adicional. */
  const setBoard = (board: string): void => {
    const ref = parseJiraBoardUrl(board);
    setJiraForm({
      ...jiraForm,
      board,
      site: ref?.site ?? jiraForm.site,
      jql: ref && jiraForm.jql === DEFAULT_JQL ? '' : jiraForm.jql,
    });
  };

  useEffect(() => setTicketBase(settings.ticketBase), [settings.ticketBase]);
  useEffect(() => {
    setJiraForm({ site: jira.site, email: jira.email, board: jira.board, jql: jira.jql, token: '' });
  }, [jira.site, jira.email, jira.board, jira.jql, jira.hasToken]);

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.typeId, (counts.get(run.typeId) ?? 0) + 1);
    return counts;
  }, [runs]);

  const updateType = (id: string, patch: { name?: string; major?: boolean }): void =>
    onSaveSettings({ ...settings, types: settings.types.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const addType = (): void => {
    const name = newType.trim();
    if (!name) return;
    if (settings.types.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      onError(t.exists);
      return;
    }
    const type = { id: `t-${crypto.randomUUID()}`, name, major: false, color: colorForIndex(settings.types.length) };
    onSaveSettings({ ...settings, types: [...settings.types, type] });
    setNewType('');
  };

  const addEnv = (): void => {
    const env = newEnv.trim();
    if (!env || settings.envs.includes(env)) return;
    onSaveSettings({ ...settings, envs: [...settings.envs, env] });
    setNewEnv('');
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      onImport(JSON.parse(await file.text()) as Backup);
    } catch {
      onError(t.badBackup);
    }
  };

  return (
    <section>
      <div className="grid2">
        <div className="card">
          <h3>{t.types}</h3>
          <p className="hint">{t.typesHint}</p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>★</th><th>{t.name}</th><th>{t.runs}</th><th /></tr>
              </thead>
              <tbody>
                {settings.types.map((type) => {
                  const used = usage.get(type.id) ?? 0;
                  return (
                    <tr key={type.id}>
                      <td>
                        <button
                          className="link"
                          title={t.markMajor}
                          style={{ fontSize: 16, color: type.major ? 'var(--warn)' : 'var(--line)' }}
                          onClick={() => updateType(type.id, { major: !type.major })}
                        >
                          ★
                        </button>
                      </td>
                      <td>
                        <input
                          key={type.name}
                          defaultValue={type.name}
                          style={{ borderColor: 'transparent', padding: '4px 6px', color: type.color, fontWeight: 600 }}
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (name && name !== type.name) updateType(type.id, { name });
                            else e.target.value = type.name;
                          }}
                        />
                      </td>
                      <td className="num">{used}</td>
                      <td>
                        {used > 0 ? (
                          <span className="hint">{t.inUse}</span>
                        ) : (
                          <button
                            className="link danger"
                            disabled={settings.types.length < 2}
                            onClick={() => onSaveSettings({ ...settings, types: settings.types.filter((t) => t.id !== type.id) })}
                          >
                            {t.remove}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="inline-add">
            <input
              placeholder={t.newType}
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={onEnter(addType)}
            />
            <button className="btn" onClick={addType}>{t.add}</button>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>{t.language}</h3>
            <p className="hint">{t.languageHint}</p>
            <div className="seg" role="group" aria-label={t.language}>
              {LANGUAGES.map((l) => (
                <button key={l} className={l === lang ? 'on' : ''} aria-pressed={l === lang} onClick={() => onSaveSettings({ ...settings, language: l })}>
                  {LANGUAGE_NAMES[l]}
                </button>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3>{t.envs}</h3>
            {settings.envs.length === 0 && <span className="hint">{t.noEnvs}</span>}
            {settings.envs.map((env) => (
              <span key={env} className="tag" style={{ margin: '0 6px 6px 0' }}>
                {env}{' '}
                <button
                  className="link danger"
                  title={t.remove}
                  onClick={() => onSaveSettings({ ...settings, envs: settings.envs.filter((e) => e !== env) })}
                >
                  ×
                </button>
              </span>
            ))}
            <div className="inline-add">
              <input placeholder={t.newEnv} value={newEnv} onChange={(e) => setNewEnv(e.target.value)} onKeyDown={onEnter(addEnv)} />
              <button className="btn" onClick={addEnv}>{t.add}</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-head">
              <h3 style={{ margin: 0 }}>{t.jira}</h3>
              <div className="spacer" />
              <JiraStatus jira={jira} loading={jiraLoading} detail={false} />
            </div>
            {jira.connection === 'error' && <p className="callout bad">{jira.error}</p>}
            <p className="hint">{t.jiraHint}</p>
            <label className="f">
              {t.board}
              <input
                placeholder={t.boardPh}
                value={jiraForm.board}
                onChange={(e) => setBoard(e.target.value)}
              />
            </label>
            {boardInvalid && <p className="hint">{t.boardInvalid}</p>}
            {boardRef && (
              <p className="hint">{t.boardInfo(String(boardRef.boardId), boardRef.filter ?? '')}</p>
            )}
            <label className="f" style={{ marginTop: 8 }}>
              {t.site}
              <input
                placeholder={t.sitePh}
                value={jiraForm.site}
                disabled={boardRef !== null}
                onChange={(e) => setJiraForm({ ...jiraForm, site: e.target.value })}
              />
            </label>
            <label className="f" style={{ marginTop: 8 }}>
              {t.email}
              <input type="email" value={jiraForm.email} onChange={(e) => setJiraForm({ ...jiraForm, email: e.target.value })} />
            </label>
            <label className="f" style={{ marginTop: 8 }}>
              API token
              <span className="input-affix">
                <input
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder={jira.hasToken ? t.tokenSaved : t.tokenPh}
                  value={jiraForm.token}
                  onChange={(e) => setJiraForm({ ...jiraForm, token: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={showToken ? t.hideToken : t.showToken}
                  onClick={() => setShowToken(!showToken)}
                >
                  <Icon name={showToken ? 'eyeOff' : 'eye'} />
                </button>
              </span>
            </label>
            <a className="small-link" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">
              {t.createToken} <Icon name="external" size={12} />
            </a>
            <label className="f" style={{ marginTop: 8 }}>
              {boardRef ? t.jqlBoard : t.jql}
              <textarea rows={2} value={jiraForm.jql} onChange={(e) => setJiraForm({ ...jiraForm, jql: e.target.value })} />
            </label>
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={boardInvalid || jiraLoading} onClick={() => onSaveJira(jiraForm)}>
                {jiraLoading ? t.connecting : jira.connection === 'connected' ? t.saveReload : t.connectLoad}
              </button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3>{t.ticketLink}</h3>
            <label className="f">
              {t.baseUrl}
              <input
                placeholder={t.baseUrlPh}
                value={ticketBase}
                onChange={(e) => setTicketBase(e.target.value)}
                onBlur={() => {
                  const value = ticketBase.trim();
                  if (value !== settings.ticketBase) onSaveSettings({ ...settings, ticketBase: value });
                }}
              />
            </label>
          </div>

          <div className="card">
            <h3>{t.backup}</h3>
            <p className="hint">{t.backupHint}</p>
            <div className="row" style={{ margin: 0 }}>
              <button className="btn" onClick={() => exportBackup(state)}>{t.exportJson}</button>
              <button className="btn" onClick={() => exportCsv(state)}>{t.exportCsv}</button>
              <label className="btn">
                {t.import}
                <input type="file" accept=".json,application/json" hidden onChange={importFile} />
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
