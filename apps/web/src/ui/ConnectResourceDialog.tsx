import { detectProvider, type Fix } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { fetchMeta } from '../data/server-api';
import {
  addResource,
  testResource,
  type OneTimeSecrets,
  type ResourceTestResult,
} from '../data/resource-api';
import {
  buildDraft,
  pointsAtLocalhost,
  RESOURCE_KINDS,
  S3_PROVIDERS,
  slugify,
  type KindSpec,
  type PasswordSource,
} from './resource-draft';
import { formatMetric } from './ResourceHud';
import { DoctorReportView } from './DoctorReportView';
import { useUiStore } from './ui-store';

/**
 * "Connect a database or bucket": pick a kind, fill a short form, test it
 * with one real read-only poll, add it. Nothing secret is saved: the entry
 * only names where a password lives (an environment variable or a file).
 * A password typed for the test is sent with that one request and dropped.
 */
export function ConnectResourceDialog() {
  const open = useUiStore((store) => store.connectResourceOpen);
  return (
    <AnimatePresence>{open && <ConnectResourceForm key="connect-resource" />}</AnimatePresence>
  );
}

function ConnectResourceForm() {
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const districts = useMemo(
    () =>
      [...new Set([...hosts.map((h) => h.district), ...resources.map((r) => r.district)])].sort(),
    [hosts, resources],
  );
  const [spec, setSpec] = useState<KindSpec | null>(null);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [district, setDistrict] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [provider, setProvider] = useState<string>('aws');
  const [passwordSource, setPasswordSource] = useState<PasswordSource>('typed');
  const [passwordRef, setPasswordRef] = useState('');
  const [secrets, setSecrets] = useState<OneTimeSecrets>({});
  const [result, setResult] = useState<ResourceTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inContainer, setInContainer] = useState(false);
  const [extras, setExtras] = useState<Record<string, unknown>>({});
  const resultRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMeta()
      .then((meta) => !cancelled && setInContainer(meta.inContainer === true))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The result sits under the form: bring it into view so a test never looks silent.
  useEffect(() => {
    if (result || error)
      resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [result, error]);

  const close = () => useUiStore.getState().setConnectResourceOpen(false);

  const choose = (next: KindSpec) => {
    setSpec(next);
    setValues(
      Object.fromEntries(
        next.fields.filter((f) => f.initial !== undefined).map((f) => [f.key, f.initial!]),
      ),
    );
    setPasswordSource(next.password ? 'typed' : 'none');
    setPasswordRef('');
    setSecrets({});
    setExtras({});
    setResult(null);
    setError(null);
    if (!district)
      setDistrict(
        next.kind === 's3'
          ? 'Object storage'
          : next.kind === 'rds' || next.kind === 'loadbalancer'
            ? ''
            : next.kind === 'http' || next.kind === 'tcp'
              ? 'Edge'
              : 'Databases',
      );
  };

  const draft = (
    formValues: Record<string, string | boolean> = values,
    doctorExtras: Record<string, unknown> = extras,
  ) => ({
    ...buildDraft({
      kind: spec!.kind,
      id: id || slugify(name),
      name,
      district,
      values: formValues,
      passwordSource,
      passwordRef,
      provider,
    }),
    // Doctor settings without a field in this form (e.g. Mongo authSource, S3 path style).
    ...doctorExtras,
  });

  // A typed password is sent only when the password comes from the field (not env/file).
  const credentials = (from: OneTimeSecrets = secrets): OneTimeSecrets => ({
    ...from,
    password: passwordSource === 'typed' ? from.password : undefined,
  });

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // State updates land after this render, so a re-test right after a fix gets its inputs passed in.
  const test = (override?: {
    values: Record<string, string | boolean>;
    extras: Record<string, unknown>;
    secrets: OneTimeSecrets;
  }) =>
    run('Testing…', async () => {
      const entry = override ? draft(override.values, override.extras) : draft();
      setResult(await testResource(entry, credentials(override?.secrets)));
    });

  /** A proven Doctor fix: put its settings in the form, then test again. */
  const applyFix = (fix: Fix) => {
    if (!fix.patch || !spec) return;
    const formKeys = new Set(spec.fields.map((field) => field.key));
    const next = { ...values };
    const nextExtras = { ...extras };
    let nextSecrets = secrets;
    for (const [key, value] of Object.entries(fix.patch)) {
      if (key === 'passwordSecret' || key === 'passwordEnv' || key === 'passwordFile') {
        nextSecrets = { ...nextSecrets, password: '' };
        continue;
      }
      if (!formKeys.has(key)) {
        if (value === undefined || value === null) delete nextExtras[key];
        else nextExtras[key] = value;
        continue;
      }
      if (value === undefined || value === null) next[key] = '';
      else next[key] = typeof value === 'boolean' ? value : String(value);
    }
    setValues(next);
    setExtras(nextExtras);
    setSecrets(nextSecrets);
    void test({ values: next, extras: nextExtras, secrets: nextSecrets });
  };

  // Prevention: recognise managed services from the host and say what they need.
  const hostValue = String(values.host ?? values.url ?? '');
  const providerProfile = spec ? detectProvider(spec.kind, hostValue) : null;
  const providerMismatch =
    providerProfile &&
    ((providerProfile.tlsRequired && values.tls !== true && spec?.kind !== 'mongodb') ||
      (providerProfile.port !== undefined &&
        'port' in values &&
        String(values.port) !== String(providerProfile.port)));
  const applyProvider = () => {
    if (!providerProfile) return;
    setValues((current) => ({
      ...current,
      ...(providerProfile.tlsRequired ? { tls: true } : {}),
      ...(providerProfile.port !== undefined && 'port' in current
        ? { port: String(providerProfile.port) }
        : {}),
    }));
    setResult(null);
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    void run('Adding…', async () => {
      const entry = draft();
      await addResource(entry, credentials());
      // Typed credentials are now in the server's encrypted vault; the form forgets them.
      useUiStore
        .getState()
        .showNotice(`Added ${entry.name ?? entry.id}. It appears in the city in a moment.`);
      close();
    });
  };

  const setValue = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
    setResult(null);
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // Outside clicks close the kind picker only: once a form is open, a stray click
      // (say, where a button was before the result box changed height) must not lose it.
      onMouseDown={(event) => event.target === event.currentTarget && !spec && close()}
    >
      <motion.form
        className="add-host connect-resource"
        role="dialog"
        aria-label="Connect a server, database, bucket, probe or load balancer"
        initial={{ y: 12 }}
        animate={{ y: 0 }}
        onSubmit={add}
      >
        <header>
          <h2>
            {spec
              ? `Connect ${spec.label}`
              : 'Connect a server, database, bucket, probe or load balancer'}
          </h2>
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </header>

        {!spec && (
          <>
            <p className="settings-help">
              Read-only: the app only reads statistics, never your rows or objects. Passwords and
              keys you type here are saved encrypted on this machine, never in a config file.
            </p>
            <div className="kind-grid">
              <button
                type="button"
                className="kind-tile is-ssh"
                onClick={() => {
                  // Servers have their own guided setup (key, host key check, test).
                  close();
                  useUiStore.getState().setAddHostOpen(true);
                }}
              >
                <span className="kind-tile-title">SSH server</span>
                <span className="kind-tile-blurb">
                  Linux server or VM: CPU, memory, disks, services, terminal and security checks
                </span>
              </button>
              {RESOURCE_KINDS.map((kind) => (
                <button
                  key={kind.kind}
                  type="button"

                  className="kind-tile"
                  onClick={() => choose(kind)}
                >
                  <span className="kind-tile-title">{kind.label}</span>
                  <span className="kind-tile-blurb">{kind.blurb}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {spec && (
          <>
            <button type="button" className="link-button" onClick={() => setSpec(null)}>
              ← other kind
            </button>
            <fieldset disabled={busy !== null}>
              <label className="settings-field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!idEdited) setId(slugify(event.target.value));
                  }}
                  placeholder={
                    spec.kind === 's3' || spec.kind === 'rds'
                      ? 'e.g. aws-prod'
                      : spec.kind === 'loadbalancer'
                        ? 'e.g. shop-prod'
                        : spec.kind === 'http' || spec.kind === 'tcp'
                          ? 'e.g. shop-health'
                          : 'e.g. orders-db'
                  }
                  required
                  maxLength={80}
                />
              </label>
              <label className="settings-field">
                <span>Id</span>
                <input
                  value={id}
                  onChange={(event) => {
                    setId(slugify(event.target.value));
                    setIdEdited(true);
                  }}
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                />
                <span className="settings-help">
                  stable: place in the city and history follow it
                </span>
              </label>
              <label className="settings-field">
                <span>District</span>
                <input
                  value={district}
                  onChange={(event) => setDistrict(event.target.value)}
                  list="connect-resource-districts"
                  placeholder={
                    spec.kind === 'rds'
                      ? 'default: RDS · <region>'
                      : spec.kind === 'loadbalancer'
                        ? 'default: AWS · <region>'
                        : ''
                  }
                />
                <datalist id="connect-resource-districts">
                  {districts.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              </label>

              {spec.kind === 's3' && (
                <label className="settings-field">
                  <span>Provider</span>
                  <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                    {S3_PROVIDERS.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {spec.fields
                .filter((field) => !field.advanced)
                .map((field) =>
                  field.type === 'checkbox' ? (
                    <label key={field.key} className="settings-field is-check">
                      <span>{field.label}</span>
                      <input
                        type="checkbox"
                        checked={values[field.key] === true}
                        onChange={(event) => setValue(field.key, event.target.checked)}
                      />
                    </label>
                  ) : field.type === 'textarea' ? (
                    <label key={field.key} className="settings-field is-wide">
                      <span>{field.label}</span>
                      <textarea
                        rows={3}
                        spellCheck={false}
                        value={
                          typeof values[field.key] === 'string' ? (values[field.key] as string) : ''
                        }
                        onChange={(event) => setValue(field.key, event.target.value)}
                        placeholder={field.placeholder}
                      />
                    </label>
                  ) : (
                    <label key={field.key} className="settings-field">
                      <span>{field.label}</span>
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={
                          typeof values[field.key] === 'string' ? (values[field.key] as string) : ''
                        }
                        onChange={(event) => setValue(field.key, event.target.value)}
                        placeholder={
                          field.key === 'endpoint' && spec.kind === 's3'
                            ? (S3_PROVIDERS.find((p) => p.id === provider)?.endpoint ??
                              field.placeholder)
                            : field.placeholder
                        }
                        required={field.required === true}
                      />
                      {field.help && <span className="settings-help">{field.help}</span>}
                    </label>
                  ),
                )}
              {providerProfile && (
                <div className={`provider-note${providerMismatch ? ' is-warning' : ''}`}>
                  <strong>{providerProfile.name}</strong> · {providerProfile.note}
                  {providerMismatch && (
                    <button type="button" onClick={applyProvider}>
                      Use its settings
                      {providerProfile.tlsRequired ? ' (TLS on' : ' ('}
                      {providerProfile.port !== undefined ? `, port ${providerProfile.port})` : ')'}
                    </button>
                  )}
                </div>
              )}
              {inContainer && pointsAtLocalhost(values) && (
                <p className="settings-help is-warning">
                  If the app runs in Docker, “localhost” is the container itself: use
                  host.docker.internal for a database on this computer.
                </p>
              )}
            </fieldset>

            {spec.password && (
              <fieldset disabled={busy !== null}>
                <legend>Password</legend>
                {passwordSource === 'typed' ? (
                  <label className="settings-field">
                    <span>Password</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={secrets.password ?? ''}
                      onChange={(event) => {
                        setSecrets((s) => ({ ...s, password: event.target.value }));
                        setResult(null);
                      }}
                      placeholder="paste it here"
                    />
                    <span className="settings-help">
                      Saved encrypted on this machine. Leave empty if there is none.
                    </span>
                  </label>
                ) : (
                  <p className="settings-help">
                    Read from {passwordSource === 'env' ? 'an environment variable' : 'a file'}{' '}
                    (Advanced below).
                  </p>
                )}
              </fieldset>
            )}

            {spec.keys && (
              <fieldset disabled={busy !== null}>
                <legend>Access keys</legend>
                <label className="settings-field">
                  <span>Access key</span>
                  <input
                    autoComplete="off"
                    spellCheck={false}
                    value={secrets.accessKeyId ?? ''}
                    onChange={(event) => {
                      setSecrets((s) => ({ ...s, accessKeyId: event.target.value }));
                      setResult(null);
                    }}
                    placeholder={spec.kind === 's3' ? 'DO00… or AKIA…' : 'AKIA…'}
                  />
                </label>
                <label className="settings-field">
                  <span>Secret key</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={secrets.secretAccessKey ?? ''}
                    onChange={(event) => {
                      setSecrets((s) => ({ ...s, secretAccessKey: event.target.value }));
                      setResult(null);
                    }}
                  />
                  <span className="settings-help">
                    Saved encrypted on this machine. Leave both empty to use this machine&apos;s own
                    AWS credentials (~/.aws, environment, instance role).
                  </span>
                </label>
              </fieldset>
            )}

            {(spec.password || spec.fields.some((field) => field.advanced)) && (
              <details className="connect-advanced">
                <summary>Advanced: environment variables, files, AWS profiles</summary>
                <fieldset disabled={busy !== null}>
                  {spec.password && (
                    <label className="settings-field">
                      <span>Password from</span>
                      <select
                        value={passwordSource}
                        onChange={(event) =>
                          setPasswordSource(event.target.value as PasswordSource)
                        }
                      >
                        <option value="typed">the field above (saved encrypted)</option>
                        <option value="env">an environment variable</option>
                        <option value="file">a file</option>
                        <option value="none">no password</option>
                      </select>
                    </label>
                  )}
                  {spec.password && (passwordSource === 'env' || passwordSource === 'file') && (
                    <>
                      <label className="settings-field">
                        <span>{passwordSource === 'env' ? 'Variable name' : 'File path'}</span>
                        <input
                          value={passwordRef}
                          onChange={(event) => setPasswordRef(event.target.value)}
                          placeholder={
                            passwordSource === 'env'
                              ? 'ORDERS_DB_PASSWORD'
                              : '/config/secrets/orders-db'
                          }
                        />
                        <span className="settings-help">
                          For setups that already manage secrets outside the app.
                        </span>
                      </label>
                      <label className="settings-field">
                        <span>Password for this test</span>
                        <input
                          type="password"
                          autoComplete="off"
                          value={secrets.password ?? ''}
                          onChange={(event) =>
                            setSecrets((s) => ({ ...s, password: event.target.value }))
                          }
                        />
                        <span className="settings-help">optional; used for Test only</span>
                      </label>
                    </>
                  )}
                  {spec.fields
                    .filter((field) => field.advanced)
                    .map((field) => (
                      <label key={field.key} className="settings-field">
                        <span>{field.label}</span>
                        <input
                          value={
                            typeof values[field.key] === 'string'
                              ? (values[field.key] as string)
                              : ''
                          }
                          onChange={(event) => setValue(field.key, event.target.value)}
                          placeholder={field.placeholder}
                        />
                      </label>
                    ))}
                  {spec.keys && (
                    <p className="settings-help">
                      Keys typed above take precedence over variables and profiles.
                    </p>
                  )}
                </fieldset>
              </details>
            )}

            {Object.keys(extras).length > 0 && (
              <p className="settings-help">
                Set by the Doctor (saved with the entry; change later under Edit):{' '}
                {Object.entries(extras).map(([key, value], index) => (
                  <span key={key}>
                    {index > 0 && ', '}
                    <code>
                      {key}: {String(value)}
                    </code>
                  </span>
                ))}{' '}
                <button type="button" className="link-button" onClick={() => setExtras({})}>
                  undo
                </button>
              </p>
            )}

            {spec.grant && (
              <p className="settings-help">
                Recommended read-only access: <code>{spec.grant}</code>
              </p>
            )}

            {result && (
              <section
                ref={resultRef}
                className={`connect-result${result.ok ? ' is-ok' : ' is-error'}`}
                aria-live="polite"
              >
                <h3>{result.ok ? 'Connected' : 'Test failed'}</h3>
                {result.error && <p>{result.error}</p>}
                <ul>
                  {result.found.map((entry) => (
                    <li key={entry.name}>
                      <strong>{entry.name}</strong> · {entry.engine} ·{' '}
                      {entry.ok
                        ? entry.metrics
                            .slice(0, 6)
                            .map((m) => `${m.label} ${formatMetric(m)}`)
                            .join(' · ')
                        : entry.error}
                    </li>
                  ))}
                </ul>
                {!result.ok && result.doctor && (
                  <>
                    <h3 className="doctor-title">Doctor</h3>
                    <DoctorReportView
                      report={result.doctor}
                      onApply={applyFix}
                      applying={busy === 'Testing…' ? 'any' : null}
                    />
                  </>
                )}
              </section>
            )}
            {error && (
              <p
                className="add-host-error"
                role="alert"
                ref={(node) => {
                  if (!result) resultRef.current = node;
                }}
              >
                {error}
              </p>
            )}

            <footer>
              <button type="button" onClick={() => void test()} disabled={busy !== null}>
                {busy === 'Testing…' ? busy : 'Test connection'}
              </button>
              <button type="submit" className="button-primary" disabled={busy !== null}>
                {busy === 'Adding…' ? busy : 'Add to the city'}
              </button>
            </footer>
          </>
        )}
      </motion.form>
    </motion.div>
  );
}
