const fs = require('fs');
const path = 'C:/apps/tzmc.push.app/frontend/src/app/core/services/chat-store.service.ts';
let content = fs.readFileSync(path, 'utf8');

const newFunc = `  async sendReaction(targetMessageId: string, emoji: string): Promise<void> {
    const currentUser = this.currentUser();
    const activeChatId = this.activeChatId();
    if (!currentUser || !activeChatId) {
      throw new Error('אין צ׳אט פעיל.');
    }

    const normalizedTargetId = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    if (!normalizedTargetId || !normalizedEmoji) {
      return;
    }

    const chatMessages = this.messagesByChat()[activeChatId] ?? [];
    const targetMessage = chatMessages.find((message) => message.messageId === normalizedTargetId) ?? null;
    const group = this.groups().find((item) => item.id === activeChatId) ?? null;
    const fallbackGroup = targetMessage?.groupId
      ? this.groups().find((item) => item.id === this.normalizeChatId(targetMessage.groupId || '')) ?? null
      : null;
    const effectiveGroup = group ?? fallbackGroup;

    const reaction: MessageReaction = {
      emoji: normalizedEmoji,
      reactor: currentUser,
      reactorName: this.getDisplayName(currentUser)
    };

    const fallbackGroupId = this.normalizeChatId(activeChatId);
    if (!fallbackGroupId) {
      throw new Error('יעד לא נמצא.');
    }
    this.applyReactionToMessage(fallbackGroupId, normalizedTargetId, reaction);

    if (!this.networkOnline()) {
      this.lastError.set('לא ניתן לשלוח תגובה ללא חיבור.');
      throw new Error('Offline');
    }

    const activeChat = this.activeChat();
    let payload: ReactionPayload;

    if (effectiveGroup) {
      payload = {
        groupId: effectiveGroup.id,
        groupName: effectiveGroup.name || activeChat?.title || effectiveGroup.id,
        groupMembers: effectiveGroup.members ?? [],
        groupCreatedBy: effectiveGroup.createdBy || '',
        groupAdmins: effectiveGroup.admins ?? [],
        groupUpdatedAt: effectiveGroup.updatedAt || Date.now(),
        groupType: effectiveGroup.type === 'group' ? 'group' : 'community',
        targetMessageId: normalizedTargetId,
        emoji: normalizedEmoji,
        reactor: currentUser,
        reactorName: reaction.reactorName || currentUser
      };
    } else {
      payload = {
        targetUser: fallbackGroupId,
        targetMessageId: normalizedTargetId,
        emoji: normalizedEmoji,
        reactor: currentUser,
        reactorName: reaction.reactorName || currentUser
      };
    }
    
    await this.sendReactionTransport(payload);
  }

  clearIncomingReactionNotice(): void {`;

const startIdx = content.indexOf('  async sendReaction(targetMessageId: string, emoji: string): Promise<void> {');
const endIdx = content.indexOf('  clearIncomingReactionNotice(): void {', startIdx);

if (startIdx !== -1 && endIdx !== -1) {
    content = content.substring(0, startIdx) + newFunc + content.substring(endIdx + '  clearIncomingReactionNotice(): void {'.length);
    fs.writeFileSync(path, content, 'utf8');
    console.log('patched chat-store.service.ts!');
} else {
    console.log('indices not found', startIdx, endIdx);
}
