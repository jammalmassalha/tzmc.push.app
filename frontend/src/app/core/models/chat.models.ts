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
  status?: number;
}

export interface ChatGroup {
  id: string;
  name: string;
  members: string[];
  admins?: string[];
  createdBy: string;
  updatedAt: number;
  type: GroupType;
}

export interface CommunityGroupConfig {
  id: string;
  name: string;
  staticMembers?: string[];
  allowedWriters: string[];
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
  fileUrl?: string | null;
  direction: 'incoming' | 'outgoing';
  timestamp: number;
  deliveryStatus: DeliveryStatus;
  groupId?: string | null;
  groupName?: string | null;
  groupType?: GroupType | null;
  reactions?: MessageReaction[];
  editedAt?: number | null;
  deletedAt?: number | null;
  replyTo?: MessageReference | null;
  forwarded?: boolean;
  forwardedFrom?: string | null;
  forwardedFromName?: string | null;
  userReceivedTime?: number | null;
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
  toUser?: string;
  recipient?: string;
  type?: string;
  chatId?: string;
  isTyping?: boolean;
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
  fileUrl?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupMembers?: string[] | null;
  groupCreatedBy?: string | null;
  groupAdmins?: string[] | null;
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
  userReceivedTime?: number;
}

export interface ReplyPayload {
  user: string;
  senderName: string;
  reply: string;
  imageUrl: string | null;
  fileUrl?: string | null;
  originalSender: string;
  messageId: string;
  membersToNotify?: string[];
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
  groupCreatedBy?: string;
  groupAdmins?: string[];
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
  groupAdmins?: string[];
  actorUser?: string;
  groupUpdatedAt: number;
  groupType: GroupType;
  membersToNotify: string[];
}

export interface ReactionPayload {
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
  groupCreatedBy?: string;
  groupAdmins?: string[];
  groupUpdatedAt?: number;
  groupType?: GroupType;
  targetUser?: string;
  targetMessageId: string;
  emoji: string;
  reactor: string;
  reactorName: string;
}

export interface TypingPayload {
  user: string;
  isTyping: boolean;
  targetUser?: string;
  chatId?: string;
  groupId?: string;
  groupName?: string;
  groupMembers?: string[];
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
  groupAdmins?: string[];
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
  groupAdmins?: string[];
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

export type HelpdeskDepartment = 'מערכות מידע' | 'אחזקה';
export type HelpdeskStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type HelpdeskRole = 'Admin' | 'Editor';

export interface HelpdeskTicketPayload {
  department: HelpdeskDepartment;
  title: string;
  description: string;
  location?: string | null;
}

export interface HelpdeskTicket {
  id: number;
  creatorUsername: string;
  department: string;
  title: string;
  description: string;
  location?: string | null;
  status: HelpdeskStatus;
  handlerUsername?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HelpdeskManagedUser {
  username: string;
  role: HelpdeskRole;
  department: string;
}

export interface HelpdeskMyRole {
  role: HelpdeskRole;
  department: string;
}

export interface HelpdeskDashboard {
  ongoing: HelpdeskTicket[];
  past: HelpdeskTicket[];
  assigned: HelpdeskTicket[];
  myRole: HelpdeskMyRole | null;
  editorTickets: HelpdeskTicket[] | null;
  handlers: HelpdeskManagedUser[] | null;
}

export interface HelpdeskNote {
  id: number;
  ticketId: number;
  authorUsername: string;
  noteText: string;
  attachmentUrl?: string | null;
  createdAt: string;
}

export interface HelpdeskStatusHistoryEntry {
  id: number;
  ticketId: number;
  oldStatus: string | null;
  newStatus: string;
  changedBy: string;
  createdAt: string;
}

export interface PersistedChatState {
  contacts: Contact[];
  groups: ChatGroup[];
  unreadByChat: Record<string, number>;
  messages: ChatMessage[];
}
