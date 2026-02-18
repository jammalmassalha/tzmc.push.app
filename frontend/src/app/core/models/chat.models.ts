export type GroupType = 'group' | 'community';

export type DeliveryStatus = 'pending' | 'sent' | 'queued' | 'failed' | 'delivered' | 'read';

export interface MessageReaction {
  emoji: string;
  reactor: string;
  reactorName?: string;
}

export interface Contact {
  username: string;
  displayName: string;
  info?: string;
  phone?: string;
  upic?: string;
}

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];
  createdBy: string;
  updatedAt: number;
  type: GroupType;
}

export interface MessageReference {
  messageId: string;
  sender: string;
  senderDisplayName?: string;
  body?: string;
  imageUrl?: string | null;
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
  reactions?: MessageReaction[];
  editedAt?: number | null;
  deletedAt?: number | null;
  replyTo?: MessageReference | null;
  forwarded?: boolean;
  forwardedFrom?: string | null;
  forwardedFromName?: string | null;
}

export interface ChatListItem {
  id: string;
  title: string;
  info?: string;
  subtitle: string;
  lastTimestamp: number;
  unread: number;
  isGroup: boolean;
  pinned: boolean;
  avatarUrl?: string | null;
}

export interface IncomingServerMessage {
  messageId?: string;
  sender?: string;
  type?: string;
  editedAt?: number;
  deletedAt?: number;
  messageIds?: string[];
  readAt?: number;
  targetMessageId?: string;
  emoji?: string;
  reactor?: string;
  reactorName?: string;
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
  replyToMessageId?: string;
  replyToSender?: string;
  replyToSenderName?: string;
  replyToBody?: string;
  replyToImageUrl?: string | null;
  forwarded?: boolean;
  forwardedFrom?: string;
  forwardedFromName?: string;
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
  replyToMessageId?: string;
  replyToSender?: string;
  replyToSenderName?: string;
  replyToBody?: string;
  replyToImageUrl?: string | null;
  forwarded?: boolean;
  forwardedFrom?: string;
  forwardedFromName?: string;
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

export interface ReactionPayload {
  groupId: string;
  groupName: string;
  groupMembers: string[];
  groupCreatedBy: string;
  groupUpdatedAt: number;
  groupType: GroupType;
  targetMessageId: string;
  emoji: string;
  reactor: string;
  reactorName: string;
}

export interface ReadReceiptPayload {
  reader: string;
  sender: string;
  messageIds: string[];
  readAt: number;
}

export interface EditMessagePayload {
  sender: string;
  messageId: string;
  body: string;
  editedAt: number;
  timestamp?: number;
  recipient?: string;
  recipients?: string[];
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
  groupCreatedBy?: string;
  groupUpdatedAt?: number;
  groupType?: GroupType;
}

export interface DeleteMessagePayload {
  sender: string;
  messageId: string;
  deletedAt: number;
  timestamp?: number;
  recipient?: string;
  recipients?: string[];
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
  groupCreatedBy?: string;
  groupUpdatedAt?: number;
  groupType?: GroupType;
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
