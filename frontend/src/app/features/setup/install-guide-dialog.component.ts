import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

type InstallPlatform = 'android' | 'ios';

@Component({
  selector: 'app-install-guide-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  templateUrl: './install-guide-dialog.component.html',
  styleUrl: './install-guide-dialog.component.scss'
})
export class InstallGuideDialogComponent {
  readonly selectedPlatform = signal<InstallPlatform>('android');
  private readonly dialogRef = inject(MatDialogRef<InstallGuideDialogComponent>);

  selectPlatform(platform: InstallPlatform): void {
    this.selectedPlatform.set(platform);
  }

  close(): void {
    this.dialogRef.close();
  }
}
