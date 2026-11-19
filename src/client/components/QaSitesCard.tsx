import { useEffect, useState } from 'react';
import type { QaConfig, QaSite, Settings } from '../../shared/types';
import { defaultQaConfig } from '../../shared/orchestrator';
import { useText } from '../i18n';

interface QaSitesCardProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
}

const TEXT = {
  es: {
    title: 'Sitios y skills',
    hint: 'Dónde se prueba y con qué skills de Claude Code. El smoke ofrece un botón por sitio; un ticket se valida con el orquestador en el sitio cuyo estado de Jira tiene.',
    sites: 'Sitios', id: 'Id', name: 'Nombre', url: 'URL', env: 'Ambiente', jiraStatus: 'Estado de Jira',
    jiraStatusPh: 'p. ej. On QA (vacío: ninguno)', remove: 'Quitar', addSite: 'Agregar sitio',
    regressionSite: 'La regresión corre en', skills: 'Skills de Claude Code',
    orchestrator: 'Orquestador QA', smoke: 'Smoke', regression: 'Regresión',
    hosts: 'Dominios de los test runs', hostsHint: 'Separados por comas (p. ej. testomat.io). Los links de la regresión tienen que ser de uno de ellos.',
    save: 'Guardar sitios y skills', reset: 'Volver a los valores por defecto', discard: 'Descartar cambios', unsaved: 'Hay cambios sin guardar.',
    removeSite: (name: string) => `Quitar el sitio ${name}`,
  },
  en: {
    title: 'Sites & skills',
    hint: 'Where you test and with which Claude Code skills. The smoke test gets one button per site; a ticket is validated by the orchestrator on the site that matches its Jira status.',
    sites: 'Sites', id: 'Id', name: 'Name', url: 'URL', env: 'Environment', jiraStatus: 'Jira status',
    jiraStatusPh: 'e.g. On QA (empty: none)', remove: 'Remove', addSite: 'Add site',
    regressionSite: 'Regression runs on', skills: 'Claude Code skills',
    orchestrator: 'QA orchestrator', smoke: 'Smoke', regression: 'Regression',
    hosts: 'Test run domains', hostsHint: 'Comma separated (e.g. testomat.io). Regression links must come from one of them.',
    save: 'Save sites & skills', reset: 'Restore defaults', discard: 'Discard changes', unsaved: 'There are unsaved changes.',
    removeSite: (name: string) => `Remove the ${name} site`,
  },
};

/** Free id for a new site (site-1, site-2…). */
const nextId = (sites: QaSite[]): string => {
  for (let i = 1; ; i++) if (!sites.some((s) => s.id === `site-${i}`)) return `site-${i}`;
};

/** Editor for sites, skills and test run domains: everything is saved together with one button. */
export function QaSitesCard({ settings, onSave }: QaSitesCardProps) {
  const t = useText(TEXT);
  const [draft, setDraft] = useState<QaConfig>(settings.qa);
  const [hosts, setHosts] = useState(settings.qa.testRunHosts.join(', '));
  // If settings change from elsewhere (another save), the draft follows them.
  useEffect(() => {
    setDraft(settings.qa);
    setHosts(settings.qa.testRunHosts.join(', '));
  }, [settings.qa]);

  const next: QaConfig = { ...draft, testRunHosts: hosts.split(',').map((h) => h.trim()).filter(Boolean) };
  const dirty = JSON.stringify(next) !== JSON.stringify(settings.qa);
  const setSite = (index: number, patch: Partial<QaSite>): void =>
    setDraft((d) => ({ ...d, sites: d.sites.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));

  return (
    <div className="card qa-sites">
      <h3>{t.title}</h3>
      <p className="hint">{t.hint}</p>

      <div className="table-wrap">
        <table className="qa-sites-table">
          <thead>
            <tr><th>{t.id}</th><th>{t.name}</th><th>{t.url}</th><th>{t.env}</th><th>{t.jiraStatus}</th><th /></tr>
          </thead>
          <tbody>
            {draft.sites.map((site, i) => (
              <tr key={i}>
                <td><input aria-label={`${t.id} ${i + 1}`} value={site.id} onChange={(e) => setSite(i, { id: e.target.value.toLowerCase() })} /></td>
                <td><input aria-label={`${t.name} ${i + 1}`} value={site.name} onChange={(e) => setSite(i, { name: e.target.value })} /></td>
                <td><input aria-label={`${t.url} ${i + 1}`} value={site.url} onChange={(e) => setSite(i, { url: e.target.value })} /></td>
                <td>
                  <input aria-label={`${t.env} ${i + 1}`} list="qa-envs" value={site.env} onChange={(e) => setSite(i, { env: e.target.value })} />
                </td>
                <td><input aria-label={`${t.jiraStatus} ${i + 1}`} placeholder={t.jiraStatusPh} value={site.jiraStatus} onChange={(e) => setSite(i, { jiraStatus: e.target.value })} /></td>
                <td>
                  <button
                    className="link danger"
                    disabled={draft.sites.length === 1}
                    aria-label={t.removeSite(site.name || site.id)}
                    onClick={() => setDraft((d) => ({ ...d, sites: d.sites.filter((_, j) => j !== i) }))}
                  >
                    {t.remove}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="qa-envs">{settings.envs.map((env) => <option key={env} value={env} />)}</datalist>
      </div>
      <button
        className="btn small"
        onClick={() => setDraft((d) => ({ ...d, sites: [...d.sites, { id: nextId(d.sites), name: '', url: 'https://', env: settings.envs[0] ?? '', jiraStatus: '' }] }))}
      >
        {t.addSite}
      </button>

      <div className="qa-sites-grid">
        <label className="f">
          {t.regressionSite}
          <select value={draft.regressionSiteId} onChange={(e) => setDraft((d) => ({ ...d, regressionSiteId: e.target.value }))}>
            {draft.sites.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </select>
        </label>
        <label className="f">
          {t.hosts}
          <input value={hosts} onChange={(e) => setHosts(e.target.value)} />
          <span className="hint">{t.hostsHint}</span>
        </label>
      </div>

      <h4 className="qa-sites-sub">{t.skills}</h4>
      <div className="qa-sites-grid three">
        {(['orchestrator', 'smoke', 'regression'] as const).map((kind) => (
          <label key={kind} className="f">
            {t[kind]}
            <input value={draft.skills[kind]} onChange={(e) => setDraft((d) => ({ ...d, skills: { ...d.skills, [kind]: e.target.value } }))} />
          </label>
        ))}
      </div>

      <div className="actions">
        <button className="btn small" onClick={() => { const def = defaultQaConfig(); setDraft(def); setHosts(def.testRunHosts.join(', ')); }}>{t.reset}</button>
        <div className="spacer" />
        {dirty && <span className="hint">{t.unsaved}</span>}
        {dirty && <button className="btn small" onClick={() => { setDraft(settings.qa); setHosts(settings.qa.testRunHosts.join(', ')); }}>{t.discard}</button>}
        <button className="btn small primary" disabled={!dirty} onClick={() => onSave({ ...settings, qa: next })}>{t.save}</button>
      </div>
    </div>
  );
}
