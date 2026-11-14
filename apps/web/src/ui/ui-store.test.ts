import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

describe('side panels', () => {
  beforeEach(() => {
    const ui = useUiStore.getState();
    ui.setUpcomingOpen(false);
    ui.setCostsOpen(false);
    ui.setSecurityOpen(false);
    ui.openDoctor(undefined);
  });

  it('show one at a time, so Esc closes the one you see', () => {
    const ui = useUiStore.getState();
    ui.setUpcomingOpen(true);
    ui.setCostsOpen(true);
    expect(useUiStore.getState()).toMatchObject({ upcomingOpen: false, costsOpen: true });

    ui.setSecurityOpen(true, 'web-01');
    ui.openDoctor(null);
    expect(useUiStore.getState()).toMatchObject({
      costsOpen: false,
      securityOpen: false,
      securityTarget: null,
      doctorTarget: null,
    });
  });

  it('closing one leaves the others alone', () => {
    const ui = useUiStore.getState();
    ui.setUpcomingOpen(true);
    ui.setCostsOpen(false);
    expect(useUiStore.getState().upcomingOpen).toBe(true);
  });
});
