import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface HelpdeskTicketDialogData {
  department: string;
}

export interface HelpdeskTicketDialogResult {
  title: string;
  description: string;
}

@Component({
  selector: 'app-helpdesk-ticket-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule
  ],
  templateUrl: './helpdesk-ticket-dialog.component.html',
  styleUrl: './helpdesk-ticket-dialog.component.scss'
})
export class HelpdeskTicketDialogComponent {
  readonly data = inject<HelpdeskTicketDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HelpdeskTicketDialogComponent, HelpdeskTicketDialogResult>);
  private readonly fb = inject(FormBuilder);

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(200)]],
    description: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(2000)]]
  });

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.dialogRef.close({
      title: this.form.controls.title.value.trim(),
      description: this.form.controls.description.value.trim()
    });
  }
}
