import { CommonModule } from '@angular/common';
import { Component, inject, signal, OnInit, ViewChild, ElementRef } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { HelpdeskManagedUser, HelpdeskMyRole, HelpdeskNote, HelpdeskStatus, HelpdeskStatusHistoryEntry, HelpdeskTicket } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';

export interface HelpdeskTicketDetailDialogData {
  ticket: HelpdeskTicket;
  currentUsername: string;
  myRole: HelpdeskMyRole | null;
  handlers: HelpdeskManagedUser[] | null;
  statusLabel: (status: string) => string;
  resolveUsername: (username: string) => string;
  resolveContact: (username: string) => { displayName: string; info?: string; phone?: string };
  assignHandler: (ticketId: number, handlerUsername: string | null) => Promise<void>;
  updateStatus: (ticketId: number, status: string) => Promise<void>;
}

export interface HelpdeskTicketDetailDialogResult {
  changed?: boolean;
}

@Component({
  selector: 'app-helpdesk-ticket-detail-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDividerModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatSelectModule
  ],
  templateUrl: './helpdesk-ticket-detail-dialog.component.html',
  styleUrl: './helpdesk-ticket-detail-dialog.component.scss'
})
export class HelpdeskTicketDetailDialogComponent implements OnInit {
  readonly data = inject<HelpdeskTicketDetailDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HelpdeskTicketDetailDialogComponent, HelpdeskTicketDetailDialogResult>);
  private readonly api = inject(ChatApiService);

  readonly notes = signal<HelpdeskNote[]>([]);
  readonly isLoadingNotes = signal(true);
  readonly isSubmittingNote = signal(false);
  readonly noteError = signal<string | null>(null);

  readonly pendingAttachmentUrl = signal<string | null>(null);
  readonly pendingAttachmentName = signal<string | null>(null);
  readonly isUploadingAttachment = signal(false);
  readonly uploadError = signal<string | null>(null);

  readonly imageModalUrl = signal<string | null>(null);

  @ViewChild('noteFileInput') noteFileInputRef?: ElementRef<HTMLInputElement>;

  readonly statusHistory = signal<HelpdeskStatusHistoryEntry[]>([]);
  readonly isLoadingHistory = signal(true);

  readonly isAssigningHandler = signal(false);
  readonly handlerError = signal<string | null>(null);
  selectedHandler: string | null = this.data.ticket.handlerUsername ?? null;

  readonly isUpdatingStatus = signal(false);
  readonly statusError = signal<string | null>(null);
  selectedStatus: HelpdeskStatus = this.data.ticket.status;
  readonly currentTicketStatus = signal<HelpdeskStatus>(this.data.ticket.status);

  private changed = false;

  readonly noteControl = new FormControl('', [Validators.maxLength(1000)]);

  readonly allStatuses: HelpdeskStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

  get canManageHandler(): boolean {
    const { myRole, ticket } = this.data;
    return Boolean(myRole && myRole.department === ticket.department);
  }

  get canChangeStatus(): boolean {
    const { currentUsername, myRole, ticket } = this.data;
    if (ticket.creatorUsername === currentUsername) return true;
    if (ticket.handlerUsername === currentUsername) return true;
    if (myRole && myRole.department === ticket.department) return true;
    return false;
  }

  get availableHandlers(): HelpdeskManagedUser[] {
    return this.data.handlers ?? [];
  }

  get creatorContact(): { displayName: string; info?: string; phone?: string } {
    return this.data.resolveContact(this.data.ticket.creatorUsername);
  }

  resolveDisplay(username: string | null | undefined): string {
    if (!username) return '—';
    return this.data.resolveUsername(username) || username;
  }

  ngOnInit(): void {
    this.loadNotes();
    this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    this.isLoadingHistory.set(true);
    try {
      const loaded = await this.api.getHelpdeskTicketHistory(this.data.ticket.id);
      this.statusHistory.set(loaded);
    } catch {
      // non-critical — history just won't show
    } finally {
      this.isLoadingHistory.set(false);
    }
  }

  private async loadNotes(): Promise<void> {
    this.isLoadingNotes.set(true);
    try {
      const loaded = await this.api.getHelpdeskTicketNotes(this.data.ticket.id);
      this.notes.set(loaded);
    } catch {
      // non-critical — notes just won't show
    } finally {
      this.isLoadingNotes.set(false);
    }
  }

  async submitNote(): Promise<void> {
    if (this.isSubmittingNote()) return;
    const text = (this.noteControl.value ?? '').trim();
    const attachmentUrl = this.pendingAttachmentUrl();
    if (!text && !attachmentUrl) return;
    if (text && text.length < 2 && !attachmentUrl) return;

    this.noteError.set(null);
    this.isSubmittingNote.set(true);
    try {
      const noteId = await this.api.addHelpdeskNote(this.data.ticket.id, text, attachmentUrl);
      const newNote: HelpdeskNote = {
        id: noteId,
        ticketId: this.data.ticket.id,
        authorUsername: this.data.currentUsername,
        noteText: text,
        attachmentUrl: attachmentUrl || null,
        createdAt: new Date().toISOString()
      };
      this.notes.update((list) => [...list, newNote]);
      this.noteControl.reset();
      this.clearPendingAttachment();
    } catch (error) {
      this.noteError.set(error instanceof Error ? error.message : 'שגיאה בשמירת ההערה');
    } finally {
      this.isSubmittingNote.set(false);
    }
  }

  triggerFileInput(): void {
    this.noteFileInputRef?.nativeElement?.click();
  }

  async onNoteFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-selected
    input.value = '';

    this.uploadError.set(null);
    this.isUploadingAttachment.set(true);
    try {
      const result = await this.api.uploadFile(file);
      if (!result.url) {
        throw new Error('שגיאה בהעלאת הקובץ');
      }
      this.pendingAttachmentUrl.set(result.url);
      this.pendingAttachmentName.set(file.name);
    } catch (error) {
      this.uploadError.set(error instanceof Error ? error.message : 'שגיאה בהעלאת הקובץ');
    } finally {
      this.isUploadingAttachment.set(false);
    }
  }

  clearPendingAttachment(): void {
    this.pendingAttachmentUrl.set(null);
    this.pendingAttachmentName.set(null);
    this.uploadError.set(null);
  }

  isImageUrl(url: string): boolean {
    return /\.(jpeg|jpg|png|gif|webp)(\?|#|$)/i.test(url);
  }

  openImageModal(url: string): void {
    this.imageModalUrl.set(url);
  }

  closeImageModal(): void {
    this.imageModalUrl.set(null);
  }

  get canSubmitNote(): boolean {
    const text = (this.noteControl.value ?? '').trim();
    const hasAttachment = Boolean(this.pendingAttachmentUrl());
    if (hasAttachment) return true;
    return text.length >= 2;
  }

  async saveHandler(): Promise<void> {
    if (this.isAssigningHandler()) return;
    this.handlerError.set(null);
    this.isAssigningHandler.set(true);
    try {
      await this.data.assignHandler(this.data.ticket.id, this.selectedHandler);
      this.changed = true;
    } catch (error) {
      this.handlerError.set(error instanceof Error ? error.message : 'שגיאה בשיוך מטפל');
    } finally {
      this.isAssigningHandler.set(false);
    }
  }

  async saveStatus(): Promise<void> {
    if (this.isUpdatingStatus()) return;
    this.statusError.set(null);
    this.isUpdatingStatus.set(true);
    try {
      await this.data.updateStatus(this.data.ticket.id, this.selectedStatus);
      this.currentTicketStatus.set(this.selectedStatus);
      this.changed = true;
    } catch (error) {
      this.statusError.set(error instanceof Error ? error.message : 'שגיאה בעדכון הסטטוס');
    } finally {
      this.isUpdatingStatus.set(false);
    }
  }

  close(): void {
    this.dialogRef.close({ changed: this.changed });
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return iso;
    }
  }

  get statusChipClass(): string {
    switch (this.currentTicketStatus()) {
      case 'open': return 'chip-open';
      case 'in_progress': return 'chip-in-progress';
      case 'resolved': return 'chip-resolved';
      case 'closed': return 'chip-closed';
      default: return '';
    }
  }

  get totalDuration(): string {
    const history = this.statusHistory();
    if (!history.length) return '';
    const first = history[0];
    const openTime = new Date(first.createdAt).getTime();
    if (!Number.isFinite(openTime)) return '';

    // Find the last closed/resolved entry, or use now
    const closedEntry = [...history].reverse().find(
      (h) => h.newStatus === 'closed' || h.newStatus === 'resolved'
    );
    const endTime = closedEntry ? new Date(closedEntry.createdAt).getTime() : Date.now();
    if (!Number.isFinite(endTime)) return '';

    const diffMs = endTime - openTime;
    if (diffMs < 0) return '';
    const diffMin = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days > 0) {
      return `${days} ימים, ${remainingHours} שעות, ${mins} דקות`;
    }
    if (hours > 0) {
      return `${hours} שעות, ${mins} דקות`;
    }
    return `${mins} דקות`;
  }

  statusDisplayLabel(status: string): string {
    return this.data.statusLabel(status);
  }
}
