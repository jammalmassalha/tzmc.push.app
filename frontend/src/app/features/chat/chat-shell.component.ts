import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  effect,
  signal
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, ActivatedRoute } from '@angular/router';
import { startWith } from 'rxjs';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  DeliveryStatus
} from '../../core/models/chat.models';
import { ChatStoreService, IncomingReactionNotice } from '../../core/services/chat-store.service';
import { CreateGroupDialogComponent } from './dialogs/create-group-dialog.component';
import { NewChatDialogComponent } from './dialogs/new-chat-dialog.component';

type MessageRenderPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'location'; url: string; label: string }
  | { kind: 'image'; url: string };

interface ParsedMessageCacheEntry {
  body: string;
  parts: MessageRenderPart[];
}

interface AvatarPreview {
  title: string;
  imageUrl: string;
  lqipUrl: string;
}

interface GroupMembersPreview {
  groupId: string;
  title: string;
  type: 'group' | 'community';
  canManageMembers: boolean;
  members: Array<{
    username: string;
    displayName: string;
    info?: string;
    isAdmin: boolean;
  }>;
}

interface GroupMemberAddCandidate {
  username: string;
  displayName: string;
  info?: string;
}

interface ReactionBucket {
  emoji: string;
  count: number;
}

interface ReactionDetailRow {
  username: string;
  displayName: string;
  emoji: string;
}

interface ReactionDetailsPreview {
  groupTitle: string;
  rows: ReactionDetailRow[];
}

@Component({
  selector: 'app-chat-shell',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    ScrollingModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatToolbarModule,
    MatProgressBarModule,
    MatChipsModule,
    MatSnackBarModule
  ],
  templateUrl: './chat-shell.component.html',
  styleUrl: './chat-shell.component.scss'
})
export class ChatShellComponent implements OnInit, OnDestroy {
  @ViewChild(CdkVirtualScrollViewport) contactsViewport?: CdkVirtualScrollViewport;
  @ViewChild('messagesPanel') messagesPanel?: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput') fileInputRef?: ElementRef<HTMLInputElement>;
  private readonly avatarThumbCache = new Map<string, string>();
  private readonly avatarLqipCache = new Map<string, string>();
  readonly loadedAvatarUrls = signal<Set<string>>(new Set<string>());
  readonly previewAvatarLoaded = signal(false);

  private readonly mobileQuery = window.matchMedia('(max-width: 960px)');
  private readonly onMediaChange = (event: MediaQueryListEvent): void => {
    this.isMobile.set(event.matches);
    this.showContactsPane.set(!event.matches || !this.store.activeChatId());
  };
  private readonly onViewportResize = (): void => this.updateViewportHeight();

  readonly searchControl = new FormControl('', { nonNullable: true });
  readonly messageControl = new FormControl('', { nonNullable: true });

