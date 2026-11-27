import { useEffect, useState, type FormEvent } from 'react';
import type { QaPerson, QaProfile, SetupState } from '../../shared/types';
import { api } from '../api';
import { useText } from '../i18n';
import { Icon } from './icons';

const TEXT = {
  es: {
    title: 'Mi perfil QA',
    hint: 'Las skills de QA leen este perfil para asignarte los tickets y firmar los reportes con tu nombre, y para pasar los TCs a quien los ejecuta.',
    loading: 'Leyendo el perfil…',
    tester: 'Tester (tú)',
    name: 'Nombre', accountId: 'accountId de Jira',
    fromJira: 'Usar mi cuenta de Jira',
    fromJiraOff: 'Conecta Jira más abajo para tomar tu nombre y accountId de tu cuenta',
    executor: 'Ejecutor de TCs',
    executorHint: 'Quien ejecuta los TCs cuando un ticket pasa QA: las skills le asignan los items [TC]. Si lo dejas vacío, quedan contigo.',
    search: 'Buscar en Jira por nombre', searchBtn: 'Buscar', searching: 'Buscando…', noResults: 'Nadie en Jira con ese nombre',
    pick: (name: string) => `Elegir a ${name} como ejecutor de TCs`,
    clear: 'Quitar ejecutor',
    save: 'Guardar perfil', saving: 'Guardando…', saved: 'Perfil QA guardado',
    needTester: 'Completa tu nombre y tu accountId',
    halfExecutor: 'Completa nombre y accountId del ejecutor, o quítalo',
    badId: 'Eso no parece un accountId de Jira (por ejemplo, 712020:7439f202-…)',
    file: 'Archivo', notYet: 'todavía no existe: se crea al guardar',
    unreadable: 'El archivo no se puede leer; al guardar se reemplaza.',
  },
  en: {
    title: 'My QA profile',
    hint: 'The QA skills read this profile to assign tickets to you and sign reports with your name, and to hand the TCs to whoever runs them.',
    loading: 'Reading the profile…',
    tester: 'Tester (you)',
    name: 'Name', accountId: 'Jira accountId',
    fromJira: 'Use my Jira account',
    fromJiraOff: 'Connect Jira below to take your name and accountId from your account',
    executor: 'TC executor',
    executorHint: 'Who runs the TCs when a ticket passes QA: the skills assign the [TC] items to them. Leave it empty and they stay with you.',
    search: 'Search Jira by name', searchBtn: 'Search', searching: 'Searching…', noResults: 'Nobody in Jira with that name',
    pick: (name: string) => `Choose ${name} as TC executor`,
    clear: 'Remove executor',
    save: 'Save profile', saving: 'Saving…', saved: 'QA profile saved',
    needTester: 'Fill in your name and your accountId',
    halfExecutor: "Fill in the executor's name and accountId, or remove them",
    badId: 'That does not look like a Jira accountId (for example, 712020:7439f202-…)',
    file: 'File', notYet: 'does not exist yet: saving creates it',
    unreadable: 'The file cannot be read; saving replaces it.',
  },
};

/** Same rule as the server: Jira Cloud accountIds. */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{6,128}$/;
const EMPTY: QaPerson = { name: '', accountId: '' };
const trimmed = (p: QaPerson): QaPerson => ({ name: p.name.trim(), accountId: p.accountId.trim() });

interface ProfileCardProps {
  jiraConnected: boolean;
  /** The setup check after saving (the profile row changes). */
  onSaved: (setup: SetupState | null) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Settings card: the QA profile the skills read (`~/.config/avm-qa/profile.json`). */
export function ProfileCard({ jiraConnected, onSaved, onNotice, onError }: ProfileCardProps) {
  const t = useText(TEXT);
  const [profile, setProfile] = useState<QaProfile | null>(null);
  const [tester, setTester] = useState<QaPerson>(EMPTY);
  const [executor, setExecutor] = useState<QaPerson>(EMPTY);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<QaPerson[] | null>(null);
  const [busy, setBusy] = useState<'' | 'jira' | 'search' | 'save'>('');

  useEffect(() => {
    api.getProfile().then(
      (p) => {
        setProfile(p);
        setTester(p.tester ?? EMPTY);
        setExecutor(p.tcExecutor ?? EMPTY);
      },
      (error: unknown) => onError(errorText(error)),
    );
  }, [onError]);

  const run = async (what: 'jira' | 'search' | 'save', action: () => Promise<void>): Promise<void> => {
    setBusy(what);
    try {
      await action();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy('');
    }
  };

  const fromJira = () => run('jira', async () => setTester(await api.jiraMyself()));
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    void run('search', async () => setResults(await api.searchJiraUsers(query.trim())));
  };

