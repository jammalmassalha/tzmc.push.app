import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';

export interface ConfirmMessageActionDialogData {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmColor?: 'primary' | 'warn' | 'accent';
}

@Component({
  selector: 'app-confirm-message-action-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  templateUrl: './confirm-message-action-dialog.component.html',
  styleUrl: './confirm-message-action-dialog.component.scss'
})
export class ConfirmMessageActionDialogComponent {
  readonly data = inject<ConfirmMessageActionDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<ConfirmMessageActionDialogComponent, boolean>);
}
