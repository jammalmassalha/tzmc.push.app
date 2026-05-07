import { Component, inject, signal, OnInit, ElementRef, ViewChild } from '@angular/core';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { HelpdeskTicketFormField } from '../../../core/models/chat.models';

export interface HelpdeskTicketDialogData {
  department: string;
}

export interface HelpdeskTicketDialogResult {
  title: string;
  description: string;
  location: string | null;
  phone: string | null;
  attachmentUrl: string | null;
  customFields: Record<string, string | number>;
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
    MatProgressSpinnerModule,
    MatRadioModule
  ],
  templateUrl: './helpdesk-ticket-dialog.component.html',
  styleUrl: './helpdesk-ticket-dialog.component.scss'
})
export class HelpdeskTicketDialogComponent implements OnInit {
  readonly data = inject<HelpdeskTicketDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HelpdeskTicketDialogComponent, HelpdeskTicketDialogResult>);
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ChatApiService);

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(200)]],
    description: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(2000)]]
  });

  readonly locationControl = new FormControl<string>('', [Validators.required]);
  readonly phoneControl = new FormControl<string>('');
  readonly allLocations = signal<string[]>([]);
  readonly filteredLocations = signal<string[]>([]);
  readonly isLoadingLocations = signal(true);
  readonly selectedFile = signal<File | null>(null);
  readonly uploadedUrl = signal<string | null>(null);
  readonly isUploading = signal(false);
  readonly isLoadingDepartmentForm = signal(false);
  readonly departmentFormFields = signal<HelpdeskTicketFormField[]>([]);
  readonly filteredSelectOptions = signal<Record<string, string[]>>({});

  private readonly customFieldControls = new Map<string, FormControl<string>>();

  ngOnInit(): void {
    this.loadLocations();
    this.loadDepartmentForm();
    this.locationControl.valueChanges.subscribe((value) => {
      this.filterLocations(value || '');
    });
  }

  customControl(fieldId: string): FormControl<string> {
    const existing = this.customFieldControls.get(fieldId);
    if (existing) return existing;
    const fallback = new FormControl<string>('', { nonNullable: true });
    this.customFieldControls.set(fieldId, fallback);
    return fallback;
  }

  onSelectSearch(fieldId: string): void {
    const field = this.departmentFormFields().find((item) => item.id === fieldId && item.type === 'select');
    if (!field) return;
    const searchValue = (this.customControl(fieldId).value || '').trim().toLowerCase();
    const source = Array.isArray(field.options) ? field.options : [];
    const next = searchValue
      ? source.filter((option) => option.toLowerCase().includes(searchValue))
      : source;
    this.filteredSelectOptions.update((current) => ({ ...current, [fieldId]: next }));
  }

  selectOptions(fieldId: string): string[] {
    const fromFilter = this.filteredSelectOptions()[fieldId];
    if (Array.isArray(fromFilter)) return fromFilter;
    const field = this.departmentFormFields().find((item) => item.id === fieldId && item.type === 'select');
    return Array.isArray(field?.options) ? field.options : [];
  }

  isFieldInvalid(field: HelpdeskTicketFormField): boolean {
    const control = this.customControl(field.id);
    return Boolean(field.required && control.hasError('required') && control.touched);
  }

  private async loadDepartmentForm(): Promise<void> {
    this.isLoadingDepartmentForm.set(true);
    try {
      const fields = await this.api.getHelpdeskDepartmentTicketForm(this.data.department);
      const parsedFields = Array.isArray(fields)
        ? fields.filter((field) => field && typeof field.id === 'string' && typeof field.label === 'string')
        : [];
      this.departmentFormFields.set(parsedFields);

      const nextFiltered: Record<string, string[]> = {};
      for (const field of parsedFields) {
        const initialValue = String(field.initialValue ?? '').trim();
        const validators = field.required ? [Validators.required] : [];
        this.customFieldControls.set(
          field.id,
          new FormControl<string>(initialValue, { nonNullable: true, validators })
        );
        if (field.type === 'select') {
          nextFiltered[field.id] = Array.isArray(field.options) ? field.options : [];
        }
      }
      this.filteredSelectOptions.set(nextFiltered);
    } catch {
      this.departmentFormFields.set([]);
    } finally {
      this.isLoadingDepartmentForm.set(false);
    }
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

  triggerFileInput(): void {
    this.fileInput.nativeElement.click();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      alert('הקובץ גדול מדי. גודל מקסימלי: 10MB');
      return;
    }

    this.selectedFile.set(file);
    this.isUploading.set(true);

    try {
      const url = await this.api.uploadHelpdeskAttachment(file);
      this.uploadedUrl.set(url);
    } catch (error) {
      console.error('Failed to upload file:', error);
      alert('שגיאה בהעלאת הקובץ');
      this.selectedFile.set(null);
    } finally {
      this.isUploading.set(false);
    }
  }

  removeFile(): void {
    this.selectedFile.set(null);
    this.uploadedUrl.set(null);
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
  }

  submit(): void {
    if (this.form.invalid || this.locationControl.invalid) {
      this.form.markAllAsTouched();
      this.locationControl.markAsTouched();
      return;
    }
    for (const field of this.departmentFormFields()) {
      const control = this.customControl(field.id);
      if (field.required && !String(control.value || '').trim()) {
        control.markAsTouched();
      }
      if (control.invalid) {
        return;
      }
    }

    const customFields: Record<string, string | number> = {};
    for (const field of this.departmentFormFields()) {
      const control = this.customControl(field.id);
      const value = String(control.value || '').trim();
      if (!value) continue;
      if (field.type === 'input' && field.inputType === 'number') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          customFields[field.id] = parsed;
        }
      } else {
        customFields[field.id] = value;
      }
    }

    const locationValue = (this.locationControl.value || '').trim();
    const phoneValue = (this.phoneControl.value || '').trim();
    this.dialogRef.close({
      title: this.form.controls.title.value.trim(),
      description: this.form.controls.description.value.trim(),
      location: locationValue || null,
      phone: phoneValue || null,
      attachmentUrl: this.uploadedUrl(),
      customFields
    });
  }
}
