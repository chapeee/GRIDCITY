import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useFleetStore } from '../data/fleet-store';
import {
  addHost,
  createKey,
  importKey,
  installKey,
  listKeys,
  probeHost,
  testHost,
  trustHost,
  type HostDraft,
  type HostKeyProbe,
  type LocalKey,
} from '../data/server-api';
import { DEFAULT_PROVIDER, findProvider, SERVER_PROVIDERS } from './server-providers';
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

/** "ubuntu@1.2.3.4:22" -> "1.2.3.4:22" (the target without its user). */
function withoutUser(target: string): string {
  const at = target.lastIndexOf('@');
  return at === -1 ? target.trim() : target.slice(at + 1).trim();
}

/** "ubuntu@1.2.3.4" -> "ubuntu", or null when no user was typed. */
function userOf(target: string): string | null {
  const at = target.lastIndexOf('@');
  return at === -1 ? null : target.slice(0, at).trim() || null;
}

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
  const [providerId, setProviderId] = useState(DEFAULT_PROVIDER.id);
  const provider = findProvider(providerId);
  const [target, setTarget] = useState('');
  /** The target with the user that worked (found automatically for cloud images). */
  const [workingTarget, setWorkingTarget] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Optional bastion ("ec2-user@bastion…"); the server is reached through it. */
  const [jumpTarget, setJumpTarget] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** Whose identity the trust step is showing: the server or its jump host. */
  const [probeRole, setProbeRole] = useState<'server' | 'jump'>('server');
  /** Behind a jump host, the server is probed once a key is chosen. */
  const [serverTrusted, setServerTrusted] = useState(false);
  const jump = jumpTarget.trim();
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
    setWorkingTarget(null);
    setCopied(false);
    setProbeRole('server');
    setServerTrusted(false);
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
  const draft = (forTarget: string = workingTarget ?? target): HostDraft => ({
    target: forTarget,
    ...(jump ? { jump: { target: jump } } : {}),
    name: name.trim() || undefined,
    district: district.trim() || undefined,
    auth:
      chosenKey?.source === 'file' && (chosenKey.configPath ?? chosenKey.privatePath)
        ? { method: 'keyFile', path: (chosenKey.configPath ?? chosenKey.privatePath)! }
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
    void run(jump ? 'Contacting the jump host…' : 'Contacting the server…', async () => {
      const result = await probeHost(jump || target);
      setProbe(result);
      setProbeRole(jump ? 'jump' : 'server');
      if (!jump) setServerTrusted(result.trust === 'trusted');
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
      if (probeRole === 'jump') {
        await trustHost(jump, probe.fingerprint);
        await loadKeys();
        setStep('key');
        return;
      }
      const via = jump && keyId ? { target: jump, keyId } : undefined;
      await trustHost(serverProbeTarget(), probe.fingerprint, via);
      setServerTrusted(true);
      if (via) {
        // Behind a jump host the key was already chosen: carry on testing it.
        setStep('key');
        await testKey();
      } else {
        await loadKeys();
        setStep('key');
      }
    });

  /** The address the server is probed with (its user does not matter here). */
  const serverProbeTarget = () => target.trim();

  const keyFileInput = useRef<HTMLInputElement>(null);

  /** The user picked a key file (.pem, .ppk, id_*): upload it and select it. */
  const uploadKey = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // picking the same file again still fires
    if (!file) return;
    void run('Reading the key…', async () => {
      if (file.size > 64 * 1024) throw new Error('That file is too large to be an SSH key.');
      const content = await file.text().catch(() => {
        throw new Error(
          `Your computer would not let the browser read "${file.name}". Its file permissions are probably locked down: copy the key to a normal folder (or give your user read access), then upload it again.`,
        );
      });
      const { key } = await importKey(file.name, content);
      await loadKeys(key?.id);
    });
  };

  const makeKey = () =>
    void run('Creating a key…', async () => {
      const { key } = await createKey();
      await loadKeys(key?.id);
    });

  const save = async (forTarget?: string) => {
    const saved = await addHost(draft(forTarget));
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

  // Step 3 -> does the server accept this key? Finds the user name for
  // cloud images (AWS: ubuntu, ec2-user, admin…) when none was typed.
  const tryKey = () => void run('Testing the key…', testKey);

  const testKey = async () => {
    if (jump && !serverTrusted && keyId) {
      setBusy('Reaching the server through the jump host…');
      const result = await probeHost(serverProbeTarget(), { target: jump, keyId });
      setProbe(result);
      setProbeRole('server');
      if (result.trust === 'unknown') return setStep('trust');
      if (result.trust !== 'trusted') return setStep('blocked');
      setServerTrusted(true);
    }
    {
      const address = withoutUser(target);
      const queue = userOf(target)
        ? [target.trim()]
        : provider.users.length > 0
          ? provider.users.map((user) => `${user}@${address}`)
          : [target.trim()];
      const firstChoice = queue[0]!;
      const tried = new Set<string>();

      while (queue.length > 0) {
        const candidate = queue.shift()!;
        if (tried.has(candidate)) continue;
        tried.add(candidate);
        const user = userOf(candidate);
        if (user) setBusy(`Trying ${user}…`);
        const test = await testHost(draft(candidate));
        if (test.result.ok) {
          setWorkingTarget(candidate);
          return save(candidate);
        }
        if (test.result.problem === 'wrong-user' && test.result.suggestedUser) {
          queue.unshift(`${test.result.suggestedUser}@${address}`); // the image told us
          continue;
        }
        if (test.result.problem === 'auth') continue; // try the next user
        throw new Error(test.advice.join('\n'));
      }

      // Nobody accepted the key.
      if (provider.passwords && !jump) {
        setWorkingTarget(firstChoice);
        setStep('install');
        return;
      }
      const users = [...tried].map((candidate) => userOf(candidate) ?? '?').join(', ');
      throw new Error(
        provider.pasteKeyHelp
          ? `The server did not accept this key (as ${users}). Copy the public key and add it as described above, then press Continue again.`
          : `The server did not accept this key as ${users}. Pick the key pair this server was created with, or type the user name in the address (user@host).`,
      );
    }
  };

  /** Copies the chosen key's public half, in the format the provider wants. */
  const copyPublicKey = async () => {
    if (!chosenKey?.publicKey) return;
    const user = userOf(target);
    const text =
      provider.pasteWithUser && user
        ? `${user}:${chosenKey.publicKey.split(' ').slice(0, 2).join(' ')} ${user}`
        : chosenKey.publicKey;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError(`Could not copy automatically. The public key is: ${text}`);
    }
  };

  // Step 4 -> password once, then test and save.
  const submitInstall = (event: FormEvent) => {
    event.preventDefault();
    const secret = password;
    setPassword(''); // never kept in state longer than one attempt
    void run('Installing the key…', async () => {
      if (!keyId) return;
      await installKey(workingTarget ?? target, keyId, secret);
      const test = await testHost(draft());
      if (!test.result.ok) throw new Error(test.advice.join('\n'));
      await save();
    });
  };

  const stepIndex = STEP_LABELS.findIndex(([id]) => id === (step === 'blocked' ? 'trust' : step));
  const shownTarget = workingTarget ?? target;
  const shownUser = userOf(shownTarget);
  const endpointText = probe
    ? `${shownUser ? `${shownUser}@` : ''}${probe.endpoint.address}${probe.endpoint.port === 22 ? '' : `:${probe.endpoint.port}`}`
    : shownTarget;

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
                  <span>Where is this server?</span>
                  <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                    {SERVER_PROVIDERS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>SSH address</span>
                  <input
                    ref={firstField}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder={
                      provider.users.length > 0
                        ? '13.204.32.177 or a host name'
                        : provider.id === 'gcp'
                          ? 'yourname@34.120.1.2'
                          : 'user@192.168.1.155'
                    }
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <small>
                    {provider.users.length > 0
                      ? `IP or host name. The user is optional: the app tries ${provider.users.slice(0, 3).join(', ')}${provider.users.length > 3 ? '…' : ''} for you.`
                      : 'user@host or user@host:port, as you would type after ssh'}
                  </small>
                </label>
                {showAdvanced ? (
                  <label className="field">
                    <span>Jump host (bastion)</span>
                    <input
                      value={jumpTarget}
                      onChange={(e) => setJumpTarget(e.target.value)}
                      placeholder="ec2-user@bastion.example.com"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <small>
                      For servers without a public SSH port: the app connects through this host
                      (like ssh -J), using the same key. Leave empty to connect directly.
                    </small>
                  </label>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setShowAdvanced(true)}
                  >
                    Reach it through a jump host (bastion)…
                  </button>
                )}
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
                  First time connecting to{' '}
                  {probeRole === 'jump' ? (
                    <>
                      the jump host <strong>{jump}</strong>
                    </>
                  ) : (
                    <strong>{endpointText}</strong>
                  )}
                  . This is its identity:
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
                <p className="wizard-hint">{provider.keyHelp}</p>
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
                <div className="key-actions">
                  <button
                    type="button"
                    onClick={() => keyFileInput.current?.click()}
                    disabled={!!busy}
                  >
                    Upload a key file…
                  </button>
                  <button type="button" onClick={makeKey} disabled={!!busy}>
                    Create a new key for this app
                  </button>
                  <input
                    ref={keyFileInput}
                    type="file"
                    className="visually-hidden"
                    aria-label="Key file"
                    accept=".pem,.ppk,.key,application/x-pem-file,text/plain,*/*"
                    onChange={uploadKey}
                    tabIndex={-1}
                  />
                </div>
                {chosenKey?.publicKey && provider.pasteKeyHelp && (
                  <div className="paste-key">
                    <button type="button" onClick={() => void copyPublicKey()} disabled={!!busy}>
                      {copied ? 'Copied ✓' : 'Copy public key'}
                    </button>
                    <small>{provider.pasteKeyHelp}</small>
                  </div>
                )}
                <p className="wizard-hint">
                  Got a key from AWS, a cloud console or PuTTY? Upload the <strong>private</strong>{' '}
                  key file (.pem, .ppk or id_…): it is copied into your SSH folder, PuTTY keys are
                  converted, and the public half is worked out for you. Or create a new key; it only
                  opens servers it is installed on.
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
                <p className="wizard-hint">
                  Cloud servers (AWS, GCP, Azure…) usually turn passwords off. For those, go back
                  and upload the key file the provider gave you instead.
                </p>
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
