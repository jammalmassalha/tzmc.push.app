import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App {
  private static readonly MOBILE_CACHE_SESSION_KEY = 'mobile-cache-cleanup-v2';

  constructor() {
    void this.clearCachesOnMobileLoad();
  }

  private async clearCachesOnMobileLoad(): Promise<void> {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return;
    }

    if (!this.isMobileDevice() || !this.shouldRunCacheCleanup()) {
      return;
    }

    try {
      await this.clearServiceWorkers();

      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }

      await this.clearIndexedDatabases();
      this.markCacheCleanupDone();
    } catch {
      // Keep app startup resilient even if cache cleanup fails.
    }
  }

  private shouldRunCacheCleanup(): boolean {
    if (this.isReloadNavigation()) {
      return true;
    }

    try {
      return !sessionStorage.getItem(App.MOBILE_CACHE_SESSION_KEY);
    } catch {
      return false;
    }
  }

  private markCacheCleanupDone(): void {
    try {
      sessionStorage.setItem(App.MOBILE_CACHE_SESSION_KEY, '1');
    } catch {
      // Ignore session storage write failures.
    }
  }

  private async clearServiceWorkers(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  }

  private async clearIndexedDatabases(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      return;
    }

    const knownNames = ['ngsw:db', 'PushNotificationsDB'];
    const idbFactory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    };

    let databaseNames = [...knownNames];
    if (typeof idbFactory.databases === 'function') {
      try {
        const discovered = await idbFactory.databases();
        databaseNames = Array.from(
          new Set([
            ...knownNames,
            ...discovered
              .map((entry) => String(entry?.name ?? '').trim())
              .filter(Boolean)
          ])
        );
      } catch {
        // Ignore discovery failure and fallback to known names.
      }
    }

    await Promise.all(
      databaseNames.map(
        (name) =>
          new Promise<void>((resolve) => {
            try {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            } catch {
              resolve();
            }
          })
      )
    );
  }

  private isMobileDevice(): boolean {
    return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  private isReloadNavigation(): boolean {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (entries.length > 0) {
      return entries[0].type === 'reload';
    }

    const legacyNavigation = (performance as Performance & { navigation?: { type?: number } }).navigation;
    return legacyNavigation?.type === 1;
  }
}
