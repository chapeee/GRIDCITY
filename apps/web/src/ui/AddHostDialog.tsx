import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useFleetStore } from '../data/fleet-store';
import {
  addHost,
  createKey,
  installKey,
  listKeys,
  probeHost,
  testHost,
  trustHost,
  type HostDraft,
  type HostKeyProbe,
  type LocalKey,
} from '../data/server-api';
import { useUiStore } from './ui-store';

/**
 * "Connect a server": everything that used to need a terminal, as explicit
 * steps. Nothing is trusted, created or installed without a click, and the
 * password (only asked if the server does not accept the key yet) is sent
 * once for that step and never stored.
 *
 *   address -> trust (fingerprint) -> key -> [password once] -> done
 */
type Step = 'address' | 'trust' | 'blocked' | 'key' | 'install' | 'done';

const STEP_LABELS: [Step, string][] = [
  ['address', 'Address'],
  ['trust', 'Trust'],
  ['key', 'Key'],
  ['install', 'Install key'],
  ['done', 'Done'],
];

/** "root@192.168.1.155:22" -> "192.168.1.155", for the name placeholder. */
function addressFromTarget(target: string): string {
  const withoutUser = target.trim().split('@').pop() ?? '';
  if (withoutUser.startsWith('[')) return withoutUser.slice(1, withoutUser.indexOf(']'));
  return (withoutUser.match(/:/g) ?? []).length === 1
    ? (withoutUser.split(':')[0] ?? '')
    : withoutUser;
}

