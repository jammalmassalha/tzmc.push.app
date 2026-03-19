import { TestBed } from '@angular/core/testing';
import { ChatApiService } from './chat-api.service';
import { ChatStoreService } from './chat-store.service';
import { beforeEach, describe, expect, it } from 'vitest';

describe('ChatStoreService full sync ordering', () => {
  let service: ChatStoreService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ChatStoreService,
        {
          provide: ChatApiService,
          useValue: {}
        }
      ]
    });
    service = TestBed.inject(ChatStoreService);
  });

  it('keeps deletion when delete-action arrives before base message', () => {
    const sender = '0501111111';
    const messageId = 'msg-delete-order-1';
    const messageTimestamp = 1710000000000;
    const deletedAt = 1710000005000;

    (service as any).applyIncomingMessagesBatch(
      [
        {
          type: 'delete-action',
          sender,
          messageId,
          deletedAt,
          timestamp: deletedAt
        },
        {
          sender,
          messageId,
          body: 'hello world',
          timestamp: messageTimestamp
        }
      ],
      {
        applyActions: true,
        incrementUnread: false,
        trackReadReceipts: false
      }
    );

    const chatId = (service as any).normalizeChatId(sender);
    const messagesByChat = (service as any).messagesByChat() as Record<string, Array<Record<string, unknown>>>;
    const chatMessages = messagesByChat[chatId] ?? [];

    expect(chatMessages.length).toBe(1);
    expect(chatMessages[0]['messageId']).toBe(messageId);
    expect(chatMessages[0]['deletedAt']).toBe(deletedAt);
    expect(chatMessages[0]['body']).not.toBe('hello world');
  });

  it('keeps deleted incoming message hidden when duplicate arrives with new id', () => {
    const sender = '0503333333';
    const originalMessageId = 'msg-original-1';
    const duplicateMessageId = 'msg-duplicate-2';
    const messageTimestamp = 1710000010000;
    const deletedAt = 1710000015000;

    (service as any).applyIncomingMessagesBatch(
      [
        {
          sender,
          messageId: originalMessageId,
          body: 'ghost text',
          timestamp: messageTimestamp
        }
      ],
      {
        applyActions: true,
        incrementUnread: false,
        trackReadReceipts: false
      }
    );

    (service as any).applyIncomingMessagesBatch(
      [
        {
          type: 'delete-action',
          sender,
          messageId: originalMessageId,
          deletedAt,
          timestamp: deletedAt
        }
      ],
      {
        applyActions: true,
        incrementUnread: false,
        trackReadReceipts: false
      }
    );

    (service as any).applyIncomingMessagesBatch(
      [
        {
          sender,
          messageId: duplicateMessageId,
          body: 'ghost text',
          timestamp: messageTimestamp
        }
      ],
      {
        applyActions: true,
        incrementUnread: false,
        trackReadReceipts: false
      }
    );

    const chatId = (service as any).normalizeChatId(sender);
    const messagesByChat = (service as any).messagesByChat() as Record<string, Array<Record<string, unknown>>>;
    const chatMessages = messagesByChat[chatId] ?? [];

    expect(chatMessages.length).toBe(1);
    expect(chatMessages[0]['messageId']).toBe(originalMessageId);
    expect(chatMessages[0]['deletedAt']).toBe(deletedAt);
    expect(chatMessages[0]['body']).not.toBe('ghost text');
  });
});

describe('ChatStoreService HR sector filtering', () => {
  let service: ChatStoreService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ChatStoreService,
        {
          provide: ChatApiService,
          useValue: {}
        }
      ]
    });
    service = TestBed.inject(ChatStoreService);
  });

  it('keeps only HR steps that match current user sector', () => {
    (service as any).currentUser.set('0501111111');
    (service as any).contacts.set([
      {
        username: '0501111111',
        displayName: 'בודק',
        info: 'ענף הדרכה'
      }
    ]);

    const filtered = (service as any).filterHrStepsForCurrentUser([
      { id: '1', name: 'ענף רווחה', subject: '', showToAllUsers: false },
      { id: '2', name: 'ענף הדרכה', subject: '', showToAllUsers: false },
      { id: '3', name: 'טפסים', subject: 'הדרכה', showToAllUsers: false },
      { id: '4', name: 'פתוח לכולם', subject: '', showToAllUsers: true }
    ]);

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['2', '3', '4']);
  });

  it('returns only showToAllUsers rows when no sector match exists', () => {
    (service as any).currentUser.set('0502222222');
    (service as any).contacts.set([
      {
        username: '0502222222',
        displayName: 'בודק',
        info: 'לוגיסטיקה'
      }
    ]);

    const original = [
      { id: '1', name: 'ענף רווחה', subject: '', showToAllUsers: false },
      { id: '2', name: 'ענף הדרכה', subject: '', showToAllUsers: false },
      { id: '3', name: 'פתוח לכולם', subject: '', showToAllUsers: true }
    ];
    const filtered = (service as any).filterHrStepsForCurrentUser(original);

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['3']);
  });
});
