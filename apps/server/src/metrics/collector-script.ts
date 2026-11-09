/**
 * The single command run on every host per poll. Nothing is installed on the
 * remote host: this POSIX script only reads /proc, df and /etc/os-release.
 *
 * It is sent on stdin to `sh -s`, so it works the same whatever the user's
 * login shell is (bash, zsh, fish…) and needs no quoting. Each section starts
 * with a marker line; a missing or failing section simply comes back empty,
 * and the corresponding metric is reported as unknown.
 */
export const SECTION_MARKER = '@@section ';
export const END_MARKER = '@@end';

/** Section names, in the order the script prints them. */
export const SECTIONS = ['stat', 'meminfo', 'loadavg', 'netdev', 'uptime', 'df', 'os'] as const;
export type SectionName = (typeof SECTIONS)[number];

export const COLLECTOR_COMMAND = 'sh -s';

export const COLLECTOR_SCRIPT = `export LC_ALL=C
echo '${SECTION_MARKER}stat'; head -n 1 /proc/stat 2>/dev/null
echo '${SECTION_MARKER}meminfo'; cat /proc/meminfo 2>/dev/null
echo '${SECTION_MARKER}loadavg'; cat /proc/loadavg 2>/dev/null
echo '${SECTION_MARKER}netdev'; cat /proc/net/dev 2>/dev/null
echo '${SECTION_MARKER}uptime'; cat /proc/uptime 2>/dev/null
echo '${SECTION_MARKER}df'; df -P -k 2>/dev/null
echo '${SECTION_MARKER}os'; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); uname -r 2>/dev/null
echo '${END_MARKER}'
`;
