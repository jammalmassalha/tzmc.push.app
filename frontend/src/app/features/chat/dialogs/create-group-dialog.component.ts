import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { startWith } from 'rxjs';
import { Contact, GroupType } from '../../../core/models/chat.models';

export interface CreateGroupDialogData {
  contacts: Contact[];
  currentUser: string | null;
}

export interface CreateGroupDialogResult {
  name: string;
  type: GroupType;
  members: string[];
}

@Component({
  selector: 'app-create-group-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './create-group-dialog.component.html',
  styleUrl: './create-group-dialog.component.scss'
})
export class CreateGroupDialogComponent {
  readonly data = inject<CreateGroupDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<CreateGroupDialogComponent, CreateGroupDialogResult>);
  private readonly fb = inject(FormBuilder);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    type: this.fb.nonNullable.control<GroupType>('group')
  });

  readonly searchControl = this.fb.nonNullable.control('');
  readonly searchTerm = toSignal(this.searchControl.valueChanges.pipe(startWith('')), {
    initialValue: ''
  });
  readonly selectedMembers = signal<Set<string>>(new Set<string>());
  readonly failedAvatarUsers = signal<Set<string>>(new Set<string>());
  readonly errorMessage = signal<string>('');

  readonly filteredContacts = computed(() => {
    const query = this.searchTerm().trim().toLowerCase();
    const currentUser = this.data.currentUser;

    return this.data.contacts.filter((contact) => {
      if (currentUser && contact.username === currentUser) return false;
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

  toggleMember(username: string, checked: boolean): void {
    const next = new Set(this.selectedMembers());
    if (checked) {
      next.add(username);
    } else {
      next.delete(username);
    }
    this.selectedMembers.set(next);
    if (next.size > 0) {
      this.errorMessage.set('');
    }
  }

  isSelected(username: string): boolean {
    return this.selectedMembers().has(username);
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

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const members = Array.from(this.selectedMembers());
    if (!members.length) {
      this.errorMessage.set('יש לבחור לפחות משתתף אחד.');
      return;
    }

    this.dialogRef.close({
      name: this.form.controls.name.value.trim(),
      type: this.form.controls.type.value,
      members
    });
  }
}
