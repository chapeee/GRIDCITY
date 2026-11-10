/**
 * Parses what people naturally type for an SSH target:
 * "192.168.1.155", "root@192.168.1.155", "root@box.lan:2222", "[::1]:22".
 */
export interface HostTarget {
  user: string | null;
  address: string;
  port: number | null;
}

export function parseHostTarget(input: string): HostTarget | null {
  const text = input.trim().replace(/^ssh:\/\//, '');
  if (!text || /\s/.test(text)) return null;

  const at = text.lastIndexOf('@');
  const user = at > 0 ? text.slice(0, at) : null;
  let rest = at >= 0 ? text.slice(at + 1) : text;

  let port: number | null = null;
  if (rest.startsWith('[')) {
    // [IPv6]:port
    const close = rest.indexOf(']');
    if (close === -1) return null;
    const after = rest.slice(close + 1);
    if (after.startsWith(':')) port = Number(after.slice(1));
    else if (after) return null;
    rest = rest.slice(1, close);
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const [host, portText] = rest.split(':');
    rest = host ?? '';
    port = Number(portText);
  }

  if (!rest) return null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { user, address: rest, port };
}

/** A valid host id from a name: "Web 01.lan" -> "web-01-lan". */
export function idFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+|-+$/g, '') || 'host'
  );
}
