import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EffectRef,
  OnDestroy,
  computed,
  effect,
  signal
} from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterOutlet
} from '@angular/router';
import { Subscription } from 'rxjs';
import { ChatStoreService } from './core/services/chat-store.service';
import { getNotifyBaseUrl, runtimeConfig } from './core/config/runtime-config';

type StartupLoaderPhase = 'auth' | 'contacts' | 'chats' | 'finalizing' | 'ready';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnDestroy {
  private static readonly MOBILE_CACHE_MAJOR_VERSION_KEY = 'mobile-cache-major-version-v1';
  private static readonly STARTUP_SYNC_TIMEOUT_MS = 7000;
  private static readonly STARTUP_LOADER_TIMEOUT_MS = 30000;
  private static readonly STARTUP_HIDE_DELAY_MS = 220;
  private static readonly APP_VERSION_FETCH_TIMEOUT_MS = 2500;
  // Customize these labels to change startup loader text.
  private static readonly STARTUP_TEXT_BY_PHASE: Record<StartupLoaderPhase, string> = {
    auth: 'מאמת משתמש…',
    contacts: 'טוען נתוני אנשי קשר…',
    chats: 'טוען שיחות והודעות…',
    finalizing: 'מסיים טעינה…',
    ready: 'מוכן'
  };
  private static readonly STARTUP_MIN_PERCENT_BY_PHASE: Record<StartupLoaderPhase, number> = {
    auth: 12,
    contacts: 45,
    chats: 72,
    finalizing: 92,
    ready: 100
  };
  private static readonly STARTUP_MAX_PERCENT_BY_PHASE: Record<StartupLoaderPhase, number> = {
    auth: 36,
    contacts: 68,
    chats: 88,
    finalizing: 98,
    ready: 100
  };

  readonly startupLoaderVisible = signal(true);
  readonly startupLoaderSeconds = signal(0);
  readonly startupLoaderPhase = signal<StartupLoaderPhase>('auth');
  readonly startupLoaderPercent = signal(12);
  readonly startupLoaderText = computed(() => {
    const phase = this.startupLoaderPhase();
    const label = App.STARTUP_TEXT_BY_PHASE[phase] ?? 'טוען…';
    return `${label} ${this.startupLoaderSeconds()}s`;
  });
  private startupLoaderIntervalId: number | null = null;
  private startupLoaderTimeoutId: number | null = null;
  private startupLoaderHideDelayId: number | null = null;
  private startupNavigationSub: Subscription | null = null;
  private startupStorePhaseEffectRef: EffectRef | null = null;

  constructor(
    private readonly store: ChatStoreService,
    private readonly router: Router
  ) {
    this.startStartupLoader();
    this.scheduleCacheCleanupAfterInitialRender();
    this.bindServiceWorkerWindowContextSync();
  }

  ngOnDestroy(): void {
    this.stopStartupLoaderTimers();
    if (this.startupLoaderHideDelayId !== null) {
      window.clearTimeout(this.startupLoaderHideDelayId);
      this.startupLoaderHideDelayId = null;
    }
    this.startupNavigationSub?.unsubscribe();
    this.startupNavigationSub = null;
    this.startupStorePhaseEffectRef?.destroy();
    this.startupStorePhaseEffectRef = null;
  }

  private startStartupLoader(): void {
    if (typeof window === 'undefined') {
      this.startupLoaderVisible.set(false);
      return;
    }

    this.setStartupLoaderPhase('auth');
    this.startupLoaderIntervalId = window.setInterval(() => {
      this.startupLoaderSeconds.update((value) => value + 1);
      this.advanceStartupLoaderProgressTick();
    }, 1000);
    this.startupLoaderTimeoutId = window.setTimeout(() => {
      this.hideStartupLoader();
    }, App.STARTUP_LOADER_TIMEOUT_MS);
    this.startupStorePhaseEffectRef = effect(() => {
      if (!this.startupLoaderVisible()) {
        return;
      }
      if (this.store.loading()) {
        this.setStartupLoaderPhase('contacts');
        return;
      }
      if (this.store.syncing()) {
        this.setStartupLoaderPhase('chats');
      }
    });

    this.startupNavigationSub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.setStartupLoaderPhase('chats');
        return;
      }
      if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) {
        this.completeStartupLoader();
      }
    });
  }

  private setStartupLoaderPhase(phase: StartupLoaderPhase): void {
    if (!this.startupLoaderVisible()) return;
    this.startupLoaderPhase.set(phase);
    const minPercent = App.STARTUP_MIN_PERCENT_BY_PHASE[phase] ?? 0;
    this.startupLoaderPercent.update((value) => Math.max(value, minPercent));
  }

  private advanceStartupLoaderProgressTick(): void {
    if (!this.startupLoaderVisible()) return;
    const phase = this.startupLoaderPhase();
    const maxPercent = App.STARTUP_MAX_PERCENT_BY_PHASE[phase] ?? 99;
    if (maxPercent <= 0) return;
    this.startupLoaderPercent.update((value) => Math.min(maxPercent, value + 1));
  }

  private completeStartupLoader(): void {
    if (!this.startupLoaderVisible()) return;
    this.setStartupLoaderPhase('finalizing');
    this.startupLoaderPercent.set(100);
    this.startupLoaderPhase.set('ready');
    if (this.startupLoaderHideDelayId !== null) {
      window.clearTimeout(this.startupLoaderHideDelayId);
    }
    this.startupLoaderHideDelayId = window.setTimeout(() => {
      this.startupLoaderHideDelayId = null;
      this.hideStartupLoader();
    }, App.STARTUP_HIDE_DELAY_MS);
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

  private scheduleCacheCleanupAfterInitialRender(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.setTimeout(() => {
      void this.clearCachesOnMobileLoad();
    }, 1200);
  }

  private async clearCachesOnMobileLoad(): Promise<void> {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return;
    }

    if (!this.isMobileDevice()) {
      return;
    }

    const cleanupDecision = await this.getCacheCleanupDecision();
    if (!cleanupDecision.shouldCleanup) {
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
      this.markCacheCleanupVersion(cleanupDecision.currentMajorVersion);
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
        subscriptionUrl: `${getNotifyBaseUrl(runtimeConfig.notifyReplyUrl)}/register-device`,
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
    window.addEventListener('focus', () => {
      postContext();
      if (this.store.isAuthenticated()) {
        void this.store.drainAllPendingPushPayloads();
      }
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        postContext();
        if (this.store.isAuthenticated()) {
          void this.store.drainAllPendingPushPayloads();
        }
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

  private async getCacheCleanupDecision(): Promise<{
    shouldCleanup: boolean;
    currentMajorVersion: string;
  }> {
    const currentMajorVersion = await this.resolveCurrentMajorAppVersion();
    if (!currentMajorVersion) {
      return { shouldCleanup: false, currentMajorVersion: '' };
    }

    const previousMajorVersion = this.readMarkedCacheCleanupVersion();
    if (!previousMajorVersion) {
      this.markCacheCleanupVersion(currentMajorVersion);
      return { shouldCleanup: false, currentMajorVersion };
    }

    return {
      shouldCleanup: previousMajorVersion !== currentMajorVersion,
      currentMajorVersion
    };
  }

  private readMarkedCacheCleanupVersion(): string | null {
    try {
      const value = localStorage.getItem(App.MOBILE_CACHE_MAJOR_VERSION_KEY);
      return value ? value.trim() : null;
    } catch {
      return null;
    }
  }

  private markCacheCleanupVersion(majorVersion: string): void {
    if (!majorVersion) {
      return;
    }
    try {
      localStorage.setItem(App.MOBILE_CACHE_MAJOR_VERSION_KEY, majorVersion);
    } catch {
      // Ignore storage write failures.
    }
  }

  private async resolveCurrentMajorAppVersion(): Promise<string | null> {
    const version = await this.fetchCurrentAppVersion();
    if (!version) {
      return null;
    }
    return this.extractMajorVersion(version);
  }

  private async fetchCurrentAppVersion(): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), App.APP_VERSION_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${runtimeConfig.versionUrl}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { version?: unknown };
      const value = String(body?.version ?? '').trim();
      return value || null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private extractMajorVersion(version: string): string | null {
    const normalized = version.trim();
    const match = normalized.match(/^v?(\d+)(?:[.\-+_]|$)/i);
    return match?.[1] ?? null;
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
}
