import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, signal } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router, RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs';
import { ChatStoreService } from './core/services/chat-store.service';
import { runtimeConfig } from './core/config/runtime-config';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnDestroy {
  private static readonly MOBILE_CACHE_SESSION_KEY = 'mobile-cache-cleanup-v4';
  private static readonly STARTUP_SYNC_TIMEOUT_MS = 7000;
  private static readonly STARTUP_LOADER_TIMEOUT_MS = 30000;
  readonly startupLoaderVisible = signal(true);
  readonly startupLoaderSeconds = signal(0);
  private startupLoaderIntervalId: number | null = null;
  private startupLoaderTimeoutId: number | null = null;
  private startupNavigationSub: Subscription | null = null;

  constructor(
    private readonly store: ChatStoreService,
    private readonly router: Router
  ) {
    this.startStartupLoader();
    void this.clearCachesOnMobileLoad();
    this.bindServiceWorkerWindowContextSync();
  }

  ngOnDestroy(): void {
    this.stopStartupLoaderTimers();
    this.startupNavigationSub?.unsubscribe();
    this.startupNavigationSub = null;
  }

  private startStartupLoader(): void {
    if (typeof window === 'undefined') {
      this.startupLoaderVisible.set(false);
      return;
    }

    this.startupLoaderIntervalId = window.setInterval(() => {
      this.startupLoaderSeconds.update((value) => value + 1);
    }, 1000);
    this.startupLoaderTimeoutId = window.setTimeout(() => {
      this.hideStartupLoader();
    }, App.STARTUP_LOADER_TIMEOUT_MS);

    this.startupNavigationSub = this.router.events.subscribe((event) => {
      if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.hideStartupLoader();
      }
    });
  }

  private hideStartupLoader(): void {
    if (!this.startupLoaderVisible()) {
      return;
    }
    this.startupLoaderVisible.set(false);
    this.stopStartupLoaderTimers();
  }

  private stopStartupLoaderTimers(): void {
    if (this.startupLoaderIntervalId !== null) {
      window.clearInterval(this.startupLoaderIntervalId);
      this.startupLoaderIntervalId = null;
    }
    if (this.startupLoaderTimeoutId !== null) {
      window.clearTimeout(this.startupLoaderTimeoutId);
      this.startupLoaderTimeoutId = null;
    }
  }

  private async clearCachesOnMobileLoad(): Promise<void> {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return;
    }

    if (!this.isMobileDevice() || !this.shouldRunCacheCleanup()) {
      return;
    }

    try {
      await this.preloadMessagesBeforeCacheCleanup();
      await this.refreshServiceWorkers();

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

  private async preloadMessagesBeforeCacheCleanup(): Promise<void> {
    if (!this.store.isAuthenticated()) {
      return;
    }

    const syncTask = this.store.preloadLatestMessagesBeforeCacheCleanup();
    const timeoutTask = new Promise<void>((resolve) => {
      window.setTimeout(resolve, App.STARTUP_SYNC_TIMEOUT_MS);
    });

    await Promise.race([syncTask, timeoutTask]);
  }

  private bindServiceWorkerWindowContextSync(): void {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return;
    }
    if (!('serviceWorker' in navigator)) {
      return;
    }

    const postContext = (): void => {
      const standalone = this.isStandaloneWindow();
      const username = String(
        this.store.currentUser() || ''
      )
        .trim()
        .toLowerCase();
      const payload = {
        action: 'register-window-context',
        standalone,
        username,
        subscriptionUrl: runtimeConfig.subscriptionUrl,
        vapidPublicKey: runtimeConfig.vapidPublicKey,
        url: window.location.href,
        at: Date.now()
      };

      void navigator.serviceWorker.ready
        .then((registration) => {
          const worker = registration.active ?? navigator.serviceWorker.controller;
          worker?.postMessage(payload);
        })
        .catch(() => undefined);
    };

    postContext();
    window.addEventListener('focus', postContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        postContext();
      }
    });
  }

  private isStandaloneWindow(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return false;
    }

    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    return Boolean(
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      navigatorWithStandalone.standalone
    );
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

  private async refreshServiceWorkers(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
  }

  private async clearIndexedDatabases(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      return;
    }

    const knownNames = ['PushNotificationsDB'];
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
              .filter((name) => !name.startsWith('ngsw:'))
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
