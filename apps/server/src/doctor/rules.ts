import type { Diagnosis, Fix, LadderStep, ProviderProfile } from '@app/shared';

/**
 * The Doctor's knowledge: each rule reads the evidence (the error text, the
 * connection ladder, the detected provider, where the app runs) and, when it
 * recognises a cause, explains it and proposes fixes. Rules never touch
 * anything; patch fixes are tried against the real target by the Doctor
 * before they are offered as working.
 *
 * Rules are written from the actual messages each driver and service
 * produces (mysql2, pg, ioredis, mongodb, tedious, the AWS SDK, Node's net
 * and tls), so they match real failures, not guesses.
 */
export interface RuleContext {
  kind: string;
  /** The entry's settings (no secrets: those are vault ids). */
  config: Record<string, unknown>;
  error: string;
  ladder: readonly LadderStep[];
  provider: ProviderProfile | null;
  inContainer: boolean;
  /** Addresses the host resolved to. */
  addresses: readonly string[];
}

export interface Rule {
  id: string;
  /** Kinds it applies to; '*' for every kind (network, TLS). */
  kinds: readonly string[] | '*';
  match(context: RuleContext): Omit<Diagnosis, 'id'> | null;
}

type FixInput = Partial<Omit<Fix, 'id' | 'label'>> & { label: string };

let fixCounter = 0;
export function fix(input: FixInput): Fix {
  fixCounter += 1;
  return {
    id: `fix-${fixCounter}`,
    kind: input.patch ? 'patch' : 'manual',
    patch: input.patch ?? null,
    risk: input.risk ?? 'safe',
    steps: input.steps ?? [],
    command: input.command ?? null,
    verified: input.verified ?? 'untested',
    verifyNote: input.verifyNote ?? null,
    label: input.label,
  };
}

