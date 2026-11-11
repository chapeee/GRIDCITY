import { z } from 'zod';

/**
 * Topology: who talks to whom. A link joins two buildings of the city (a
 * server, a database, a bucket, a load balancer, a probe), in the direction
 * traffic flows: `from` uses `to`.
 *
 * Three honest sources, never guessed:
 * - `declared`: `dependsOn` in hosts.yaml or resources.yaml, written by you;
 * - `observed`: an established TCP connection the server really saw on the
 *   host (service discovery), matched to another building's address and port;
 * - `balances`: a load balancer and a target it reports in its target group.
 *
 * An observed link that is not seen again fades: `lastSeenAt` tells how old
 * it is, and the server drops it after a few discovery rounds.
 */
export const LinkKindSchema = z.enum(['declared', 'observed', 'balances', 'probes']);
export type LinkKind = z.infer<typeof LinkKindSchema>;

export const LinkSchema = z.object({
  /** `${from}>${to}`, so the same pair never appears twice. */
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: LinkKindSchema,
  /** Port or protocol seen, e.g. ":5432", "https"; null for declared links. */
  label: z.string().nullable().default(null),
  /** When the connection was last seen (observed and balances); null for declared. */
  lastSeenAt: z.number().int().nullable().default(null),
});
export type Link = z.infer<typeof LinkSchema>;

export function linkId(from: string, to: string): string {
  return `${from}>${to}`;
}

/** Declared links beat observed ones for the same pair; the newest observation wins otherwise. */
export function mergeLinks(...sources: readonly (readonly Link[])[]): Link[] {
  const rank: Record<LinkKind, number> = { declared: 3, balances: 2, probes: 2, observed: 1 };
  const merged = new Map<string, Link>();
  for (const links of sources) {
    for (const link of links) {
      if (link.from === link.to) continue;
      const current = merged.get(link.id);
      if (
        !current ||
        rank[link.kind] > rank[current.kind] ||
        (rank[link.kind] === rank[current.kind] &&
          (link.lastSeenAt ?? 0) > (current.lastSeenAt ?? 0))
      ) {
        merged.set(link.id, link);
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Links touching one building, split by direction. */
export function linksOf(links: readonly Link[], id: string): { uses: Link[]; usedBy: Link[] } {
  return {
    uses: links.filter((link) => link.from === id),
    usedBy: links.filter((link) => link.to === id),
  };
}

/**
 * Everything that depends on `id`, directly or through others: the blast
 * radius if it goes down. Links point from user to used, so this walks them
 * backwards. Each entry carries its distance (1 = uses it directly).
 */
export function blastRadius(links: readonly Link[], id: string): { id: string; depth: number }[] {
  const usersOf = new Map<string, string[]>();
  for (const link of links) {
    const list = usersOf.get(link.to) ?? [];
    list.push(link.from);
    usersOf.set(link.to, list);
  }
  const seen = new Map<string, number>([[id, 0]]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const user of usersOf.get(current) ?? []) {
      if (seen.has(user)) continue;
      seen.set(user, seen.get(current)! + 1);
      queue.push(user);
    }
  }
  seen.delete(id);
  return [...seen.entries()]
    .map(([dependent, depth]) => ({ id: dependent, depth }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

/**
 * When several things fail at once, which failures explain the others?
 * A failing building whose own dependencies are all healthy is a likely
 * root cause; a failing building that uses a failing one is probably a
 * consequence. Returns each root with the failures it explains.
 */
export function rootCauses(
  links: readonly Link[],
  failing: ReadonlySet<string>,
): { id: string; explains: string[] }[] {
  const uses = new Map<string, string[]>();
  for (const link of links) {
    const list = uses.get(link.from) ?? [];
    list.push(link.to);
    uses.set(link.from, list);
  }
  const roots = [...failing].filter((id) => !(uses.get(id) ?? []).some((dep) => failing.has(dep)));
  return roots
    .map((root) => ({
      id: root,
      explains: blastRadius(links, root)
        .map((entry) => entry.id)
        .filter((dependent) => failing.has(dependent)),
    }))
    .sort((a, b) => b.explains.length - a.explains.length || a.id.localeCompare(b.id));
}
