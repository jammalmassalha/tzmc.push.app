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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription, firstValueFrom, startWith } from 'rxjs';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  DeliveryStatus
} from '../../core/models/chat.models';
import {
  ActivatedChatMeta,
  ChatStoreService,
  IncomingReactionNotice
} from '../../core/services/chat-store.service';
import { CreateGroupDialogComponent } from './dialogs/create-group-dialog.component';
import { NewChatDialogComponent } from './dialogs/new-chat-dialog.component';
import { ConfirmMessageActionDialogComponent } from './dialogs/confirm-message-action-dialog.component';

type MessageRenderPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'location'; url: string; label: string }
  | { kind: 'phone'; display: string; phone: string }
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
    MatProgressSpinnerModule,
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
  private readonly onViewportResize = (): void => {
    this.updateViewportHeight();
    if (!this.shouldApplyIosKeyboardWorkaround()) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && this.isEditableElement(activeElement)) {
      this.resetIosViewportPosition();
    }
  };
  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    if (!this.shouldApplyIosKeyboardWorkaround()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !this.isEditableElement(target)) {
      return;
    }
    this.resetIosViewportPosition();
    window.setTimeout(() => this.resetIosViewportPosition(), 90);
    window.setTimeout(() => this.resetIosViewportPosition(), 220);
  };
  private readonly onDocumentFocusOut = (): void => {
    if (!this.shouldApplyIosKeyboardWorkaround()) return;
    window.setTimeout(() => this.resetIosViewportPosition(), 100);
  };

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

  readonly reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly nowTimestamp = signal(Date.now());
  readonly stickyMessageTimestamp = signal<number | null>(null);
  readonly isMessagesPanelAtBottom = signal(true);
  readonly avatarPreview = signal<AvatarPreview | null>(null);
  readonly reactionTargetMessageId = signal<string | null>(null);
  readonly messageActionTarget = signal<ChatMessage | null>(null);
  readonly editingMessageTarget = signal<ChatMessage | null>(null);
  readonly pendingMessageActionIds = signal<Set<string>>(new Set<string>());
  readonly reactionDetailsPreview = signal<ReactionDetailsPreview | null>(null);
  readonly phoneActionTarget = signal<{ display: string; phone: string } | null>(null);
  readonly groupMembersPreview = signal<GroupMembersPreview | null>(null);
  readonly groupMemberAddOpen = signal(false);
  readonly groupMemberAddSearchTerm = signal('');
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
  readonly filteredGroupMemberAddCandidates = computed<GroupMemberAddCandidate[]>(() => {
    const query = this.groupMemberAddSearchTerm().trim().toLowerCase();
    const candidates = this.groupMemberAddCandidates();
    if (!query) return candidates;
    return candidates.filter((candidate) =>
      candidate.displayName.toLowerCase().includes(query) ||
      candidate.username.toLowerCase().includes(query) ||
      String(candidate.info || '').toLowerCase().includes(query)
    );
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
  private readonly conversationSwipeMinDistancePx = 80;
  private readonly conversationSwipeMaxDurationMs = 800;
  private readonly conversationSwipeHorizontalBias = 1.35;
  private readonly conversationSwipeCancelVerticalDeltaPx = 24;
  private conversationSwipeStartX: number | null = null;
  private conversationSwipeStartY: number | null = null;
  private conversationSwipeLastX: number | null = null;
  private conversationSwipeLastY: number | null = null;
  private conversationSwipeStartedAt: number | null = null;
  private conversationSwipeTracking = false;
  private lastAutoScrollChatId: string | null = null;
  private lastAutoScrollMessageCount = 0;
  private pendingOpenScroll: { chatId: string; unreadBeforeOpen: number } | null = null;
  private openBoundaryScrollRafId: number | null = null;
  private relativeTimeRefreshId: number | null = null;
  private routeQueryParamsSub: Subscription | null = null;

  private readonly autoScrollEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const size = this.store.activeMessages().length;
    const activationMeta = this.store.lastActivatedChatMeta();
    if (!activeChatId || size === 0) {
      this.pendingOpenScroll = null;
      if (this.openBoundaryScrollRafId !== null) {
        window.cancelAnimationFrame(this.openBoundaryScrollRafId);
        this.openBoundaryScrollRafId = null;
      }
      this.lastAutoScrollChatId = activeChatId;
      this.lastAutoScrollMessageCount = size;
      return;
    }

    const chatChanged = this.lastAutoScrollChatId !== activeChatId;
    const messageCountIncreased = size > this.lastAutoScrollMessageCount;
    const wasAtBottom = this.isMessagesPanelAtBottom();

    this.lastAutoScrollChatId = activeChatId;
    this.lastAutoScrollMessageCount = size;

    if (chatChanged) {
      const unreadBeforeOpen = this.resolveUnreadBeforeOpen(activeChatId, activationMeta);
      this.pendingOpenScroll = {
        chatId: activeChatId,
        unreadBeforeOpen
      };
      queueMicrotask(() => this.scheduleOpenBoundaryScroll());
      return;
    }

    if (this.pendingOpenScroll && this.pendingOpenScroll.chatId === activeChatId) {
      return;
    }

    if (messageCountIncreased && wasAtBottom) {
      queueMicrotask(() => this.scrollMessagesToBottom('auto'));
    }
  });

  private readonly viewportStabilityEffect = effect(() => {
    const visible = !this.isMobile() || this.showContactsPane();
    const count = this.filteredChats().length;
    if (!visible || count === 0) return;
    queueMicrotask(() => this.contactsViewport?.checkViewportSize());
  });

  private readonly mobileActiveChatPaneEffect = effect(() => {
    if (!this.isMobile()) return;
    if (!this.store.activeChatId()) return;
    this.showContactsPane.set(false);
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

  private readonly editingMessageGuardEffect = effect(() => {
    const editing = this.editingMessageTarget();
    if (!editing) return;

    const activeChatId = this.store.activeChatId();
    if (!activeChatId || activeChatId !== editing.chatId) {
      this.clearComposerEditState();
      return;
    }

    const latest = this.store
      .activeMessages()
      .find((message) => message.messageId === editing.messageId);
    if (!latest || latest.direction !== 'outgoing' || latest.deletedAt) {
      this.clearComposerEditState();
      return;
    }

    if (latest !== editing) {
      this.editingMessageTarget.set(latest);
    }
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
    document.addEventListener('focusin', this.onDocumentFocusIn, true);
    document.addEventListener('focusout', this.onDocumentFocusOut, true);
    this.updateViewportHeight();
    this.relativeTimeRefreshId = window.setInterval(() => {
      this.nowTimestamp.set(Date.now());
    }, 60_000);

    await this.store.initialize();
    this.routeQueryParamsSub?.unsubscribe();
    this.routeQueryParamsSub = this.route.queryParamMap.subscribe((queryParams) => {
      const chatFromUrl = queryParams.get('chat');
      if (chatFromUrl) {
        this.openChat(chatFromUrl);
        return;
      }

      if (this.isMobile() && this.store.activeChatId()) {
        this.showContactsPane.set(false);
      }
    });
  }

  ngOnDestroy(): void {
    this.mobileQuery.removeEventListener('change', this.onMediaChange);
    window.removeEventListener('resize', this.onViewportResize);
    window.visualViewport?.removeEventListener('resize', this.onViewportResize);
    window.visualViewport?.removeEventListener('scroll', this.onViewportResize);
    document.removeEventListener('focusin', this.onDocumentFocusIn, true);
    document.removeEventListener('focusout', this.onDocumentFocusOut, true);
    if (this.relativeTimeRefreshId !== null) {
      window.clearInterval(this.relativeTimeRefreshId);
      this.relativeTimeRefreshId = null;
    }
    if (this.openBoundaryScrollRafId !== null) {
      window.cancelAnimationFrame(this.openBoundaryScrollRafId);
      this.openBoundaryScrollRafId = null;
    }
    this.routeQueryParamsSub?.unsubscribe();
    this.routeQueryParamsSub = null;
    if (typeof document !== 'undefined') {
      document.body.classList.remove('chat-room-active');
      document.documentElement.classList.remove('chat-room-active');
    }
  }

  openChat(chatId: string): void {
    this.resetConversationSwipeGesture();
    this.clearComposerEditState();
    this.messageActionTarget.set(null);
    this.closeReactionDetails();
    this.store.setActiveChat(chatId);
    if (this.isMobile()) {
      this.showContactsPane.set(false);
    }
  }

  backToList(): void {
    this.resetConversationSwipeGesture();
    this.clearComposerEditState();
    this.messageActionTarget.set(null);
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
    const editingTarget = this.editingMessageTarget();
    if (editingTarget) {
      const trimmed = content.trim();
      if (!trimmed) return;
      const editingMessageId = editingTarget.messageId;
      if (this.isMessageActionPendingById(editingMessageId)) {
        return;
      }
      this.setMessageActionPending(editingMessageId, true);

      // Optimistic UX: close edit mode immediately so user feels instant submit.
      this.clearComposerEditState();

      try {
        await this.store.editSentMessageForEveryone(editingMessageId, trimmed);
        this.snackBar.open('ההודעה נערכה.', 'סגור', { duration: 2200 });
      } catch (error) {
        const latest = this.store
          .activeMessages()
          .find((message) => message.messageId === editingMessageId && message.direction === 'outgoing');
        if (latest && !latest.deletedAt) {
          this.editingMessageTarget.set(latest);
          this.messageControl.setValue(trimmed);
        }
        const message = error instanceof Error ? error.message : 'עריכת ההודעה נכשלה';
        this.snackBar.open(message, 'סגור', { duration: 3000 });
      } finally {
        this.setMessageActionPending(editingMessageId, false);
      }
      return;
    }

    this.messageControl.setValue('');
    try {
      await this.store.sendTextMessage(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת ההודעה נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 3000 });
      this.messageControl.setValue(content);
    }
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

  onConversationTouchStart(event: TouchEvent): void {
    if (!this.shouldEnableConversationSwipe(event)) {
      this.resetConversationSwipeGesture();
      return;
    }

    const touch = event.touches[0];
    this.conversationSwipeStartX = touch.clientX;
    this.conversationSwipeStartY = touch.clientY;
    this.conversationSwipeLastX = touch.clientX;
    this.conversationSwipeLastY = touch.clientY;
    this.conversationSwipeStartedAt = Date.now();
    this.conversationSwipeTracking = true;
  }

  onConversationTouchMove(event: TouchEvent): void {
    if (!this.conversationSwipeTracking || event.touches.length !== 1) {
      this.resetConversationSwipeGesture();
      return;
    }

    const touch = event.touches[0];
    this.conversationSwipeLastX = touch.clientX;
    this.conversationSwipeLastY = touch.clientY;

    const startX = this.conversationSwipeStartX ?? touch.clientX;
    const startY = this.conversationSwipeStartY ?? touch.clientY;
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);

    if (
      verticalDistance >= this.conversationSwipeCancelVerticalDeltaPx &&
      verticalDistance > horizontalDistance * this.conversationSwipeHorizontalBias
    ) {
      // Preserve normal vertical message scrolling and avoid accidental back navigation.
      this.resetConversationSwipeGesture();
    }
  }

  onConversationTouchEnd(event: TouchEvent): void {
    if (!this.conversationSwipeTracking) {
      this.resetConversationSwipeGesture();
      return;
    }

    const fallbackX = this.conversationSwipeLastX ?? this.conversationSwipeStartX;
    const fallbackY = this.conversationSwipeLastY ?? this.conversationSwipeStartY;
    const changedTouch = event.changedTouches?.[0];
    const endX = changedTouch ? changedTouch.clientX : fallbackX;
    const endY = changedTouch ? changedTouch.clientY : fallbackY;
    const startX = this.conversationSwipeStartX;
    const startY = this.conversationSwipeStartY;
    const startedAt = this.conversationSwipeStartedAt;

    this.resetConversationSwipeGesture();

    if (
      startX === null ||
      startY === null ||
      endX === null ||
      endY === null ||
      startedAt === null ||
      !this.isMobile() ||
      !this.store.activeChatId() ||
      this.showContactsPane()
    ) {
      return;
    }

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);
    const elapsed = Date.now() - startedAt;
    const isHorizontalSwipe =
      horizontalDistance >= this.conversationSwipeMinDistancePx &&
      horizontalDistance > verticalDistance * this.conversationSwipeHorizontalBias &&
      elapsed <= this.conversationSwipeMaxDurationMs;

    if (isHorizontalSwipe) {
      this.backToList();
    }
  }

  onConversationTouchCancel(): void {
    this.resetConversationSwipeGesture();
  }

  handleTextInputFocus(): void {
    if (!this.shouldApplyIosKeyboardWorkaround()) return;
    this.resetIosViewportPosition();
    window.setTimeout(() => this.resetIosViewportPosition(), 90);
    window.setTimeout(() => this.resetIosViewportPosition(), 220);
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

  clearChatSearch(): void {
    this.searchControl.setValue('');
  }

  openGroupMembers(): void {
    this.closeReactionDetails();
    const activeChat = this.store.activeChat();
    if (!activeChat?.isGroup) return;

    const group = this.findGroupById(activeChat.id);
    if (!group) return;
    this.groupMemberAddOpen.set(false);
    this.groupMemberAddSearchTerm.set('');
    this.groupMembersPreview.set(this.buildGroupMembersPreview(group));
  }

  async addCommunityMember(username: string): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;

    const normalized = String(username || '').trim().toLowerCase();
    if (!normalized) return;

    const nextMembers = Array.from(new Set([...preview.members.map((member) => member.username), normalized]));
    await this.updateCommunityMembers(preview.groupId, nextMembers, 'המשתתף נוסף לקבוצה.');
    this.groupMemberAddSearchTerm.set('');
    this.groupMemberAddOpen.set(false);
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
    await this.updateCommunityMembers(preview.groupId, nextMembers, 'המשתתף הוסר מהקבוצה.');
  }

  closeGroupMembers(): void {
    this.groupMemberAddOpen.set(false);
    this.groupMemberAddSearchTerm.set('');
    this.groupMembersPreview.set(null);
  }

  toggleGroupMemberAddPanel(): void {
    const nextState = !this.groupMemberAddOpen();
    this.groupMemberAddOpen.set(nextState);
    if (!nextState) {
      this.groupMemberAddSearchTerm.set('');
    }
  }

  onGroupMemberSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.groupMemberAddSearchTerm.set(String(target?.value || ''));
  }

  clearGroupMemberSearch(): void {
    this.groupMemberAddSearchTerm.set('');
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
    const canManageMembers = Boolean(adminUsername && currentUser === adminUsername);
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

  canCallActiveChat(): boolean {
    const activeChat = this.store.activeChat();
    if (!activeChat || activeChat.isGroup) return false;
    return Boolean(this.normalizePhoneForAction(activeChat.id));
  }

  startCallToActiveChat(): void {
    const activeChat = this.store.activeChat();
    if (!activeChat || activeChat.isGroup) return;
    const phone = this.normalizePhoneForAction(activeChat.id);
    if (!phone) {
      this.snackBar.open('לא נמצא מספר טלפון תקין לחיוג.', 'סגור', { duration: 2400 });
      return;
    }
    window.location.href = `tel:${phone}`;
  }

  openPhoneActions(part: { display: string; phone: string }): void {
    const normalized = this.normalizePhoneForAction(part.phone || part.display);
    if (!normalized) return;
    this.phoneActionTarget.set({
      display: String(part.display || normalized),
      phone: normalized
    });
  }

  closePhoneActions(): void {
    this.phoneActionTarget.set(null);
  }

  async copyPhoneTarget(): Promise<void> {
    const target = this.phoneActionTarget();
    if (!target?.phone) return;
    const copied = await this.copyTextToClipboard(target.phone);
    this.snackBar.open(copied ? 'המספר הועתק.' : 'לא ניתן להעתיק את המספר.', 'סגור', {
      duration: 2000
    });
    if (copied) {
      this.closePhoneActions();
    }
  }

  callPhoneTarget(): void {
    const target = this.phoneActionTarget();
    if (!target?.phone) return;
    window.location.href = `tel:${target.phone}`;
    this.closePhoneActions();
  }

  setMessageActionTarget(message: ChatMessage): void {
    this.messageActionTarget.set(message);
  }

  canManageOutgoingMessage(message: ChatMessage): boolean {
    if (message.direction !== 'outgoing') return false;
    if (!message.messageId) return false;
    if (message.deletedAt) return false;
    return (
      message.deliveryStatus === 'sent' ||
      message.deliveryStatus === 'delivered' ||
      message.deliveryStatus === 'read'
    );
  }

  isMessageActionPending(message: ChatMessage): boolean {
    return this.isMessageActionPendingById(message.messageId);
  }

  canEditOutgoingMessage(message: ChatMessage): boolean {
    if (!this.canManageOutgoingMessage(message)) return false;
    if (message.imageUrl) return false;
    return Boolean(String(message.body || '').trim());
  }

  isEditingMessage(message: ChatMessage): boolean {
    return this.editingMessageTarget()?.messageId === message.messageId;
  }

  isMessageEdited(message: ChatMessage): boolean {
    return !message.deletedAt && Boolean(message.editedAt);
  }

  isMessageDeleted(message: ChatMessage): boolean {
    return Boolean(message.deletedAt);
  }

  isMessageActionSyncing(message: ChatMessage): boolean {
    if (!this.isMessageActionPending(message)) return false;
    return this.isMessageEdited(message) || this.isMessageDeleted(message);
  }

  startEditingSelectedMessage(): void {
    const target = this.messageActionTarget();
    if (!target || !this.canEditOutgoingMessage(target)) {
      this.clearComposerEditState();
      return;
    }
    if (this.isMessageActionPendingById(target.messageId)) {
      return;
    }
    this.editingMessageTarget.set(target);
    this.messageControl.setValue(target.body || '');
  }

  cancelEditingMessage(): void {
    this.clearComposerEditState();
  }

  async deleteSelectedMessageForEveryone(): Promise<void> {
    const target = this.messageActionTarget();
    if (!target || !this.canManageOutgoingMessage(target)) {
      return;
    }
    const targetMessageId = target.messageId;
    if (this.isMessageActionPendingById(targetMessageId)) {
      return;
    }

    const dialogRef = this.dialog.open(ConfirmMessageActionDialogComponent, {
      width: '360px',
      data: {
        title: 'מחיקת הודעה',
        message: 'האם למחוק הודעה זו אצל כולם?',
        confirmLabel: 'מחק אצל כולם',
        cancelLabel: 'ביטול',
        confirmColor: 'warn'
      }
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) {
      return;
    }

    this.setMessageActionPending(targetMessageId, true);
    try {
      await this.store.deleteSentMessageForEveryone(targetMessageId);
      if (this.editingMessageTarget()?.messageId === targetMessageId || this.isMessageDeleted(target)) {
        this.clearComposerEditState();
      }
      this.snackBar.open('ההודעה נמחקה אצל כולם.', 'סגור', { duration: 2400 });
    } catch (error) {
      const message = error instanceof Error
        ? `ההודעה נמחקה מקומית. ייתכן שהמחיקה אצל כולם נכשלה: ${error.message}`
        : 'ההודעה נמחקה מקומית אך ייתכן שלא נמחקה אצל כולם.';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    } finally {
      this.setMessageActionPending(targetMessageId, false);
    }
  }

  outgoingStatusLabel(status: DeliveryStatus): string {
    switch (status) {
      case 'queued':
      case 'pending':
        return 'שולח';
      case 'sent':
      case 'delivered':
        return 'נמסר';
      case 'read':
        return 'נקרא';
      case 'failed':
        return 'נכשל';
      default:
        return 'שולח';
    }
  }

  outgoingStatusIcon(status: DeliveryStatus): string {
    if (status === 'failed') {
      return 'error_outline';
    }
    if (status === 'read' || status === 'sent' || status === 'delivered') {
      return 'done_all';
    }
    return 'done';
  }

  isOutgoingStatusRead(status: DeliveryStatus): boolean {
    return status === 'read';
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

  private resolveUnreadBeforeOpen(
    activeChatId: string,
    activationMeta: ActivatedChatMeta | null
  ): number {
    if (!activationMeta || activationMeta.chatId !== activeChatId) {
      return 0;
    }
    const unread = Number(activationMeta.unreadBeforeOpen || 0);
    return Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  }

  private scheduleOpenBoundaryScroll(): void {
    const pending = this.pendingOpenScroll;
    if (!pending) return;
    if (this.openBoundaryScrollRafId !== null) {
      window.cancelAnimationFrame(this.openBoundaryScrollRafId);
      this.openBoundaryScrollRafId = null;
    }

    let attempts = 0;
    const runAttempt = () => {
      const latest = this.pendingOpenScroll;
      const activeChatId = this.store.activeChatId();
      if (!latest || latest.chatId !== activeChatId) {
        this.pendingOpenScroll = null;
        this.openBoundaryScrollRafId = null;
        return;
      }

      attempts += 1;
      const allowApproximation = attempts >= 6;
      const anchored = this.scrollToLastReadBoundary(latest.unreadBeforeOpen, {
        allowApproximation
      });
      if (anchored) {
        this.pendingOpenScroll = null;
        this.openBoundaryScrollRafId = null;
        return;
      }

      if (attempts >= 8) {
        this.pendingOpenScroll = null;
        this.openBoundaryScrollRafId = null;
        return;
      }

      this.openBoundaryScrollRafId = window.requestAnimationFrame(runAttempt);
    };

    this.openBoundaryScrollRafId = window.requestAnimationFrame(runAttempt);
  }

  private scrollToLastReadBoundary(
    unreadBeforeOpen: number,
    options: { allowApproximation?: boolean } = {}
  ): boolean {
    const panel = this.messagesPanel?.nativeElement;
    const messages = this.store.activeMessages();
    if (!panel || !messages.length) return false;

    const unreadCount = Math.min(
      messages.length,
      Math.max(0, Math.floor(Number(unreadBeforeOpen) || 0))
    );
    if (unreadCount <= 0) {
      this.scrollMessagesToBottom('auto');
      return true;
    }

    const firstUnreadIndex = Math.max(0, messages.length - unreadCount);
    const lastReadIndex = Math.max(0, firstUnreadIndex - 1);
    const targetRow =
      this.findMessageRowByIndex(firstUnreadIndex) || this.findMessageRowByIndex(lastReadIndex);
    if (!targetRow) {
      if (!options.allowApproximation) {
        return false;
      }
      const ratio = Math.min(1, Math.max(0, firstUnreadIndex / Math.max(1, messages.length)));
      const estimatedTop = Math.max(
        0,
        Math.round(panel.scrollHeight * ratio - panel.clientHeight * 0.45)
      );
      panel.scrollTo({
        top: estimatedTop,
        behavior: 'auto'
      });
      this.updateStickyMessageDateFromViewport();
      this.updateMessagesBottomState();
      return true;
    }

    const topPadding = 20;
    const desiredTop = Math.max(0, targetRow.offsetTop - topPadding);
    panel.scrollTo({
      top: desiredTop,
      behavior: 'auto'
    });
    this.updateStickyMessageDateFromViewport();
    this.updateMessagesBottomState();
    return true;
  }

  private findMessageRowByIndex(messageIndex: number): HTMLElement | null {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel || !Number.isFinite(messageIndex) || messageIndex < 0) return null;
    return panel.querySelector<HTMLElement>(`.message-row[data-message-index="${messageIndex}"]`);
  }

  private updateViewportHeight(): void {
    const visualViewport = window.visualViewport;
    const shouldUseVisualViewport = Boolean(visualViewport && visualViewport.scale <= 1.05);
    const viewportHeight = shouldUseVisualViewport
      ? (visualViewport?.height ?? window.innerHeight)
      : window.innerHeight;
    const viewportOffsetTop = shouldUseVisualViewport
      ? Math.max(0, Math.round(visualViewport?.offsetTop ?? 0))
      : 0;
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
    document.documentElement.style.setProperty('--app-viewport-offset-top', `${viewportOffsetTop}px`);
  }

  private shouldApplyIosKeyboardWorkaround(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIPhoneFamily = /iP(hone|od|ad)/i.test(ua);
    const isIpadOsDesktopUA = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
    return isIPhoneFamily || isIpadOsDesktopUA;
  }

  private isEditableElement(element: HTMLElement): boolean {
    const tagName = element.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable;
  }

  private resetIosViewportPosition(): void {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    this.updateViewportHeight();
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
    const isAtBottom = distanceFromBottom <= this.scrollBottomThresholdPx;
    this.isMessagesPanelAtBottom.set(isAtBottom);
    if (isAtBottom && this.store.activeChatId()) {
      this.store.markActiveChatReadAtBottom();
    }
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
        this.appendTextAndPhoneParts(parts, value.slice(lastIndex, start));
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
        this.appendTextAndPhoneParts(parts, trailingText);
      }

      lastIndex = start + rawMatch.length;
    }

    if (lastIndex < value.length) {
      this.appendTextAndPhoneParts(parts, value.slice(lastIndex));
    }

    if (!parts.length) {
      this.appendTextAndPhoneParts(parts, value);
    }

    return parts;
  }

  private appendTextAndPhoneParts(parts: MessageRenderPart[], text: string): void {
    const source = String(text || '');
    if (!source) return;

    const phoneRegex = /(?:\+97205\d{8}|\+9725\d{8}|05\d{8})/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = phoneRegex.exec(source)) !== null) {
      const start = match.index;
      const rawMatch = match[0];
      if (start > lastIndex) {
        parts.push({ kind: 'text', text: source.slice(lastIndex, start) });
      }

      const prevChar = start > 0 ? source.charAt(start - 1) : '';
      const nextChar = source.charAt(start + rawMatch.length);
      const hasValidBoundaryBefore = !prevChar || !/[0-9+]/.test(prevChar);
      const hasValidBoundaryAfter = !nextChar || !/[0-9]/.test(nextChar);
      if (!hasValidBoundaryBefore || !hasValidBoundaryAfter) {
        parts.push({ kind: 'text', text: rawMatch });
        lastIndex = start + rawMatch.length;
        continue;
      }

      const { cleanPhone, trailingText } = this.stripTrailingPhonePunctuation(rawMatch);
      const normalizedPhone = this.normalizePhoneForAction(cleanPhone);
      if (normalizedPhone) {
        parts.push({
          kind: 'phone',
          display: cleanPhone,
          phone: normalizedPhone
        });
      } else {
        parts.push({ kind: 'text', text: cleanPhone });
      }

      if (trailingText) {
        parts.push({ kind: 'text', text: trailingText });
      }
      lastIndex = start + rawMatch.length;
    }

    if (lastIndex < source.length) {
      parts.push({ kind: 'text', text: source.slice(lastIndex) });
    }
  }

  private stripTrailingPhonePunctuation(phone: string): { cleanPhone: string; trailingText: string } {
    let cleanPhone = String(phone || '');
    let trailingText = '';
    while (/[),.!?;:]$/.test(cleanPhone)) {
      trailingText = `${cleanPhone.slice(-1)}${trailingText}`;
      cleanPhone = cleanPhone.slice(0, -1);
    }
    return { cleanPhone, trailingText };
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

  private normalizePhoneForAction(value: string): string {
    const source = String(value || '').trim().replace(/\s+/g, '');
    if (!source) return '';
    if (/^05\d{8}$/.test(source)) return source;
    if (/^\+9725\d{8}$/.test(source)) return source;
    if (/^\+97205\d{8}$/.test(source)) return source;
    return '';
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // Fallback below.
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
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

  private shouldEnableConversationSwipe(event: TouchEvent): boolean {
    if (!this.isMobile()) return false;
    if (!this.store.activeChatId()) return false;
    if (this.showContactsPane()) return false;
    if (event.touches.length !== 1) return false;

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return true;
    }
    return !this.shouldIgnoreConversationSwipeTarget(target);
  }

  private shouldIgnoreConversationSwipeTarget(target: HTMLElement): boolean {
    return Boolean(
      target.closest(
        'textarea, input, select, button, a, [role="button"], [mat-menu-item], [contenteditable="true"]'
      )
    );
  }

  private resetConversationSwipeGesture(): void {
    this.conversationSwipeStartX = null;
    this.conversationSwipeStartY = null;
    this.conversationSwipeLastX = null;
    this.conversationSwipeLastY = null;
    this.conversationSwipeStartedAt = null;
    this.conversationSwipeTracking = false;
  }

  private clearComposerEditState(options: { clearComposer?: boolean } = {}): void {
    this.editingMessageTarget.set(null);
    this.messageActionTarget.set(null);
    if (options.clearComposer !== false) {
      this.messageControl.setValue('');
    }
  }

  private isMessageActionPendingById(messageId: string): boolean {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) return false;
    return this.pendingMessageActionIds().has(normalizedId);
  }

  private setMessageActionPending(messageId: string, pending: boolean): void {
    const normalizedId = String(messageId || '').trim();
    if (!normalizedId) return;

    const next = new Set(this.pendingMessageActionIds());
    if (pending) {
      next.add(normalizedId);
    } else {
      next.delete(normalizedId);
    }
    this.pendingMessageActionIds.set(next);
  }
}
