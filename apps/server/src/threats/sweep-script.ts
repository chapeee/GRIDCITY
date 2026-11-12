/**
 * The security sweep: read-only commands sent on stdin to `sh -s` over the
 * host's existing SSH connection, like the discovery script. Nothing is
 * installed or changed. Each section says where its data came from
 * (`@@source …`) or why it has none:
 *
 * - `@@unavailable` the data exists but this user may not read it
 * - `@@missing`     the tool is not installed (CrowdSec, Fail2ban)
 * - `@@denied`      the tool is installed but needs root (sudo -n refused)
 *
 * `sudo -n` is tried only where a tool needs root, and never prompts: with a
 * password-protected sudo it fails at once and the section says so.
 */
export const SWEEP_SECTION = '@@section ';
export const SWEEP_SOURCE = '@@source ';
export const SWEEP_JAIL = '@@jail ';
export const SWEEP_END = '@@end-sweep';
export const SWEEP_COMMAND = 'sh -s';

export const SWEEP_SECTIONS = [
  'clock',
  'auth',
  'users',
  'listen',
  'crowdsec-alerts',
  'crowdsec-decisions',
  'crowdsec-bouncers',
  'fail2ban',
] as const;
export type SweepSectionName = (typeof SWEEP_SECTIONS)[number];

/** Lines of the auth log read per sweep (about a day on a busy internet-facing host). */
export const AUTH_TAIL_LINES = 4000;

export const SWEEP_SCRIPT = `export LC_ALL=C
echo '${SWEEP_SECTION}clock'; date +%s; date +%z
echo '${SWEEP_SECTION}auth'
if [ -r /var/log/auth.log ]; then echo '${SWEEP_SOURCE}/var/log/auth.log'; tail -n ${AUTH_TAIL_LINES} /var/log/auth.log
elif [ -r /var/log/secure ]; then echo '${SWEEP_SOURCE}/var/log/secure'; tail -n ${AUTH_TAIL_LINES} /var/log/secure
elif command -v journalctl >/dev/null 2>&1 && { [ "$(id -u)" = 0 ] || id -nG 2>/dev/null | grep -qwE 'systemd-journal|adm|wheel'; }; then echo '${SWEEP_SOURCE}journal'; journalctl -q --no-pager -o short-iso -n ${AUTH_TAIL_LINES} _COMM=sshd + _COMM=sshd-session + _COMM=sudo 2>/dev/null
elif [ -f /var/log/auth.log ] && sudo -n true 2>/dev/null; then echo '${SWEEP_SOURCE}/var/log/auth.log (sudo)'; sudo -n tail -n ${AUTH_TAIL_LINES} /var/log/auth.log
elif [ -f /var/log/secure ] && sudo -n true 2>/dev/null; then echo '${SWEEP_SOURCE}/var/log/secure (sudo)'; sudo -n tail -n ${AUTH_TAIL_LINES} /var/log/secure
else echo '@@unavailable'; fi
echo '${SWEEP_SECTION}users'; (getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null) | awk -F: '{print $1":"$3":"$7}' || echo '@@unavailable'
echo '${SWEEP_SECTION}listen'; ss -Hlntu 2>/dev/null || ss -lntu 2>/dev/null || netstat -lntu 2>/dev/null || echo '@@unavailable'
CS=''
if command -v cscli >/dev/null 2>&1; then
  if cscli version >/dev/null 2>&1 && cscli alerts list -l 1 -o json >/dev/null 2>&1; then CS='cscli'; elif sudo -n cscli alerts list -l 1 -o json >/dev/null 2>&1; then CS='sudo -n cscli'; fi
fi
echo '${SWEEP_SECTION}crowdsec-alerts'
if ! command -v cscli >/dev/null 2>&1; then echo '@@missing'; elif [ -z "$CS" ]; then echo '@@denied'; else echo "${SWEEP_SOURCE}$CS"; $CS alerts list --since 24h -l 200 -o json 2>/dev/null; echo; fi
echo '${SWEEP_SECTION}crowdsec-decisions'
if ! command -v cscli >/dev/null 2>&1; then echo '@@missing'; elif [ -z "$CS" ]; then echo '@@denied'; else echo "${SWEEP_SOURCE}$CS"; $CS decisions list -o json 2>/dev/null; echo; fi
echo '${SWEEP_SECTION}crowdsec-bouncers'
if ! command -v cscli >/dev/null 2>&1; then echo '@@missing'; elif [ -z "$CS" ]; then echo '@@denied'; else B=$($CS bouncers list -o json 2>/dev/null || sudo -n cscli bouncers list -o json 2>/dev/null); if [ -n "$B" ]; then echo "${SWEEP_SOURCE}$CS"; echo "$B"; else echo '@@denied'; fi; fi
echo '${SWEEP_SECTION}fail2ban'
if ! command -v fail2ban-client >/dev/null 2>&1; then echo '@@missing'
else
  F2B=''
  if fail2ban-client ping >/dev/null 2>&1; then F2B='fail2ban-client'; elif sudo -n fail2ban-client ping >/dev/null 2>&1; then F2B='sudo -n fail2ban-client'; fi
  if [ -z "$F2B" ]; then echo '@@denied'
  else
    echo "${SWEEP_SOURCE}$F2B"
    for j in $($F2B status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do echo "${SWEEP_JAIL}$j"; $F2B status "$j" 2>/dev/null; done
  fi
fi
echo '${SWEEP_END}'
`;