const has = (text: string, ...patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
const rung = (context: RuleContext, step: LadderStep['step']) =>
  context.ladder.find((entry) => entry.step === step);
const quoted = (text: string, pattern: RegExp) => pattern.exec(text)?.[1] ?? null;
const tlsOn = (context: RuleContext) => context.config.tls === true;
const host = (context: RuleContext) => String(context.config.host ?? '');
/** Works in the connect form (the field is right there) and for a saved entry (Edit). */
const PASSWORD_STEP =
  'Type it in the Password field and test again (for a saved entry: Edit → New password).';

/** The patch that turns TLS on, plus what the provider tells us about certificates. */
function tlsOnFixes(context: RuleContext): Fix[] {
  const fixes = [
    fix({
      label: 'Turn on TLS',
      patch: { tls: true },
      steps: ['Encrypt the connection with TLS, verifying the server certificate.'],
    }),
  ];
  if (context.provider?.privateCa) {
    fixes.push(
      fix({
        label: `Paste the ${context.provider.name} CA certificate`,
        steps: [
          `The certificate is signed by a private CA. Download it: ${context.provider.privateCa.where}.`,
          'Paste it in Edit → TLS → CA certificate. Verification stays on.',
        ],
      }),
    );
  }
  return fixes;
}

export const RULES: Rule[] = [
  // ---------- TLS required / not supported ----------
  {
    id: 'db.tls-required',
    kinds: ['mysql', 'postgres', 'redis', 'mongodb'],
    match: (context) => {
      const required = has(
        context.error,
        /insecure transport are prohibited/i, // MySQL require_secure_transport
        /Authentication requires secure connection/i, // caching_sha2_password over plain text
        /no pg_hba\.conf entry .*(no encryption|SSL off)/i,
        /connection is insecure \(try using `?sslmode=require/i, // Neon
        /SSL connection is required|SSL\/TLS required|sslmode=require/i,
      );
      const providerSays = context.provider?.tlsRequired && !tlsOn(context);
      if (!required && !providerSays) return null;
      if (tlsOn(context) && !providerSays) return null;
      return {
        title: 'The server requires an encrypted (TLS) connection',
        explanation:
          'The server refuses plain-text connections, and this entry connects without TLS. ' +
          'Managed databases (DigitalOcean, Azure, PlanetScale, Neon, Supabase, Aiven) enforce this by default.',
        confidence: required ? 'certain' : 'likely',
        evidence: [
          ...(required ? [`server said: "${context.error.slice(0, 160)}"`] : []),
          ...(context.provider ? [`${context.provider.name}: ${context.provider.note}`] : []),
        ],
        fixes: tlsOnFixes(context),
      };
    },
  },
  {
    id: 'db.tls-unsupported',
    kinds: ['mysql', 'postgres', 'redis', 'mongodb', 'tcp', 'http'],
    match: (context) => {
      if (
        !has(
          context.error,
          /does not support (SSL|secure) connections?/i,
          /wrong version number|packet length too long|ERR_SSL_WRONG_VERSION_NUMBER/i,
        )
      ) {
        return null;
      }
      return {
        title: 'TLS is on, but the server does not speak TLS on this port',
        explanation:
          'The client started a TLS handshake and the server answered in plain text. Either TLS is not enabled on the server, or it listens for TLS on another port.',
        confidence: 'certain',
        evidence: [`error: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: 'Turn off TLS',
            patch: { tls: false },
            steps: ['Connect in plain text (fine on a private network or through a tunnel).'],
          }),
          fix({
            label: 'Enable TLS on the server',
            steps: [
              'Configure a certificate on the server (ssl_cert/ssl_key, or the provider setting), then turn TLS back on here.',
            ],
          }),
        ],
      };
    },
  },

  // ---------- Certificates ----------
  {
    id: 'tls.untrusted-ca',
    kinds: '*',
    match: (context) => {
      if (
        !has(
          context.error,
          /self[- ]signed certificate|unable to (verify the first certificate|get local issuer certificate)|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i,
        )
      ) {
        return null;
      }
      const selfSigned = /self[- ]signed certificate(?! in)/i.test(context.error);
      return {
        title: selfSigned
          ? 'The server uses a self-signed certificate'
          : 'The server certificate is signed by a CA this machine does not know',
        explanation:
          'TLS works, but the certificate cannot be verified against the public CAs. Managed services often sign with their own CA; you can give the app that CA (best), or skip verification (encrypted, but no protection against an impostor).',
        confidence: 'certain',
        evidence: [
          `error: "${context.error.slice(0, 160)}"`,
          ...(context.provider?.privateCa
            ? [`${context.provider.name} signs with a private CA`]
            : []),
        ],
        fixes: [
          fix({
            label: 'Paste the CA certificate',
            steps: [
              context.provider?.privateCa
                ? `Download it: ${context.provider.privateCa.where}.`
                : 'Get the CA certificate (PEM) from your provider or server admin.',
              'Edit → TLS → CA certificate. Verification stays on.',
            ],
          }),
          context.kind === 'mssql'
            ? fix({
                label: 'Trust the server certificate',
                patch: { trustServerCertificate: true },
                risk: 'lower-security',
                steps: ['Encrypted, but the certificate is not checked.'],
              })
            : context.kind === 'http'
              ? fix({
                  label: 'Accept the untrusted certificate',
                  patch: { insecure: true },
                  risk: 'lower-security',
                  steps: ['The probe still reports expiry, but stops checking who signed it.'],
                })
              : fix({
                  label: 'Skip certificate verification',
                  patch: { tlsVerify: false },
                  risk: 'lower-security',
                  steps: ['Encrypted, but an impostor with any certificate would be accepted.'],
                }),
        ],
      };
    },
  },
  {
    id: 'tls.hostname-mismatch',
    kinds: '*',
    match: (context) =>
      has(
        context.error,
        /does not match certificate's altnames|ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i,
      )
        ? {
            title: 'The certificate is for a different name than the one you connect to',
            explanation:
              'Connecting by IP address or by an alias makes the name differ from the certificate. Use the hostname the certificate was issued for.',
            confidence: 'certain',
            evidence: [
              `error: "${context.error.slice(0, 160)}"`,
              `connecting to "${host(context) || context.config.url || context.config.endpoint}"`,
            ],
            fixes: [
              fix({
                label: 'Use the certificate hostname',
                steps: [
                  'Edit → Host: the name in the certificate (the provider shows it as the connection host).',
                ],
              }),
            ],
          }
        : null,
  },
  {
    id: 'tls.expired',
    kinds: '*',
    match: (context) =>
      has(context.error, /certificate has expired|CERT_HAS_EXPIRED/i)
        ? {
            title: 'The server certificate has expired',
            explanation:
              'The server presents a certificate past its end date. Renew it on the server (certbot renew, or the provider dashboard).',
            confidence: 'certain',
            evidence: [`error: "${context.error.slice(0, 160)}"`],
            fixes: [
              fix({
                label: 'Renew the certificate on the server',
                command: 'sudo certbot renew',
                steps: ['Renew, then reload the service that serves it.'],
              }),
            ],
          }
        : null,
  },

  // ---------- Network ----------
  {
    id: 'net.dns',
    kinds: '*',
    match: (context) => {
      const dns = rung(context, 'dns');
      if (dns?.status !== 'failed' && !has(context.error, /ENOTFOUND|EAI_AGAIN|getaddrinfo/i))
        return null;
      const name = host(context) || quoted(context.error, /ENOTFOUND (\S+)/) || 'the host';
      const internal = /\.(internal|local|lan|svc|cluster\.local)$|^[a-z0-9-]+$/i.test(name);
      const srv = /querySrv/i.test(context.error);
      return {
        title: srv ? 'The mongodb+srv address has no DNS record' : `"${name}" does not resolve`,
        explanation: srv
          ? 'mongodb+srv:// looks up an SRV record; this name has none. Copy the exact connection string from Atlas, or use mongodb:// with the host and port.'
          : internal
            ? 'This looks like a private or internal name. It only resolves inside its own network (VPC, VPN, cluster or LAN), not from where this app runs.'
            : 'The name has no DNS record from this machine: a typo, a deleted instance, or a private DNS zone.',
        confidence: 'certain',
        evidence: [dns?.detail ?? `error: "${context.error.slice(0, 120)}"`],
        fixes: [
          fix({
            label: 'Check the host name',
            steps: ['Copy the host from the provider dashboard (no protocol, no port).'],
          }),
          ...(internal
            ? [
                fix({
                  label: 'Connect from inside that network',
                  steps: [
                    'Run the app on a machine in that network, use a VPN, or an SSH tunnel through a server there.',
                  ],
                }),
              ]
            : []),
        ],
      };
    },
  },
  {
    id: 'net.localhost-in-container',
    kinds: '*',
    match: (context) => {
      const target = `${host(context)} ${context.config.url ?? ''} ${context.config.endpoint ?? ''}`;
      if (
        !context.inContainer ||
        !/(^|\/\/|@|\s)(localhost|127\.0\.0\.1|\[::1\])([:/\s]|$)/i.test(target)
      )
        return null;
      return {
        title: '"localhost" inside Docker is the container itself',
        explanation:
          'The app runs in a container, so localhost points at the container, not at your computer. Docker gives your computer the name host.docker.internal.',
        confidence: 'certain',
        evidence: ['the app is running in a container', `target: ${target.trim()}`],
        fixes: [
          fix({
            label: 'Use host.docker.internal',
            patch: { host: 'host.docker.internal' },
            steps: [
              'Reach the service on your computer from the container (Linux needs extra_hosts: ["host.docker.internal:host-gateway"], already in compose.yaml).',
            ],
          }),
        ],
      };
    },
  },
  {
    id: 'net.refused',
    kinds: '*',
    match: (context) => {
      const tcp = rung(context, 'tcp');
      if (
        !(tcp?.status === 'failed' && /refused/.test(tcp.detail)) &&
        !has(context.error, /ECONNREFUSED/)
      )
        return null;
      const port = Number(context.config.port ?? 0);
      const providerPort = context.provider?.port;
      const loopbackOnly = context.addresses.every(
        (address) => address.startsWith('127.') || address === '::1',
      );
      return {
        title: `Nothing accepts connections on port ${port || 'this port'}`,
        explanation: loopbackOnly
          ? 'The name points at this machine and nothing listens on that port here.'
          : 'The host answered but refused the port: the service is stopped, listens on another port, or only on 127.0.0.1 on that server (bind-address).',
        confidence: providerPort && providerPort !== port ? 'certain' : 'likely',
        evidence: [
          tcp?.detail ?? `error: "${context.error.slice(0, 120)}"`,
          ...(providerPort && providerPort !== port
            ? [`${context.provider!.name} uses port ${providerPort}`]
            : []),
        ],
        fixes: [
          ...(providerPort && providerPort !== port
            ? [fix({ label: `Use port ${providerPort}`, patch: { port: providerPort } })]
            : []),
          fix({
            label: 'Check the service and its bind address',
            steps: [
              'On the server: is the service running (systemctl status …)?',
              'Does it listen on all interfaces? MySQL bind-address / Postgres listen_addresses / Redis bind must not be 127.0.0.1 only.',
            ],
            command: 'ss -lntp',
          }),
        ],
      };
    },
  },
  {
    id: 'net.timeout',
    kinds: '*',
    match: (context) => {
      const tcp = rung(context, 'tcp');
      const timedOut =
        (tcp?.status === 'failed' && /did not answer/.test(tcp.detail)) ||
        has(
          context.error,
          /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out|Server selection timed out/i,
        );
      if (!timedOut || has(context.error, /ECONNREFUSED|ENOTFOUND/)) return null;
      const scope = context.addresses.some((a) =>
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a),
      )
        ? 'private'
        : 'public';
      return {
        title: 'The connection is silently dropped: a firewall or access list blocks this machine',
        explanation:
          scope === 'private'
            ? 'The host has a private address, reachable only from its own network (VPC, LAN or VPN).'
            : 'Packets get no answer at all. Managed databases accept only listed IPs ("trusted sources", security groups, Atlas IP access list).',
        confidence: tcp?.status === 'failed' ? 'certain' : 'likely',
        evidence: [
          tcp?.detail ?? `error: "${context.error.slice(0, 120)}"`,
          `address scope: ${scope}`,
        ],
        fixes: [
          fix({
            label: "Allow this machine's IP",
            steps: [
              "Add this machine's public IP to the database's trusted sources / security group inbound rules / IP access list.",
              'Find it with: curl -s https://checkip.amazonaws.com',
            ],
          }),
          ...(scope === 'private'
            ? [
                fix({
                  label: 'Connect from inside the network',
                  steps: ['Run the app inside that network, or use a VPN or SSH tunnel.'],
                }),
              ]
            : []),
        ],
      };
    },
  },

  // ---------- Credentials and privileges ----------
  {
    id: 'auth.rejected',
    kinds: ['mysql', 'postgres', 'mssql', 'mongodb', 'redis'],
    match: (context) => {
      if (
        !has(
          context.error,
          /Access denied for user|password authentication failed|Login failed for user|Authentication failed|bad auth|WRONGPASS|invalid username-password/i,
        )
      )
        return null;
      const noPassword = /using password: NO/i.test(context.error);
      const seenAs = quoted(context.error, /@'([^']+)'/);
      const fixes = [
        fix({
          label: noPassword ? 'Enter the password' : 'Re-enter the password',
          steps: [PASSWORD_STEP],
        }),
      ];
      if (context.kind === 'mongodb' && !context.config.authSource) {
        fixes.unshift(
          fix({
            label: 'Authenticate against the admin database',
            patch: { authSource: 'admin' },
            steps: ['Users created in "admin" (the usual case) need authSource=admin.'],
          }),
        );
      }
      return {
        title: noPassword
          ? 'No password was sent'
          : 'The server rejected the user name or password',
        explanation: noPassword
          ? 'The entry has no password, and this user needs one.'
          : `The login reached the server and was refused${seenAs ? `; the server sees this client as ${seenAs}, so the user must be allowed from that address` : ''}.`,
        confidence: 'certain',
        evidence: [`server said: "${context.error.slice(0, 160)}"`],
        fixes,
      };
    },
  },
  {
    id: 'mysql.host-not-allowed',
    kinds: ['mysql'],
    match: (context) => {
      const ip = quoted(context.error, /Host '([^']+)' is not allowed to connect/i);
      if (!ip) return null;
      const user = String(context.config.user ?? 'monitor');
      return {
        title: `MySQL does not allow logins from ${ip}`,
        explanation:
          'The user exists, but only for other client addresses. Create it for this address (or a range).',
        confidence: 'certain',
        evidence: [`server said: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: `Allow ${user} from ${ip}`,
            command: `CREATE USER '${user}'@'${ip}' IDENTIFIED BY '…'; GRANT PROCESS, REPLICATION CLIENT ON *.* TO '${user}'@'${ip}';`,
            steps: ['Run it as an admin on the server.'],
          }),
        ],
      };
    },
  },
  {
    id: 'db.unknown-database',
    kinds: ['mysql', 'postgres', 'mssql'],
    match: (context) => {
      const name =
        quoted(context.error, /Unknown database '([^']+)'/i) ??
        quoted(context.error, /database "([^"]+)" does not exist/i) ??
        quoted(context.error, /Cannot open database "([^"]+)"/i);
      if (!name) return null;
      const fallback =
        context.kind === 'postgres' ? 'postgres' : context.kind === 'mssql' ? 'master' : undefined;
      return {
        title: `The database "${name}" does not exist`,
        explanation: 'Statistics are server-wide, so any existing database works for monitoring.',
        confidence: 'certain',
        evidence: [`server said: "${context.error.slice(0, 160)}"`],
        fixes: [
          fallback
            ? fix({ label: `Use "${fallback}"`, patch: { database: fallback } })
            : fix({ label: 'Connect without a database', patch: { database: undefined } }),
        ],
      };
    },
  },
  {
    id: 'pg.role-missing',
    kinds: ['postgres'],
    match: (context) => {
      const role = quoted(context.error, /role "([^"]+)" does not exist/i);
      if (!role) return null;
      return {
        title: `The user "${role}" does not exist on this server`,
        explanation: 'Create a read-only monitoring role.',
        confidence: 'certain',
        evidence: [`server said: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: `Create ${role}`,
            command: `CREATE ROLE ${role} LOGIN PASSWORD '…'; GRANT pg_monitor TO ${role};`,
          }),
        ],
      };
    },
  },
  {
    id: 'db.too-many-connections',
    kinds: ['mysql', 'postgres'],
    match: (context) =>
      has(
        context.error,
        /Too many connections|too many clients already|remaining connection slots are reserved/i,
      )
        ? {
            title: 'The server is out of connection slots',
            explanation:
              'Every connection is taken. This is a real incident on the database, not a setting here: something is leaking or flooding connections.',
            confidence: 'certain',
            evidence: [`server said: "${context.error.slice(0, 160)}"`],
            fixes: [
              fix({
                label: 'Find who holds the connections',
                command:
                  context.kind === 'postgres'
                    ? 'SELECT usename, client_addr, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;'
                    : 'SHOW PROCESSLIST;',
              }),
            ],
          }
        : null,
  },
  {
    id: 'redis.no-password-needed',
    kinds: ['redis'],
    match: (context) =>
      has(
        context.error,
        /AUTH .* called without any password configured|Client sent AUTH, but no password is set/i,
      )
        ? {
            title: 'This Redis has no password, but the entry sends one',
            explanation:
              'Remove the password from the entry (and consider setting one on the server).',
            confidence: 'certain',
            evidence: [`server said: "${context.error.slice(0, 160)}"`],
            fixes: [
              fix({
                label: 'Do not send a password',
                patch: {
                  passwordSecret: undefined,
                  passwordEnv: undefined,
                  passwordFile: undefined,
                },
              }),
            ],
          }
        : null,
  },
  {
    // Discovery worked (the login and the API call succeeded) and returned an empty list.
    id: 'discovery.empty',
    kinds: ['s3', 'rds', 'loadbalancer'],
    match: (context) => {
      if (!/found nothing to watch/i.test(context.error)) return null;
      const what =
        context.kind === 's3'
          ? 'buckets'
          : context.kind === 'rds'
            ? 'DB instances'
            : 'load balancers';
      const filterKey =
        context.kind === 's3' ? 'buckets' : context.kind === 'rds' ? 'instances' : 'names';
      const filtered = Array.isArray(context.config[filterKey]);
      return {
        title: `Signed in, but there are no ${what} to watch`,
        explanation: `The credentials work and the API answered with an empty list. Nothing is broken; there is just nothing here yet${filtered ? ', or the "Only these" list matches none' : ''}.`,
        confidence: 'likely',
        evidence: [
          `region: ${String(context.config.region ?? 'default')}`,
          ...(context.config.endpoint ? [`endpoint: ${String(context.config.endpoint)}`] : []),
        ],
        fixes: [
          fix({
            label: `Check where the ${what} are`,
            steps: [
              ...(context.kind === 's3'
                ? ['Create a bucket, or check that these keys may list it (s3:ListAllMyBuckets).']
                : [`Check that the ${what} live in this region; each region is separate.`]),
              ...(filtered ? ['Clear "Only these" or fix the names in it.'] : []),
              'Test again; you can also add it now and it fills in when something appears.',
            ],
          }),
        ],
      };
    },
  },
  {
    // The port is open; what the service said first is not what the probe expects.
    id: 'tcp.unexpected-banner',
    kinds: ['tcp'],
    match: (context) => {
      const mismatch = /^banner "(.*)" does not contain "(.*)"$/s.exec(context.error);
      const silent = /^no banner received \(expected "(.*)"\)$/.exec(context.error);
      if (!mismatch && !silent) return null;
      return {
        title: mismatch
          ? `The port answered, but not with "${mismatch[2]}"`
          : 'The port is open, but the service sent nothing first',
        explanation: mismatch
          ? `It greeted with "${mismatch[1]}". Another service may be listening on this port, or the expected text is too specific.`
          : 'Many services (HTTP, most databases over TLS) wait for the client to speak first, so there is no banner to check.',
        confidence: 'certain',
        evidence: [`probe said: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: mismatch ? 'Check the expected text' : 'Remove the banner check',
            steps: mismatch
              ? ['Compare with the banner shown above.', 'Fix or clear "Banner contains".']
              : ['Clear "Banner contains": the open port is then the check.'],
          }),
        ],
      };
    },
  },
  {
    // The probe reached the endpoint and got an answer; the answer failed a check.
    id: 'http.unexpected-response',
    kinds: ['http'],
    match: (context) => {
      const status = /^HTTP (\d{3})/.exec(context.error);
      const body = /^body does not contain "(.*)"$/s.exec(context.error);
      if (!status && !body) return null;
      const expected = context.config.expectStatus;
      return {
        title: status
          ? `The endpoint answered with HTTP ${status[1]}`
          : `The endpoint answered, but the body lacks "${body![1]}"`,
        explanation: status
          ? expected
            ? `The network and TLS work; the response status is not the ${String(expected)} this probe expects.`
            : 'The network and TLS work; the response is not a 2xx/3xx. The service itself reports a problem, or the URL is wrong.'
          : 'The network, TLS and status are fine; the page does not contain the text this probe looks for.',
        confidence: 'certain',
        evidence: [`probe said: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: status ? 'Check the URL and the expected status' : 'Check the expected text',
            steps: status
              ? [
                  'Open the URL in a browser from this machine.',
                  'If this status is normal for it, set "Expect status" to it.',
                ]
              : [
                  'Open the URL and look for the text (it is case-sensitive).',
                  'Fix or clear "Body contains".',
                ],
          }),
        ],
      };
    },
  },
  {
    id: 'redis.noauth',
    kinds: ['redis'],
    match: (context) =>
      has(context.error, /NOAUTH/i)
        ? {
            title: 'Redis requires a password',
            explanation: 'The server has requirepass or ACL users; the entry sends none.',
            confidence: 'certain',
            evidence: [`server said: "${context.error.slice(0, 120)}"`],
            fixes: [
              fix({
                label: 'Enter the password',
                steps: [PASSWORD_STEP],
              }),
            ],
          }
        : null,
  },
  {
    id: 'stream.reset-tls-mismatch',
    kinds: ['redis', 'mongodb', 'postgres'],
    match: (context) => {
      if (
        tlsOn(context) ||
        !has(
          context.error,
          /ECONNRESET|Connection is closed|socket hang up|Connection terminated unexpectedly|connection .* closed/i,
        )
      )
        return null;
      return {
        title: 'The server hangs up right after connecting: it probably expects TLS',
        explanation:
          'Services with in-transit encryption (Upstash, ElastiCache, Atlas, poolers) close plain-text connections without a message.',
        confidence: 'possible',
        evidence: [
          `error: "${context.error.slice(0, 120)}"`,
          rung(context, 'tcp')?.status === 'ok' ? 'the port is open' : '',
        ].filter(Boolean),
        fixes: tlsOnFixes(context),
      };
    },
  },
  {
    id: 'mssql.encryption-required',
    kinds: ['mssql'],
    match: (context) =>
      has(context.error, /requires encryption|set 'encrypt' config option to true/i)
        ? {
            title: 'SQL Server requires encryption',
            explanation: 'Force Encryption is on for this server.',
            confidence: 'certain',
            evidence: [`server said: "${context.error.slice(0, 160)}"`],
            fixes: [fix({ label: 'Turn on Encrypt', patch: { encrypt: true } })],
          }
        : null,
  },

  // ---------- AWS / S3 ----------
  {
    id: 'aws.no-credentials',
    kinds: ['s3', 'rds', 'loadbalancer'],
    match: (context) =>
      has(
        context.error,
        /Could not load credentials|CredentialsProviderError|Unable to locate credentials|missing credentials/i,
      )
        ? {
            title: 'No AWS credentials were found',
            explanation:
              'The entry has no access keys, and this machine has none in ~/.aws, the environment or an instance role.',
            confidence: 'certain',
            evidence: [`error: "${context.error.slice(0, 120)}"`],
            fixes: [
              fix({
                label: 'Paste an access key pair',
                steps: ['Edit → Access keys (saved encrypted). Use a read-only key.'],
              }),
            ],
          }
        : null,
  },
  {
    id: 'aws.bad-key',
    kinds: ['s3', 'rds', 'loadbalancer'],
    match: (context) => {
      const wrongId = has(
        context.error,
        /InvalidAccessKeyId|Access Key Id you provided does not exist|security token included in the request is invalid|UnrecognizedClient/i,
      );
      const wrongSecret = has(
        context.error,
        /SignatureDoesNotMatch|signature we calculated does not match/i,
      );
      if (!wrongId && !wrongSecret) return null;
      return {
        title: wrongSecret
          ? 'The secret key does not match the access key'
          : 'The access key is unknown to this provider',
        explanation: wrongSecret
          ? 'The key id is valid but the secret is wrong (a copy-paste slip is the usual cause), or the endpoint/region signs differently.'
          : 'The key does not exist here: deleted, mistyped, or a key from another provider (an AWS key sent to Spaces/R2, or the reverse).',
        confidence: 'certain',
        evidence: [`error: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: 'Re-enter the key pair',
            steps: ['Edit → Access keys. Both fields, from the same provider as the endpoint.'],
          }),
        ],
      };
    },
  },
  {
    id: 'aws.region-mismatch',
    kinds: ['s3'],
    match: (context) => {
      const expected =
        quoted(context.error, /expecting '([a-z0-9-]+)'/i) ??
        quoted(context.error, /region ['"]?([a-z]{2}-[a-z]+-\d)['"]? to make/i);
      const redirect = has(
        context.error,
        /PermanentRedirect|must be addressed using the specified endpoint|301/i,
      );
      if (!expected && !redirect) return null;
      return {
        title: expected
          ? `The bucket lives in ${expected}, not ${String(context.config.region)}`
          : 'The bucket lives in another region',
        explanation:
          'S3 signs requests per region; the bucket answered with a redirect or a region error.',
        confidence: expected ? 'certain' : 'likely',
        evidence: [`error: "${context.error.slice(0, 160)}"`],
        fixes: [
          expected
            ? fix({ label: `Use region ${expected}`, patch: { region: expected } })
            : fix({
                label: 'Set the bucket region',
                steps: ['Edit → Region: the region shown on the bucket in the console.'],
              }),
        ],
      };
    },
  },
  {
    id: 's3.path-style',
    kinds: ['s3'],
    match: (context) => {
      const endpoint = String(context.config.endpoint ?? '');
      if (!endpoint || context.config.forcePathStyle === true) return null;
      const virtualHostFailed =
        has(context.error, /ENOTFOUND [a-z0-9.-]+\./i) &&
        !has(context.error, new RegExp(`ENOTFOUND ${escape(new URL(endpoint).hostname)}$`, 'i'));
      if (!virtualHostFailed) return null;
      return {
        title: 'The endpoint does not support bucket subdomains',
        explanation:
          'S3 clients put the bucket in the hostname (bucket.endpoint); self-hosted MinIO and many S3-compatible servers need the bucket in the path instead.',
        confidence: 'likely',
        evidence: [`error: "${context.error.slice(0, 120)}"`],
        fixes: [fix({ label: 'Use path-style addressing', patch: { forcePathStyle: true } })],
      };
    },
  },
  {
    id: 'aws.clock-skew',
    kinds: ['s3', 'rds', 'loadbalancer'],
    match: (context) =>
      has(
        context.error,
        /RequestTimeTooSkewed|request time and the current time is too large|Signature expired/i,
      )
        ? {
            title: "This machine's clock is wrong",
            explanation:
              'Signed requests carry the time; providers reject them when the clock is off by more than about 15 minutes.',
            confidence: 'certain',
            evidence: [
              `error: "${context.error.slice(0, 120)}"`,
              `local time: ${new Date().toISOString()}`,
            ],
            fixes: [
              fix({
                label: 'Sync the clock',
                command:
                  process.platform === 'win32' ? 'w32tm /resync' : 'sudo timedatectl set-ntp true',
                steps: ['Turn on automatic time sync.'],
              }),
            ],
          }
        : null,
  },
  {
    id: 'aws.access-denied',
    kinds: ['s3', 'rds', 'loadbalancer'],
    match: (context) => {
      if (!has(context.error, /AccessDenied|not authorized to perform|Access Denied|Forbidden/i))
        return null;
      const action = quoted(context.error, /perform: ([a-z0-9-]+:[A-Za-z]+)/i);
      const needed =
        context.kind === 'rds'
          ? 'rds:DescribeDBInstances, cloudwatch:GetMetricData'
          : context.kind === 'loadbalancer'
            ? 'elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, DescribeTargetHealth, cloudwatch:GetMetricData'
            : 's3:ListAllMyBuckets, s3:ListBucket (or list only the buckets you name)';
      return {
        title: action ? `The key may not call ${action}` : 'The key is valid but lacks permission',
        explanation:
          'The login worked; the IAM policy (or bucket policy) does not allow the read-only calls the app makes.',
        confidence: 'certain',
        evidence: [`error: "${context.error.slice(0, 160)}"`],
        fixes: [
          fix({
            label: 'Grant the read-only actions',
            steps: [`Attach a policy allowing: ${needed}.`],
          }),
          ...(context.kind === 's3' && !(context.config.buckets as unknown[] | undefined)?.length
            ? [
                fix({
                  label: 'Name the buckets instead of listing all',
                  steps: [
                    'Edit → Only these buckets: a key limited to some buckets cannot list every bucket.',
                  ],
                }),
              ]
            : []),
        ],
      };
    },
  },

  // ---------- HTTP probes ----------
  {
    id: 'http.status',
    kinds: ['http'],
    match: (context) => {
      const status = Number(quoted(context.error, /HTTP (\d{3})/) ?? 0);
      if (!status) return null;
      const explanation =
        status === 401 || status === 403
          ? 'The endpoint wants credentials or blocks this client. Point the probe at a public health URL.'
          : status === 404
            ? 'The path does not exist. Check the URL (a trailing slash or a /healthz path).'
            : status >= 500
              ? 'The service behind it is failing: a real incident, not a probe setting.'
              : status >= 300
                ? 'The endpoint redirects. Follow redirects, or probe the final URL.'
                : 'The status differs from the one this probe expects.';
      return {
        title: `The endpoint answers HTTP ${status}`,
        explanation,
        confidence: 'certain',
        evidence: [`probe: "${context.error}"`],
        fixes: [
          ...(status >= 300 && status < 400 && context.config.followRedirects === false
            ? [fix({ label: 'Follow redirects', patch: { followRedirects: true } })]
            : []),
          ...(context.config.expectStatus && status < 500
            ? [
                fix({
                  label: `Expect ${status}`,
                  patch: { expectStatus: status },
                  steps: ['Only if this status is the normal answer.'],
                }),
              ]
            : []),
        ],
      };
    },
  },
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Runs every applicable rule. Pure: no network, no side effects. */
export function matchRules(context: RuleContext): Diagnosis[] {
  const found: Diagnosis[] = [];
  for (const rule of RULES) {
    if (rule.kinds !== '*' && !rule.kinds.includes(context.kind)) continue;
    const result = rule.match(context);
    if (result) found.push({ id: rule.id, ...result });
  }
  return found;
}
