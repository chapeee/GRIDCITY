import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { addHost, testHost, type HostDraft, type HostTestResponse } from '../data/server-api';
import { useUiStore } from './ui-store';

type Phase = 'editing' | 'testing' | 'failed' | 'saving';

/** "root@192.168.1.155:22" -> "192.168.1.155", for the name placeholder. */
function addressFromTarget(target: string): string {
  const withoutUser = target.trim().split('@').pop() ?? '';
  if (withoutUser.startsWith('[')) return withoutUser.slice(1, withoutUser.indexOf(']'));
  return (withoutUser.match(/:/g) ?? []).length === 1
    ? (withoutUser.split(':')[0] ?? '')
    : withoutUser;
}

/** Splits "Do this: some command" so the command can be shown as code with a copy button. */
function splitCommand(step: string): { text: string; command: string | null } {
  const match =
    /^(.*?):\s+((?:ssh|ssh-add|ssh-keygen|ssh-copy-id|Start-Service|eval|type)\b.*)$/.exec(step);
  return match
    ? { text: match[1] ?? step, command: match[2] ?? null }
    : { text: step, command: null };
}

/**
 * Add a host without editing YAML: type "root@192.168.1.155", optionally a
 * name and district, then "Test & add". The connection is tested with the
 * exact checks the city uses; on failure the server explains how to fix it
 * (with commands for this OS). Passwords are never asked for or stored.
 */
export function AddHostDialog() {
  const open = useUiStore((store) => store.addHostOpen);
  const hosts = useFleetStore((store) => store.hosts);
  const districts = useMemo(() => [...new Set(hosts.map((h) => h.district))].sort(), [hosts]);

  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [district, setDistrict] = useState('');
  const [useKeyFile, setUseKeyFile] = useState(false);
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');
  const [phase, setPhase] = useState<Phase>('editing');
  const [test, setTest] = useState<HostTestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => targetRef.current?.focus(), 0);
  }, [open]);

  const close = () => {
    useUiStore.getState().setAddHostOpen(false);
    setPhase('editing');
    setTest(null);
    setError(null);
  };

  const draft = (): HostDraft => ({
    target,
    name: name.trim() || undefined,
    district: district.trim() || undefined,
    auth: useKeyFile ? { method: 'keyFile', path: keyPath.trim() } : undefined,
  });

  const save = async () => {
    setPhase('saving');
    try {
      const saved = await addHost(draft());
      useUiStore
        .getState()
        .showNotice(
          saved.demoMode
            ? `Saved ${saved.host.name}. You're viewing demo data: set DATA_MODE=real in .env and restart to see it.`
            : `Added ${saved.host.name}. Connecting…`,
        );
      setTarget('');
      setName('');
      close();
    } catch (reason) {
      setError((reason as Error).message);
      setPhase('failed');
    }
  };

  const testAndAdd = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setTest(null);
    setPhase('testing');
    try {
      const response = await testHost(draft());
      setTest(response);
      if (response.result.ok) await save();
      else setPhase('failed');
    } catch (reason) {
      setError((reason as Error).message);
      setPhase('editing');
    }
  };

  const busy = phase === 'testing' || phase === 'saving';

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
          <motion.form
            className="add-host"
            role="dialog"
            aria-label="Add a host"
            onSubmit={testAndAdd}
            initial={{ y: 12 }}
            animate={{ y: 0 }}
            exit={{ y: 12 }}
          >
            <header>
              <h2>Add a host</h2>
              <button type="button" onClick={close}>
                Close <kbd>Esc</kbd>
              </button>
            </header>

            <label className="field">
              <span>SSH address</span>
              <input
                ref={targetRef}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="root@192.168.1.155"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <small>user@host or user@host:port, the same as you would type after ssh</small>
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

            <fieldset className="field">
              <legend>Sign in with</legend>
              <label className="choice">
                <input type="radio" checked={!useKeyFile} onChange={() => setUseKeyFile(false)} />
                your ssh-agent <small>(recommended; works with passphrase-protected keys)</small>
              </label>
              <label className="choice">
                <input type="radio" checked={useKeyFile} onChange={() => setUseKeyFile(true)} />a
                key file
                {useKeyFile && (
                  <input
                    className="inline-input"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    spellCheck={false}
                    aria-label="Key file path"
                  />
                )}
              </label>
              <small>Passwords are never asked for or stored.</small>
            </fieldset>

            {error && <p className="add-host-error">{error}</p>}

            {test && !test.result.ok && (
              <section className="add-host-advice" aria-label="How to fix the connection">
                <h3>
                  Could not connect to {test.host.user}@{test.host.address}
                </h3>
                <ol>
                  {test.advice.map((step) => {
                    const { text, command } = splitCommand(step);
                    return (
                      <li key={step}>
                        {command ? (
                          <>
                            {text}:
                            <span className="command">
                              <code>{command}</code>
                              <button
                                type="button"
                                onClick={() => void navigator.clipboard?.writeText(command)}
                              >
                                Copy
                              </button>
                            </span>
                          </>
                        ) : (
                          step
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            <footer>
              {phase === 'failed' && test && !test.result.ok && (
                <button type="button" onClick={() => void save()} disabled={busy}>
                  Add anyway
                </button>
              )}
              <button type="submit" className="button-primary" disabled={busy || !target.trim()}>
                {phase === 'testing'
                  ? 'Testing connection…'
                  : phase === 'saving'
                    ? 'Adding…'
                    : phase === 'failed'
                      ? 'Test again'
                      : 'Test & add'}
              </button>
            </footer>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
