import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { DEFAULT_JQL, colorForIndex } from '../../shared/defaults';
import { parseJiraBoardUrl } from '../../shared/jiraBoard';
import type { AppState, Backup, JiraConfigInput, Settings } from '../../shared/types';
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

const onEnter = (action: () => void) => (event: KeyboardEvent): void => {
  if (event.key === 'Enter') action();
};

export function SettingsView({ state, jiraLoading, onSaveSettings, onSaveJira, onImport, onError }: SettingsViewProps) {
  const { settings, runs, jira } = state;
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
      onError('Ese tipo ya existe');
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
      onError('El archivo no es un respaldo válido');
    }
  };

  return (
    <section>
      <div className="grid2">
        <div className="card">
          <h3>Tipos de test</h3>
          <p className="hint">
            Marca con ★ las suites grandes (Smoke, Regression…): aparecen destacadas en el dashboard con su última ejecución.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>★</th><th>Nombre</th><th>Registros</th><th /></tr>
              </thead>
              <tbody>
                {settings.types.map((type) => {
                  const used = usage.get(type.id) ?? 0;
                  return (
                    <tr key={type.id}>
                      <td>
                        <button
                          className="link"
                          title="Marcar como suite grande"
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
                          <span className="hint">en uso</span>
                        ) : (
                          <button
                            className="link danger"
                            disabled={settings.types.length < 2}
                            onClick={() => onSaveSettings({ ...settings, types: settings.types.filter((t) => t.id !== type.id) })}
                          >
                            Quitar
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
              placeholder="Nuevo tipo de test, p. ej. Migración de datos"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={onEnter(addType)}
            />
            <button className="btn" onClick={addType}>Agregar</button>
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Ambientes</h3>
            {settings.envs.length === 0 && <span className="hint">Sin ambientes</span>}
            {settings.envs.map((env) => (
              <span key={env} className="tag" style={{ margin: '0 6px 6px 0' }}>
                {env}{' '}
                <button
                  className="link danger"
                  title="Quitar"
                  onClick={() => onSaveSettings({ ...settings, envs: settings.envs.filter((e) => e !== env) })}
                >
                  ×
                </button>
              </span>
            ))}
            <div className="inline-add">
              <input placeholder="Nuevo ambiente" value={newEnv} onChange={(e) => setNewEnv(e.target.value)} onKeyDown={onEnter(addEnv)} />
              <button className="btn" onClick={addEnv}>Agregar</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-head">
              <h3 style={{ margin: 0 }}>Conexión con Jira</h3>
              <div className="spacer" />
              <JiraStatus jira={jira} loading={jiraLoading} detail={false} />
            </div>
            {jira.connection === 'error' && <p className="callout bad">{jira.error}</p>}
            <p className="hint">
              Tus tickets aparecen como tarjetas en el dashboard. El API token se guarda solo en esta máquina.
            </p>
            <label className="f">
              Board (opcional: pega el link del board, con o sin filtro)
              <input
                placeholder="https://tu-sitio.atlassian.net/jira/software/projects/ABC/boards/1?filter=…"
                value={jiraForm.board}
                onChange={(e) => setBoard(e.target.value)}
              />
            </label>
            {boardInvalid && <p className="hint">Ese link no es de un board (debe contener …/boards/&lt;número&gt;).</p>}
            {boardRef && (
              <p className="hint">
                Board {boardRef.boardId}
                {boardRef.filter ? ` con filtro: ${boardRef.filter}` : ' sin filtro'}. Se omiten los tickets terminados.
              </p>
            )}
            <label className="f" style={{ marginTop: 8 }}>
              Sitio
              <input
                placeholder="https://tu-sitio.atlassian.net"
                value={jiraForm.site}
                disabled={boardRef !== null}
                onChange={(e) => setJiraForm({ ...jiraForm, site: e.target.value })}
              />
            </label>
            <label className="f" style={{ marginTop: 8 }}>
              Email de Atlassian
              <input type="email" value={jiraForm.email} onChange={(e) => setJiraForm({ ...jiraForm, email: e.target.value })} />
            </label>
            <label className="f" style={{ marginTop: 8 }}>
              API token
              <span className="input-affix">
                <input
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder={jira.hasToken ? '•••••••• (guardado — escribe para cambiarlo)' : 'Pega aquí tu API token'}
                  value={jiraForm.token}
                  onChange={(e) => setJiraForm({ ...jiraForm, token: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                  onClick={() => setShowToken(!showToken)}
                >
                  <Icon name={showToken ? 'eyeOff' : 'eye'} />
                </button>
              </span>
            </label>
            <a className="small-link" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">
              Crear un API token en Atlassian <Icon name="external" size={12} />
            </a>
            <label className="f" style={{ marginTop: 8 }}>
              {boardRef ? 'JQL adicional (opcional, se suma al filtro del board)' : 'JQL (qué tickets cargar)'}
              <textarea rows={2} value={jiraForm.jql} onChange={(e) => setJiraForm({ ...jiraForm, jql: e.target.value })} />
            </label>
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={boardInvalid || jiraLoading} onClick={() => onSaveJira(jiraForm)}>
                {jiraLoading ? 'Conectando…' : jira.connection === 'connected' ? 'Guardar y recargar tickets' : 'Conectar y cargar tickets'}
              </button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h3>Enlace de tickets</h3>
            <label className="f">
              URL base (el ticket se agrega al final)
              <input
                placeholder="https://tu-sitio.atlassian.net/browse/"
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
            <h3>Respaldo de datos</h3>
            <p className="hint">
              Los datos se guardan en qa-tests.json, en la carpeta de datos de usuario del sistema (en macOS: ~/Library/Application Support/QA Dashboard). Importar un respaldo reemplaza
              los datos actuales.
            </p>
            <div className="row" style={{ margin: 0 }}>
              <button className="btn" onClick={() => exportBackup(state)}>Exportar respaldo (JSON)</button>
              <button className="btn" onClick={() => exportCsv(state)}>Exportar CSV</button>
              <label className="btn">
                Importar respaldo
                <input type="file" accept=".json,application/json" hidden onChange={importFile} />
              </label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
