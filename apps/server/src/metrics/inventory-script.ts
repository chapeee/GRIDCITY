/**
 * The discovery script: what runs on a host, found with read-only commands
 * over the existing SSH connection. Like the metrics collector it is sent on
 * stdin to `sh -s`, prints one marker per section, and a section whose tool
 * is missing prints `@@unavailable` so the parser reports "could not tell"
 * (null) instead of "nothing" (empty).
 *
 * Nothing is installed and nothing is changed: ss/netstat, docker ps,
 * systemctl --failed, ip addr and a few files under /var.
 */
export const INVENTORY_SECTION_MARKER = '@@section ';
export const INVENTORY_END_MARKER = '@@end-inventory';
export const UNAVAILABLE_MARKER = '@@unavailable';

export const INVENTORY_SECTIONS = [
  'listen',
  'established',
  'addrs',
  'docker',
  'failed',
  'reboot',
  'updates',
] as const;
export type InventorySectionName = (typeof INVENTORY_SECTIONS)[number];

export const INVENTORY_COMMAND = 'sh -s';

export const INVENTORY_SCRIPT = `export LC_ALL=C
echo '${INVENTORY_SECTION_MARKER}listen'; ss -Hlntup 2>/dev/null || ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null || netstat -lntu 2>/dev/null || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_SECTION_MARKER}established'; ss -Htn state established 2>/dev/null || netstat -tn 2>/dev/null | grep ESTABLISHED || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_SECTION_MARKER}addrs'; ip -o addr show 2>/dev/null | awk '{print $4}' || hostname -I 2>/dev/null || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_SECTION_MARKER}docker'; docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}' 2>/dev/null || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_SECTION_MARKER}failed'; systemctl --failed --no-legend --plain 2>/dev/null || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_SECTION_MARKER}reboot'; if [ -f /var/run/reboot-required ]; then echo yes; elif [ -d /var/lib/apt ]; then echo no; else echo unknown; fi
echo '${INVENTORY_SECTION_MARKER}updates'; cat /var/lib/update-notifier/updates-available 2>/dev/null || echo '${UNAVAILABLE_MARKER}'
echo '${INVENTORY_END_MARKER}'
`;
