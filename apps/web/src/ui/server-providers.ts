/**
 * How each hosting provider hands out SSH access, so "Connect a server" can
 * pick the right user names and say exactly what to do. Facts, not branding:
 * default login users per image and whether passwords are allowed.
 */
export interface ServerProvider {
  id: string;
  label: string;
  /**
   * Users to try, in order, when the address has no "user@". Empty means the
   * user must be typed (or the app's default is used for your own servers).
   */
  users: string[];
  /** Whether the provider's images allow password login (for installing a key). */
  passwords: boolean;
  /** Shown on the key step: where the key comes from. */
  keyHelp: string;
  /** Where to paste a public key in the provider's console, if that is the way in. */
  pasteKeyHelp?: string;
  /** Google Cloud metadata wants "user:ssh-ed25519 AAAA… user". */
  pasteWithUser?: boolean;
}

export const SERVER_PROVIDERS: ServerProvider[] = [
  {
    id: 'own',
    label: 'My own server (home lab, VPS, Raspberry Pi…)',
    users: [],
    passwords: true,
    keyHelp:
      'Pick or create a key. If the server does not accept it yet, you type the password once and the app installs the key.',
    pasteKeyHelp: "Or paste the public key into the server's ~/.ssh/authorized_keys yourself.",
  },
  {
    id: 'aws',
    label: 'AWS (EC2, Lightsail)',
    users: ['ubuntu', 'ec2-user', 'admin', 'bitnami', 'centos', 'rocky', 'fedora'],
    passwords: false,
    keyHelp:
      'Upload the key pair file (.pem or .ppk) you downloaded when the instance was launched. AWS turns passwords off, and the user name is found for you.',
  },
  {
    id: 'gcp',
    label: 'Google Cloud (Compute Engine)',
    users: [],
    passwords: false,
    keyHelp:
      'Google Cloud logs in with your own key. Create one here (or pick one), copy it, and add it to the VM; the user name is the one you typed in the address.',
    pasteKeyHelp:
      'Paste it in Compute Engine → VM → Edit → SSH keys (or Metadata → SSH keys for every VM), save, then press Continue.',
    pasteWithUser: true,
  },
  {
    id: 'azure',
    label: 'Microsoft Azure',
    users: ['azureuser'],
    passwords: true,
    keyHelp:
      'Upload the .pem Azure gave you when the VM was created, or pick a key and use the password you set to install it.',
    pasteKeyHelp: 'Or paste the public key in the VM → Help → Reset password → Add SSH public key.',
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    users: ['root'],
    passwords: true,
    keyHelp:
      'Pick the key you added when creating the Droplet, or any key plus the root password to install it.',
    pasteKeyHelp: 'Or paste the public key in Settings → Security → SSH keys (new Droplets only).',
  },
  {
    id: 'hetzner',
    label: 'Hetzner',
    users: ['root'],
    passwords: true,
    keyHelp:
      'Pick the key you selected when creating the server, or any key plus the root password Hetzner emailed you.',
    pasteKeyHelp: 'Or paste the public key in Security → SSH keys (new servers only).',
  },
  {
    id: 'oracle',
    label: 'Oracle Cloud',
    users: ['opc', 'ubuntu'],
    passwords: false,
    keyHelp:
      'Upload the private key you downloaded (or chose) when the instance was created. Oracle turns passwords off.',
  },
  {
    id: 'linode',
    label: 'Linode / Akamai, Vultr, OVH, other VPS',
    users: ['root'],
    passwords: true,
    keyHelp:
      'Pick a key you added at creation, or any key plus the root password from the panel to install it.',
    pasteKeyHelp: "Or paste the public key in the provider's SSH keys page (new servers only).",
  },
];

export const DEFAULT_PROVIDER = SERVER_PROVIDERS[0]!;

export function findProvider(id: string): ServerProvider {
  return SERVER_PROVIDERS.find((provider) => provider.id === id) ?? DEFAULT_PROVIDER;
}
