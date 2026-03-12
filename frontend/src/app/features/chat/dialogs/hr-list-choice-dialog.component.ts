import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

export interface HrListChoiceOptionData {
  choiceNumber: string;
  label: string;
}

export interface HrListChoiceDialogData {
  prompt: string;
  options: HrListChoiceOptionData[];
}

export interface HrListChoiceDialogResult {
  choiceNumber: string;
  label: string;
}

@Component({
  selector: 'app-hr-list-choice-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  templateUrl: './hr-list-choice-dialog.component.html',
  styleUrl: './hr-list-choice-dialog.component.scss'
})
export class HrListChoiceDialogComponent {
  readonly data = inject<HrListChoiceDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HrListChoiceDialogComponent, HrListChoiceDialogResult>);

  choose(option: HrListChoiceOptionData): void {
    this.dialogRef.close({
      choiceNumber: String(option.choiceNumber || '').trim(),
      label: String(option.label || '').trim()
    });
  }
}
