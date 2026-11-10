import { HostAuthSchema, type HostInput } from '@app/shared';
import { z } from 'zod';
import { idFromName, parseHostTarget } from './host-target';

/**
 * What the "Add host" dialog and `npm run add-host` send: a target as people
 * type it ("root@192.168.1.155:22") plus optional extras. Everything else is
 * derived, so adding a host takes one field.
 */
export const HostDraftSchema = z.object({
  target: z.string().trim().min(1, 'Enter an address, e.g. root@192.168.1.155'),
  name: z.string().trim().max(64).optional(),
  district: z.string().trim().max(64).optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  auth: HostAuthSchema.optional(),
});
export type HostDraft = z.infer<typeof HostDraftSchema>;

export class DraftError extends Error {
  override name = 'DraftError';
}

/** Turns a draft into a host. `defaultUser` is used when the target has no "user@". */
export function draftToHostInput(draft: HostDraft, defaultUser: string): HostInput {
  const target = parseHostTarget(draft.target);
  if (!target) {
    throw new DraftError(
      `"${draft.target}" is not an SSH address. Use host, user@host or user@host:port.`,
    );
  }
  const name = draft.name || target.address;
  return {
    id: idFromName(name),
    name,
    address: target.address,
    port: target.port ?? 22,
    user: target.user ?? defaultUser,
    district: draft.district || 'default',
    tags: draft.tags ?? [],
    auth: draft.auth ?? { method: 'agent' },
  };
}
