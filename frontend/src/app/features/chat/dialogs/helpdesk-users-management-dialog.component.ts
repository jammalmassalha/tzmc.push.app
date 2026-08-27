import { CommonModule } from '@angular/common';
import { Component, inject, signal, OnInit } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { HelpdeskAdminUser } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ConfirmMessageActionDialogComponent } from './confirm-message-action-dialog.component';

@Component({
  selector: 'app-helpdesk-users-management-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatChipsModule
  ],
  templateUrl: './helpdesk-users-management-dialog.component.html',
  styleUrl: './helpdesk-users-management-dialog.component.scss'
})
export class HelpdeskUsersManagementDialogComponent implements OnInit {
  readonly dialogRef = inject(MatDialogRef<HelpdeskUsersManagementDialogComponent>);
  private readonly api = inject(ChatApiService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly fb = inject(FormBuilder);

  readonly isLoadingUsers = signal(true);
  readonly isLoadingDepts = signal(true);
  readonly isSaving = signal(false);

  readonly users = signal<HelpdeskAdminUser[]>([]);
  readonly departments = signal<{ name: string; icon: string | null }[]>([]);

  readonly editingUserId = signal<number | null>(null);

  readonly ROLES = ['Admin', 'Editor'] as const;
  readonly STATUSES = ['Active', 'Inactive'] as const;

  readonly userForm = this.fb.group({
    username: ['', [Validators.required, Validators.minLength(1), Validators.maxLength(64)]],
    role: ['Editor', Validators.required],
    departments: [[] as string[], Validators.required],
    status: ['Active', Validators.required]
  });

  ngOnInit(): void {
    this.loadUsers();
    this.loadDepartments();
  }

  private async loadUsers(): Promise<void> {
    this.isLoadingUsers.set(true);
    try {
      const users = await this.api.getHelpdeskAdminUsers();
      this.users.set(users);
    } catch {
      this.showError('שגיאה בטעינת המשתמשים');
    } finally {
      this.isLoadingUsers.set(false);
    }
  }

  private async loadDepartments(): Promise<void> {
    this.isLoadingDepts.set(true);
    try {
      const depts = await this.api.getHelpdeskDepartments();
      this.departments.set(
        depts
          .filter((dept) => dept.status === 'active')
          .map((dept) => ({ name: dept.name, icon: dept.icon }))
      );
    } catch {
      try {
        const depts = await this.api.getHelpdeskActiveDepartments();
        this.departments.set(depts);
      } catch {
        this.departments.set([]);
      }
    } finally {
      this.isLoadingDepts.set(false);
    }
  }

  startEdit(user: HelpdeskAdminUser): void {
    this.editingUserId.set(user.id);
    const userDepts = Array.isArray(user.departments) && user.departments.length
      ? user.departments
      : (user.department ? [user.department] : []);
    this.userForm.reset({
      username: user.username,
      role: user.role,
      departments: userDepts,
      status: user.status
    });
  }

  cancelForm(): void {
    this.editingUserId.set(null);
    this.userForm.reset({ username: '', role: 'Editor', departments: [], status: 'Active' });
  }

  async saveUser(): Promise<void> {
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      return;
    }
    const { username, role, departments, status } = this.userForm.getRawValue();
    const id = this.editingUserId();
    this.isSaving.set(true);
    try {
      if (id !== null) {
        await this.api.updateHelpdeskAdminUser(id, { username: username!, role: role!, departments: departments ?? [], status: status! });
        this.showSuccess('המשתמש עודכן בהצלחה');
      } else {
        await this.api.addHelpdeskAdminUser({ username: username!, role: role!, departments: departments ?? [], status: status! });
        this.showSuccess('המשתמש נוסף בהצלחה');
      }
      this.cancelForm();
      await this.loadUsers();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'שגיאה בשמירת המשתמש');
    } finally {
      this.isSaving.set(false);
    }
  }

  async toggleStatus(user: HelpdeskAdminUser): Promise<void> {
    const newStatus: 'Active' | 'Inactive' = user.status === 'Active' ? 'Inactive' : 'Active';
    const confirmLabel = newStatus === 'Inactive' ? 'השבתה' : 'הפעלה';
    const ref = this.dialog.open(ConfirmMessageActionDialogComponent, {
      data: {
        title: `${confirmLabel} משתמש`,
        message: `האם לבצע ${confirmLabel} עבור ${user.username}?`,
        confirmLabel,
        cancelLabel: 'ביטול'
      },
      width: '320px'
    });
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;
    try {
      await this.api.patchHelpdeskAdminUserStatus(user.id, newStatus);
      this.showSuccess(`סטטוס עודכן ל-${newStatus === 'Active' ? 'פעיל' : 'לא פעיל'}`);
      await this.loadUsers();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'שגיאה בעדכון סטטוס');
    }
  }

  async removeUser(user: HelpdeskAdminUser): Promise<void> {
    const ref = this.dialog.open(ConfirmMessageActionDialogComponent, {
      data: {
        title: 'הסרת משתמש',
        message: `האם להסיר את המשתמש ${user.username}?`,
        confirmLabel: 'הסר',
        cancelLabel: 'ביטול'
      },
      width: '320px'
    });
    const confirmed = await firstValueFrom(ref.afterClosed());
    if (!confirmed) return;
    try {
      await this.api.removeHelpdeskAdminUser(user.username);
      this.showSuccess('המשתמש הוסר בהצלחה');
      await this.loadUsers();
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'שגיאה בהסרת המשתמש');
    }
  }

  getUserDepartmentsDisplay(user: HelpdeskAdminUser): string {
    const depts = Array.isArray(user.departments) && user.departments.length
      ? user.departments
      : (user.department ? [user.department] : []);
    return depts.join(' | ');
  }

  roleBadgeClass(role: string): string {
    return role === 'Admin' ? 'role-badge admin' : 'role-badge editor';
  }

  statusBadgeClass(status: string): string {
    return status === 'Active' ? 'status-badge active' : 'status-badge inactive';
  }

  formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return iso;
    }
  }

  private showSuccess(message: string): void {
    this.snackBar.open(message, 'סגור', { duration: 3000, panelClass: ['snack-success'] });
  }

  private showError(message: string): void {
    this.snackBar.open(message, 'סגור', { duration: 5000, panelClass: ['snack-error'] });
  }
}