  readonly searchTerm = toSignal(this.searchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });
  readonly messageValue = toSignal(this.messageControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });

  readonly isMobile = signal(this.mobileQuery.matches);
  readonly showContactsPane = signal(this.mobileQuery.matches);

  readonly filteredChats = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const chats = this.store.chatItems();
    if (!query) return chats;

    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(query) ||
        chat.id.toLowerCase().includes(query) ||
        chat.subtitle.toLowerCase().includes(query) ||
        String(chat.info || '').toLowerCase().includes(query)
    );
  });

  readonly composerPlaceholder = computed(() => {
    if (!this.store.activeChat()) {
      return 'בחר צ׳אט כדי להתחיל';
    }
    return this.store.canSendToActiveChat() ? 'הקלד הודעה' : 'רק מנהל יכול לשלוח בקבוצת קהילה';
  });

  readonly isBusy = computed(
    () => this.store.loading() || this.store.syncing() || this.store.uploading()
  );
  readonly reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly nowTimestamp = signal(Date.now());
  readonly stickyMessageTimestamp = signal<number | null>(null);
  readonly isMessagesPanelAtBottom = signal(true);
  readonly avatarPreview = signal<AvatarPreview | null>(null);
  readonly reactionTargetMessageId = signal<string | null>(null);
  readonly reactionDetailsPreview = signal<ReactionDetailsPreview | null>(null);
  readonly groupMembersPreview = signal<GroupMembersPreview | null>(null);
  readonly groupMemberAddCandidates = computed<GroupMemberAddCandidate[]>(() => {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return [];

    const existingMembers = new Set(preview.members.map((member) => member.username));
    return this.store.contacts()
      .filter((contact) => !existingMembers.has(contact.username))
      .map((contact) => ({
        username: contact.username,
        displayName: contact.displayName || contact.username,
        info: contact.info
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'he'));
  });
  readonly stickyMessageDateLabel = computed(() => {
    const timestamp = this.stickyMessageTimestamp();
    return timestamp ? this.formatMessageDateBadge(timestamp) : '';
  });
  readonly showScrollToBottomButton = computed(
    () =>
      Boolean(this.store.activeChatId()) &&
      this.store.activeMessages().length > 0 &&
      !this.isMessagesPanelAtBottom()
  );
  private readonly messagePartsCache = new Map<string, ParsedMessageCacheEntry>();
  private readonly scrollBottomThresholdPx = 44;
  private relativeTimeRefreshId: number | null = null;

  private readonly autoScrollEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const size = this.store.activeMessages().length;
    if (!activeChatId || size === 0) return;
    queueMicrotask(() => this.scrollMessagesToBottom('auto'));
  });

  private readonly viewportStabilityEffect = effect(() => {
    const visible = !this.isMobile() || this.showContactsPane();
    const count = this.filteredChats().length;
    if (!visible || count === 0) return;
    queueMicrotask(() => this.contactsViewport?.checkViewportSize());
  });

  private readonly stickyDateViewportEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const count = this.store.activeMessages().length;
    if (!activeChatId || count === 0) {
      this.stickyMessageTimestamp.set(null);
      this.isMessagesPanelAtBottom.set(true);
      return;
    }
    queueMicrotask(() => {
      this.updateStickyMessageDateFromViewport();
      this.updateMessagesBottomState();
    });
  });

  private readonly bodyScrollLockEffect = effect(() => {
    const hasActiveChat = Boolean(this.store.activeChatId());
    const chatRoomVisible = !this.isMobile() || !this.showContactsPane();
    const shouldLockBodyScroll = hasActiveChat && chatRoomVisible;

    if (typeof document !== 'undefined') {
      document.body.classList.toggle('chat-room-active', shouldLockBodyScroll);
      document.documentElement.classList.toggle('chat-room-active', shouldLockBodyScroll);
    }
  });

  private readonly reactionToastEffect = effect(() => {
    const notice = this.store.incomingReactionNotice();
    if (!notice) return;

    this.showReactionToast(notice);
    this.store.clearIncomingReactionNotice();
  });

  constructor(
    readonly store: ChatStoreService,
    private readonly dialog: MatDialog,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly route: ActivatedRoute
  ) {}

  async ngOnInit(): Promise<void> {
    this.mobileQuery.addEventListener('change', this.onMediaChange);
    window.addEventListener('resize', this.onViewportResize, { passive: true });
    window.visualViewport?.addEventListener('resize', this.onViewportResize);
    window.visualViewport?.addEventListener('scroll', this.onViewportResize);
    this.updateViewportHeight();
    this.relativeTimeRefreshId = window.setInterval(() => {
      this.nowTimestamp.set(Date.now());
    }, 60_000);

    await this.store.initialize();
    const chatFromUrl = this.route.snapshot.queryParamMap.get('chat');
    if (chatFromUrl) {
      this.openChat(chatFromUrl);
      return;
    }

    if (this.isMobile() && this.store.activeChatId()) {
      this.showContactsPane.set(false);
    }
  }

  ngOnDestroy(): void {
    this.mobileQuery.removeEventListener('change', this.onMediaChange);
    window.removeEventListener('resize', this.onViewportResize);
    window.visualViewport?.removeEventListener('resize', this.onViewportResize);
    window.visualViewport?.removeEventListener('scroll', this.onViewportResize);
    if (this.relativeTimeRefreshId !== null) {
      window.clearInterval(this.relativeTimeRefreshId);
      this.relativeTimeRefreshId = null;
    }
    if (typeof document !== 'undefined') {
      document.body.classList.remove('chat-room-active');
      document.documentElement.classList.remove('chat-room-active');
    }
  }

  openChat(chatId: string): void {
    this.closeReactionDetails();
    this.store.setActiveChat(chatId);
    if (this.isMobile()) {
      this.showContactsPane.set(false);
    }
  }

  backToList(): void {
    this.closeReactionDetails();
    this.store.clearLastActiveChat();
    this.showContactsPane.set(true);
    queueMicrotask(() => this.contactsViewport?.checkViewportSize());
  }

  async refresh(): Promise<void> {
    await this.store.refresh(true);
    this.snackBar.open('המידע עודכן.', 'סגור', { duration: 2200 });
  }

  async flushOutbox(): Promise<void> {
    await this.store.flushOutbox();
    this.snackBar.open('סנכרון הודעות הושלם.', 'סגור', { duration: 2200 });
  }

  async sendMessage(): Promise<void> {
    if (!this.canSendMessage()) return;

    const content = this.messageControl.value;
    this.messageControl.setValue('');
    await this.store.sendTextMessage(content);
  }

  async handleComposerSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.sendMessage();
  }

  onMessagesPanelScroll(): void {
    this.updateStickyMessageDateFromViewport();
    this.updateMessagesBottomState();
  }

  scrollToBottomFromButton(): void {
    this.scrollMessagesToBottom('smooth');
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!this.store.canSendToActiveChat()) {
      this.snackBar.open('לא ניתן לשלוח קובץ בקבוצה זו.', 'סגור', { duration: 3000 });
      input.value = '';
      return;
    }

    await this.store.sendFile(file);
    input.value = '';
  }

  openImagePicker(): void {
    if (!this.store.activeChat() || !this.store.canSendToActiveChat()) {
      this.snackBar.open('לא ניתן לצרף תמונה בצ׳אט זה.', 'סגור', { duration: 2500 });
      return;
    }
    this.fileInputRef?.nativeElement.click();
  }

  async shareLocation(): Promise<void> {
    if (!this.store.activeChat() || !this.store.canSendToActiveChat()) {
      this.snackBar.open('לא ניתן לשתף מיקום בצ׳אט זה.', 'סגור', { duration: 2500 });
      return;
    }
    if (!('geolocation' in navigator)) {
      this.snackBar.open('המכשיר לא תומך בשיתוף מיקום.', 'סגור', { duration: 3000 });
      return;
    }

    try {
      const position = await this.getCurrentPosition();
      const latitude = position.coords.latitude.toFixed(6);
      const longitude = position.coords.longitude.toFixed(6);
      const mapLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
      await this.store.sendTextMessage(`📍 ${mapLink}`);
      this.snackBar.open('המיקום נשלח.', 'סגור', { duration: 2000 });
    } catch {
      this.snackBar.open('לא ניתן לקבל מיקום. אנא אשר הרשאות.', 'סגור', { duration: 3500 });
    }
  }

  canSendMessage(): boolean {
    return Boolean(this.messageValue().trim()) && this.store.canSendToActiveChat() && !!this.store.activeChat();
  }

  openNewChatDialog(): void {
    const dialogRef = this.dialog.open(NewChatDialogComponent, {
      width: '420px',
      data: {
        contacts: this.store.contacts(),
        currentUser: this.store.currentUser()
      }
    });

    dialogRef.afterClosed().subscribe((username) => {
      if (username) {
        this.store.startDirectChat(username);
        this.openChat(username);
      }
    });
  }

  openCreateGroupDialog(): void {
    const dialogRef = this.dialog.open(CreateGroupDialogComponent, {
      width: '520px',
      data: {
        contacts: this.store.contacts(),
        currentUser: this.store.currentUser()
      }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (!result) return;

      try {
        await this.store.createGroup(result);
        this.snackBar.open('הקבוצה נוצרה.', 'סגור', { duration: 2600 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'נכשל ביצירת קבוצה';
        this.snackBar.open(message, 'סגור', { duration: 3600 });
      }
    });
  }

  async logout(): Promise<void> {
    this.store.logout();
    await this.router.navigate(['/setup']);
  }

  openGroupMembers(): void {
    this.closeReactionDetails();
    const activeChat = this.store.activeChat();
    if (!activeChat?.isGroup) return;

    const group = this.findGroupById(activeChat.id);
    if (!group) return;
    this.groupMembersPreview.set(this.buildGroupMembersPreview(group));
  }

  async addCommunityMember(username: string): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;

    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return;

    const nextMembers = Array.from(new Set([...preview.members.map((member) => member.username), normalized]));
    await this.updateCommunityMembers(preview.groupId, nextMembers, 'המשתתף נוסף לקהילה.');
  }

  async removeCommunityMember(username: string): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;

    const normalized = String(username || '').trim().toLowerCase();
    const target = preview.members.find((member) => member.username === normalized);
    if (!target || target.isAdmin) return;

    const nextMembers = preview.members
      .map((member) => member.username)
      .filter((memberUsername) => memberUsername !== normalized);
    await this.updateCommunityMembers(preview.groupId, nextMembers, 'המשתתף הוסר מהקהילה.');
  }

  closeGroupMembers(): void {
    this.groupMembersPreview.set(null);
  }

  canShowGroupMembers(): boolean {
    const activeChat = this.store.activeChat();
    return Boolean(activeChat?.isGroup && this.findGroupById(activeChat.id));
  }

  canRemoveCommunityMember(groupPreview: GroupMembersPreview, username: string): boolean {
    if (!groupPreview.canManageMembers) return false;
    const member = groupPreview.members.find((item) => item.username === username);
    return Boolean(member && !member.isAdmin);
  }

  private buildGroupMembersPreview(group: ChatGroup): GroupMembersPreview {
    const contactsByUsername = new Map(
      this.store.contacts().map((contact) => [contact.username, contact])
    );
    const currentUser = String(this.store.currentUser() || '').trim().toLowerCase();
    const adminUsername = String(group.createdBy || '').trim().toLowerCase();
    const canManageMembers = group.type === 'community' && currentUser === adminUsername;
    const members = (group.members ?? [])
      .map((username) => {
        const normalized = String(username || '').trim().toLowerCase();
        const contact = contactsByUsername.get(normalized);
        return {
          username: normalized,
          displayName: contact?.displayName || normalized,
          info: contact?.info,
          isAdmin: normalized === adminUsername
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'he'));

    return {
      groupId: group.id,
      title: group.name,
      type: group.type,
      canManageMembers,
      members
    };
  }

  private async updateCommunityMembers(
    groupId: string,
    nextMembers: string[],
    successMessage: string
  ): Promise<void> {
    try {
      await this.store.updateCommunityGroupMembers(groupId, nextMembers);
      this.snackBar.open(successMessage, 'סגור', { duration: 2400 });
      const refreshed = this.findGroupById(groupId);
      if (!refreshed) {
        this.closeGroupMembers();
        return;
      }
      this.groupMembersPreview.set(this.buildGroupMembersPreview(refreshed));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'עדכון חברי קבוצה נכשל';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    }
  }

  canReactToMessage(message: ChatMessage): boolean {
    if (!message.messageId) return false;
    const activeChat = this.store.activeChat();
    if (!activeChat?.isGroup) return false;

    const activeGroup = this.findActiveGroup();
    if (activeGroup) {
      return activeGroup.type === 'community';
    }

    // Fallback for non-admin devices where group metadata is temporarily stale.
    return !this.store.canSendToActiveChat();
  }

  setReactionTarget(message: ChatMessage): void {
    if (!this.canReactToMessage(message)) return;
    this.reactionTargetMessageId.set(message.messageId);
  }

  async addReaction(emoji: string): Promise<void> {
    const targetMessageId = this.reactionTargetMessageId();
    const normalizedEmoji = String(emoji || '').trim();
    if (!targetMessageId || !normalizedEmoji) return;

    try {
      await this.store.sendReaction(targetMessageId, normalizedEmoji);
    } catch {
      this.snackBar.open('לא ניתן לעדכן תגובה כעת.', 'סגור', { duration: 2500 });
    } finally {
      this.reactionTargetMessageId.set(null);
    }
  }

  reactionBuckets(message: ChatMessage): ReactionBucket[] {
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    if (!reactions.length) return [];

    const counts = new Map<string, number>();
    for (const reaction of reactions) {
      const emoji = String(reaction?.emoji || '').trim();
      if (!emoji) continue;
      counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([emoji, count]) => ({ emoji, count }));
  }

  reactionTotal(message: ChatMessage): number {
    return Array.isArray(message.reactions) ? message.reactions.length : 0;
  }

  canViewReactionDetails(message: ChatMessage): boolean {
    const activeGroup = this.findActiveGroup();
    return Boolean(
      activeGroup &&
      activeGroup.type === 'community' &&
      this.store.canSendToActiveChat() &&
      Array.isArray(message.reactions) &&
      message.reactions.length
    );
  }

  openReactionDetails(message: ChatMessage): void {
    if (!this.canViewReactionDetails(message)) return;

    const activeChat = this.store.activeChat();
    const contactsByUsername = new Map(
      this.store.contacts().map((contact) => [contact.username, contact])
    );
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    const rowsByUser = new Map<string, ReactionDetailRow>();

    reactions.forEach((reaction, index) => {
      const emoji = String(reaction?.emoji || '').trim();
      if (!emoji) return;

      const normalizedUsername = this.normalizeUsername(reaction?.reactor || '');
      const fallbackKey = normalizedUsername || `unknown-${index}`;
      const contact = normalizedUsername ? contactsByUsername.get(normalizedUsername) : null;
      const displayName =
        contact?.displayName ||
        String(reaction?.reactorName || '').trim() ||
        normalizedUsername ||
        'משתמש';

      rowsByUser.set(fallbackKey, {
        username: normalizedUsername || '',
        displayName,
        emoji
      });
    });

    const rows = Array.from(rowsByUser.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'he')
    );

    this.reactionDetailsPreview.set({
      groupTitle: activeChat?.title || 'קבוצה',
      rows
    });
  }

  closeReactionDetails(): void {
    this.reactionDetailsPreview.set(null);
  }

  private showReactionToast(notice: IncomingReactionNotice): void {
    const text = `${notice.reactorName} הגיב ${notice.emoji}`;
    const title = notice.groupName ? `${notice.groupName} · ${text}` : text;
    this.snackBar.open(title, 'סגור', {
      duration: 2400,
      verticalPosition: 'top'
    });
  }

  formatTime(timestamp: number): string {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('he-IL', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  formatChatListTime(timestamp: number): string {
    if (!timestamp) return '';

    const now = this.nowTimestamp();
    const diffMs = now - timestamp;
    if (diffMs < 0) {
      return this.formatTime(timestamp);
    }

    const minuteMs = 60_000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;

    if (diffMs < 2 * minuteMs) {
      return 'לפני דקה';
    }

    if (diffMs < hourMs) {
      const minutes = Math.max(2, Math.floor(diffMs / minuteMs));
      return `${minutes} דקות`;
    }

    if (diffMs < 2 * hourMs) {
      return 'שעה';
    }

    const messageDate = new Date(timestamp);
    const nowDate = new Date(now);
    if (this.isSameCalendarDay(messageDate, nowDate)) {
      return this.formatTime(timestamp);
    }

    if (diffMs < 2 * dayMs) {
      return 'לפני יום';
    }

    return new Intl.DateTimeFormat('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(messageDate);
  }

  shouldShowMessageDateBadge(index: number, timestamp: number): boolean {
    if (index <= 0) return true;

    const messages = this.store.activeMessages();
    const previous = messages[index - 1];
    if (!previous) return true;

    return this.getCalendarDayKey(previous.timestamp) !== this.getCalendarDayKey(timestamp);
  }

  formatMessageDateBadge(timestamp: number): string {
    if (!timestamp) return '';

    const messageDate = new Date(timestamp);
    const nowDate = new Date(this.nowTimestamp());
    if (this.isSameCalendarDay(messageDate, nowDate)) {
      return 'היום';
    }

    const yesterdayDate = new Date(nowDate);
    yesterdayDate.setDate(nowDate.getDate() - 1);
    if (this.isSameCalendarDay(messageDate, yesterdayDate)) {
      return 'אתמול';
    }

    return new Intl.DateTimeFormat('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(messageDate);
  }

  openChatAvatar(event: MouseEvent, chat: ChatListItem): void {
    event.stopPropagation();
    const imageUrl = String(chat.avatarUrl || '').trim();
    if (!imageUrl) return;

    this.previewAvatarLoaded.set(false);
    this.avatarPreview.set({
      title: chat.title || chat.id,
      imageUrl,
      lqipUrl: this.previewAvatarLqip(imageUrl)
    });
  }

  closeChatAvatar(): void {
    this.previewAvatarLoaded.set(false);
    this.avatarPreview.set(null);
  }

  chatAvatarFallback(chat: ChatListItem): string {
    const source = String(chat.title || chat.id || '').trim();
    if (!source) return '?';
    return source.charAt(0).toUpperCase();
  }

  chatAvatarThumb(chat: ChatListItem): string {
    const original = String(chat.avatarUrl || '').trim();
    if (!original) return '';

    const cached = this.avatarThumbCache.get(original);
    if (cached) {
      return cached;
    }

    const optimized = this.optimizeAvatarUrl(original, 128);
    this.avatarThumbCache.set(original, optimized);
    return optimized;
  }

  previewAvatarLqip(url: string): string {
    const original = String(url || '').trim();
    if (!original) return '';

    const cached = this.avatarLqipCache.get(original);
    if (cached) {
      return cached;
    }

    const optimized = this.optimizeAvatarUrl(original, 40);
    this.avatarLqipCache.set(original, optimized);
    return optimized;
  }

  isAvatarLoaded(url: string): boolean {
    const normalized = String(url || '').trim();
    if (!normalized) return false;
    return this.loadedAvatarUrls().has(normalized);
  }

  markAvatarLoaded(url: string): void {
    const normalized = String(url || '').trim();
    if (!normalized) return;
    if (this.loadedAvatarUrls().has(normalized)) return;

    const next = new Set(this.loadedAvatarUrls());
    next.add(normalized);
    this.loadedAvatarUrls.set(next);
  }

  onPreviewAvatarLoaded(): void {
    this.previewAvatarLoaded.set(true);
  }

  getMessageRenderParts(messageId: string, body: string): MessageRenderPart[] {
    const key = messageId || body;
    const cached = this.messagePartsCache.get(key);
    if (cached && cached.body === body) {
      return cached.parts;
    }

    const parts = this.parseMessageBody(body);
    this.messagePartsCache.set(key, { body, parts });
    return parts;
  }

  openFullImage(url: string): void {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  outgoingStatusLabel(status: DeliveryStatus): string {
    switch (status) {
      case 'queued':
        return 'ממתין';
      case 'pending':
        return 'שולח';
      case 'failed':
        return 'נכשל';
      default:
        return 'נשלח';
    }
  }

  trackByChatId(_: number, chat: ChatListItem): string {
    return chat.id;
  }

  private scrollMessagesToBottom(behavior: ScrollBehavior = 'auto'): void {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel) return;
    panel.scrollTo({
      top: panel.scrollHeight,
      behavior
    });
    this.updateStickyMessageDateFromViewport();
    this.updateMessagesBottomState();
  }

  private updateViewportHeight(): void {
    const visualViewport = window.visualViewport;
    const shouldUseVisualViewport = Boolean(visualViewport && visualViewport.scale <= 1.05);
    const viewportHeight = shouldUseVisualViewport
      ? (visualViewport?.height ?? window.innerHeight)
      : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
  }

  private isSameCalendarDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  private getCalendarDayKey(timestamp: number): string {
    const value = new Date(timestamp);
    return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  }

  private optimizeAvatarUrl(url: string, size: number): string {
    const value = String(url || '').trim();
    if (!value) return '';
    const normalizedSize = Math.max(24, Math.min(512, Math.floor(size)));

    // Convert Drive file links to native thumbnails to avoid loading huge originals.
    const driveFileMatch = value.match(/drive\.google\.com\/file\/d\/([^/]+)/i);
    if (driveFileMatch?.[1]) {
      const id = encodeURIComponent(driveFileMatch[1]);
      return `https://drive.google.com/thumbnail?id=${id}&sz=w${normalizedSize}-h${normalizedSize}`;
    }

    if (/drive\.google\.com/i.test(value)) {
      try {
        const parsed = new URL(value);
        const id = parsed.searchParams.get('id');
        if (id) {
          return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${normalizedSize}-h${normalizedSize}`;
        }
      } catch {
        // Keep original URL if parsing fails.
      }
    }

    // Common Google profile image hosts support size suffixes like =s96-c.
    if (/googleusercontent\.com/i.test(value)) {
      if (/=s\d+(-c)?$/i.test(value)) {
        return value.replace(/=s\d+(-c)?$/i, `=s${normalizedSize}-c`);
      }
      return `${value}=s${normalizedSize}-c`;
    }

    return value;
  }

  private updateStickyMessageDateFromViewport(): void {
    const panel = this.messagesPanel?.nativeElement;
    const messages = this.store.activeMessages();
    if (!panel || !messages.length) {
      this.stickyMessageTimestamp.set(null);
      return;
    }

    const rows = panel.querySelectorAll<HTMLElement>('.message-row[data-message-index]');
    const viewportTop = panel.scrollTop + 1;
    let timestamp = messages[messages.length - 1]?.timestamp ?? null;

    for (const row of rows) {
      if (row.offsetTop + row.offsetHeight < viewportTop) {
        continue;
      }

      const rawIndex = row.dataset['messageIndex'];
      const index = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;
      if (!Number.isNaN(index) && messages[index]) {
        timestamp = messages[index].timestamp;
      }
      break;
    }

    if (this.stickyMessageTimestamp() !== timestamp) {
      this.stickyMessageTimestamp.set(timestamp);
    }
  }

  private updateMessagesBottomState(): void {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel) {
      this.isMessagesPanelAtBottom.set(true);
      return;
    }

    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    this.isMessagesPanelAtBottom.set(distanceFromBottom <= this.scrollBottomThresholdPx);
  }

  private parseMessageBody(body: string): MessageRenderPart[] {
    const value = String(body || '');
    if (!value.trim()) {
      return [];
    }

    const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
    const parts: MessageRenderPart[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlRegex.exec(value)) !== null) {
      const start = match.index;
      const rawMatch = match[0];

      if (start > lastIndex) {
        parts.push({ kind: 'text', text: value.slice(lastIndex, start) });
      }

      const { cleanUrl, trailingText } = this.stripTrailingPunctuation(rawMatch);

      if (this.isImageUrl(cleanUrl)) {
        parts.push({ kind: 'image', url: cleanUrl });
      } else if (this.isLocationUrl(cleanUrl)) {
        parts.push({ kind: 'location', url: cleanUrl, label: 'המיקום שלי' });
      } else {
        parts.push({ kind: 'link', url: cleanUrl, label: 'לחץ כאן למעבר לכתובת' });
      }

      if (trailingText) {
        parts.push({ kind: 'text', text: trailingText });
      }

      lastIndex = start + rawMatch.length;
    }

    if (lastIndex < value.length) {
      parts.push({ kind: 'text', text: value.slice(lastIndex) });
    }

    if (!parts.length) {
      parts.push({ kind: 'text', text: value });
    }

    return parts;
  }

  private stripTrailingPunctuation(url: string): { cleanUrl: string; trailingText: string } {
    let cleanUrl = String(url || '');
    let trailingText = '';
    while (/[),.!?;:]$/.test(cleanUrl)) {
      trailingText = `${cleanUrl.slice(-1)}${trailingText}`;
      cleanUrl = cleanUrl.slice(0, -1);
    }
    return { cleanUrl, trailingText };
  }

  private isImageUrl(url: string): boolean {
    return /\.(jpeg|jpg|png|gif|webp)(\?|$)/i.test(url);
  }

  private isLocationUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes('maps.google.com') ||
      lower.includes('google.com/maps') ||
      lower.includes('maps.app.goo.gl')
    );
  }

  private getCurrentPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 60000
      });
    });
  }

  private findActiveGroup(): ChatGroup | null {
    const activeChat = this.store.activeChat();
    if (!activeChat?.isGroup) return null;
    return this.findGroupById(activeChat.id);
  }

  private findGroupById(groupId: string): ChatGroup | null {
    const normalized = String(groupId || '').trim().toLowerCase();
    if (!normalized) return null;
    return this.store.groups().find((group) => group.id === normalized) ?? null;
  }

  private normalizeUsername(value: string): string {
    return String(value || '').trim().toLowerCase();
  }
}
