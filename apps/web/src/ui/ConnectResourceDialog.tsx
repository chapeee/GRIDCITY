import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState, type FormEvent } from 'react';
import { useFleetStore } from '../data/fleet-store';
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
  const [passwordSource, setPasswordSource] = useState<PasswordSource>('env');
  const [passwordRef, setPasswordRef] = useState('');
  const [secrets, setSecrets] = useState<OneTimeSecrets>({});
  const [result, setResult] = useState<ResourceTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const close = () => useUiStore.getState().setConnectResourceOpen(false);

  const choose = (next: KindSpec) => {
    setSpec(next);
    setValues(
      Object.fromEntries(
        next.fields.filter((f) => f.initial !== undefined).map((f) => [f.key, f.initial!]),
      ),
    );
    setPasswordSource(next.password ? 'env' : 'none');
    setPasswordRef('');
    setSecrets({});
    setResult(null);
    setError(null);
    if (!district)
      setDistrict(next.kind === 's3' ? 'Object storage' : next.kind === 'rds' ? '' : 'Databases');
  };

  const draft = () =>
    buildDraft({
      kind: spec!.kind,
      id: id || slugify(name),
      name,
      district,
      values,
      passwordSource,
      passwordRef,
      provider,
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

  const test = () =>
    run('Testing…', async () => {
      setResult(await testResource(draft(), secrets));
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    void run('Adding…', async () => {
      const entry = draft();
      await addResource(entry);
      // Typed secrets are dropped with the form; nothing else holds them.
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
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <motion.form
        className="add-host connect-resource"
        role="dialog"
        aria-label="Connect a database or bucket"
        initial={{ y: 12 }}
        animate={{ y: 0 }}
        onSubmit={add}
      >
        <header>
          <h2>{spec ? `Connect ${spec.label}` : 'Connect a database or bucket'}</h2>
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </header>

        {!spec && (
          <>
            <p className="settings-help">
              Read-only: the app only reads statistics, never your rows or objects. Passwords are
              never saved; you choose where they live.
            </p>
            <div className="kind-grid">
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
                    spec.kind === 's3' || spec.kind === 'rds' ? 'e.g. aws-prod' : 'e.g. orders-db'
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
                  placeholder={spec.kind === 'rds' ? 'default: RDS · <region>' : ''}
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

              {spec.fields.map((field) =>
                field.type === 'checkbox' ? (
                  <label key={field.key} className="settings-field is-check">
                    <span>{field.label}</span>
                    <input
                      type="checkbox"
                      checked={values[field.key] === true}
                      onChange={(event) => setValue(field.key, event.target.checked)}
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
              {pointsAtLocalhost(values) && (
                <p className="settings-help is-warning">
                  If the app runs in Docker, “localhost” is the container itself: use
                  host.docker.internal for a database on this computer.
                </p>
              )}
            </fieldset>

            {spec.password && (
              <fieldset disabled={busy !== null}>
                <legend>Password</legend>
                <div className="segmented" role="radiogroup" aria-label="Where the password lives">
                  {(
                    [
                      ['env', 'Environment variable'],
                      ['file', 'File'],
                      ['none', 'No password'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={passwordSource === value}
                      aria-pressed={passwordSource === value}
                      onClick={() => setPasswordSource(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {passwordSource !== 'none' && (
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
                      {passwordSource === 'env'
                        ? 'Set it where the app runs (Docker: add NAME=… to .env, then docker compose up -d).'
                        : 'First line of the file. In Docker, a file in ./config is /config/… inside.'}
                    </span>
                  </label>
                )}
                {passwordSource !== 'none' && (
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
                    <span className="settings-help">optional; used for Test only, never saved</span>
                  </label>
                )}
              </fieldset>
            )}

            {spec.kind === 's3' && (
              <fieldset disabled={busy !== null}>
                <legend>Keys for this test (optional)</legend>
                <label className="settings-field">
                  <span>Access key</span>
                  <input
                    autoComplete="off"
                    value={secrets.accessKeyId ?? ''}
                    onChange={(event) =>
                      setSecrets((s) => ({ ...s, accessKeyId: event.target.value }))
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Secret key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={secrets.secretAccessKey ?? ''}
                    onChange={(event) =>
                      setSecrets((s) => ({ ...s, secretAccessKey: event.target.value }))
                    }
                  />
                  <span className="settings-help">used for Test only, never saved</span>
                </label>
              </fieldset>
            )}

            {spec.grant && (
              <p className="settings-help">
                Recommended read-only access: <code>{spec.grant}</code>
              </p>
            )}

            {result && (
              <section
                className={`connect-result${result.ok ? ' is-ok' : ' is-error'}`}
                aria-live="polite"
              >
                <h3>{result.ok ? 'Connected' : 'Could not connect'}</h3>
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
              </section>
            )}
            {error && (
              <p className="add-host-error" role="alert">
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
