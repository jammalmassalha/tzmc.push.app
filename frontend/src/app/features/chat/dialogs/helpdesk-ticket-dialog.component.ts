import { Component, inject, signal, OnInit } from '@angular/core';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatApiService } from '../../../core/services/chat-api.service';

export interface HelpdeskTicketDialogData {
  department: string;
}

export interface HelpdeskTicketDialogResult {
  title: string;
  description: string;
  location: string | null;
}

@Component({
  selector: 'app-helpdesk-ticket-dialog',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatAutocompleteModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './helpdesk-ticket-dialog.component.html',
  styleUrl: './helpdesk-ticket-dialog.component.scss'
})
export class HelpdeskTicketDialogComponent implements OnInit {
  readonly data = inject<HelpdeskTicketDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HelpdeskTicketDialogComponent, HelpdeskTicketDialogResult>);
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ChatApiService);

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(200)]],
    description: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(2000)]]
  });

  readonly locationControl = new FormControl<string>('', [Validators.required]);
  readonly allLocations = signal<string[]>([]);
  readonly filteredLocations = signal<string[]>([]);
  readonly isLoadingLocations = signal(true);

  ngOnInit(): void {
    this.loadLocations();
    this.locationControl.valueChanges.subscribe((value) => {
      this.filterLocations(value || '');
    });
  }

  private async loadLocations(): Promise<void> {
    this.isLoadingLocations.set(true);
    try {
      const locations = await this.api.getHelpdeskLocations();
      this.allLocations.set(locations);
      this.filteredLocations.set(locations);
    } catch {
      // Non-critical - location picker just won't have suggestions
    } finally {
      this.isLoadingLocations.set(false);
    }
  }

  private filterLocations(query: string): void {
    const q = query.trim().toLowerCase();
    if (!q) {
      this.filteredLocations.set(this.allLocations());
      return;
    }
    const filtered = this.allLocations().filter((loc) => loc.toLowerCase().includes(q));
    this.filteredLocations.set(filtered);
  }

  submit(): void {
    if (this.form.invalid || this.locationControl.invalid) {
      this.form.markAllAsTouched();
      this.locationControl.markAsTouched();
      return;
    }
    const locationValue = (this.locationControl.value || '').trim();
    this.dialogRef.close({
      title: this.form.controls.title.value.trim(),
      description: this.form.controls.description.value.trim(),
      location: locationValue || null
    });
  }
}
