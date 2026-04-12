import { Injectable, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ChatApiService, RealtimeSocket } from './chat-api.service';

export type RealtimeTransportMode = 'socket' | 'sse' | 'polling';

const POLL_INTERVAL_MS = 15000;
const STREAM_RETRY_MS = 5000;
const SOCKET_RETRY_MS = 3500;
const SOCKET_FALLBACK_TO_SSE_DELAY_MS = 1800;
const SOCKET_MAX_FAILURES_BEFORE_COOLDOWN = 3;
const SOCKET_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const SOCKET_ACK_TIMEOUT_MS = 6000;

@Injectable({ providedIn: 'root' })
export class RealtimeTransportService {
  /** Current transport mode. */
  readonly transportMode = signal<RealtimeTransportMode>('polling');

  /** Human-readable label for the current transport mode. */
  readonly transportLabel = computed(() => {
    const mode = this.transportMode();
    if (mode === 'socket') return 'Socket';
    if (mode === 'sse') return 'SSE';
    return 'Polling';
  });

  /** Emits raw incoming payloads from any transport (socket object or SSE string). */
  readonly message$ = new Subject<string | object>();

  /**
   * Emits whenever a transport successfully connects or reconnects.
   * Consumers should use this to trigger foreground sync (pull messages, recover logs, etc.).
   */
  readonly connected$ = new Subject<void>();

  /** Emits on each polling interval tick so the consumer can pull messages. */
  readonly pollTick$ = new Subject<void>();

  private socket: RealtimeSocket | null = null;
  private socketConnected = false;
  private socketConnecting = false;
  private stream: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketSseFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private socketConsecutiveFailures = 0;
  private socketDisabledUntil = 0;

  private activeUser: string | null = null;
  private networkReachableFn: () => boolean = () => true;

  constructor(private readonly api: ChatApiService) {}

  /**
   * Start the transport state machine for the given user.
   * Attempts Socket.io first, then falls back to SSE, with automatic reconnect.
   *
   * @param user          Normalized user identifier.
   * @param isNetworkReachable  Callback that returns whether the network is currently reachable.
   */
  connect(user: string, isNetworkReachable: () => boolean): void {
    this.disconnect();
    this.activeUser = user;
    this.networkReachableFn = isNetworkReachable;
    if (!this.networkReachableFn()) {
      return;
    }
    void this.connectSocketPreferred(user);
  }

  /**
   * Emit an event through the active socket and wait for an acknowledgement.
   * Returns `null` when the socket is not connected or the ack times out.
   */
  emitWithAck(
    eventName: string,
    payload: unknown,
    timeoutMs = SOCKET_ACK_TIMEOUT_MS
  ): Promise<Record<string, unknown> | null> {
    if (!this.socket || !this.socketConnected) {
      return Promise.resolve(null);
    }

    return new Promise<Record<string, unknown> | null>((resolve) => {
      let settled = false;
      const done = (value: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const timeoutId = setTimeout(() => done(null), timeoutMs);
      try {
        this.socket?.emit(eventName, payload, (ackPayload: unknown) => {
          if (ackPayload && typeof ackPayload === 'object') {
            done(ackPayload as Record<string, unknown>);
            return;
          }
          done(null);
        });
      } catch {
        done(null);
      }
    });
  }

  /** Tear down all transports and timers. */
  disconnect(): void {
    this.shuttingDown = true;
    this.stopSocketOnly();
    this.stopStreamOnly();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socketReconnectTimer) {
      clearTimeout(this.socketReconnectTimer);
      this.socketReconnectTimer = null;
    }
    if (this.socketSseFallbackTimer) {
      clearTimeout(this.socketSseFallbackTimer);
      this.socketSseFallbackTimer = null;
    }

    this.setTransportMode('polling');
    this.shuttingDown = false;
  }

