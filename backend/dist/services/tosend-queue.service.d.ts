import { Pool } from 'mysql2/promise';

export interface ToSendMessage {
  id?: number;
  recipient: string;
  sender: string;
  message_content: string;
  created_at?: Date | string;
  status?: string;
}

export interface ToSendMessageResponse {
  recipient: string;
  sender: string;
  content: string;
}

export interface ToSendQueueStats {
  pending: number;
  sent: number;
  total: number;
}

export declare class ToSendQueueService {
  constructor(pool: Pool);
  ensureTableExists(): Promise<void>;
  addMessage(message: ToSendMessage): Promise<number>;
  addMessages(messages: ToSendMessage[]): Promise<number>;
  getPendingMessages(recipient?: string): Promise<ToSendMessageResponse[]>;
  markMessagesSent(ids: number[]): Promise<void>;
  deleteSentMessages(): Promise<number>;
  getQueueStats(): Promise<ToSendQueueStats>;
  clearQueue(): Promise<number>;
}
