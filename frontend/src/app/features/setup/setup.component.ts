import { CommonModule } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { ChatStoreService } from '../../core/services/chat-store.service';
import { InstallGuideDialogComponent } from './install-guide-dialog.component';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule
  ],
  templateUrl: './setup.component.html',
  styleUrl: './setup.component.scss'
})
export class SetupComponent implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly store = inject(ChatStoreService);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  readonly form = this.fb.nonNullable.group({
    phone: ['', [Validators.required, Validators.pattern(/^0\d{9}$/)]]
  });

  readonly submitting = signal(false);
  readonly deferredPrompt = signal<BeforeInstallPromptEvent | null>(null);
  readonly canInstall = computed(() => Boolean(this.deferredPrompt()));

  private readonly onBeforeInstallPromptBound = this.onBeforeInstallPrompt.bind(this);

  constructor() {
    window.addEventListener('beforeinstallprompt', this.onBeforeInstallPromptBound as EventListener);
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeinstallprompt', this.onBeforeInstallPromptBound as EventListener);
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const phone = this.form.controls.phone.value;
    this.submitting.set(true);
    try {
      const normalizedPhone = await this.store.requestUserVerificationCode(phone);
      await this.router.navigate(['/setup/verify'], {
        queryParams: { phone: normalizedPhone }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת קוד אימות נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 4000 });
    } finally {
      this.submitting.set(false);
    }
  }

  async installApp(): Promise<void> {
    const promptEvent = this.deferredPrompt();
    if (!promptEvent) return;

    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } finally {
      this.deferredPrompt.set(null);
    }
  }

  openInstallGuide(): void {
    this.dialog.open(InstallGuideDialogComponent, {
      width: '520px',
      maxWidth: '95vw',
      autoFocus: false
    });
  }

  private onBeforeInstallPrompt(event: Event): void {
    event.preventDefault();
    this.deferredPrompt.set(event as BeforeInstallPromptEvent);
  }
}
