import { isNewerVersion } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import { LATEST_RELEASE_URL, UpdateChecker, updateCheckLockedOff } from './update-check';

const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const checker = (fetchImpl: typeof fetch, enabled = true, lockedOff = false) =>
  new UpdateChecker({
    currentVersion: '1.0.0',
    install: 'npm',
    enabled: () => enabled,
    lockedOff,
    fetch: fetchImpl,
    now: () => 42,
  });

describe('isNewerVersion', () => {
  it('compares each part as a number', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.1.0-beta.1', '1.0.0')).toBe(false);
  });
});

describe('UpdateChecker', () => {
  it('reports a newer release from GitHub', async () => {
    const fetchImpl = answer({
      tag_name: 'v1.0.1',
      html_url: 'https://github.com/chapeee/GRIDCITY/releases/tag/v1.0.1',
    });
    const info = await checker(fetchImpl as unknown as typeof fetch).check();
    expect(fetchImpl).toHaveBeenCalledWith(LATEST_RELEASE_URL, expect.anything());
    expect(info).toMatchObject({
      current: '1.0.0',
      latest: '1.0.1',
      available: true,
      releaseUrl: 'https://github.com/chapeee/GRIDCITY/releases/tag/v1.0.1',
      checkedAt: 42,
      error: null,
    });
  });

  it('says nothing is available when up to date', async () => {
    const info = await checker(answer({ tag_name: 'v1.0.0' }) as unknown as typeof fetch).check();
    expect(info).toMatchObject({ latest: '1.0.0', available: false });
  });

  it('keeps failures quiet and readable', async () => {
    const info = await checker(answer({}, 403) as unknown as typeof fetch).check();
    expect(info).toMatchObject({ available: false, error: 'GitHub answered 403' });
  });

  it('never asks when turned off in Settings or by the environment', async () => {
    const fetchImpl = answer({ tag_name: 'v9.0.0' });
    await expect(
      checker(fetchImpl as unknown as typeof fetch, false).check(),
    ).resolves.toMatchObject({ enabled: false, available: false });
    await expect(
      checker(fetchImpl as unknown as typeof fetch, true, true).check(),
    ).resolves.toMatchObject({ enabled: false, lockedOff: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a release link that points somewhere else', async () => {
    const info = await checker(
      answer({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x' }) as unknown as typeof fetch,
    ).check();
    expect(info.releaseUrl).toBe('https://github.com/chapeee/GRIDCITY/releases/tag/v1.2.0');
  });

  it('reads GRIDCITY_UPDATE_CHECK', () => {
    expect(updateCheckLockedOff({ GRIDCITY_UPDATE_CHECK: 'off' })).toBe(true);
    expect(updateCheckLockedOff({ GRIDCITY_UPDATE_CHECK: 'false' })).toBe(true);
    expect(updateCheckLockedOff({})).toBe(false);
  });
});
