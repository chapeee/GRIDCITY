import { isNewerVersion, parseVersion, type InstallKind, type UpdateInfo } from '@app/shared';

/** GitHub's public "latest release" (betas and drafts are never "latest"). */
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/chapeee/GRIDCITY/releases/latest';
const RELEASES_PAGE = 'https://github.com/chapeee/GRIDCITY/releases';

/** Once a day; the first check soon after start so a fresh launch sees it. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdateCheckerOptions {
  currentVersion: string;
  install: InstallKind;
  /** The Settings switch (read on every check, so turning it off stops the next one). */
  enabled: () => boolean;
  /** GRIDCITY_UPDATE_CHECK=off: never ask, whatever Settings says. */
  lockedOff?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  onChange?: (info: UpdateInfo) => void;
}

/**
 * Asks GitHub whether a newer GRIDCITY is out. One anonymous GET to a public
 * page, no cookies, nothing about the user or their servers. Failures (no
 * network, rate limit) are kept quiet: they only show as "could not check".
 */
export class UpdateChecker {
  private latest: string | null = null;
  private releaseUrl: string | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<UpdateInfo> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return !this.options.lockedOff && this.options.enabled();
  }

  view(): UpdateInfo {
    const enabled = this.enabled;
    const latest = enabled ? this.latest : null;
    return {
      current: this.options.currentVersion,
      latest,
      available: latest !== null && isNewerVersion(latest, this.options.currentVersion),
      releaseUrl: enabled ? this.releaseUrl : null,
      checkedAt: enabled ? this.checkedAt : null,
      enabled,
      lockedOff: Boolean(this.options.lockedOff),
      install: this.options.install,
      error: enabled ? this.error : null,
    };
  }

  /** First check shortly after start, then once a day. */
  start(): void {
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Checks now (the "Check now" button, or the timer). Off: does nothing. */
  check(): Promise<UpdateInfo> {
    if (!this.enabled) return Promise.resolve(this.view());
    this.running ??= this.ask().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delay: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(UPDATE_CHECK_INTERVAL_MS));
    }, delay);
    this.timer.unref?.();
  }

  private async ask(): Promise<UpdateInfo> {
    try {
      const response = await this.fetchImpl(LATEST_RELEASE_URL, {
        headers: {
          accept: 'application/vnd.github+json',
          // A generic name: GitHub asks for one, and it says nothing about the user.
          'user-agent': 'GRIDCITY-update-check',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
      if (!parseVersion(tag)) throw new Error('GitHub sent no version');
      this.latest = tag.replace(/^v/, '');
      this.releaseUrl =
        typeof body.html_url === 'string' && body.html_url.startsWith(RELEASES_PAGE)
          ? body.html_url
          : `${RELEASES_PAGE}/tag/v${this.latest}`;
      this.checkedAt = this.now();
      this.error = null;
    } catch (error) {
      this.error =
        (error as Error).name === 'TimeoutError'
          ? 'GitHub did not answer in time'
          : (error as Error).message;
    }
    const info = this.view();
    this.options.onChange?.(info);
    return info;
  }
}

/** desktop (Electron runs the server), Docker, or npm/npx. */
export function detectInstall(inContainer: boolean): InstallKind {
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return 'desktop';
  return inContainer ? 'docker' : 'npm';
}

/** GRIDCITY_UPDATE_CHECK=off (or false, 0, no) turns the check off for good. */
export function updateCheckLockedOff(env: NodeJS.ProcessEnv): boolean {
  return /^(off|false|0|no)$/i.test(env.GRIDCITY_UPDATE_CHECK?.trim() ?? '');
}
