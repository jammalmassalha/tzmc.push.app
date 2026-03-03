import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { startWith } from 'rxjs';
import { Contact } from '../../../core/models/chat.models';

export interface NewChatDialogData {
  contacts: Contact[];
  currentUser: string | null;
}

@Component({
  selector: 'app-new-chat-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './new-chat-dialog.component.html',
  styleUrl: './new-chat-dialog.component.scss'
})
export class NewChatDialogComponent {
  readonly data = inject<NewChatDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<NewChatDialogComponent, string>);

  readonly searchControl = new FormControl('', { nonNullable: true });
  readonly searchTerm = toSignal(this.searchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });
  readonly failedAvatarUsers = signal<Set<string>>(new Set<string>());

  readonly filteredContacts = computed(() => {
    const current = this.data.currentUser;
    const query = this.searchTerm().trim().toLowerCase();

    return this.data.contacts.filter((contact) => {
      if (current && contact.username === current) return false;
      if (!query) return true;
      const info = String(contact.info || '').toLowerCase();
      const phone = String(contact.phone || '').toLowerCase();
      return (
        contact.displayName.toLowerCase().includes(query) ||
        contact.username.toLowerCase().includes(query) ||
        info.includes(query) ||
        phone.includes(query)
      );
    });
  });

  startChat(username: string): void {
    this.dialogRef.close(username);
  }

  avatarUrl(username: string, upic?: string): string | null {
    if (this.failedAvatarUsers().has(username)) {
      return null;
    }
    const normalized = String(upic || '').trim();
    return normalized || null;
  }

  avatarFallback(displayName: string, username: string): string {
    const source = String(displayName || username || '').trim();
    return source ? source.charAt(0).toUpperCase() : '?';
  }

  markAvatarLoadError(username: string): void {
    const next = new Set(this.failedAvatarUsers());
    next.add(username);
    this.failedAvatarUsers.set(next);
  }
}
