const fs = require('fs');
const htmlPath = 'C:/apps/tzmc.push.app/frontend/src/app/features/chat/chat-shell.component.html';
const tsPath = 'C:/apps/tzmc.push.app/frontend/src/app/features/chat/chat-shell.component.ts';

// 1. HTML
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(
    '<div class="message-bubble" [class.deleted]="isMessageDeleted(message)">',
    '<div class="message-bubble" [class.deleted]="isMessageDeleted(message)" (contextmenu)="onMessageContextMenu($event, message)">'
);
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('HTML updated.');

// 2. TS
let ts = fs.readFileSync(tsPath, 'utf8');
const methodCode = `
  onMessageContextMenu(event: MouseEvent | TouchEvent, message: ChatMessage): void {
    if (!this.canReactToMessage(message)) return;
    
    // Attempt to locate the matMenuTrigger attached to the react button.
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const reactBtn = target.querySelector('.message-react-btn') as HTMLElement;
      if (reactBtn) {
        event.preventDefault();
        event.stopPropagation();
        this.setReactionTarget(message);
        reactBtn.click();
      }
    }
  }

  canReactToMessage`;
ts = ts.replace('  canReactToMessage', methodCode);
fs.writeFileSync(tsPath, ts, 'utf8');
console.log('TS updated.');