  /** Start interval-based polling (dead-code path kept for completeness). */
  startPolling(user: string): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      this.pollTick$.next();
    }, POLL_INTERVAL_MS);

    if (!this.socketConnected && !this.stream) {
      this.setTransportMode('polling');
    }

    this.pollTick$.next();
    this.activeUser = user;
  }

  // ---------------------------------------------------------------------------
  //  Socket.io
  // ---------------------------------------------------------------------------

  private async connectSocketPreferred(user: string): Promise<void> {
    this.shuttingDown = false;
    if (this.socketDisabledUntil > Date.now()) {
      this.startSseFallback(user);
      this.scheduleSocketReconnect(user);
      return;
    }
    if (!this.networkReachableFn()) {
      this.startSseFallback(user);
      return;
    }
    if (this.socketConnecting) {
      return;
    }
    this.socketConnecting = true;

    if (this.socketSseFallbackTimer) {
      clearTimeout(this.socketSseFallbackTimer);
      this.socketSseFallbackTimer = null;
    }

    this.socketSseFallbackTimer = setTimeout(() => {
      this.socketSseFallbackTimer = null;
      if (!this.socketConnected && this.activeUser === user) {
        this.startSseFallback(user);
      }
    }, SOCKET_FALLBACK_TO_SSE_DELAY_MS);

    try {
      const socket = await this.api.createRealtimeSocket(user);
      if (this.activeUser !== user) {
        socket.disconnect();
        return;
      }
      this.shuttingDown = true;
      this.stopSocketOnly();
      this.shuttingDown = false;
      this.socket = socket;

      socket.on('connect', () => {
        if (this.activeUser !== user) return;
        this.resetSocketFailureState();
        this.socketConnected = true;
        this.socketConnecting = false;
        this.setTransportMode('socket');
        if (this.socketSseFallbackTimer) {
          clearTimeout(this.socketSseFallbackTimer);
          this.socketSseFallbackTimer = null;
        }
        this.stopStreamOnly();
        this.connected$.next();
      });

      socket.on('chat:message', (incoming: unknown) => {
        if (!incoming || typeof incoming !== 'object') return;
        this.message$.next(incoming as object);
      });

      socket.on('chat:connected', () => {
        if (this.activeUser !== user) return;
        this.resetSocketFailureState();
        this.socketConnected = true;
        this.setTransportMode('socket');
        this.stopStreamOnly();
        this.connected$.next();
      });

      socket.on('disconnect', () => {
        if (this.shuttingDown || this.activeUser !== user) return;
        this.shuttingDown = true;
        this.stopSocketOnly();
        this.shuttingDown = false;
        this.socketConnected = false;
        this.socketConnecting = false;
        this.setTransportMode('polling');
        this.handleSocketConnectFailure(user);
      });

      socket.on('connect_error', () => {
        if (this.shuttingDown || this.activeUser !== user) return;
        this.shuttingDown = true;
        this.stopSocketOnly();
        this.shuttingDown = false;
        this.socketConnected = false;
        this.socketConnecting = false;
        this.setTransportMode('polling');
        this.handleSocketConnectFailure(user);
      });

      socket.connect();
    } catch {
      this.shuttingDown = true;
      this.stopSocketOnly();
      this.shuttingDown = false;
      this.socketConnecting = false;
      this.socketConnected = false;
      this.setTransportMode('polling');
      this.handleSocketConnectFailure(user);
    }
  }

  // ---------------------------------------------------------------------------
  //  SSE
  // ---------------------------------------------------------------------------

  private startSseFallback(user: string): void {
    if (this.socketConnected || !this.networkReachableFn()) {
      return;
    }
    if (this.stream) {
      return;
    }
    try {
      this.stream = this.api.createMessageStream(user);
      this.setTransportMode('sse');
      this.stream.addEventListener('message', (event: MessageEvent<string>) => {
        this.message$.next(event.data);
      });
      this.stream.addEventListener('connected', () => {
        this.connected$.next();
      });
      this.stream.onerror = () => {
        this.stopStreamOnly();
        this.scheduleStreamReconnect(user);
      };
    } catch {
      this.scheduleStreamReconnect(user);
    }
  }

  // ---------------------------------------------------------------------------
  //  Failure handling & reconnect
  // ---------------------------------------------------------------------------

  private handleSocketConnectFailure(user: string): void {
    if (this.activeUser !== user) {
      return;
    }
    this.socketConsecutiveFailures += 1;
    this.startSseFallback(user);

    if (this.socketConsecutiveFailures >= SOCKET_MAX_FAILURES_BEFORE_COOLDOWN) {
      this.socketConsecutiveFailures = 0;
      this.socketDisabledUntil = Date.now() + SOCKET_FAILURE_COOLDOWN_MS;
    }

    this.scheduleSocketReconnect(user);
  }

  private resetSocketFailureState(): void {
    this.socketConsecutiveFailures = 0;
    this.socketDisabledUntil = 0;
  }

  private scheduleStreamReconnect(user: string): void {
    if (this.socketConnected || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.activeUser !== user) return;
      this.startSseFallback(user);
    }, STREAM_RETRY_MS);
  }

  private scheduleSocketReconnect(user: string): void {
    if (this.socketReconnectTimer) return;
    const waitMs = this.socketDisabledUntil > Date.now()
      ? Math.max(SOCKET_RETRY_MS, this.socketDisabledUntil - Date.now())
      : SOCKET_RETRY_MS;
    this.socketReconnectTimer = setTimeout(() => {
      this.socketReconnectTimer = null;
      if (this.activeUser !== user || !this.networkReachableFn()) return;
      void this.connectSocketPreferred(user);
    }, waitMs);
  }

  // ---------------------------------------------------------------------------
  //  Internal teardown helpers
  // ---------------------------------------------------------------------------

  private stopSocketOnly(): void {
    this.socketConnected = false;
    this.socketConnecting = false;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    if (this.stream) {
      this.setTransportMode('sse');
    } else {
      this.setTransportMode('polling');
    }
  }

  private stopStreamOnly(): void {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
    if (!this.socketConnected) {
      this.setTransportMode('polling');
    }
  }

  private setTransportMode(mode: RealtimeTransportMode): void {
    if (this.transportMode() === mode) {
      return;
    }
    this.transportMode.set(mode);
  }
}
