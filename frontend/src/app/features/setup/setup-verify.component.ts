import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { ChatStoreService } from '../../core/services/chat-store.service';

@Component({
  selector: 'app-setup-verify',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
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
export class SetupVerifyComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly store = inject(ChatStoreService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);

  readonly form = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });

  readonly phone = signal('');
  readonly submitting = signal(false);
  readonly resending = signal(false);
  readonly maskedPhone = computed(() => this.maskPhone(this.phone()));

  ngOnInit(): void {
    const phoneFromQuery = String(this.route.snapshot.queryParamMap.get('phone') || '').trim();
    const normalized = this.normalizePhone(phoneFromQuery);
    if (!normalized) {
      void this.router.navigate(['/setup']);
      return;
    }
    this.phone.set(normalized);
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

    this.submitting.set(true);
    try {
      await this.store.verifyUserVerificationCode(phone, this.form.controls.code.value);
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
    if (!phone || this.resending()) return;

    this.resending.set(true);
    try {
      await this.store.requestUserVerificationCode(phone);
      this.snackBar.open('קוד אימות נשלח שוב.', 'סגור', { duration: 2800 });
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

  private normalizePhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    return /^0\d{9}$/.test(digits) ? digits : '';
  }

  private maskPhone(value: string): string {
    const normalized = this.normalizePhone(value);
    if (!normalized) return '';
    return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`;
  }
}
