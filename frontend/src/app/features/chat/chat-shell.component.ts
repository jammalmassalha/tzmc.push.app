import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
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
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription, firstValueFrom, startWith } from 'rxjs';
import {
  ChatGroup,
  ChatListItem,
  ChatMessage,
  DeliveryStatus,
  MessageReference
} from '../../core/models/chat.models';
import {
  ActivatedChatMeta,
  ChatStoreService,
  IncomingReactionNotice,
  ShuttleBreadcrumbStep,
  ShuttleLanguage,
  ShuttleOperationsDateGroup,
  ShuttleOrdersDashboard,
  ShuttleQuickPickerState
} from '../../core/services/chat-store.service';
import { CreateGroupDialogComponent } from './dialogs/create-group-dialog.component';
import { NewChatDialogComponent } from './dialogs/new-chat-dialog.component';
import { ConfirmMessageActionDialogComponent } from './dialogs/confirm-message-action-dialog.component';
import { ForwardMessageDialogComponent } from './dialogs/forward-message-dialog.component';

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
  canEditTitle: boolean;
  canManageMembers: boolean;
  members: Array<{
    username: string;
    displayName: string;
    info?: string;
    upic?: string;
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

interface ShuttleOrderMessageCard {
  title: string;
  statusLabel: string;
  dayDate: string;
  shift: string;
  station: string;
  cancelled: boolean;
}

interface HrListChoiceOption {
  choiceNumber: string;
  label: string;
}

interface HrListChoiceDialogPayload {
  sourceMessageId: string;
  prompt: string;
  options: HrListChoiceOption[];
}

interface HrListChoiceCacheEntry {
  body: string;
  payload: HrListChoiceDialogPayload | null;
}

const MESSAGE_PAGE_SIZE = 15;
const LOAD_OLDER_MESSAGES_SCROLL_THRESHOLD_PX = 56;
const SHUTTLE_OPERATIONS_BACKGROUND_REFRESH_MS = 30_000;

type ShuttleUiTextKey =
  | 'ordersTitle'
  | 'refresh'
  | 'loading'
  | 'processingOrderTitle'
  | 'processingOrderSubtitle'
  | 'ordersTablistAria'
  | 'ongoingTab'
  | 'pastTab'
  | 'ongoingEmpty'
  | 'pastEmpty'
  | 'activeStatus'
  | 'deleteOrder'
  | 'dateLabel'
  | 'shiftLabel'
  | 'stationLabel'
  | 'pastStatusCancelled'
  | 'pastStatusDone'
  | 'pickerStepsAria'
  | 'stationSearchPlaceholder'
  | 'stationSearchAria'
  | 'clearStationSearchAria'
  | 'noSearchResults'
  | 'stationListAria'
  | 'stationSubtitle'
  | 'selectOption'
  | 'confirmSelection'
  | 'backToMenu'
  | 'searchResults'
  | 'deleteOrderDialogTitle'
  | 'deleteOrderDialogMessage'
  | 'deleteOrderDialogConfirm'
  | 'deleteOrderDialogCancel'
  | 'orderCancelledToast'
  | 'orderCancelFailedFallback'
  | 'pickerOptionRequired'
  | 'pickerOptionUnavailable'
  | 'pickerOptionFailed'
  | 'refreshFailedFallback'
  | 'orderSavedFallback'
  | 'orderCancelledFallback'
  | 'languageLabel';

const SHUTTLE_UI_TEXT: Record<ShuttleLanguage, Record<ShuttleUiTextKey, string>> = {
  he: {
    ordersTitle: 'ההזמנות שלי',
    refresh: 'רענון',
    loading: 'טוען נתונים...',
    processingOrderTitle: 'שומר את ההזמנה...',
    processingOrderSubtitle: 'הבקשה נשלחה ונמצאת בעיבוד. נא להמתין.',
    ordersTablistAria: 'קטגוריות הזמנות',
    ongoingTab: 'פעילות',
    pastTab: 'עבר',
    ongoingEmpty: 'אין הזמנות פעילות כרגע.',
    pastEmpty: 'אין הזמנות עבר להצגה.',
    activeStatus: 'פעילה',
    deleteOrder: 'מחק הזמנה',
    dateLabel: 'תאריך',
    shiftLabel: 'משמרת',
    stationLabel: 'תחנה',
    pastStatusCancelled: 'בוטלה',
    pastStatusDone: 'הסתיימה',
    pickerStepsAria: 'שלבי הזמנת הסעה',
    stationSearchPlaceholder: 'חיפוש תחנה',
    stationSearchAria: 'חיפוש תחנה',
    clearStationSearchAria: 'נקה חיפוש תחנות',
    noSearchResults: 'לא נמצאו תוצאות עבור החיפוש.',
    stationListAria: 'רשימת תחנות',
    stationSubtitle: 'תחנת איסוף',
    selectOption: 'בחר אפשרות',
    confirmSelection: 'אישור בחירה',
    backToMenu: 'חזרה לתפריט',
    searchResults: 'נמצאו',
    deleteOrderDialogTitle: 'מחיקת הזמנה',
    deleteOrderDialogMessage: 'האם למחוק (לבטל) את ההזמנה הזו?',
    deleteOrderDialogConfirm: 'כן, מחק',
    deleteOrderDialogCancel: 'ביטול',
    orderCancelledToast: 'ההזמנה בוטלה.',
    orderCancelFailedFallback: 'ביטול ההזמנה נכשל.',
    pickerOptionRequired: 'יש לבחור אפשרות מהרשימה.',
    pickerOptionUnavailable: 'האפשרות שבחרת אינה זמינה כרגע.',
    pickerOptionFailed: 'בחירה נכשלה. נסה שוב.',
    refreshFailedFallback: 'טעינת ההזמנות נכשלה',
    orderSavedFallback: 'הזמנה נשמרה',
    orderCancelledFallback: 'הזמנה בוטלה',
    languageLabel: 'שפה'
  },
  ru: {
    ordersTitle: 'Мои заказы',
    refresh: 'Обновить',
    loading: 'Загрузка данных...',
    processingOrderTitle: 'Сохраняем заказ...',
    processingOrderSubtitle: 'Запрос отправлен и обрабатывается. Пожалуйста, подождите.',
    ordersTablistAria: 'Категории заказов',
    ongoingTab: 'Активные',
    pastTab: 'Прошлые',
    ongoingEmpty: 'Сейчас нет активных заказов.',
    pastEmpty: 'Нет прошлых заказов для отображения.',
    activeStatus: 'Активен',
    deleteOrder: 'Удалить заказ',
    dateLabel: 'Дата',
    shiftLabel: 'Смена',
    stationLabel: 'Станция',
    pastStatusCancelled: 'Отменен',
    pastStatusDone: 'Завершен',
    pickerStepsAria: 'Шаги заказа трансфера',
    stationSearchPlaceholder: 'Поиск станции',
    stationSearchAria: 'Поиск станции',
    clearStationSearchAria: 'Очистить поиск станций',
    noSearchResults: 'По вашему запросу ничего не найдено.',
    stationListAria: 'Список станций',
    stationSubtitle: 'Станция посадки',
    selectOption: 'Выберите вариант',
    confirmSelection: 'Подтвердить выбор',
    backToMenu: 'Назад в меню',
    searchResults: 'Найдено',
    deleteOrderDialogTitle: 'Удаление заказа',
    deleteOrderDialogMessage: 'Удалить (отменить) этот заказ?',
    deleteOrderDialogConfirm: 'Да, удалить',
    deleteOrderDialogCancel: 'Отмена',
    orderCancelledToast: 'Заказ отменен.',
    orderCancelFailedFallback: 'Не удалось отменить заказ.',
    pickerOptionRequired: 'Выберите вариант из списка.',
    pickerOptionUnavailable: 'Выбранный вариант сейчас недоступен.',
    pickerOptionFailed: 'Не удалось выбрать вариант. Попробуйте снова.',
    refreshFailedFallback: 'Не удалось загрузить заказы',
    orderSavedFallback: 'Заказ сохранен',
    orderCancelledFallback: 'Заказ отменен',
    languageLabel: 'Язык'
  }
};

@Component({
  selector: 'app-chat-shell',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    ScrollingModule,
    MatDialogModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatToolbarModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatChipsModule,
    MatSnackBarModule
  ],
  templateUrl: './chat-shell.component.html',
  styleUrl: './chat-shell.component.scss'
})
export class ChatShellComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild(CdkVirtualScrollViewport) contactsViewport?: CdkVirtualScrollViewport;
  @ViewChild('messagesPanel') messagesPanel?: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput') fileInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('composerTextarea') composerTextareaRef?: ElementRef<HTMLTextAreaElement>;
  private readonly avatarThumbCache = new Map<string, string>();
  private readonly avatarLqipCache = new Map<string, string>();
  readonly loadedAvatarUrls = signal<Set<string>>(new Set<string>());
  readonly previewAvatarLoaded = signal(false);
  private readonly composerTextareaMinHeightPx = 22;
  private readonly composerTextareaMaxHeightPx = 132;

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
  readonly shuttlePickerControl = new FormControl('', { nonNullable: true });
  readonly shuttlePickerSearchControl = new FormControl('', { nonNullable: true });

  readonly searchTerm = toSignal(this.searchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });
  readonly messageValue = toSignal(this.messageControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });
  readonly shuttlePickerSearchValue = toSignal(this.shuttlePickerSearchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });

  readonly isMobile = signal(this.mobileQuery.matches);
  readonly showContactsPane = signal(this.mobileQuery.matches);

  readonly filteredChats = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const chats = this.store.chatItems().filter((chat) => this.shouldDisplayChatInContactsPane(chat));
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
    const activeChat = this.store.activeChat();
    if (!activeChat) {
      return 'בחר צ׳אט כדי להתחיל';
    }
    if (this.isShuttleOperationsRoomActive()) {
      return 'חדר הסעות למעקב בלבד';
    }
    if (this.store.getShuttleQuickPickerState()) {
      return 'לבחירה השתמש בכפתורים';
    }
    if (this.hrComposerActions() && !this.hrComposerActions()?.canWriteMessage) {
      return 'כדי לכתוב הודעה יש לבחור קודם באפשרות כתיבה';
    }
    if (this.store.canSendToActiveChat()) {
      return 'הקלד הודעה';
    }
    if (this.store.isDovrutGroupChat(activeChat.id)) {
      return 'רק מנהלי החדר יכולים לשלוח בחדר זה';
    }
    return 'רק מנהל יכול לשלוח בקבוצת קהילה';
  });
  readonly shuttleQuickPicker = computed<ShuttleQuickPickerState | null>(() =>
    this.store.getShuttleQuickPickerState()
  );
  readonly isSubmittingShuttlePicker = signal(false);
  readonly isSubmittingHrListChoice = signal(false);
  readonly lockedHrListChoiceMessageIds = signal<Set<string>>(new Set<string>());
  readonly hrComposerActions = computed(() => this.store.getHrComposerActionsForActiveChat());
  readonly showHrStartSessionButton = computed(() => Boolean(this.hrComposerActions()));
  readonly showHrBackButton = computed(() => Boolean(this.hrComposerActions()?.canGoBack));
  readonly showHrEndSessionButton = computed(() => Boolean(this.hrComposerActions()?.hasOpenSession));
  readonly isHrTextInputEnabled = computed(() => this.hrComposerActions()?.canWriteMessage ?? true);
  readonly isSubmittingShuttleOrder = signal(false);
  readonly isCancellingShuttleOrderIds = signal<Set<string>>(new Set<string>());
  readonly shuttlePickerHasOptions = computed(() => {
    const picker = this.shuttleQuickPicker();
    return Boolean(picker && picker.options.length);
  });
  readonly shuttleOrdersDashboard = computed<ShuttleOrdersDashboard | null>(() =>
    this.store.getShuttleOrdersDashboard()
  );
  readonly shuttleOperationsDateGroups = computed<ShuttleOperationsDateGroup[] | null>(() =>
    this.store.getShuttleOperationsDateGroupsForActiveChat()
  );
  readonly isLoadingShuttleOperationsOrders = computed(() =>
    this.store.getShuttleOperationsOrdersLoading()
  );
  readonly shuttleOperationsManualSyncFailedAt = signal<number | null>(null);
  readonly shuttleOperationsManualSyncFailedMessage = signal('');
  readonly isShuttleOperationsRoomActive = computed(() =>
    Boolean(this.shuttleOperationsDateGroups())
  );
  readonly isLoadingShuttleOrders = computed(() =>
    this.store.getShuttleOrdersLoading()
  );
  readonly shuttleLanguage = computed<ShuttleLanguage>(() => this.store.getShuttleLanguage());
  readonly shuttleDashboardTab = signal<'ongoing' | 'past'>('ongoing');
  readonly isShuttleRoomActive = computed(() =>
    Boolean(this.shuttleOrdersDashboard() || this.shuttleQuickPicker() || this.isShuttleOperationsRoomActive())
  );
  readonly isComposerHidden = computed(() =>
    Boolean(this.shuttleQuickPicker() || this.isShuttleOperationsRoomActive())
  );
  readonly expandedShuttleOperationsDates = signal<Set<string>>(new Set<string>());
  readonly shuttleBreadcrumbs = computed<ShuttleBreadcrumbStep[] | null>(() =>
    this.store.getShuttleFlowBreadcrumbs()
  );
  readonly isShuttleStationPicker = computed(() => {
    const picker = this.shuttleQuickPicker();
    return Boolean(picker && picker.mode === 'select' && picker.key.startsWith('station-'));
  });
  readonly filteredShuttlePickerOptions = computed(() => {
    const picker = this.shuttleQuickPicker();
    if (!picker || picker.mode !== 'select') {
      return [];
    }

    const options = picker.options;
    if (!this.isShuttleStationPicker()) {
      return options;
    }

    const query = String(this.shuttlePickerSearchValue() || '').trim().toLowerCase();
    if (!query) {
      return options;
    }

    return options.filter((option) => String(option.label || '').toLowerCase().includes(query));
  });

  readonly reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly nowTimestamp = signal(Date.now());
  readonly stickyMessageTimestamp = signal<number | null>(null);
  readonly isMessagesPanelAtBottom = signal(true);
  readonly avatarPreview = signal<AvatarPreview | null>(null);
  readonly reactionTargetMessageId = signal<string | null>(null);
  readonly messageActionTarget = signal<ChatMessage | null>(null);
  readonly editingMessageTarget = signal<ChatMessage | null>(null);
  readonly replyingMessageTarget = signal<ChatMessage | null>(null);
  readonly pendingMessageActionIds = signal<Set<string>>(new Set<string>());
  readonly reactionDetailsPreview = signal<ReactionDetailsPreview | null>(null);
  readonly phoneActionTarget = signal<{ display: string; phone: string } | null>(null);
  readonly groupMembersPreview = signal<GroupMembersPreview | null>(null);
  readonly failedGroupMemberAvatarUsers = signal<Set<string>>(new Set<string>());
  readonly isLoggingOut = signal(false);
  readonly logoutElapsedSeconds = signal(0);
  readonly logoutLoaderText = computed(() => {
    const seconds = this.logoutElapsedSeconds();
    return seconds > 0 ? `מתנתק... ${seconds}ש׳` : 'מתנתק...';
  });
  readonly groupMemberAddOpen = signal(false);
  readonly isInlineGroupTitleEditing = signal(false);
  readonly inlineGroupTitleEditGroupId = signal<string | null>(null);
  readonly inlineGroupTitleEditValue = signal('');
  readonly groupTitleEditValue = signal('');
  readonly groupMemberAddSearchTerm = signal('');
  readonly selectedGroupMemberAddUsernames = signal<Set<string>>(new Set<string>());
  readonly selectedGroupMemberRemoveUsernames = signal<Set<string>>(new Set<string>());
  readonly selectedGroupMemberAddCount = computed(() => this.selectedGroupMemberAddUsernames().size);
  readonly selectedGroupMemberRemoveCount = computed(() => this.selectedGroupMemberRemoveUsernames().size);
  readonly canSaveGroupTitle = computed(() => {
    const preview = this.groupMembersPreview();
    if (!preview?.canEditTitle) return false;
    const nextTitle = String(this.groupTitleEditValue() || '').trim();
    if (nextTitle.length < 2) return false;
    return nextTitle !== preview.title;
  });
  readonly canEditActiveGroupTitle = computed(() => {
    const group = this.findActiveGroup();
    if (!group) return false;
    return this.canCurrentUserEditGroupTitle(group);
  });
  readonly canSaveInlineGroupTitle = computed(() => {
    if (!this.isInlineGroupTitleEditing()) return false;
    if (!this.canEditActiveGroupTitle()) return false;
    const group = this.findActiveGroup();
    if (!group) return false;
    const nextTitle = String(this.inlineGroupTitleEditValue() || '').trim();
    if (nextTitle.length < 2) return false;
    return nextTitle !== String(group.name || '').trim();
  });
  readonly currentUserDepartment = computed(() => {
    const currentUser = this.normalizeUsername(this.store.currentUser() || '');
    if (!currentUser) return '';
    const currentContact = this.store.contacts().find((contact) => this.normalizeUsername(contact.username) === currentUser);
    return this.extractDepartmentFromInfo(currentContact?.info);
  });
  readonly groupMemberAddCandidates = computed<GroupMemberAddCandidate[]>(() => {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return [];
    const currentDepartment = this.currentUserDepartment();
    if (!currentDepartment) return [];

    const existingMembers = new Set(preview.members.map((member) => member.username));
    return this.store.contacts()
      .filter(
        (contact) => {
          const normalizedUsername = this.normalizeUsername(contact.username);
          if (!normalizedUsername) return false;
          return (
            !existingMembers.has(normalizedUsername) &&
            this.extractDepartmentFromInfo(contact.info) === currentDepartment
          );
        }
      )
      .map((contact) => ({
        username: this.normalizeUsername(contact.username),
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
  readonly visibleMessageCount = signal(MESSAGE_PAGE_SIZE);
  readonly visibleMessageStartIndex = computed(() => {
    const total = this.store.activeMessages().length;
    const count = this.visibleMessageCount();
    return Math.max(0, total - count);
  });
  readonly visibleMessages = computed<ChatMessage[]>(() => {
    const messages = this.store.activeMessages();
    return messages.slice(this.visibleMessageStartIndex());
  });
  readonly hasOlderMessages = computed(() => this.visibleMessageStartIndex() > 0);
  readonly showScrollToBottomButton = computed(
    () =>
      Boolean(this.store.activeChatId()) &&
      !this.isShuttleRoomActive() &&
      this.store.activeMessages().length > 0 &&
      !this.isMessagesPanelAtBottom()
  );
  private readonly messagePartsCache = new Map<string, ParsedMessageCacheEntry>();
  private readonly hrListChoiceCache = new Map<string, HrListChoiceCacheEntry>();
  private readonly hrChatId = this.normalizeUsername('ציפי');
  private readonly scrollBottomThresholdPx = 44;
  private readonly loadOlderMessagesScrollThresholdPx = LOAD_OLDER_MESSAGES_SCROLL_THRESHOLD_PX;
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
  private lastShuttlePickerKey: string | null = null;
  private lastAutoScrollChatId: string | null = null;
  private lastAutoScrollMessageCount = 0;
  private pendingOpenScroll: { chatId: string; unreadBeforeOpen: number } | null = null;
  private openBoundaryScrollRafId: number | null = null;
  private relativeTimeRefreshId: number | null = null;
  private logoutProgressIntervalId: number | null = null;
  private shuttleOperationsBackgroundRefreshId: number | null = null;
  private routeQueryParamsSub: Subscription | null = null;
  private isLoadingOlderMessages = false;
  private lastPaginatedChatId: string | null = null;

  private readonly autoScrollEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const size = this.store.activeMessages().length;
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
      this.pendingOpenScroll = null;
      if (this.openBoundaryScrollRafId !== null) {
        window.cancelAnimationFrame(this.openBoundaryScrollRafId);
        this.openBoundaryScrollRafId = null;
      }
      queueMicrotask(() => {
        window.requestAnimationFrame(() => this.scrollMessagesToBottom('auto'));
      });
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

  private readonly messagePaginationEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const totalMessages = this.store.activeMessages().length;

    if (activeChatId !== this.lastPaginatedChatId) {
      this.lastPaginatedChatId = activeChatId;
      this.visibleMessageCount.set(MESSAGE_PAGE_SIZE);
      return;
    }

    if (!activeChatId) {
      this.visibleMessageCount.set(MESSAGE_PAGE_SIZE);
      return;
    }

    const maxVisibleCount = Math.max(MESSAGE_PAGE_SIZE, totalMessages);
    if (this.visibleMessageCount() > maxVisibleCount) {
      this.visibleMessageCount.set(maxVisibleCount);
    }
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
  private readonly composerTextareaResizeEffect = effect(() => {
    this.messageValue();
    queueMicrotask(() => this.syncComposerTextareaHeight());
  });

  private readonly reactionToastEffect = effect(() => {
    const notice = this.store.incomingReactionNotice();
    if (!notice) return;

    this.showReactionToast(notice);
    this.store.clearIncomingReactionNotice();
  });

  private readonly shuttlePickerSyncEffect = effect(() => {
    const picker = this.shuttleQuickPicker();
    const key = picker?.key ?? null;
    if (key !== this.lastShuttlePickerKey) {
      this.lastShuttlePickerKey = key;
      this.shuttlePickerControl.setValue('');
      this.shuttlePickerSearchControl.setValue('');
    }
  });

  private readonly shuttlePickerOptionValidityEffect = effect(() => {
    const picker = this.shuttleQuickPicker();
    if (!picker || picker.mode !== 'select') {
      return;
    }

    const selected = String(this.shuttlePickerControl.value || '').trim();
    if (!selected) {
      return;
    }

    const visibleOptions = this.filteredShuttlePickerOptions();
    if (!visibleOptions.some((option) => option.value === selected)) {
      this.shuttlePickerControl.setValue('');
    }
  });

  private readonly shuttleOperationsAutoRefreshEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    if (!this.store.isShuttleOperationsRoomChat(activeChatId)) {
      if (this.shuttleOperationsBackgroundRefreshId !== null) {
        window.clearInterval(this.shuttleOperationsBackgroundRefreshId);
        this.shuttleOperationsBackgroundRefreshId = null;
      }
      return;
    }
    void this.store.refreshShuttleOperationsOrdersForActiveUser({ force: false, silent: true }).catch(() => undefined);
    if (this.shuttleOperationsBackgroundRefreshId === null) {
      this.shuttleOperationsBackgroundRefreshId = window.setInterval(() => {
        void this.store.refreshShuttleOperationsOrdersForActiveUser({ force: false, silent: true }).catch(() => undefined);
      }, SHUTTLE_OPERATIONS_BACKGROUND_REFRESH_MS);
    }
  });

  private readonly shuttleOperationsExpansionSyncEffect = effect(() => {
    const groups = this.shuttleOperationsDateGroups();
    if (!groups || !groups.length) {
      this.expandedShuttleOperationsDates.set(new Set<string>());
      return;
    }
    const nextExpanded = new Set(this.expandedShuttleOperationsDates());
    const validDateKeys = new Set(groups.map((group) => group.date));
    for (const existingKey of Array.from(nextExpanded)) {
      if (!validDateKeys.has(existingKey)) {
        nextExpanded.delete(existingKey);
      }
    }
    if (!nextExpanded.size && groups[0]?.date) {
      nextExpanded.add(groups[0].date);
    }
    this.expandedShuttleOperationsDates.set(nextExpanded);
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

  private readonly replyingMessageGuardEffect = effect(() => {
    const replying = this.replyingMessageTarget();
    if (!replying) return;

    const activeChatId = this.store.activeChatId();
    if (!activeChatId || activeChatId !== replying.chatId) {
      this.replyingMessageTarget.set(null);
      return;
    }

    const latest = this.store
      .activeMessages()
      .find((message) => message.messageId === replying.messageId);
    if (!latest || latest.deletedAt) {
      this.replyingMessageTarget.set(null);
      return;
    }

    if (latest !== replying) {
      this.replyingMessageTarget.set(latest);
    }
  });
  private readonly inlineGroupTitleEditGuardEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const editGroupId = this.inlineGroupTitleEditGroupId();
    if (!this.isInlineGroupTitleEditing()) return;
    if (!activeChatId || !editGroupId || activeChatId !== editGroupId) {
      this.cancelInlineGroupTitleEdit();
      return;
    }
    const group = this.findGroupById(editGroupId);
    if (!group || !this.canCurrentUserEditGroupTitle(group)) {
      this.cancelInlineGroupTitleEdit();
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

    void this.store.initialize();
    void this.enforceMandatoryPushRegistrationOnEntry();
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

  ngAfterViewInit(): void {
    queueMicrotask(() => this.syncComposerTextareaHeight());
  }

  private async enforceMandatoryPushRegistrationOnEntry(): Promise<void> {
    await this.store.ensureSessionReady();
    if (!this.store.isAuthenticated()) {
      return;
    }
    if (!this.store.networkOnline()) {
      return;
    }
    try {
      await this.store.ensurePushRegistrationReadyForCurrentUser({ promptIfNeeded: true });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'נדרש רישום מחדש להתראות Push לפני המשך שימוש.';
      this.snackBar.open(message, 'סגור', { duration: 5200 });
      await this.store.logout();
      await this.router.navigate(['/setup']);
    }
  }

  ngOnDestroy(): void {
    this.store.cancelTypingForActiveChat();
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
    if (this.shuttleOperationsBackgroundRefreshId !== null) {
      window.clearInterval(this.shuttleOperationsBackgroundRefreshId);
      this.shuttleOperationsBackgroundRefreshId = null;
    }
    if (this.openBoundaryScrollRafId !== null) {
      window.cancelAnimationFrame(this.openBoundaryScrollRafId);
      this.openBoundaryScrollRafId = null;
    }
    this.clearLogoutProgressInterval();
    this.routeQueryParamsSub?.unsubscribe();
    this.routeQueryParamsSub = null;
    if (typeof document !== 'undefined') {
      document.body.classList.remove('chat-room-active');
      document.documentElement.classList.remove('chat-room-active');
    }
  }

  openChat(chatId: string): void {
    this.store.cancelTypingForActiveChat();
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
    this.store.cancelTypingForActiveChat();
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

  openInformationSecurityPolicy(): void {
    const policyPath = '/notify/uploads/InformationSecurityandCyberPolicy.pdf';
    const popup = window.open(policyPath, '_blank', 'noopener,noreferrer');
    if (!popup) {
      this.snackBar.open('לא ניתן לפתוח את הקובץ כעת.', 'סגור', { duration: 2600 });
    }
  }

  async flushOutbox(): Promise<void> {
    try {
      await this.store.forceSyncAllMessagesAndClearCache();
      this.snackBar.open('סנכרון מלא הושלם.', 'סגור', { duration: 2200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'הסנכרון נכשל. נסה שוב.';
      this.snackBar.open(message, 'סגור', { duration: 2800 });
    }
  }

  async resetAllBadges(): Promise<void> {
    try {
      const clearedKeys = await this.store.resetAllServerBadgesForAdmin();
      this.snackBar.open(`איפוס מונים הושלם (${clearedKeys}).`, 'סגור', { duration: 2600 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'איפוס מונים נכשל';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    }
  }

  async sendMessage(): Promise<void> {
    this.store.cancelTypingForActiveChat();
    if (this.isComposerHidden() && !this.editingMessageTarget()) {
      return;
    }
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

    const replyingTarget = this.replyingMessageTarget();
    const replyReference = replyingTarget ? this.buildReplyReference(replyingTarget) : null;
    this.messageControl.setValue('');
    if (replyingTarget) {
      this.replyingMessageTarget.set(null);
    }
    try {
      await this.store.sendTextMessage(content, replyReference ? { replyTo: replyReference } : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת ההודעה נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 3000 });
      this.messageControl.setValue(content);
      if (replyingTarget) {
        this.replyingMessageTarget.set(replyingTarget);
      }
    }
  }

  async handleComposerSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.sendMessage();
  }

  async chooseShuttlePickerOption(value: string): Promise<void> {
    const normalized = String(value || '').trim();
    if (!normalized || this.isSubmittingShuttlePicker()) return;
    const picker = this.shuttleQuickPicker();
    if (picker) {
      const option = picker.options.find((item) => String(item.value || '').trim() === normalized);
      if (option?.disabled) {
        this.snackBar.open(this.shuttleText('pickerOptionUnavailable'), this.shuttleCloseActionLabel(), { duration: 2400 });
        return;
      }
    }
    const shouldShowOrderLoader = Boolean(
      picker &&
      picker.mode === 'select' &&
      picker.key.startsWith('station-')
    );
    this.isSubmittingShuttlePicker.set(true);
    this.isSubmittingShuttleOrder.set(shouldShowOrderLoader);
    try {
      await this.store.submitShuttleQuickPickerSelection(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : this.shuttleText('pickerOptionFailed');
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 2800 });
    } finally {
      this.isSubmittingShuttlePicker.set(false);
      this.isSubmittingShuttleOrder.set(false);
    }
  }

  async submitShuttlePickerSelection(): Promise<void> {
    const picker = this.shuttleQuickPicker();
    if (!picker) return;
    const selectedValue = String(this.shuttlePickerControl.value || '').trim();
    if (!selectedValue) {
      this.snackBar.open(this.shuttleText('pickerOptionRequired'), this.shuttleCloseActionLabel(), { duration: 2200 });
      return;
    }
    const selectedOption = picker.options.find(
      (option) => String(option.value || '').trim() === selectedValue
    );
    if (selectedOption?.disabled) {
      this.snackBar.open(this.shuttleText('pickerOptionUnavailable'), this.shuttleCloseActionLabel(), { duration: 2400 });
      return;
    }
    await this.chooseShuttlePickerOption(selectedValue);
  }

  async goBackFromShuttlePicker(): Promise<void> {
    await this.chooseShuttlePickerOption('0');
  }

  clearShuttlePickerSearch(): void {
    if (!this.shuttlePickerSearchControl.value) return;
    this.shuttlePickerSearchControl.setValue('');
  }

  setShuttleLanguage(language: ShuttleLanguage): void {
    this.store.setShuttleLanguage(language);
  }

  isShuttleLanguage(language: ShuttleLanguage): boolean {
    return this.shuttleLanguage() === language;
  }

  shuttleText(key: ShuttleUiTextKey): string {
    return SHUTTLE_UI_TEXT[this.shuttleLanguage()][key];
  }

  shuttleCloseActionLabel(): string {
    return this.shuttleLanguage() === 'ru' ? 'Закрыть' : 'סגור';
  }

  shuttleSearchResultLabel(count: number): string {
    return this.shuttleLanguage() === 'ru'
      ? `Найдено ${count} подходящих станций`
      : `נמצאו ${count} תחנות תואמות`;
  }

  shuttleOrderDayDateLabel(dayName: string, date: string): string {
    return `${String(dayName || '').trim()} ${String(date || '').trim()}`.trim();
  }

  shuttlePastStatusLabel(order: { statusLabel: string }): string {
    return String(order.statusLabel || '').toLowerCase().includes('отмен') || String(order.statusLabel || '').includes('בוטל')
      ? this.shuttleText('pastStatusCancelled')
      : this.shuttleText('pastStatusDone');
  }

  setShuttleDashboardTab(tab: 'ongoing' | 'past'): void {
    this.shuttleDashboardTab.set(tab);
  }

  async refreshShuttleOrders(): Promise<void> {
    if (this.isLoadingShuttleOrders()) return;
    try {
      await this.store.refreshShuttleOrdersForActiveUser();
    } catch (error) {
      const message = error instanceof Error ? error.message : this.shuttleText('refreshFailedFallback');
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 2800 });
    }
  }

  async refreshShuttleOperationsOrders(): Promise<void> {
    if (this.isLoadingShuttleOperationsOrders()) return;
    try {
      await this.store.refreshShuttleOperationsOrdersForActiveUser({ force: true, throwOnError: true });
      this.shuttleOperationsManualSyncFailedAt.set(null);
      this.shuttleOperationsManualSyncFailedMessage.set('');
    } catch (error) {
      const message = error instanceof Error ? error.message : this.shuttleText('refreshFailedFallback');
      this.shuttleOperationsManualSyncFailedAt.set(Date.now());
      this.shuttleOperationsManualSyncFailedMessage.set(message);
    }
  }

  isShuttleOperationsDateExpanded(date: string): boolean {
    const normalizedDate = String(date || '').trim();
    if (!normalizedDate) return false;
    return this.expandedShuttleOperationsDates().has(normalizedDate);
  }

  setShuttleOperationsDateExpanded(date: string, expanded: boolean): void {
    const normalizedDate = String(date || '').trim();
    if (!normalizedDate) return;
    const next = new Set(this.expandedShuttleOperationsDates());
    if (expanded) {
      next.add(normalizedDate);
    } else {
      next.delete(normalizedDate);
    }
    this.expandedShuttleOperationsDates.set(next);
  }

  canCancelShuttleOperationsOrder(): boolean {
    return this.store.canCurrentUserManageShuttleOperationsOrders();
  }

  async cancelShuttleOperationsOrder(orderCompositeId: string): Promise<void> {
    const normalizedId = String(orderCompositeId || '').trim();
    if (!normalizedId) return;
    if (this.isCancellingShuttleOrder(normalizedId)) return;
    if (!this.canCancelShuttleOperationsOrder()) return;

    const dialogRef = this.dialog.open(ConfirmMessageActionDialogComponent, {
      width: '360px',
      data: {
        title: this.shuttleText('deleteOrderDialogTitle'),
        message: this.shuttleText('deleteOrderDialogMessage'),
        confirmLabel: this.shuttleText('deleteOrderDialogConfirm'),
        cancelLabel: this.shuttleText('deleteOrderDialogCancel'),
        confirmColor: 'warn'
      }
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) {
      return;
    }

    this.setShuttleOrderCancelling(normalizedId, true);
    try {
      await this.store.cancelShuttleOperationsOrderByCompositeId(normalizedId);
      this.snackBar.open(this.shuttleText('orderCancelledToast'), this.shuttleCloseActionLabel(), { duration: 2400 });
    } catch (error) {
      const message = error instanceof Error ? error.message : this.shuttleText('orderCancelFailedFallback');
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 3200 });
    } finally {
      this.setShuttleOrderCancelling(normalizedId, false);
    }
  }

  async cancelShuttleOrder(orderId: string): Promise<void> {
    const normalizedId = String(orderId || '').trim();
    if (!normalizedId) return;
    if (this.isCancellingShuttleOrder(orderId)) return;

    const dialogRef = this.dialog.open(ConfirmMessageActionDialogComponent, {
      width: '360px',
      data: {
        title: this.shuttleText('deleteOrderDialogTitle'),
        message: this.shuttleText('deleteOrderDialogMessage'),
        confirmLabel: this.shuttleText('deleteOrderDialogConfirm'),
        cancelLabel: this.shuttleText('deleteOrderDialogCancel'),
        confirmColor: 'warn'
      }
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) {
      return;
    }

    this.setShuttleOrderCancelling(normalizedId, true);
    try {
      await this.store.cancelShuttleOrderById(normalizedId);
      this.snackBar.open(this.shuttleText('orderCancelledToast'), this.shuttleCloseActionLabel(), { duration: 2400 });
    } catch (error) {
      const message = error instanceof Error ? error.message : this.shuttleText('orderCancelFailedFallback');
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 3200 });
    } finally {
      this.setShuttleOrderCancelling(normalizedId, false);
    }
  }

  isCancellingShuttleOrder(orderId: string): boolean {
    const normalizedId = String(orderId || '').trim();
    if (!normalizedId) return false;
    return this.isCancellingShuttleOrderIds().has(normalizedId);
  }

  shuttleOrderMessageCard(message: ChatMessage): ShuttleOrderMessageCard | null {
    const recordType = String(message.recordType || '').trim();
    if (recordType !== 'shuttle-submit-success' && recordType !== 'shuttle-cancel-success') {
      return null;
    }

    const body = String(message.body || '').trim();
    if (!body) return null;
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    const summaryLine = lines.find((line) => line.includes('[') && line.includes('|'));
    if (!summaryLine) return null;

    const cleanSummary = summaryLine.replace(/^\d+\.\s*/, '').trim();
    const match = cleanSummary.match(/^\[(.+?)\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/);
    if (!match) return null;

    const statusLabel = String(match[1] || '').trim();
    const dayDate = String(match[2] || '').trim();
    const shift = String(match[3] || '').trim();
    const station = String(match[4] || '').trim();
    const title = lines[0] || (
      recordType === 'shuttle-cancel-success'
        ? this.shuttleText('orderCancelledFallback')
        : this.shuttleText('orderSavedFallback')
    );

    return {
      title,
      statusLabel,
      dayDate,
      shift,
      station,
      cancelled:
        recordType === 'shuttle-cancel-success' ||
        statusLabel.includes('בוטל') ||
        statusLabel.toLowerCase().includes('отмен')
    };
  }

  onMessagesPanelScroll(): void {
    this.tryLoadOlderMessagesOnScroll();
    this.updateStickyMessageDateFromViewport();
    this.updateMessagesBottomState();
  }

  messageAbsoluteIndex(index: number): number {
    return this.visibleMessageStartIndex() + Math.max(0, Math.trunc(index));
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
    this.syncComposerTextareaHeight();
    if (!this.shouldApplyIosKeyboardWorkaround()) return;
    this.resetIosViewportPosition();
    window.setTimeout(() => this.resetIosViewportPosition(), 90);
    window.setTimeout(() => this.resetIosViewportPosition(), 220);
  }

  onComposerInput(): void {
    this.syncComposerTextareaHeight();
    this.store.reportTypingActivity(this.messageControl.value);
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
    if (this.isComposerHidden()) {
      const message = this.isShuttleOperationsRoomActive()
        ? 'בחדר זה לא ניתן לשלוח הודעות.'
        : 'בחדר זה בוחרים אפשרויות דרך הכפתורים בלבד.';
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 2600 });
      return;
    }
    if (!this.store.activeChat() || !this.store.canSendToActiveChat()) {
      this.snackBar.open('לא ניתן לצרף תמונה בצ׳אט זה.', 'סגור', { duration: 2500 });
      return;
    }
    this.fileInputRef?.nativeElement.click();
  }

  async shareLocation(): Promise<void> {
    if (this.isComposerHidden()) {
      const message = this.isShuttleOperationsRoomActive()
        ? 'בחדר זה לא ניתן לשלוח הודעות.'
        : 'בחדר זה בוחרים אפשרויות דרך הכפתורים בלבד.';
      this.snackBar.open(message, this.shuttleCloseActionLabel(), { duration: 2600 });
      return;
    }
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
    if (this.isComposerHidden() && !this.editingMessageTarget()) {
      return false;
    }
    if (!this.isHrTextInputEnabled() && !this.editingMessageTarget()) {
      return false;
    }
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
    if (this.isLoggingOut()) {
      return;
    }

    this.startLogoutLoader();
    try {
      await this.store.logout();
      await this.router.navigate(['/setup']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ההתנתקות נכשלה. נסה שוב.';
      this.snackBar.open(message, 'סגור', { duration: 3400 });
    } finally {
      this.stopLogoutLoader();
    }
  }

  clearChatSearch(): void {
    this.searchControl.setValue('');
  }

  private startLogoutLoader(): void {
    this.clearLogoutProgressInterval();
    this.logoutElapsedSeconds.set(0);
    this.isLoggingOut.set(true);
    this.logoutProgressIntervalId = window.setInterval(() => {
      this.logoutElapsedSeconds.update((seconds) => seconds + 1);
    }, 1000);
  }

  private stopLogoutLoader(): void {
    this.clearLogoutProgressInterval();
    this.logoutElapsedSeconds.set(0);
    this.isLoggingOut.set(false);
  }

  private clearLogoutProgressInterval(): void {
    if (this.logoutProgressIntervalId !== null) {
      window.clearInterval(this.logoutProgressIntervalId);
      this.logoutProgressIntervalId = null;
    }
  }

  openGroupMembers(): void {
    this.closeReactionDetails();
    const activeChat = this.store.activeChat();
    if (!activeChat?.isGroup) return;

    const group = this.findGroupById(activeChat.id);
    if (!group) return;
    this.groupMemberAddOpen.set(false);
    this.groupTitleEditValue.set(group.name);
    this.groupMemberAddSearchTerm.set('');
    this.clearSelectedGroupMemberAdds();
    this.clearSelectedGroupMemberRemovals();
    this.failedGroupMemberAvatarUsers.set(new Set<string>());
    this.groupMembersPreview.set(this.buildGroupMembersPreview(group));
  }

  async addSelectedCommunityMembers(): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;
    const selected = Array.from(this.selectedGroupMemberAddUsernames());
    if (!selected.length) {
      this.snackBar.open('בחר לפחות איש קשר אחד להוספה.', 'סגור', { duration: 2200 });
      return;
    }

    const existingMemberSet = new Set(preview.members.map((member) => member.username));
    const toAdd = selected.filter((username) => !existingMemberSet.has(username));
    if (!toAdd.length) {
      this.snackBar.open('כל אנשי הקשר שנבחרו כבר נמצאים בקבוצה.', 'סגור', { duration: 2400 });
      this.clearSelectedGroupMemberAdds();
      return;
    }

    const nextMembers = Array.from(new Set([...preview.members.map((member) => member.username), ...toAdd]));
    const successMessage = toAdd.length === 1 ? 'המשתתף נוסף לקבוצה.' : `נוספו ${toAdd.length} משתתפים לקבוצה.`;
    await this.updateCommunityMembers(preview.groupId, nextMembers, successMessage);
    this.clearSelectedGroupMemberAdds();
    this.groupMemberAddSearchTerm.set('');
    this.groupMemberAddOpen.set(false);
  }

  async removeSelectedCommunityMembers(): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;
    const selected = Array.from(this.selectedGroupMemberRemoveUsernames());
    if (!selected.length) {
      this.snackBar.open('בחר לפחות משתתף אחד להסרה.', 'סגור', { duration: 2200 });
      return;
    }

    const removableSet = new Set(
      preview.members
        .filter((member) => !member.isAdmin)
        .map((member) => member.username)
    );
    const toRemove = selected.filter((username) => removableSet.has(username));
    if (!toRemove.length) {
      this.snackBar.open('לא ניתן להסיר את המשתתפים שנבחרו.', 'סגור', { duration: 2400 });
      this.clearSelectedGroupMemberRemovals();
      return;
    }

    const toRemoveSet = new Set(toRemove);
    const nextMembers = preview.members
      .map((member) => member.username)
      .filter((memberUsername) => !toRemoveSet.has(memberUsername));
    const successMessage = toRemove.length === 1 ? 'המשתתף הוסר מהקבוצה.' : `הוסרו ${toRemove.length} משתתפים מהקבוצה.`;
    await this.updateCommunityMembers(preview.groupId, nextMembers, successMessage);
    this.clearSelectedGroupMemberRemovals();
  }

  closeGroupMembers(): void {
    this.groupMemberAddOpen.set(false);
    this.groupTitleEditValue.set('');
    this.groupMemberAddSearchTerm.set('');
    this.clearSelectedGroupMemberAdds();
    this.clearSelectedGroupMemberRemovals();
    this.failedGroupMemberAvatarUsers.set(new Set<string>());
    this.groupMembersPreview.set(null);
  }

  toggleGroupMemberAddPanel(): void {
    const nextState = !this.groupMemberAddOpen();
    this.groupMemberAddOpen.set(nextState);
    if (!nextState) {
      this.groupMemberAddSearchTerm.set('');
      this.clearSelectedGroupMemberAdds();
    }
  }

  onGroupMemberSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.groupMemberAddSearchTerm.set(String(target?.value || ''));
  }

  clearGroupMemberSearch(): void {
    this.groupMemberAddSearchTerm.set('');
  }

  toggleGroupMemberAddSelection(username: string): void {
    const normalized = this.normalizeUsername(username);
    if (!normalized) return;

    const next = new Set(this.selectedGroupMemberAddUsernames());
    if (next.has(normalized)) {
      next.delete(normalized);
    } else {
      next.add(normalized);
    }
    this.selectedGroupMemberAddUsernames.set(next);
  }

  isGroupMemberAddSelected(username: string): boolean {
    const normalized = this.normalizeUsername(username);
    if (!normalized) return false;
    return this.selectedGroupMemberAddUsernames().has(normalized);
  }

  clearSelectedGroupMemberAdds(): void {
    this.selectedGroupMemberAddUsernames.set(new Set<string>());
  }

  toggleGroupMemberRemoveSelection(username: string): void {
    const preview = this.groupMembersPreview();
    if (!preview?.canManageMembers) return;

    const normalized = this.normalizeUsername(username);
    if (!normalized) return;

    const target = preview.members.find((member) => member.username === normalized);
    if (!target || target.isAdmin) return;

    const next = new Set(this.selectedGroupMemberRemoveUsernames());
    if (next.has(normalized)) {
      next.delete(normalized);
    } else {
      next.add(normalized);
    }
    this.selectedGroupMemberRemoveUsernames.set(next);
  }

  isGroupMemberRemoveSelected(username: string): boolean {
    const normalized = this.normalizeUsername(username);
    if (!normalized) return false;
    return this.selectedGroupMemberRemoveUsernames().has(normalized);
  }

  clearSelectedGroupMemberRemovals(): void {
    this.selectedGroupMemberRemoveUsernames.set(new Set<string>());
  }

  onGroupTitleEditInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.groupTitleEditValue.set(String(target?.value || ''));
  }

  resetGroupTitleEdit(): void {
    const preview = this.groupMembersPreview();
    this.groupTitleEditValue.set(preview?.title || '');
  }

  async saveGroupTitleEdit(): Promise<void> {
    const preview = this.groupMembersPreview();
    if (!preview?.canEditTitle) return;
    const nextTitle = String(this.groupTitleEditValue() || '').trim();
    if (nextTitle.length < 2) {
      this.snackBar.open('יש להזין שם קבוצה תקין.', 'סגור', { duration: 2200 });
      return;
    }
    if (nextTitle === preview.title) {
      return;
    }

    try {
      await this.store.updateGroupTitle(preview.groupId, nextTitle);
      this.snackBar.open('שם הקבוצה עודכן.', 'סגור', { duration: 2200 });
      const refreshed = this.findGroupById(preview.groupId);
      if (!refreshed) {
        this.closeGroupMembers();
        return;
      }
      const refreshedPreview = this.buildGroupMembersPreview(refreshed);
      this.groupMembersPreview.set(refreshedPreview);
      this.groupTitleEditValue.set(refreshedPreview.title);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'עדכון שם קבוצה נכשל';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
      this.resetGroupTitleEdit();
    }
  }

  startInlineGroupTitleEdit(event?: Event): void {
    event?.stopPropagation();
    const group = this.findActiveGroup();
    if (!group || !this.canCurrentUserEditGroupTitle(group)) {
      return;
    }
    this.inlineGroupTitleEditGroupId.set(group.id);
    this.inlineGroupTitleEditValue.set(String(group.name || '').trim());
    this.isInlineGroupTitleEditing.set(true);
  }

  cancelInlineGroupTitleEdit(event?: Event): void {
    event?.stopPropagation();
    this.isInlineGroupTitleEditing.set(false);
    this.inlineGroupTitleEditGroupId.set(null);
    this.inlineGroupTitleEditValue.set('');
  }

  onInlineGroupTitleInput(event: Event): void {
    event.stopPropagation();
    const target = event.target as HTMLInputElement | null;
    this.inlineGroupTitleEditValue.set(String(target?.value || ''));
  }

  async saveInlineGroupTitleEdit(event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!this.isInlineGroupTitleEditing()) return;
    const group = this.findActiveGroup();
    if (!group || !this.canCurrentUserEditGroupTitle(group)) {
      this.cancelInlineGroupTitleEdit();
      return;
    }
    const nextTitle = String(this.inlineGroupTitleEditValue() || '').trim();
    if (nextTitle.length < 2) {
      this.snackBar.open('יש להזין שם קבוצה תקין.', 'סגור', { duration: 2200 });
      return;
    }
    if (nextTitle === String(group.name || '').trim()) {
      this.cancelInlineGroupTitleEdit();
      return;
    }
    try {
      await this.store.updateGroupTitle(group.id, nextTitle);
      this.snackBar.open('שם הקבוצה עודכן.', 'סגור', { duration: 2200 });
      const refreshed = this.findGroupById(group.id);
      if (refreshed) {
        this.inlineGroupTitleEditValue.set(String(refreshed.name || '').trim());
      }
      this.cancelInlineGroupTitleEdit();
      const preview = this.groupMembersPreview();
      if (preview && preview.groupId === group.id) {
        this.groupMembersPreview.set({
          ...preview,
          title: nextTitle
        });
        this.groupTitleEditValue.set(nextTitle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'עדכון שם קבוצה נכשל';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    }
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

  groupMembersMetaText(groupPreview: GroupMembersPreview): string {
    if (groupPreview.type !== 'community') {
      return 'קבוצה רגילה · כל המשתתפים יכולים לשלוח';
    }
    if (this.store.isDovrutGroupChat(groupPreview.groupId)) {
      return 'קבוצת קהילה · רק מנהלי החדר שולחים הודעות';
    }
    return 'קבוצת קהילה · רק מנהל שולח הודעות';
  }

  conversationSubtitle(chat: ChatListItem): string {
    const info = String(chat.info || '').trim();
    if (info) {
      return info;
    }
    return chat.isGroup ? 'קבוצה' : chat.id;
  }

  groupMemberAvatarUrl(member: {
    username: string;
    upic?: string;
  }): string | null {
    const normalizedUsername = this.normalizeUsername(member.username);
    if (normalizedUsername && this.failedGroupMemberAvatarUsers().has(normalizedUsername)) {
      return null;
    }
    const rawUrl = String(member.upic || '').trim();
    if (!rawUrl) return null;
    return this.optimizeAvatarUrl(rawUrl, 96);
  }

  groupMemberAvatarFallback(member: {
    displayName: string;
    username: string;
  }): string {
    const source = String(member.displayName || member.username || '').trim();
    return source ? source.charAt(0).toUpperCase() : '?';
  }

  markGroupMemberAvatarLoadError(username: string): void {
    const normalizedUsername = this.normalizeUsername(username);
    if (!normalizedUsername || this.failedGroupMemberAvatarUsers().has(normalizedUsername)) {
      return;
    }
    const next = new Set(this.failedGroupMemberAvatarUsers());
    next.add(normalizedUsername);
    this.failedGroupMemberAvatarUsers.set(next);
  }

  private buildGroupMembersPreview(group: ChatGroup): GroupMembersPreview {
    const contactsByUsername = new Map(
      this.store.contacts().map((contact) => [contact.username, contact])
    );
    const currentUser = String(this.store.currentUser() || '').trim().toLowerCase();
    const isDovrutGroup = this.store.isDovrutGroupChat(group.id);
    const adminUsernames = this.resolveGroupAdminUsernames(group);
    const isCurrentUserAdmin = Boolean(currentUser && adminUsernames.includes(currentUser));
    const canManageMembers = !isDovrutGroup && isCurrentUserAdmin;
    const canEditTitle = !isDovrutGroup && isCurrentUserAdmin;
    const members = (group.members ?? [])
      .map((username) => {
        const normalized = String(username || '').trim().toLowerCase();
        const contact = contactsByUsername.get(normalized);
        return {
          username: normalized,
          displayName: contact?.displayName || normalized,
          info: contact?.info,
          upic: contact?.upic,
          isAdmin: isDovrutGroup
            ? this.store.isDovrutAdminUser(normalized)
            : adminUsernames.includes(normalized)
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'he'));

    return {
      groupId: group.id,
      title: group.name,
      type: group.type,
      canEditTitle,
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
      this.groupTitleEditValue.set(refreshed.name);
      this.clearSelectedGroupMemberAdds();
      this.clearSelectedGroupMemberRemovals();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'עדכון חברי קבוצה נכשל';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    }
  }


  longPressTimer: any;

  onTouchStart(event: Event, message: ChatMessage): void {
    if (!this.canReactToMessage(message)) return;
    this.longPressTimer = setTimeout(() => {
      this.triggerReactionMenu(event, message);
    }, 500);
  }

  onTouchEnd(): void {
    clearTimeout(this.longPressTimer);
  }

  onTouchMove(): void {
    clearTimeout(this.longPressTimer);
  }

  triggerReactionMenu(event: Event, message: ChatMessage): void {
    if (!this.canReactToMessage(message)) return;
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const reactBtn = target.querySelector('.message-react-btn') as HTMLElement;
      if (reactBtn) {
        if (event.preventDefault) event.preventDefault();
        this.setReactionTarget(message);
        reactBtn.click();
      }
    }
  }

  onMessageContextMenu(event: MouseEvent | TouchEvent, message: ChatMessage): void {
    if (!this.canReactToMessage(message)) return;
    
    // Attempt to locate the matMenuTrigger attached to the react button.
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const reactBtn = target.querySelector('.message-react-btn') as HTMLElement;
      if (reactBtn) {
        event.preventDefault();
        event.stopPropagation();
        this.setReactionTarget(message);
        reactBtn.click();
      }
    }
  }

  canReactToMessage(message: ChatMessage): boolean {
    return !!message.messageId;
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
    if (!activeGroup) return false;
    const currentUser = this.normalizeUsername(this.store.currentUser() || '');
    if (!currentUser) return false;
    const adminUsers = this.resolveGroupAdminUsernames(activeGroup);
    const isGroupAdmin = this.store.isDovrutGroupChat(activeGroup.id)
      ? this.store.isDovrutAdminUser(currentUser)
      : adminUsers.includes(currentUser);
    return Boolean(
      isGroupAdmin &&
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

  canOpenMessageActions(message: ChatMessage): boolean {
    if (!message.messageId) return false;
    if (this.canManageOutgoingMessage(message)) return true;
    return this.canReplyToMessage(message) || this.canForwardMessage(message);
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

  canReplyToMessage(message: ChatMessage): boolean {
    if (!message.messageId || message.deletedAt) return false;
    return Boolean(String(message.body || '').trim() || message.imageUrl);
  }

  canForwardMessage(message: ChatMessage): boolean {
    if (!message.messageId || message.deletedAt) return false;
    return Boolean(String(message.body || '').trim() || message.imageUrl);
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

  isMessageForwarded(message: ChatMessage): boolean {
    return Boolean(message.forwarded);
  }

  replyAuthorLabel(reference: MessageReference): string {
    const senderKey = this.normalizeUsername(reference.sender);
    if (senderKey && senderKey === this.normalizeUsername(this.store.currentUser() || '')) {
      return 'אתה';
    }

    const senderName = String(reference.senderDisplayName || '').trim();
    if (senderName) {
      return senderName;
    }

    const fromContacts = this.store.contacts().find((contact) => contact.username === senderKey);
    if (fromContacts?.displayName) {
      return fromContacts.displayName;
    }

    return senderKey || 'הודעה';
  }

  replyPreviewLabel(reference: MessageReference): string {
    if (reference.imageUrl) {
      return '📷 תמונה';
    }
    const body = String(reference.body || '').trim();
    if (!body) {
      return 'הודעה';
    }
    return this.clampPreview(body, 90);
  }

  composerReplyTitle(message: ChatMessage): string {
    const reference = this.buildReplyReference(message);
    if (!reference) {
      return 'תגובה';
    }
    return `תגובה אל ${this.replyAuthorLabel(reference)}`;
  }

  composerReplyPreview(message: ChatMessage): string {
    const reference = this.buildReplyReference(message);
    if (!reference) {
      return '';
    }
    return this.replyPreviewLabel(reference);
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
    this.replyingMessageTarget.set(null);
    this.editingMessageTarget.set(target);
    this.messageControl.setValue(target.body || '');
  }

  cancelEditingMessage(): void {
    this.clearComposerEditState();
  }

  startReplyToSelectedMessage(): void {
    const target = this.messageActionTarget();
    if (!target || !this.canReplyToMessage(target)) {
      this.replyingMessageTarget.set(null);
      return;
    }
    this.editingMessageTarget.set(null);
    this.replyingMessageTarget.set(target);
    this.messageActionTarget.set(null);
  }

  cancelReplyingMessage(): void {
    this.replyingMessageTarget.set(null);
    this.messageActionTarget.set(null);
  }

  async forwardSelectedMessage(): Promise<void> {
    const target = this.messageActionTarget();
    if (!target || !this.canForwardMessage(target)) {
      return;
    }
    const targetMessageId = target.messageId;
    if (this.isMessageActionPendingById(targetMessageId)) {
      return;
    }

    const currentUser = this.normalizeUsername(this.store.currentUser() || '');
    const destinationChats = this.store
      .chatItems()
      .filter((chat) => chat.id !== currentUser && this.store.canSendToChat(chat.id));
    if (!destinationChats.length) {
      this.snackBar.open('לא נמצאו צ׳אטים זמינים להעברה.', 'סגור', { duration: 2600 });
      return;
    }

    const dialogRef = this.dialog.open(ForwardMessageDialogComponent, {
      width: '420px',
      data: {
        chats: destinationChats,
        currentChatId: this.store.activeChatId()
      }
    });
    const destinationChatId = await firstValueFrom(dialogRef.afterClosed());
    if (!destinationChatId) {
      return;
    }

    this.setMessageActionPending(targetMessageId, true);
    try {
      await this.store.forwardMessageToChat(destinationChatId, target);
      this.messageActionTarget.set(null);
      const destinationTitle =
        this.store.chatItems().find((chat) => chat.id === this.normalizeUsername(destinationChatId))?.title
        ?? destinationChatId;
      this.snackBar.open(`ההודעה הועברה אל ${destinationTitle}.`, 'סגור', { duration: 2600 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'העברת ההודעה נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 3200 });
    } finally {
      this.setMessageActionPending(targetMessageId, false);
    }
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

  private shouldDisplayChatInContactsPane(chat: ChatListItem): boolean {
    if (chat.pinned || chat.isGroup) {
      return true;
    }

    if (chat.id === this.store.activeChatId()) {
      return true;
    }

    return chat.lastTimestamp > 0 || chat.unread > 0;
  }

  private tryLoadOlderMessagesOnScroll(): void {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel) return;
    if (this.isLoadingOlderMessages) return;
    if (!this.hasOlderMessages()) return;
    if (panel.scrollTop > this.loadOlderMessagesScrollThresholdPx) return;

    this.loadOlderMessagesPage();
  }

  private loadOlderMessagesPage(): void {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel) return;
    if (this.isLoadingOlderMessages) return;
    if (!this.hasOlderMessages()) return;

    const previousScrollHeight = panel.scrollHeight;
    const previousScrollTop = panel.scrollTop;
    this.isLoadingOlderMessages = true;
    this.visibleMessageCount.update((count) => count + MESSAGE_PAGE_SIZE);

    window.requestAnimationFrame(() => {
      const refreshedPanel = this.messagesPanel?.nativeElement;
      if (refreshedPanel) {
        const nextScrollHeight = refreshedPanel.scrollHeight;
        const heightDelta = Math.max(0, nextScrollHeight - previousScrollHeight);
        refreshedPanel.scrollTop = previousScrollTop + heightDelta;
      }
      this.isLoadingOlderMessages = false;
      this.updateStickyMessageDateFromViewport();
      this.updateMessagesBottomState();
    });
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

  private syncComposerTextareaHeight(): void {
    const textarea = this.composerTextareaRef?.nativeElement;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const nextHeight = Math.max(
      this.composerTextareaMinHeightPx,
      Math.min(textarea.scrollHeight, this.composerTextareaMaxHeightPx)
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > this.composerTextareaMaxHeightPx ? 'auto' : 'hidden';
    textarea.scrollTop = textarea.scrollHeight;
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

    const urlRegex = /(https?:\/\/[^\s<>"']+|\/?notify\/uploads\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
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
      const normalizedUrl = this.normalizeMessageUrl(cleanUrl);

      if (this.isImageUrl(normalizedUrl)) {
        parts.push({ kind: 'image', url: normalizedUrl });
      } else if (this.isLocationUrl(normalizedUrl)) {
        parts.push({ kind: 'location', url: normalizedUrl, label: 'המיקום שלי' });
      } else {
        parts.push({ kind: 'link', url: normalizedUrl, label: 'לחץ כאן לפתיחת קובץ/קישור' });
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

  private normalizeMessageUrl(url: string): string {
    const value = String(url || '').trim();
    if (!value) return '';

    let normalized = value;
    if (/^www\./i.test(normalized)) {
      normalized = `https://${normalized}`;
    } else if (/^\/?notify\/uploads\//i.test(normalized)) {
      normalized = normalized.startsWith('/') ? normalized : `/${normalized}`;
    }

    normalized = normalized.replace(
      /(\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|rar|7z|jpeg|jpg|png|gif|webp))\/(?=$|[?#])/i,
      '$1'
    );
    return normalized;
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

  formatMessageTextPart(text: string): string {
    const escaped = this.escapeHtml(String(text || ''));
    return this.applyWhatsAppStyleBoldFormatting(escaped);
  }

  private applyWhatsAppStyleBoldFormatting(value: string): string {
    const source = String(value || '');
    if (!source || source.indexOf('*') === -1) {
      return source;
    }

    return source.replace(
      /\*([^*\n]+?)\*/g,
      (full, content: string) => {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) {
          return full;
        }
        return `<strong class="message-inline-bold">${normalizedContent}</strong>`;
      }
    );
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  private buildReplyReference(message: ChatMessage): MessageReference | null {
    const messageId = String(message.messageId || '').trim();
    const sender = this.normalizeUsername(message.sender || '');
    if (!messageId || !sender) {
      return null;
    }

    const body = String(message.body || '');
    const imageUrl = message.imageUrl ?? null;
    if (!body.trim() && !imageUrl) {
      return null;
    }

    const senderDisplayName = String(message.senderDisplayName || '').trim();
    return {
      messageId,
      sender,
      senderDisplayName: senderDisplayName || undefined,
      body,
      imageUrl
    };
  }

  private clampPreview(value: string, maxLength = 90): string {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}…`;
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

  private resolveGroupAdminUsernames(group: ChatGroup): string[] {
    const adminUsers = Array.from(
      new Set((group.admins ?? [])
        .map((admin) => this.normalizeUsername(admin))
        .filter(Boolean))
    );
    const createdBy = this.normalizeUsername(group.createdBy || '');
    if (createdBy && !adminUsers.includes(createdBy)) {
      adminUsers.push(createdBy);
    }
    return adminUsers;
  }

  private canCurrentUserEditGroupTitle(group: ChatGroup): boolean {
    if (this.store.isDovrutGroupChat(group.id)) {
      return false;
    }
    const currentUser = this.normalizeUsername(this.store.currentUser() || '');
    if (!currentUser) return false;
    return this.resolveGroupAdminUsernames(group).includes(currentUser);
  }

  private normalizeUsername(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private isHrChatRoom(chatId: string | null | undefined): boolean {
    return this.normalizeUsername(chatId || '') === this.hrChatId;
  }

  private parseHrListChoiceMessage(message: ChatMessage): HrListChoiceDialogPayload | null {
    const sourceMessageId = String(message.messageId || message.id || '').trim();
    if (!sourceMessageId) {
      return null;
    }
    const body = String(message.body || '');
    const normalizedBody = body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!normalizedBody) {
      return null;
    }

    const lines = normalizedBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const options: HrListChoiceOption[] = [];
    const promptLines: string[] = [];
    let encounteredChoiceLine = false;
    for (const line of lines) {
      const match = line.match(/^(\d{1,2})\s*[\.\)\-]\s*(.+)$/);
      if (match) {
        encounteredChoiceLine = true;
        const label = String(match[2] || '').trim();
        options.push({
          choiceNumber: String(match[1] || '').trim(),
          label: label || `אפשרות ${match[1]}`
        });
        continue;
      }
      if (!encounteredChoiceLine) {
        promptLines.push(line);
      }
    }

    if (!options.length) {
      const inlineMatches = Array.from(
        normalizedBody.matchAll(/(?:^|\s)(\d{1,2})\s*[\.\)\-]\s*([^\n]+?)(?=(?:\s+\d{1,2}\s*[\.\)\-])|$)/g)
      );
      for (const match of inlineMatches) {
        const number = String(match[1] || '').trim();
        const label = String(match[2] || '').trim();
        if (!number || !label) continue;
        options.push({
          choiceNumber: number,
          label
        });
      }
    }

    if (options.length < 1) {
      return null;
    }
    const prompt = promptLines.join('\n').trim() || 'יש לבחור אפשרות מהרשימה:';
    return {
      sourceMessageId,
      prompt,
      options
    };
  }

  private getHrListChoicePayload(message: ChatMessage): HrListChoiceDialogPayload | null {
    const cacheKey = String(message.messageId || message.id || '').trim();
    if (!cacheKey) {
      return this.parseHrListChoiceMessage(message);
    }
    const body = String(message.body || '');
    const cached = this.hrListChoiceCache.get(cacheKey);
    if (cached && cached.body === body) {
      return cached.payload;
    }
    const payload = this.parseHrListChoiceMessage(message);
    this.hrListChoiceCache.set(cacheKey, { body, payload });
    return payload;
  }

  hrInlineChoicePayload(message: ChatMessage): HrListChoiceDialogPayload | null {
    if (message.direction !== 'incoming') return null;
    if (!this.isHrChatRoom(this.store.activeChatId())) return null;
    return this.getHrListChoicePayload(message);
  }

  async chooseHrListChoice(
    choiceNumber: string,
    choiceLabel?: string | null,
    sourceMessageId?: string
  ): Promise<void> {
    const normalized = String(choiceNumber || '').trim();
    if (!/^\d{1,2}$/.test(normalized)) return;
    if (this.isSubmittingHrListChoice()) return;
    const displayLabel = String(choiceLabel || '').trim() || normalized;

    this.isSubmittingHrListChoice.set(true);
    try {
      await this.store.sendTextMessage(displayLabel, { hrFlowInput: normalized });
      this.lockHrListChoiceSourceMessage(sourceMessageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת הבחירה נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 2800 });
    } finally {
      this.isSubmittingHrListChoice.set(false);
    }
  }

  async goBackInHrFlow(): Promise<void> {
    await this.sendHrComposerControlMessage('חזרה', '0');
  }

  async startNewHrSession(): Promise<void> {
    await this.sendHrComposerControlMessage('התחל מחדש', '0');
  }

  async endHrConversation(): Promise<void> {
    await this.sendHrComposerControlMessage('סיום שיחה', '__hr_end__');
  }

  isHrListChoiceLocked(sourceMessageId: string | null | undefined): boolean {
    const normalized = String(sourceMessageId || '').trim();
    if (!normalized) return false;
    return this.lockedHrListChoiceMessageIds().has(normalized);
  }

  private lockHrListChoiceSourceMessage(sourceMessageId: string | null | undefined): void {
    const normalized = String(sourceMessageId || '').trim();
    if (!normalized) return;
    this.lockedHrListChoiceMessageIds.update((current) => {
      if (current.has(normalized)) {
        return current;
      }
      const next = new Set(current);
      next.add(normalized);
      return next;
    });
  }

  private async sendHrComposerControlMessage(displayText: string, flowInput: string): Promise<void> {
    if (!this.isHrChatRoom(this.store.activeChatId())) return;
    if (this.isSubmittingHrListChoice()) return;
    this.isSubmittingHrListChoice.set(true);
    try {
      await this.store.sendTextMessage(displayText, { hrFlowInput: flowInput });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת ההודעה נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 2800 });
    } finally {
      this.isSubmittingHrListChoice.set(false);
    }
  }

  private extractDepartmentFromInfo(info?: string): string {
    const rawInfo = String(info || '').trim();
    if (!rawInfo) return '';
    const [department = ''] = rawInfo.split(/\s*[-–—]\s*/, 1);
    return department.trim().toLowerCase();
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
    this.replyingMessageTarget.set(null);
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

  private setShuttleOrderCancelling(orderId: string, pending: boolean): void {
    const normalized = String(orderId || '').trim();
    if (!normalized) return;

    const next = new Set(this.isCancellingShuttleOrderIds());
    if (pending) {
      next.add(normalized);
    } else {
      next.delete(normalized);
    }
    this.isCancellingShuttleOrderIds.set(next);
  }
}
