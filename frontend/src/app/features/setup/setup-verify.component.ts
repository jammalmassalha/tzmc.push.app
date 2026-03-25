import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { ChatStoreService } from '../../core/services/chat-store.service';
import { InstallGuideDialogComponent } from './install-guide-dialog.component';

@Component({
  selector: 'app-setup-verify',
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
  templateUrl: './setup-verify.component.html',
  styleUrl: './setup-verify.component.scss'
})
export class SetupVerifyComponent implements OnInit, OnDestroy {
  private static readonly RESEND_COOLDOWN_SECONDS = 120;
  private readonly fb = inject(FormBuilder);
  private readonly store = inject(ChatStoreService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);

  readonly form = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });

  readonly phone = signal('');
  readonly submitting = signal(false);
  readonly resending = signal(false);
  readonly resendCooldownSeconds = signal(0);
  readonly verificationCompleted = signal(false);
  readonly requiresInstallBeforeVerify = computed(() => this.store.requiresHomeScreenInstallForPush());
  readonly maskedPhone = computed(() => this.maskPhone(this.phone()));
  readonly canResendCode = computed(() => !this.resending() && this.resendCooldownSeconds() <= 0);
  readonly resendCodeButtonLabel = computed(() => {
    const remaining = this.resendCooldownSeconds();
    if (remaining > 0) {
      return `שלח קוד שוב (${remaining}s)`;
    }
    return 'שלח קוד שוב';
  });
  private resendCooldownIntervalId: number | null = null;

  ngOnInit(): void {
    const phoneFromQuery = String(this.route.snapshot.queryParamMap.get('phone') || '').trim();
    const normalized = this.normalizePhone(phoneFromQuery);
    if (!normalized) {
      void this.router.navigate(['/setup']);
      return;
    }
    this.phone.set(normalized);
    this.startResendCooldown();
  }

  ngOnDestroy(): void {
    this.clearResendCooldownTimer();
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const phone = this.phone();
    if (!phone) {
      await this.router.navigate(['/setup']);
      return;
    }

    if (!this.verificationCompleted() && this.requiresInstallBeforeVerify()) {
      this.openInstallGuide();
      this.snackBar.open(
        'לפני האימות חובה להתקין את האפליקציה למסך הבית כדי לאפשר רישום Push תקין.',
        'סגור',
        { duration: 5200 }
      );
      return;
    }

    this.submitting.set(true);
    try {
      if (!this.verificationCompleted()) {
        await this.store.verifyUserVerificationCode(phone, this.form.controls.code.value);
        this.verificationCompleted.set(true);
      }
      
      // FIX: Wrap push registration in its own try-catch so it doesn't block login!
      try {
        await this.store.ensurePushRegistrationReadyForCurrentUser({ promptIfNeeded: true });
      } catch (pushError) {
        console.warn('Push registration failed or unsupported, continuing to app:', pushError);
        const msg = pushError instanceof Error ? pushError.message : '';
        if (msg) {
          // Optional: let the user know notifications won't work, but still let them in
          this.snackBar.open(`${msg} (ממשיך לאפליקציה ללא התראות)`, 'סגור', { duration: 3500 });
        }
      }
      
      // Proceed to the app regardless of whether push registration succeeded
      await this.router.navigate(['/chats']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'אימות הקוד נכשל';
      this.snackBar.open(message, 'סגור', { duration: 4000 });
    } finally {
      this.submitting.set(false);
    }
  }

  async resendCode(): Promise<void> {
    const phone = this.phone();
    if (!phone || !this.canResendCode()) return;

    this.resending.set(true);
    try {
      await this.store.requestUserVerificationCode(phone);
      this.snackBar.open('קוד אימות נשלח שוב.', 'סגור', { duration: 2800 });
      this.startResendCooldown();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת קוד אימות נכשלה';
      this.snackBar.open(message, 'סגור', { duration: 4000 });
    } finally {
      this.resending.set(false);
    }
  }

  async backToSetup(): Promise<void> {
    await this.router.navigate(['/setup']);
  }

  openInstallGuide(): void {
    this.dialog.open(InstallGuideDialogComponent, {
      width: '520px',
      maxWidth: '95vw',
      autoFocus: false
    });
  }

  private normalizePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    return /^0\d{9}$/.test(digits) ? digits : '';
  }

  private maskPhone(value: string): string {
    const normalized = this.normalizePhone(value);
    if (!normalized) return '';
    return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`;
  }

  private startResendCooldown(): void {
    this.clearResendCooldownTimer();
    this.resendCooldownSeconds.set(SetupVerifyComponent.RESEND_COOLDOWN_SECONDS);
    this.resendCooldownIntervalId = window.setInterval(() => {
      const next = this.resendCooldownSeconds() - 1;
      if (next <= 0) {
        this.resendCooldownSeconds.set(0);
        this.clearResendCooldownTimer();
        return;
      }
      this.resendCooldownSeconds.set(next);
    }, 1000);
  }

  private clearResendCooldownTimer(): void {
    if (this.resendCooldownIntervalId !== null) {
      window.clearInterval(this.resendCooldownIntervalId);
      this.resendCooldownIntervalId = null;
    }
  }
}