export function AddHostDialog() {
  const open = useUiStore((store) => store.addHostOpen);
  const hosts = useFleetStore((store) => store.hosts);
  const districts = useMemo(() => [...new Set(hosts.map((h) => h.district))].sort(), [hosts]);

  const [step, setStep] = useState<Step>('address');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [district, setDistrict] = useState('');
  const [probe, setProbe] = useState<HostKeyProbe | null>(null);
  const [keys, setKeys] = useState<LocalKey[] | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => firstField.current?.focus(), 0);
  }, [open, step]);

  const reset = () => {
    setStep('address');
    setProbe(null);
    setKeys(null);
    setKeyId(null);
    setPassword('');
    setError(null);
    setBusy(null);
  };
  const close = () => {
    useUiStore.getState().setAddHostOpen(false);
    reset();
  };

  /** Runs one step with a busy label; errors stay on screen. */
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

  const chosenKey = keys?.find((key) => key.id === keyId) ?? null;
  const draft = (): HostDraft => ({
    target,
    name: name.trim() || undefined,
    district: district.trim() || undefined,
    auth:
      chosenKey?.source === 'file' && chosenKey.privatePath
        ? { method: 'keyFile', path: chosenKey.privatePath }
        : { method: 'agent' },
  });

  const loadKeys = async (preferId?: string) => {
    const result = await listKeys();
    setKeys(result.keys);
    const preferred =
      result.keys.find((key) => key.id === preferId && key.usable) ??
      result.keys.find((key) => key.usable);
    setKeyId(preferred?.id ?? null);
  };

  // Step 1 -> read the server's fingerprint.
  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void run('Contacting the server…', async () => {
      const result = await probeHost(target);
      setProbe(result);
      if (result.trust === 'trusted') {
        await loadKeys();
        setStep('key');
      } else if (result.trust === 'unknown') {
        setStep('trust');
      } else {
        setStep('blocked');
      }
    });
  };

  // Step 2 -> the user confirmed the fingerprint.
  const confirmTrust = () =>
    void run('Trusting the server…', async () => {
      if (!probe) return;
      await trustHost(target, probe.fingerprint);
      await loadKeys();
      setStep('key');
    });

  const makeKey = () =>
    void run('Creating a key…', async () => {
      const { key } = await createKey();
      await loadKeys(key?.id);
    });

  const save = async () => {
    const saved = await addHost(draft());
    setSavedName(saved.host.name);
    setStep('done');
    useUiStore
      .getState()
      .showNotice(
        saved.demoMode
          ? `Saved ${saved.host.name}. You're viewing demo data: set DATA_MODE=real and restart to see it.`
          : `${saved.host.name} is connected.`,
      );
  };

  // Step 3 -> does the server accept this key already?
  const tryKey = () =>
    void run('Testing the key…', async () => {
      const test = await testHost(draft());
      if (test.result.ok) return save();
      if (test.result.problem === 'auth') {
        setStep('install');
        return;
      }
      throw new Error(test.advice.join('\n'));
    });

  // Step 4 -> password once, then test and save.
  const submitInstall = (event: FormEvent) => {
    event.preventDefault();
    const secret = password;
    setPassword(''); // never kept in state longer than one attempt
    void run('Installing the key…', async () => {
      if (!keyId) return;
      await installKey(target, keyId, secret);
      const test = await testHost(draft());
      if (!test.result.ok) throw new Error(test.advice.join('\n'));
      await save();
    });
  };

  const stepIndex = STEP_LABELS.findIndex(([id]) => id === (step === 'blocked' ? 'trust' : step));
  const endpointText = probe
    ? `${probe.endpoint.user}@${probe.endpoint.address}${probe.endpoint.port === 22 ? '' : `:${probe.endpoint.port}`}`
    : target;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
        >
          <motion.section
            className="add-host"
            role="dialog"
            aria-label="Connect a server"
            initial={{ y: 12 }}
            animate={{ y: 0 }}
            exit={{ y: 12 }}
          >
            <header>
              <h2>Connect a server</h2>
              <button type="button" onClick={close}>
                Close <kbd>Esc</kbd>
              </button>
            </header>

            <ol className="wizard-steps" aria-label="Progress">
              {STEP_LABELS.map(([id, label], index) => (
                <li
                  key={id}
                  className={
                    index < stepIndex ? 'is-done' : index === stepIndex ? 'is-current' : ''
                  }
                >
                  {label}
                </li>
              ))}
            </ol>

            {step === 'address' && (
              <form className="wizard-body" onSubmit={submitAddress}>
                <label className="field">
                  <span>SSH address</span>
                  <input
                    ref={firstField}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="root@192.168.1.155"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <small>user@host or user@host:port, as you would type after ssh</small>
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Name</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={addressFromTarget(target) || 'web-01'}
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>District</span>
                    <input
                      value={district}
                      onChange={(e) => setDistrict(e.target.value)}
                      placeholder="Home lab"
                      list="known-districts"
                    />
                    <datalist id="known-districts">
                      {districts.map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                  </label>
                </div>
                <footer>
                  <button
                    type="submit"
                    className="button-primary"
                    disabled={!!busy || !target.trim()}
                  >
                    {busy ?? 'Next'}
                  </button>
                </footer>
              </form>
            )}

            {step === 'trust' && probe && (
              <div className="wizard-body">
                <p>
                  First time connecting to <strong>{endpointText}</strong>. This is the
                  server&apos;s identity:
                </p>
                <p className="fingerprint">
                  <span>{probe.keyType}</span>
                  <code>{probe.fingerprint}</code>
                </p>
                <p className="wizard-hint">
                  To be sure it is really your server, compare it with what the server shows for
                  itself (on the server:{' '}
                  <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>) or your
                  provider&apos;s console. Trusting it adds it to your known_hosts, exactly like
                  answering &quot;yes&quot; in ssh.
                </p>
                <footer>
                  <button type="button" onClick={reset} disabled={!!busy}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={confirmTrust}
                    disabled={!!busy}
                  >
                    {busy ?? 'Yes, this is my server'}
                  </button>
                </footer>
              </div>
            )}

            {step === 'blocked' && probe && (
              <div className="wizard-body">
                <p className="wizard-warning">
                  {probe.trust === 'revoked'
                    ? `The key presented by ${endpointText} is revoked in your known_hosts. Refusing to connect.`
                    : `The identity of ${endpointText} CHANGED since you last trusted it (now ${probe.fingerprint}). This could be an attack, or the server was reinstalled.`}
                </p>
                <p className="wizard-hint">
                  The app never replaces a known key. If the change is expected, confirm the new
                  fingerprint with the server owner, remove the old entry with{' '}
                  <code>
                    ssh-keygen -R{' '}
                    {probe.endpoint.port === 22
                      ? probe.endpoint.address
                      : `[${probe.endpoint.address}]:${probe.endpoint.port}`}
                  </code>
                  , then start again.
                </p>
                <footer>
                  <button type="button" onClick={reset}>
                    Start again
                  </button>
                </footer>
              </div>
            )}

            {step === 'key' && (
              <div className="wizard-body">
                <p>Which key should the app log in with?</p>
                {keys && keys.length > 0 ? (
                  <div className="key-list" role="radiogroup" aria-label="Keys">
                    {keys.map((key) => (
                      <label
                        key={key.id}
                        className={`key-option${key.usable ? '' : ' is-disabled'}`}
                      >
                        <input
                          type="radio"
                          name="key"
                          checked={keyId === key.id}
                          disabled={!key.usable}
                          onChange={() => setKeyId(key.id)}
                        />
                        <span className="key-label">{key.label}</span>
                        <small>{key.note ?? key.fingerprint}</small>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="wizard-hint">You don&apos;t have an SSH key yet.</p>
                )}
                <button type="button" onClick={makeKey} disabled={!!busy}>
                  Create a new key for this app
                </button>
                <p className="wizard-hint">
                  New keys go to your SSH folder like ssh-keygen would make them, without a
                  passphrase so they also work in Docker. A key only opens servers it is installed
                  on.
                </p>
                <footer>
                  <button type="button" onClick={reset} disabled={!!busy}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={tryKey}
                    disabled={!!busy || !keyId}
                  >
                    {busy ?? 'Continue'}
                  </button>
                </footer>
              </div>
            )}

            {step === 'install' && chosenKey && (
              <form className="wizard-body" onSubmit={submitInstall}>
                <p>
                  <strong>{endpointText}</strong> doesn&apos;t accept this key yet. Enter its
                  password
                  <strong> once</strong> and the app adds the key to the server&apos;s
                  authorized_keys. After that, the key logs in on its own.
                </p>
                <label className="field">
                  <span>Password for {endpointText}</span>
                  <input
                    ref={firstField}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                    required
                  />
                  <small>Used for this one step only. Never saved, logged or shown.</small>
                </label>
                <footer>
                  <button type="button" onClick={() => setStep('key')} disabled={!!busy}>
                    Back
                  </button>
                  <button type="submit" className="button-primary" disabled={!!busy || !password}>
                    {busy ?? 'Install key and connect'}
                  </button>
                </footer>
              </form>
            )}

            {step === 'done' && (
              <div className="wizard-body">
                <p className="wizard-success">
                  {savedName} is connected. Its tower lights up as the first metrics arrive.
                </p>
                <footer>
                  <button
                    type="button"
                    onClick={() => {
                      reset();
                      setTarget('');
                      setName('');
                    }}
                  >
                    Connect another
                  </button>
                  <button type="button" className="button-primary" onClick={close}>
                    Done
                  </button>
                </footer>
              </div>
            )}

            {error && (
              <p className="add-host-error" role="alert">
                {error}
              </p>
            )}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
