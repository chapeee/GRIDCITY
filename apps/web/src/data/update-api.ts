import { UpdateInfoSchema, type UpdateInfo } from '@app/shared';
import { create } from 'zustand';

/** Whether a newer GRIDCITY is out, shared by the notice and Settings. */
interface UpdateStore {
  info: UpdateInfo | null;
  load(): Promise<void>;
  checkNow(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

async function call(path: string, init?: RequestInit): Promise<UpdateInfo> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} failed (${response.status})`);
  return UpdateInfoSchema.parse(body);
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  info: null,
  load: async () => set({ info: await call('/api/update') }),
  checkNow: async () => set({ info: await call('/api/update/check', { method: 'POST' }) }),
  setEnabled: async (enabled) =>
    set({ info: await call('/api/update', { method: 'PUT', body: JSON.stringify({ enabled }) }) }),
}));

/** What to run or download to get the new version, for how this copy was installed. */
export function updateSteps(info: UpdateInfo): { text: string; command?: string } {
  const version = info.latest ?? 'latest';
  switch (info.install) {
    case 'desktop':
      return {
        text: 'Download the installer for your system from the release page and install it over this one. Your data stays.',
      };
    case 'docker':
      return {
        text: 'Pull the new image and start the container again with the same volumes. Your data stays.',
        command: `docker pull ghcr.io/chapeee/gridcity:${version}`,
      };
    default:
      return {
        text: 'Stop GRIDCITY and start the new version. Your data stays.',
        command: 'npx gridcity stop && npx gridcity@latest',
      };
  }
}
