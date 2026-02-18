import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { startWith } from 'rxjs';
import { ChatListItem } from '../../../core/models/chat.models';

export interface ForwardMessageDialogData {
  chats: ChatListItem[];
  currentChatId?: string | null;
}

@Component({
  selector: 'app-forward-message-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './forward-message-dialog.component.html',
  styleUrl: './forward-message-dialog.component.scss'
})
export class ForwardMessageDialogComponent {
  readonly data = inject<ForwardMessageDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<ForwardMessageDialogComponent, string>);

  readonly searchControl = new FormControl('', { nonNullable: true });
  readonly searchTerm = toSignal(this.searchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });

  readonly filteredChats = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const chats = Array.isArray(this.data.chats) ? this.data.chats : [];
    if (!query) {
      return chats;
    }
    return chats.filter((chat) =>
      chat.title.toLowerCase().includes(query) ||
      chat.id.toLowerCase().includes(query) ||
      chat.subtitle.toLowerCase().includes(query) ||
      String(chat.info || '').toLowerCase().includes(query)
    );
  });

  chooseChat(chatId: string): void {
    const normalized = String(chatId || '').trim();
    if (!normalized) return;
    this.dialogRef.close(normalized);
  }

  isCurrentChat(chatId: string): boolean {
    return String(this.data.currentChatId || '').trim().toLowerCase() === String(chatId || '').trim().toLowerCase();
  }
}
