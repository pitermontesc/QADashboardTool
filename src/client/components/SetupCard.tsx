import { useState } from 'react';
import type { Lang, SetupCheck, SetupCheckId, SetupState } from '../../shared/types';
import { copyText } from '../clipboard';
import { useLang, useText } from '../i18n';
import { Icon } from './icons';

/** Commands a tester copies into Terminal (or into Claude Code, for the plugin). */
const COMMANDS: Partial<Record<SetupCheckId, string>> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  login: 'claude auth login',
  skills: '/plugin install avm-qa-skills@claudeai-organization-library',
  chrome: 'claude --chrome',
};

const TEXT = {
  es: {
    title: 'Preparar esta Mac',
    hint: 'Lo que necesitan las ejecuciones con Claude Code (orquestador, smoke y regresión). Si falta algo necesario, la app no las lanza; lo demás es recomendado.',
    checking: 'Revisando esta Mac…',
    ready: 'Lista para ejecutar con Claude',
    notReady: 'Falta algo para ejecutar con Claude',
    recheck: 'Volver a revisar',
    rechecking: 'Revisando…',
    checkedAt: (time: string) => `Revisado a las ${time}`,
    copy: 'Copiar', copied: 'Comando copiado', copyFailed: 'No se pudo copiar: selecciona el comando y cópialo',
    status: { ok: 'Listo', required: 'Falta', advice: 'Recomendado', invalid: 'Revisar', unknown: 'Sin comprobar' },
    label: {
      claude: 'Claude Code instalado', login: 'Sesión iniciada en Claude Code', skills: 'Skills de QA',
      chrome: 'Claude in Chrome conectado', profile: 'Perfil QA', jira: 'Jira conectado',
    } as Record<SetupCheckId, string>,
    ok: {
      claude: (d: string) => `Versión ${d}.`,
      login: () => 'Las ejecuciones usan tu cuenta y tu plan.',
      skills: (d: string) => `Claude Code tiene ${d}.`,
      chrome: () => 'Conectado a Claude Code. Antes de lanzar, inicia sesión con tu usuario en los sitios de prueba.',
      profile: (d: string) => `Las skills asignan tickets y firman reportes a nombre de ${d}.`,
      jira: (d: string) => `Conectado a ${d}.`,
    } as Record<SetupCheckId, (detail: string) => string>,
    fix: {
      claude: () => 'Instálalo: abre Terminal y corre este comando. Después vuelve aquí.',
      login: () => 'En Terminal, inicia sesión con tu cuenta de la organización. Las ejecuciones usan tu plan.',
      skills: (d: string) =>
        `Falta ${d}. Instala el plugin avm-qa-skills desde la biblioteca de la organización (claude.ai → Personalizar → Plugins) o con este comando dentro de Claude Code. Si usas otras skills, escribe su nombre exacto en Sitios y skills.`,
      chrome: () =>
        'Instala la extensión Claude in Chrome, inicia sesión con tu cuenta y conéctala a Claude Code corriendo este comando una vez en Terminal. Sin el navegador, las ejecuciones terminan en BLOCKED.',
      profile: () =>
        'Las skills asignan tickets y firman reportes con tu nombre. Complétalo más abajo, en Mi perfil QA (tu nombre y accountId salen de Jira); sin él, usan tu cuenta de Jira.',
      jira: () => 'Conéctalo en Conexión con Jira: sin Jira no hay tickets para el orquestador.',
    } as Record<SetupCheckId, (detail: string) => string>,
    invalid: 'El perfil no tiene tu nombre y accountId: complétalo más abajo, en Mi perfil QA.',
    unknown: { claude: '', login: 'Se comprueba cuando Claude Code esté instalado.', skills: 'Se comprueba cuando Claude Code esté instalado.', chrome: 'Solo se comprueba en macOS.', profile: '', jira: '' } as Record<SetupCheckId, string>,
    renamed: (from: string, to: string) => `Nombre ajustado al que tiene Claude Code: ${from} → ${to}`,
    banner: (what: string) => `No se pueden lanzar ejecuciones con Claude: falta ${what}.`,
    bannerWhat: { claude: 'instalar Claude Code', login: 'iniciar sesión en Claude Code', skills: 'instalar las skills de QA' } as Partial<Record<SetupCheckId, string>>,
    fixIt: 'Ver cómo arreglarlo',
    and: ' y ',
  },
  en: {
    title: 'Set up this Mac',
    hint: 'What runs with Claude Code (orchestrator, smoke and regression) need. If something required is missing, the app does not launch them; the rest is advice.',
    checking: 'Checking this Mac…',
    ready: 'Ready to run with Claude',
    notReady: 'Something is missing to run with Claude',
    recheck: 'Check again',
    rechecking: 'Checking…',
    checkedAt: (time: string) => `Checked at ${time}`,
    copy: 'Copy', copied: 'Command copied', copyFailed: 'Could not copy: select the command and copy it',
    status: { ok: 'Ready', required: 'Missing', advice: 'Recommended', invalid: 'Check it', unknown: 'Not checked' },
    label: {
      claude: 'Claude Code installed', login: 'Signed in to Claude Code', skills: 'QA skills',
      chrome: 'Claude in Chrome connected', profile: 'QA profile', jira: 'Jira connected',
    } as Record<SetupCheckId, string>,
    ok: {
      claude: (d: string) => `Version ${d}.`,
      login: () => 'Runs use your account and your plan.',
      skills: (d: string) => `Claude Code has ${d}.`,
      chrome: () => 'Connected to Claude Code. Before launching, sign in with your user on the test sites.',
      profile: (d: string) => `The skills assign tickets and sign reports as ${d}.`,
      jira: (d: string) => `Connected to ${d}.`,
    } as Record<SetupCheckId, (detail: string) => string>,
    fix: {
      claude: () => 'Install it: open Terminal and run this command. Then come back here.',
      login: () => 'In Terminal, sign in with your organization account. Runs use your plan.',
      skills: (d: string) =>
        `${d} is missing. Install the avm-qa-skills plugin from the organization library (claude.ai → Customize → Plugins) or with this command inside Claude Code. If you use other skills, type their exact name in Sites & skills.`,
      chrome: () =>
        'Install the Claude in Chrome extension, sign in with your account and connect it to Claude Code by running this command once in Terminal. Without the browser, runs end in BLOCKED.',
      profile: () =>
        'The skills assign tickets and sign reports with your name. Fill it in below, in My QA profile (your name and accountId come from Jira); without it they use your Jira account.',
      jira: () => 'Connect it in Jira connection: without Jira there are no tickets for the orchestrator.',
    } as Record<SetupCheckId, (detail: string) => string>,
    invalid: 'The profile lacks your name and accountId: fill it in below, in My QA profile.',
    unknown: { claude: '', login: 'Checked once Claude Code is installed.', skills: 'Checked once Claude Code is installed.', chrome: 'Only checked on macOS.', profile: '', jira: '' } as Record<SetupCheckId, string>,
    renamed: (from: string, to: string) => `Name switched to the one Claude Code has: ${from} → ${to}`,
    banner: (what: string) => `Runs with Claude cannot launch: you need to ${what}.`,
    bannerWhat: { claude: 'install Claude Code', login: 'sign in to Claude Code', skills: 'install the QA skills' } as Partial<Record<SetupCheckId, string>>,
    fixIt: 'See how to fix it',
    and: ' and ',
  },
};

