import type { Diagnosis, DoctorReport, Fix, LadderStep } from '@app/shared';
import { useState } from 'react';

const STEP_LABEL: Record<LadderStep['step'], string> = {
  dns: 'DNS',
  tcp: 'Port',
  tls: 'TLS',
  login: 'Login',
  access: 'Access',
};

const VERIFIED: Record<Fix['verified'], string> = {
  works: 'proven: connected with this change',
  fails: 'tried: did not connect',
  untested: 'not tested',
};

/**
 * One Doctor report: where the connection breaks (the ladder), the likely
 * causes in plain words, and the fixes, proven ones first. A proven patch
 * gets an Apply button; a lower-security one asks for a second click.
 */
export function DoctorReportView({
  report,
  onApply,
  applying,
}: {
  report: DoctorReport;
  /** Applies a patch fix. Absent: patches are shown but not applicable here. */
  onApply?: (fix: Fix) => void;
  applying?: string | null;
}) {
  if (report.ok) {
    return <p className="doctor-ok">Connected: nothing to fix.</p>;
  }
  return (
    <div className="doctor-report">
      {report.ladder.length > 0 && (
        <ol className="doctor-ladder" aria-label="Connection steps">
          {report.ladder.map((step) => (
            <li key={step.step} className={`is-${step.status}`}>
              <span className="doctor-step">{STEP_LABEL[step.step]}</span>
              <span className="doctor-step-detail">{step.detail}</span>
            </li>
          ))}
        </ol>
      )}
      {report.diagnoses.map((diagnosis, index) => (
        <DiagnosisCard
          key={diagnosis.id}
          diagnosis={diagnosis}
          primary={index === 0}
          onApply={onApply}
          applying={applying ?? null}
        />
      ))}
      {report.error && (
        <details className="doctor-raw">
          <summary>Exact error</summary>
          <code>{report.error}</code>
        </details>
      )}
    </div>
  );
}

function DiagnosisCard({
  diagnosis,
  primary,
  onApply,
  applying,
}: {
  diagnosis: Diagnosis;
  primary: boolean;
  onApply?: (fix: Fix) => void;
  applying: string | null;
}) {
  return (
    <section className={`doctor-diagnosis${primary ? ' is-primary' : ''}`}>
      <h4>
        {diagnosis.title}
        <small className={`doctor-confidence is-${diagnosis.confidence}`}>
          {diagnosis.confidence}
        </small>
      </h4>
      <p>{diagnosis.explanation}</p>
      {diagnosis.evidence.length > 0 && (
        <ul className="doctor-evidence">
          {diagnosis.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {diagnosis.fixes.length > 0 && (
        <ul className="doctor-fixes">
          {diagnosis.fixes.map((fix) => (
            <FixRow key={fix.id} fix={fix} onApply={onApply} applying={applying} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FixRow({
  fix,
  onApply,
  applying,
}: {
  fix: Fix;
  onApply?: (fix: Fix) => void;
  applying: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const applicable = fix.kind === 'patch' && fix.verified !== 'fails' && onApply;
  return (
    <li
      className={`doctor-fix is-${fix.verified}${fix.risk === 'lower-security' ? ' is-risky' : ''}`}
    >
      <div className="doctor-fix-head">
        <strong>{fix.label}</strong>
        {fix.kind === 'patch' && <small>{VERIFIED[fix.verified]}</small>}
        {fix.risk === 'lower-security' && <small className="doctor-risk">lower security</small>}
        {applicable &&
          (fix.risk === 'lower-security' && !confirming ? (
            <button type="button" onClick={() => setConfirming(true)}>
              Apply…
            </button>
          ) : (
            <button
              type="button"
              className={fix.verified === 'works' ? 'button-primary' : undefined}
              disabled={applying !== null}
              onClick={() => onApply(fix)}
            >
              {applying === fix.id ? 'Applying…' : confirming ? 'Yes, apply' : 'Apply'}
            </button>
          ))}
      </div>
      {confirming && (
        <p className="doctor-warning">
          This connects, but stops checking the server certificate: an impostor could pretend to be
          the server. Prefer pasting the CA certificate when you can.
        </p>
      )}
      {fix.steps.length > 0 && (
        <ol className="doctor-steps">
          {fix.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {fix.command && <code className="doctor-command">{fix.command}</code>}
      {fix.verified === 'fails' && fix.verifyNote && (
        <p className="doctor-note">Then the server said: {fix.verifyNote}</p>
      )}
    </li>
  );
}
