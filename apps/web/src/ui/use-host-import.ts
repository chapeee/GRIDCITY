import { useCallback, useState } from 'react';
import { importSshConfig } from '../data/server-api';
import { useUiStore } from './ui-store';

/**
 * Imports hosts from ~/.ssh/config through the server. The server writes
 * hosts.yaml and reloads the fleet; new towers appear on the next snapshot.
 */
export function useHostImport(): { importHosts(): Promise<void>; importing: boolean } {
  const [importing, setImporting] = useState(false);

  const importHosts = useCallback(async () => {
    const { showNotice } = useUiStore.getState();
    setImporting(true);
    try {
      const report = await importSshConfig();
      const skipped =
        report.skipped.length > 0 ? ` (${report.skipped.length} already configured)` : '';
      showNotice(
        report.added.length > 0
          ? `Imported ${report.added.length} host(s) from ~/.ssh/config${skipped}. Connecting…`
          : `No new hosts in ~/.ssh/config${skipped}.`,
      );
    } catch (error) {
      showNotice(`Import failed: ${(error as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, []);

  return { importHosts, importing };
}