type Text = (typeof TEXT)[Lang];

const badge = (check: SetupCheck, t: Text): { text: string; tone: 'ok' | 'bad' | 'warn' | 'muted' } => {
  if (check.status === 'ok') return { text: t.status.ok, tone: 'ok' };
  if (check.status === 'unknown') return { text: t.status.unknown, tone: 'muted' };
  if (check.status === 'invalid') return { text: t.status.invalid, tone: 'warn' };
  return check.required ? { text: t.status.required, tone: 'bad' } : { text: t.status.advice, tone: 'warn' };
};

const explain = (check: SetupCheck, t: Text): string => {
  if (check.status === 'ok') return t.ok[check.id](check.detail);
  if (check.status === 'invalid') return t.invalid;
  if (check.status === 'unknown') return t.unknown[check.id];
  return t.fix[check.id](check.detail);
};

interface SetupCardProps {
  setup: SetupState | null;
  onCheck: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/** Settings card: what this Mac has for runs with Claude, and how to fix what is missing. */
export function SetupCard({ setup, onCheck, onNotice, onError }: SetupCardProps) {
  const lang = useLang();
  const t = useText(TEXT);
  const [working, setWorking] = useState(false);

  const recheck = async (): Promise<void> => {
    setWorking(true);
    try {
      await onCheck();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };
  const copy = async (command: string): Promise<void> => {
    if (await copyText(command)) onNotice(t.copied);
    else onError(t.copyFailed);
  };

  const renamed = setup?.skills.filter((s) => s.renamedFrom) ?? [];
  return (
    <div className="card setup" id="setup" style={{ marginBottom: 12 }}>
      <div className="card-head">
        <h3 style={{ margin: 0 }}>{t.title}</h3>
        {setup && <span className={`pill ${setup.ready ? 'ok' : 'bad'}`}>{setup.ready ? t.ready : t.notReady}</span>}
        <div className="spacer" />
        <button className="btn small" disabled={working} onClick={() => void recheck()}>
          <Icon name="refresh" size={14} /> {working ? t.rechecking : t.recheck}
        </button>
      </div>
      <p className="hint">{t.hint}</p>
      {!setup ? (
        <p className="hint"><span className="spinner" /> {t.checking}</p>
      ) : (
        <>
          <ul className="setup-list" aria-label={t.title}>
            {setup.checks.map((check) => {
              const b = badge(check, t);
              const command = check.status === 'missing' ? COMMANDS[check.id] : undefined;
              return (
                <li key={check.id} className={`setup-row ${b.tone}`}>
                  <span className={`setup-icon ${b.tone}`} aria-hidden="true">
                    <Icon name={b.tone === 'ok' ? 'check' : 'alert'} size={14} />
                  </span>
                  <div className="setup-main">
                    <div className="setup-what">
                      <b>{t.label[check.id]}</b>
                      <span className={`setup-badge ${b.tone}`}>{b.text}</span>
                    </div>
                    {explain(check, t) && <p className="hint">{explain(check, t)}</p>}
                    {command && (
                      <div className="setup-cmd">
                        <code>{command}</code>
                        <button className="btn small" onClick={() => void copy(command)} aria-label={`${t.copy}: ${command}`}>
                          <Icon name="copy" size={13} /> {t.copy}
                        </button>
                      </div>
                    )}
                    {check.id === 'skills' &&
                      renamed.map((s) => <p key={s.kind} className="hint text-ok">{t.renamed(s.renamedFrom!, s.name)}</p>)}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="hint">
            {t.checkedAt(new Date(setup.checkedAt).toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-ES', { hour: '2-digit', minute: '2-digit' }))}
          </p>
        </>
      )}
    </div>
  );
}

/** Dashboard notice while a required check fails: runs with Claude would be refused. */
export function SetupBanner({ setup, onOpenSettings }: { setup: SetupState | null; onOpenSettings: () => void }) {
  const t = useText(TEXT);
  if (!setup || setup.ready) return null;
  const what = setup.checks.filter((c) => c.required && c.status === 'missing').map((c) => t.bannerWhat[c.id] ?? t.label[c.id]);
  return (
    <div className="callout bad setup-banner" role="alert">
      <Icon name="alert" size={15} />
      <span>{t.banner(what.join(t.and))}</span>
      <button className="btn small" onClick={onOpenSettings}>{t.fixIt}</button>
    </div>
  );
}
