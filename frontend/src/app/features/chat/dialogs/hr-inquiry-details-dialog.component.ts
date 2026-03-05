import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ChatMessage } from '../../../core/models/chat.models';

type HrInquiryDialogRenderPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; url: string; label: string }
  | { kind: 'location'; url: string; label: string }
  | { kind: 'image'; url: string };

export interface HrInquiryDetailsDialogData {
  title: string;
  status: 'active' | 'closed';
  openedAt: number;
  messages: ChatMessage[];
  canContinueWrite?: boolean;
}

export type HrInquiryDetailsDialogResult = 'close' | 'continue-write' | null;

@Component({
  selector: 'app-hr-inquiry-details-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule],
  templateUrl: './hr-inquiry-details-dialog.component.html',
  styleUrl: './hr-inquiry-details-dialog.component.scss'
})
export class HrInquiryDetailsDialogComponent {
  readonly data = inject<HrInquiryDetailsDialogData>(MAT_DIALOG_DATA);
  readonly dialogRef = inject(MatDialogRef<HrInquiryDetailsDialogComponent, HrInquiryDetailsDialogResult>);

  formatTime(timestamp: number): string {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('he-IL', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  formatDateTime(timestamp: number): string {
    if (!timestamp) return '';
    return new Intl.DateTimeFormat('he-IL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  statusLabel(): string {
    return this.data.status === 'closed' ? 'סגורה' : 'פעילה';
  }

  senderLabel(message: ChatMessage): string {
    if (message.direction === 'outgoing') return 'אני';
    return String(message.senderDisplayName || message.sender || 'משאבי אנוש').trim();
  }

  isClosed(): boolean {
    return this.data.status === 'closed';
  }

  closeInquiry(): void {
    this.dialogRef.close('close');
  }

  continueWrite(): void {
    this.dialogRef.close('continue-write');
  }

  openUrl(url: string): void {
    const normalized = String(url || '').trim();
    if (!normalized) return;
    window.open(normalized, '_blank', 'noopener,noreferrer');
  }

  messageParts(message: ChatMessage): HrInquiryDialogRenderPart[] {
    const body = String(message.body || '');
    if (!body.trim()) {
      return [];
    }

    const urlRegex = /(https?:\/\/[^\s<>"']+|\/?notify\/uploads\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
    const parts: HrInquiryDialogRenderPart[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(body)) !== null) {
      const start = match.index;
      const raw = match[0];
      if (start > lastIndex) {
        parts.push({ kind: 'text', text: body.slice(lastIndex, start) });
      }
      const { cleanUrl, trailingText } = this.stripTrailingPunctuation(raw);
      const url = this.normalizeMessageUrl(cleanUrl);
      if (this.isImageUrl(url)) {
        parts.push({ kind: 'image', url });
      } else if (this.isLocationUrl(url)) {
        parts.push({ kind: 'location', url, label: 'פתח מיקום' });
      } else {
        parts.push({ kind: 'link', url, label: 'פתח קובץ/קישור' });
      }
      if (trailingText) {
        parts.push({ kind: 'text', text: trailingText });
      }
      lastIndex = start + raw.length;
    }
    if (lastIndex < body.length) {
      parts.push({ kind: 'text', text: body.slice(lastIndex) });
    }
    return parts.length ? parts : [{ kind: 'text', text: body }];
  }

  private normalizeMessageUrl(url: string): string {
    const value = String(url || '').trim();
    if (!value) return '';
    let normalized = value;
    if (/^www\./i.test(normalized)) {
      normalized = `https://${normalized}`;
    } else if (/^\/?notify\/uploads\//i.test(normalized)) {
      normalized = normalized.startsWith('/') ? normalized : `/${normalized}`;
    }
    normalized = normalized.replace(
      /(\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|rar|7z|jpeg|jpg|png|gif|webp))\/(?=$|[?#])/i,
      '$1'
    );
    return normalized;
  }

  private stripTrailingPunctuation(url: string): { cleanUrl: string; trailingText: string } {
    let cleanUrl = String(url || '');
    let trailingText = '';
    while (/[),.!?;:]$/.test(cleanUrl)) {
      trailingText = `${cleanUrl.slice(-1)}${trailingText}`;
      cleanUrl = cleanUrl.slice(0, -1);
    }
    return { cleanUrl, trailingText };
  }

  private isImageUrl(url: string): boolean {
    return /\.(jpeg|jpg|png|gif|webp)(\?|$)/i.test(url);
  }

  private isLocationUrl(url: string): boolean {
    const lower = String(url || '').toLowerCase();
    return lower.includes('maps.google.com') || lower.includes('google.com/maps') || lower.includes('maps.app.goo.gl');
  }
}
