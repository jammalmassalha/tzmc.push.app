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
import { MatBadgeModule } from '@angular/material/badge';
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
import { ChatListItem, DeliveryStatus } from '../../core/models/chat.models';
import { ChatStoreService } from '../../core/services/chat-store.service';
import { CreateGroupDialogComponent } from './dialogs/create-group-dialog.component';
import { NewChatDialogComponent } from './dialogs/new-chat-dialog.component';

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
    MatBadgeModule,
    MatSnackBarModule
  ],
  templateUrl: './chat-shell.component.html',
  styleUrl: './chat-shell.component.scss'
})
export class ChatShellComponent implements OnInit, OnDestroy {
  @ViewChild(CdkVirtualScrollViewport) contactsViewport?: CdkVirtualScrollViewport;
  @ViewChild('messagesPanel') messagesPanel?: ElementRef<HTMLDivElement>;

  private readonly mobileQuery = window.matchMedia('(max-width: 960px)');
  private readonly onMediaChange = (event: MediaQueryListEvent): void => {
    this.isMobile.set(event.matches);
    this.showContactsPane.set(!event.matches || !this.store.activeChatId());
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
  readonly showContactsPane = signal(!this.mobileQuery.matches);

  readonly filteredChats = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const chats = this.store.chatItems();
    if (!query) return chats;

    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(query) ||
        chat.id.toLowerCase().includes(query) ||
        chat.subtitle.toLowerCase().includes(query)
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

  private readonly autoScrollEffect = effect(() => {
    const activeChatId = this.store.activeChatId();
    const size = this.store.activeMessages().length;
    if (!activeChatId || size === 0) return;
    queueMicrotask(() => this.scrollMessagesToBottom());
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

    await this.store.initialize();
    const chatFromUrl = this.route.snapshot.queryParamMap.get('chat');
    if (chatFromUrl) {
      this.openChat(chatFromUrl);
    } else if (!this.store.activeChatId()) {
      this.store.setActiveChat(this.store.chatItems()[0]?.id ?? null);
    }
  }

  ngOnDestroy(): void {
    this.mobileQuery.removeEventListener('change', this.onMediaChange);
  }

  openChat(chatId: string): void {
    this.store.setActiveChat(chatId);
    if (this.isMobile()) {
      this.showContactsPane.set(false);
    }
  }

  backToList(): void {
    this.showContactsPane.set(true);
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

  formatTime(timestamp: number): string {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('he-IL', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  isHttpLink(text: string): boolean {
    return /^https?:\/\/\S+$/i.test(text.trim());
  }

  isImageLink(url: string): boolean {
    return /\.(jpeg|jpg|png|gif|webp)(\?|$)/i.test(url);
  }

  isDocumentLink(url: string): boolean {
    return /\.(pdf|doc|docx)(\?|$)/i.test(url);
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

  private scrollMessagesToBottom(): void {
    const panel = this.messagesPanel?.nativeElement;
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }
}
