export type GroupType = 'group' | 'community';

export type DeliveryStatus = 'pending' | 'sent' | 'queued' | 'failed' | 'delivered';

export interface Contact {
  username: string;
  displayName: string;
  phone?: string;
}

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];
  createdBy: string;
  updatedAt: number;
  type: GroupType;
}

export interface ChatMessage {
  id: string;
  messageId: string;
  chatId: string;
  sender: string;
  senderDisplayName?: string;
  recordType?: string;
  body: string;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  direction: 'incoming' | 'outgoing';
  timestamp: number;
  deliveryStatus: DeliveryStatus;
  groupId?: string | null;
  groupName?: string | null;
}

export interface ChatListItem {
  id: string;
  title: string;
  subtitle: string;
  lastTimestamp: number;
  unread: number;
  isGroup: boolean;
  pinned: boolean;
}

export interface IncomingServerMessage {
  messageId?: string;
  sender?: string;
  body?: string;
  timestamp?: number;
  imageUrl?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupMembers?: string[] | null;
  groupCreatedBy?: string | null;
  groupUpdatedAt?: number | null;
  groupType?: GroupType | null;
  groupSenderName?: string | null;
}

export interface ReplyPayload {
  user: string;
  senderName: string;
  reply: string;
  imageUrl: string | null;
  originalSender: string;
  messageId: string;
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
  groupCreatedBy?: string;
  groupUpdatedAt?: number;
  groupType?: GroupType;
  groupSenderName?: string;
}

export interface GroupUpdatePayload {
  groupId: string;
  groupName: string;
  groupMembers: string[];
  groupCreatedBy: string;
  groupUpdatedAt: number;
  groupType: GroupType;
  membersToNotify: string[];
}

export interface OutboxDirectItem {
  id: string;
  kind: 'direct';
  payload: ReplyPayload;
  messageId: string;
  attempts: number;
  createdAt: number;
}

export interface OutboxGroupItem {
  id: string;
  kind: 'group';
  payload: Omit<ReplyPayload, 'originalSender'>;
  recipients: string[];
  messageId: string;
  attempts: number;
  createdAt: number;
}

export interface OutboxGroupUpdateItem {
  id: string;
  kind: 'group-update';
  payload: GroupUpdatePayload;
  attempts: number;
  createdAt: number;
}

export type OutboxItem = OutboxDirectItem | OutboxGroupItem | OutboxGroupUpdateItem;

export interface PersistedChatState {
  contacts: Contact[];
  groups: ChatGroup[];
  unreadByChat: Record<string, number>;
  messages: ChatMessage[];
}
