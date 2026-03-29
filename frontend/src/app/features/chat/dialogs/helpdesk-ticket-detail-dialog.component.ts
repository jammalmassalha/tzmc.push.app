import { CommonModule } from '@angular/common';
import { Component, inject, signal, OnInit } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HelpdeskNote, HelpdeskTicket } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';

export interface HelpdeskTicketDetailDialogData {
  ticket: HelpdeskTicket;
  currentUsername: string;
  statusLabel: (status: string) => string;
}

@Component({
  selector: 'app-helpdesk-ticket-detail-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDividerModule,
    MatChipsModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './helpdesk-ticket-detail-dialog.component.html',
  styleUrl: './helpdesk-ticket-detail-dialog.component.scss'
})
export class HelpdeskTicketDetailDialogComponent implements OnInit {
  readonly data = inject<HelpdeskTicketDetailDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HelpdeskTicketDetailDialogComponent>);
  private readonly api = inject(ChatApiService);

  readonly notes = signal<HelpdeskNote[]>([]);
  readonly isLoadingNotes = signal(true);
  readonly isSubmittingNote = signal(false);
  readonly noteError = signal<string | null>(null);

  readonly noteControl = new FormControl('', [Validators.required, Validators.minLength(2), Validators.maxLength(1000)]);

  ngOnInit(): void {
    this.loadNotes();
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
    if (this.noteControl.invalid || this.isSubmittingNote()) return;
    const text = (this.noteControl.value ?? '').trim();
    if (!text) return;

    this.noteError.set(null);
    this.isSubmittingNote.set(true);
    try {
      const noteId = await this.api.addHelpdeskNote(this.data.ticket.id, text);
      const newNote: HelpdeskNote = {
        id: noteId,
        ticketId: this.data.ticket.id,
        authorUsername: this.data.currentUsername,
        noteText: text,
        createdAt: new Date().toISOString()
      };
      this.notes.update((list) => [...list, newNote]);
      this.noteControl.reset();
    } catch (error) {
      this.noteError.set(error instanceof Error ? error.message : 'שגיאה בשמירת ההערה');
    } finally {
      this.isSubmittingNote.set(false);
    }
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
    switch (this.data.ticket.status) {
      case 'open': return 'chip-open';
      case 'in_progress': return 'chip-in-progress';
      case 'resolved': return 'chip-resolved';
      case 'closed': return 'chip-closed';
      default: return '';
    }
  }
}
