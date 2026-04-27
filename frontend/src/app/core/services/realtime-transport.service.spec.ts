import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatApiService, RealtimeSocket } from './chat-api.service';
import { RealtimeTransportService } from './realtime-transport.service';

function createMockSocket(): RealtimeSocket & {
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
  fire: (event: string, ...args: unknown[]) => void;
} {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const socket = {
    connected: false,
    auth: {},
    handlers,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(listener);
      return socket;
    },
    connect() {
      return socket;
    },
    disconnect() {
      return socket;
    },
    emit() {
      return socket;
    },
    fire(event: string, ...args: unknown[]) {
      for (const fn of handlers[event] ?? []) fn(...args);
    }
  } as unknown as RealtimeSocket & {
    handlers: Record<string, ((...args: unknown[]) => void)[]>;
    fire: (event: string, ...args: unknown[]) => void;
  };
  return socket;
}

describe('RealtimeTransportService', () => {
  let service: RealtimeTransportService;
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockApi: { createRealtimeSocket: ReturnType<typeof vi.fn>; createMessageStream: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSocket = createMockSocket();
    mockApi = {
      createRealtimeSocket: vi.fn().mockResolvedValue(mockSocket),
      createMessageStream: vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null
      })
    };

    TestBed.configureTestingModule({
      providers: [
        RealtimeTransportService,
        { provide: ChatApiService, useValue: mockApi }
      ]
    });
    service = TestBed.inject(RealtimeTransportService);
  });

  it('starts in polling mode', () => {
    expect(service.transportMode()).toBe('polling');
    expect(service.transportLabel()).toBe('Polling');
  });

  it('transitions to socket mode on successful connect', async () => {
    const connectedSpy = vi.fn();
    service.connected$.subscribe(connectedSpy);

    service.connect('user1', () => true);
    // Wait for async connectSocketPreferred to resolve
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalledWith('user1'));

    // Simulate socket connect event
    mockSocket.fire('connect');

    expect(service.transportMode()).toBe('socket');
    expect(service.transportLabel()).toBe('Socket');
    expect(connectedSpy).toHaveBeenCalled();
  });

  it('emits messages from socket', async () => {
    const messages: unknown[] = [];
    service.message$.subscribe((m) => messages.push(m));

    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('connect');
    mockSocket.fire('chat:message', { messageId: 'msg1', body: 'hello' });

    expect(messages.length).toBe(1);
    expect((messages[0] as Record<string, unknown>)['messageId']).toBe('msg1');
  });

  it('ignores non-object chat:message payloads', async () => {
    const messages: unknown[] = [];
    service.message$.subscribe((m) => messages.push(m));

    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('connect');
    mockSocket.fire('chat:message', null);
    mockSocket.fire('chat:message', undefined);

    expect(messages.length).toBe(0);
  });

  it('emits connected on chat:connected event', async () => {
    const connectedSpy = vi.fn();
    service.connected$.subscribe(connectedSpy);

    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('chat:connected');

    expect(connectedSpy).toHaveBeenCalled();
    expect(service.transportMode()).toBe('socket');
  });

  it('falls back to SSE on socket disconnect', async () => {
    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('connect');
    expect(service.transportMode()).toBe('socket');

    mockSocket.fire('disconnect');
    // After socket disconnect, handleSocketConnectFailure triggers SSE fallback
    expect(service.transportMode()).toBe('sse');
  });

  it('falls back to SSE on connect_error', async () => {
    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('connect_error');
    // After connect error, handleSocketConnectFailure triggers SSE fallback
    expect(service.transportMode()).toBe('sse');
  });

  it('resets to polling on disconnect()', async () => {
    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalled());

    mockSocket.fire('connect');
    expect(service.transportMode()).toBe('socket');

    service.disconnect();
    expect(service.transportMode()).toBe('polling');
  });

  it('does not connect when network is unreachable', () => {
    service.connect('user1', () => false);
    expect(mockApi.createRealtimeSocket).not.toHaveBeenCalled();
    expect(service.transportMode()).toBe('polling');
  });

  it('stops previous transport on new connect()', async () => {
    service.connect('user1', () => true);
    await vi.waitFor(() => expect(mockApi.createRealtimeSocket).toHaveBeenCalledTimes(1));

    const firstSocket = mockSocket;
    const disconnectSpy = vi.spyOn(firstSocket, 'disconnect');

    // Create a new mock socket for the second connect
    const secondSocket = createMockSocket();
    mockApi.createRealtimeSocket.mockResolvedValue(secondSocket);

    service.connect('user2', () => true);
    // The first socket should be disconnected during disconnect()
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('emits pollTick$ on startPolling', () => {
    let tickCount = 0;
    service.pollTick$.subscribe(() => { tickCount++; });

    service.startPolling('user1');

    expect(tickCount).toBe(1); // Immediate tick
    expect(service.transportMode()).toBe('polling');
  });
});