  const t1 = trimmed(tester);
  const t2 = trimmed(executor);
  const hasExecutor = t2.name !== '' || t2.accountId !== '';
  const problem =
    !t1.name || !t1.accountId ? t.needTester
    : !ACCOUNT_ID.test(t1.accountId) ? t.badId
    : hasExecutor && (!t2.name || !t2.accountId) ? t.halfExecutor
    : hasExecutor && !ACCOUNT_ID.test(t2.accountId) ? t.badId
    : null;
  // What the file already has: nothing to save. A file that does not exist yet is never "saved".
  const saved = profile !== null && profile.exists && JSON.stringify([profile.tester ?? EMPTY, profile.tcExecutor ?? EMPTY]) === JSON.stringify([t1, t2]);

  const save = () =>
    run('save', async () => {
      const result = await api.saveProfile({ tester: t1, tcExecutor: hasExecutor ? t2 : null });
      setProfile(result.profile);
      onSaved(result.setup);
      onNotice(t.saved);
    });

  return (
    <div className="card profile" style={{ marginBottom: 12 }}>
      <h3>{t.title}</h3>
      <p className="hint">{t.hint}</p>
      {!profile ? (
        <p className="hint"><span className="spinner" /> {t.loading}</p>
      ) : (
        <>
          <fieldset className="profile-who">
            <legend>{t.tester}</legend>
            <div className="profile-fields">
              <label className="f">
                {t.name}
                <input value={tester.name} onChange={(e) => setTester({ ...tester, name: e.target.value })} aria-label={`${t.tester}: ${t.name}`} />
              </label>
              <label className="f">
                {t.accountId}
                <input value={tester.accountId} onChange={(e) => setTester({ ...tester, accountId: e.target.value })} aria-label={`${t.tester}: ${t.accountId}`} spellCheck={false} />
              </label>
            </div>
            <button className="btn small" disabled={!jiraConnected || busy !== ''} title={jiraConnected ? undefined : t.fromJiraOff} onClick={() => void fromJira()}>
              {t.fromJira}
            </button>
            {!jiraConnected && <p className="hint">{t.fromJiraOff}</p>}
          </fieldset>

          <fieldset className="profile-who">
            <legend>{t.executor}</legend>
            <p className="hint">{t.executorHint}</p>
            {jiraConnected && (
              <form className="inline-add" onSubmit={search} role="search">
                <input placeholder={t.search} aria-label={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
                <button className="btn small" type="submit" disabled={query.trim().length < 2 || busy !== ''}>
                  {busy === 'search' ? t.searching : t.searchBtn}
                </button>
              </form>
            )}
            {results && (
              <ul className="profile-results">
                {results.length === 0 && <li className="hint">{t.noResults}</li>}
                {results.map((p) => (
                  <li key={p.accountId}>
                    <button
                      className="link-btn"
                      aria-label={t.pick(p.name)}
                      onClick={() => {
                        setExecutor(p);
                        setResults(null);
                        setQuery('');
                      }}
                    >
                      <b>{p.name}</b> <span className="hint">{p.accountId}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="profile-fields">
              <label className="f">
                {t.name}
                <input value={executor.name} onChange={(e) => setExecutor({ ...executor, name: e.target.value })} aria-label={`${t.executor}: ${t.name}`} />
              </label>
              <label className="f">
                {t.accountId}
                <input value={executor.accountId} onChange={(e) => setExecutor({ ...executor, accountId: e.target.value })} aria-label={`${t.executor}: ${t.accountId}`} spellCheck={false} />
              </label>
            </div>
            {hasExecutor && <button className="link-btn" onClick={() => setExecutor(EMPTY)}>{t.clear}</button>}
          </fieldset>

          {problem && !saved && <p className="hint text-warn">{problem}</p>}
          {profile.unreadable && <p className="hint text-warn">{t.unreadable}</p>}
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={problem !== null || saved || busy !== ''} onClick={() => void save()}>
              {busy === 'save' ? t.saving : t.save}
            </button>
          </div>
          <p className="hint path">
            {t.file}: <code>{profile.file}</code>
            {!profile.exists && ` (${t.notYet})`}
            {profile.exists && saved && <> <Icon name="check" size={12} /></>}
          </p>
        </>
      )}
    </div>
  );
}
