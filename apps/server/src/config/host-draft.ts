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
  /** Jump host as typed ("ec2-user@bastion.example.com"); uses the same key. */
  jump: z.object({ target: z.string().trim().min(1) }).optional(),
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
  const user = target.user ?? defaultUser;
  const auth = draft.auth ?? { method: 'agent' as const };
  let jump: HostInput['jump'];
  if (draft.jump) {
    const via = parseHostTarget(draft.jump.target);
    if (!via) {
      throw new DraftError(
        `"${draft.jump.target}" is not a jump host address. Use user@host or user@host:port.`,
      );
    }
    jump = { address: via.address, port: via.port ?? 22, user: via.user ?? user, auth };
  }
  return {
    id: idFromName(name),
    name,
    address: target.address,
    port: target.port ?? 22,
    user,
    district: draft.district || 'default',
    tags: draft.tags ?? [],
    auth,
    ...(jump ? { jump } : {}),
  };
}
