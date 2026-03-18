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
});
