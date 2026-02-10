// --- ERROR HANDLING & SAFETY ---
setTimeout(() => {
    const loader = document.getElementById('loading');
    if (loader && !loader.classList.contains('hidden')) {
        console.warn("Forcing loader hide due to timeout.");
        loader.classList.add('hidden');
        if(!localStorage.getItem('username')) {
            document.getElementById('viewSetup').classList.remove('hidden');
        }
    }
}, 3000);

// --- HELPER: DETECT DEVICE TYPE ---
function getDeviceType() {
    const ua = navigator.userAgent;
    if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
        return "Mobile";
    }
    return "PC";
}

window.onerror = function(msg, url, line) {
    console.error("Global Error:", msg);
};

const config = window.APP_CONFIG || {};
const t = (key, vars) => (window.I18N && typeof window.I18N.t === 'function' ? window.I18N.t(key, vars) : key);
const fetchWithRetry = window.fetchWithRetry ? window.fetchWithRetry : fetch;

function updateAppHeight() {
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
}

updateAppHeight();
window.addEventListener('resize', updateAppHeight);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateAppHeight);
}

function updateFooterOffset() {
    const footer = document.querySelector('.chat-footer');
    if (!footer) return;
    const height = footer.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--chat-footer-height', `${height}px`);
}

function updateHeaderOffset() {
    const headers = Array.from(document.querySelectorAll('.app-header'));
    if (!headers.length) return;
    let maxHeight = 0;
    headers.forEach((header) => {
        const rect = header.getBoundingClientRect();
        if (rect.height > maxHeight) {
            maxHeight = rect.height;
        }
    });
    if (maxHeight > 0) {
        document.documentElement.style.setProperty('--app-header-height', `${maxHeight}px`);
    }
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
if (isIOS) {
    document.body.classList.add('ios');
}

updateFooterOffset();
updateHeaderOffset();
window.addEventListener('resize', updateFooterOffset);
window.addEventListener('resize', updateHeaderOffset);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateFooterOffset);
    window.visualViewport.addEventListener('resize', updateHeaderOffset);
}

let userMap = {};        // Fast lookup { "36826717": "Jamal Massalha" }
let selectedMessageId = null; // Store ID of message being deleted
let selectedMessageData = null; // Store the full message object
// --- CONFIG ---
const DB_NAME = config.DB_NAME || 'PushNotificationsDB';
const STORE_NAME = config.STORE_NAME || 'history';
const OUTBOX_STORE = config.OUTBOX_STORE || 'outbox';
const DB_VERSION = config.DB_VERSION || 3;
const VAPID_PUBLIC_KEY = config.VAPID_PUBLIC_KEY || 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk';
const SUBSCRIPTION_URL = config.SUBSCRIPTION_URL || 'https://script.google.com/macros/s/AKfycbw70tnIlHsQTke8BxFhEbEQQJxMhKzN85cCTkJOuS_L7zUnCxNYLX-r2cxYU2j8jIn5/exec';
const NOTIFY_SERVER_URL = config.NOTIFY_SERVER_URL || 'https://www.tzmc.co.il/notify/reply';
const UPLOAD_SERVER_URL = config.UPLOAD_SERVER_URL || 'https://www.tzmc.co.il/notify/upload';
const GROUP_UPDATE_URL = config.GROUP_UPDATE_URL || 'https://www.tzmc.co.il/notify/group-update';
const GROUPS_URL = config.GROUPS_URL || 'https://www.tzmc.co.il/notify/groups';
const REACTION_URL = config.REACTION_URL || 'https://www.tzmc.co.il/notify/reaction';
const VERSION_CHECK_URL = config.VERSION_CHECK_URL || 'https://www.tzmc.co.il/notify/version';
const VERIFY_STATUS_URL = config.VERIFY_STATUS_URL || 'https://www.tzmc.co.il/notify/verify-status';
const LOG_SERVER_URL = config.LOG_SERVER_URL || 'https://www.tzmc.co.il/notify/log';

// --- STATE ---
let currentUserContext = null; 
let activeChatSender = null;
let allHistoryData = [];
let cachedUserList = [];
let cachedGroups = [];
let groupMap = {};
const GROUPS_STORAGE_KEY = 'cachedGroups';
const GROUP_ID_PREFIX = 'group:';
const HR_CHAT_FALLBACK_NAME = t('hr_chat_name');
let activeGroupEditId = null;
let activeGroupSelection = new Set();
let activeReactionMessage = null;
let activeReactionMessageId = null;
const REACTION_EMOJIS = [
    String.fromCodePoint(0x1F44D), // thumbs up
    String.fromCodePoint(0x2764, 0xFE0F), // red heart
    String.fromCodePoint(0x1F602), // face with tears of joy
    String.fromCodePoint(0x1F62E), // face with open mouth
    String.fromCodePoint(0x1F622), // crying face
    String.fromCodePoint(0x1F64F), // folded hands
    String.fromCodePoint(0x1F389) // party popper
];
let deferredPrompt;
let justOpenedChat = false; 
let shouldAutoScroll = true;
let lastContactsFetch = 0;
const CONTACTS_TTL_MS = 5 * 60 * 1000;
let lastGroupsFetch = 0;
const GROUPS_TTL_MS = 2 * 60 * 1000;
let renderSequence = 0;

// --- DOM ---
const loadingDiv = document.getElementById('loading');
const viewSetup = document.getElementById('viewSetup');
const viewContacts = document.getElementById('viewContacts');
const viewChatRoom = document.getElementById('viewChatRoom');
const usernameInput = document.getElementById('usernameInput');
const installBtn = document.getElementById('installBtn');
const modalNewChat = document.getElementById('modalNewChat');
const modalUserList = document.getElementById('modalUserList');
const userSearchInput = document.getElementById('userSearchInput');
const btnNewChat = document.getElementById('btnNewChat');
const mainMenuToggleBtn = document.getElementById('mainMenuToggleBtn');
const backupChatsBtn = document.getElementById('backupChatsBtn');
const createGroupBtn = document.getElementById('createGroupBtn');
const clearChatsBtn = document.getElementById('clearChatsBtn');
const logoutBtn = document.getElementById('logoutBtn');
const closeNewChatBtn = document.getElementById('closeNewChatBtn');
const backToContactsBtn = document.getElementById('backToContactsBtn');
const deleteChatBtn = document.getElementById('deleteChatBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const shareLocationBtn = document.getElementById('shareLocationBtn');
const toggleAttachBtn = document.getElementById('toggleAttachBtn');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const btnDeleteEveryone = document.getElementById('btnDeleteEveryone');
const btnDeleteMe = document.getElementById('btnDeleteMe');
const btnDeleteClose = document.getElementById('btnDeleteClose');
const confirmModal = document.getElementById('confirmModal');
const confirmModalMessage = document.getElementById('confirmModalMessage');
const confirmModalConfirm = document.getElementById('confirmModalConfirm');
const confirmModalCancel = document.getElementById('confirmModalCancel');
const groupMembersTrigger = document.getElementById('groupMembersTrigger');
const groupMembersModal = document.getElementById('groupMembersModal');
const groupMembersList = document.getElementById('groupMembersList');
const groupMembersMeta = document.getElementById('groupMembersMeta');
const closeGroupMembersBtn = document.getElementById('closeGroupMembersBtn');
const reactionModal = document.getElementById('reactionModal');
const reactionList = document.getElementById('reactionList');
const closeReactionBtn = document.getElementById('closeReactionBtn');
const reactionDetailModal = document.getElementById('reactionDetailModal');
const reactionDetailList = document.getElementById('reactionDetailList');
const closeReactionDetailBtn = document.getElementById('closeReactionDetailBtn');
const modalCreateGroup = document.getElementById('modalCreateGroup');
const closeCreateGroupBtn = document.getElementById('closeCreateGroupBtn');
const createGroupCancelBtn = document.getElementById('createGroupCancelBtn');
const createGroupSaveBtn = document.getElementById('createGroupSaveBtn');
const groupNameInput = document.getElementById('groupNameInput');
const groupSearchInput = document.getElementById('groupSearchInput');
const groupTypeInput = document.getElementById('groupTypeInput');
const groupTypeHint = document.getElementById('groupTypeHint');
const groupTypeLabel = document.getElementById('groupTypeLabel');
const groupUserList = document.getElementById('groupUserList');
const releaseNotesModal = document.getElementById('releaseNotesModal');
const releaseNotesTitle = document.getElementById('releaseNotesTitle');
const releaseNotesList = document.getElementById('releaseNotesList');
const releaseNotesVersion = document.getElementById('releaseNotesVersion');
const releaseNotesCloseBtn = document.getElementById('releaseNotesCloseBtn');
const releaseNotesReloadBtn = document.getElementById('releaseNotesReloadBtn');
const releaseNotesLaterBtn = document.getElementById('releaseNotesLaterBtn');
const toastContainer = document.getElementById('toastContainer');
const networkStatus = document.getElementById('networkStatus');
const networkStatusChat = document.getElementById('networkStatusChat');

if (mainMenuToggleBtn) mainMenuToggleBtn.addEventListener('click', toggleMainMenu);
if (backupChatsBtn) backupChatsBtn.addEventListener('click', () => { backupChats(); toggleMainMenu(); });
if (createGroupBtn) createGroupBtn.addEventListener('click', () => { openCreateGroupModal(); toggleMainMenu(); });
if (clearChatsBtn) clearChatsBtn.addEventListener('click', () => { clearAllChats(); toggleMainMenu(); });
if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);
if (btnNewChat) btnNewChat.addEventListener('click', openNewChatModal);
if (closeNewChatBtn) closeNewChatBtn.addEventListener('click', closeNewChatModal);
if (backToContactsBtn) backToContactsBtn.addEventListener('click', showContacts);
if (deleteChatBtn) deleteChatBtn.addEventListener('click', deleteCurrentChat);
if (attachFileBtn) attachFileBtn.addEventListener('click', () => { toggleAttachMenu(); if (fileInput) fileInput.click(); });
if (shareLocationBtn) shareLocationBtn.addEventListener('click', () => { shareLocation(); toggleAttachMenu(); });
if (toggleAttachBtn) toggleAttachBtn.addEventListener('click', toggleAttachMenu);
if (sendBtn) sendBtn.addEventListener('click', () => sendMessage());
if (fileInput) fileInput.addEventListener('change', () => handleFileUpload(fileInput));
if (btnDeleteEveryone) btnDeleteEveryone.addEventListener('click', () => confirmDelete('everyone'));
if (btnDeleteMe) btnDeleteMe.addEventListener('click', () => confirmDelete('me'));
if (btnDeleteClose) btnDeleteClose.addEventListener('click', closeDeleteModal);
if (groupMembersTrigger) groupMembersTrigger.addEventListener('click', openGroupMembersModal);
if (closeGroupMembersBtn) closeGroupMembersBtn.addEventListener('click', closeGroupMembersModal);
if (closeReactionBtn) closeReactionBtn.addEventListener('click', closeReactionModal);
if (closeReactionDetailBtn) closeReactionDetailBtn.addEventListener('click', closeReactionDetailModal);
if (closeCreateGroupBtn) closeCreateGroupBtn.addEventListener('click', closeCreateGroupModal);
if (createGroupCancelBtn) createGroupCancelBtn.addEventListener('click', closeCreateGroupModal);
if (createGroupSaveBtn) createGroupSaveBtn.addEventListener('click', saveGroupFromModal);
if (releaseNotesCloseBtn) releaseNotesCloseBtn.addEventListener('click', closeReleaseNotesModal);
if (releaseNotesLaterBtn) releaseNotesLaterBtn.addEventListener('click', closeReleaseNotesModal);
if (releaseNotesReloadBtn) releaseNotesReloadBtn.addEventListener('click', () => {
    closeReleaseNotesModal();
    handleReloadNow('release-notes');
});

// --- HELPER: GET DISPLAY NAME ---
function getDisplayName(username) {
    if (!username) return 'Unknown';
    const group = getGroupById(username);
    if (group && group.name) return group.name;
    if (username === 'Bot' || username === 'Support' || username === 'System') return username;
    const key = String(username).toLowerCase();
    return userMap[key] || username;
}

function isHrChatName(senderName) {
    if (window.HR_CHAT && typeof window.HR_CHAT.isHrChat === 'function') {
        return window.HR_CHAT.isHrChat(senderName);
    }
    return normalizeGroupValue(senderName) === normalizeGroupValue(HR_CHAT_FALLBACK_NAME);
}

function getPinnedChatEntries() {
    if (window.HR_CHAT && typeof window.HR_CHAT.getPinnedChat === 'function') {
        const entry = window.HR_CHAT.getPinnedChat();
        return entry && entry.name ? [entry] : [];
    }
    return [{ name: HR_CHAT_FALLBACK_NAME, pinned: true, isGroup: false }];
}

function isSystemSenderName(senderName) {
    const systemUsers = ['Bot', 'Support', 'System', 'Setup_User'];
    if (isHrChatName(senderName)) return true;
    return systemUsers.includes(senderName);
}

function repairEncoding(text) {
    if (!text) return '';
    const value = String(text);
    const hasReplacement = value.includes('\ufffd') || value.includes('ï¿½');
    const hasMojibake = /Ã.|Â.|â€|â€™|â€œ|â€/.test(value);
    if (!hasReplacement && !hasMojibake) {
        return value;
    }
    try {
        const decoded = decodeURIComponent(escape(value));
        return decoded.replace(/ï¿½/g, '').replace(/\ufffd/g, '');
    } catch (err) {
        return value.replace(/ï¿½/g, '').replace(/\ufffd/g, '');
    }
}

function sanitizePreviewText(text) {
    if (!text) return '';
    const temp = document.createElement('div');
    temp.innerHTML = repairEncoding(text);
    let preview = (temp.textContent || temp.innerText || '').trim();
    preview = preview.replace(/\u0000/g, '').replace(/\ufffd/g, '').replace(/ï¿½/g, '');
    preview = preview.replace(/\s+/g, ' ').trim();
    if (!preview) {
        const fallback = repairEncoding(String(text)).replace(/[\u0000-\u001f\u007f]/g, '').replace(/ï¿½/g, '').replace(/\ufffd/g, '').trim();
        preview = fallback;
    }
    return preview;
}

// --- HELPER: TEXTAREA AUTO RESIZE ---
function autoResize(textarea) {
    textarea.style.height = 'auto'; // Reset height
    const maxHeight = 85; // Approx 3 lines
    
    if (textarea.scrollHeight <= maxHeight) {
        textarea.style.height = textarea.scrollHeight + 'px';
        textarea.style.overflowY = 'hidden';
    } else {
        textarea.style.height = maxHeight + 'px';
        textarea.style.overflowY = 'auto';
    }
}

function generateMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getMessageDomId(message) {
    const key = message.messageId || message.clientMessageId || message.timestamp;
    return `msg-${key}`;
}

function setStatusMessage(text, type = 'info') {
    const status = document.getElementById('statusMessage');
    if (!status) return;
    status.textContent = text;
    status.dataset.type = type;
    status.style.color = type === 'error' ? '#d32f2f' : '#54656f';
}

function normalizePhoneInput(value) {
    if (!value) return '';
    return value.replace(/\D/g, '');
}

function isValidPhoneNumber(value) {
    const digits = value.replace(/\D/g, '');
    return digits.length === 10 && digits.startsWith('05');
}

function validateUsernameInput(showEmptyMessage = false) {
    const rawValue = usernameInput ? usernameInput.value : '';
    if (!rawValue) {
        if (showEmptyMessage) {
            setStatusMessage(t('status_empty_input'), 'error');
        } else {
            setStatusMessage('');
        }
        return false;
    }
    const normalized = normalizePhoneInput(rawValue);
    if (!showEmptyMessage && normalized.length < 10) {
        if (usernameInput) usernameInput.value = normalized;
        setStatusMessage('');
        return false;
    }
    if (!isValidPhoneNumber(normalized)) {
        setStatusMessage(t('status_invalid_phone'), 'error');
        return false;
    }
    if (usernameInput) usernameInput.value = normalized;
    setStatusMessage('');
    return true;
}

function showToast(message, type = 'info', duration = 3000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

let updateToastEl = null;

function clearUpdateToast() {
    if (updateToastEl) {
        updateToastEl.remove();
        updateToastEl = null;
    }
}

function showUpdateToast(versionLabel = '') {
    if (!toastContainer || updateToastEl) return;
    const label = versionLabel ? `(${versionLabel})` : '';
    const message = t('update_available', { version: label }).trim();
    const toast = document.createElement('div');
    toast.className = 'toast toast--update';
    const content = document.createElement('div');
    content.className = 'toast__content';
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = 'system_update';
    const text = document.createElement('span');
    text.textContent = message;
    content.appendChild(icon);
    content.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'toast__actions';
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'toast__btn toast__btn-primary';
    reloadBtn.type = 'button';
    reloadBtn.textContent = t('update_reload_now');
    reloadBtn.addEventListener('click', () => handleReloadNow('toast'));
    const laterBtn = document.createElement('button');
    laterBtn.className = 'toast__btn';
    laterBtn.type = 'button';
    laterBtn.textContent = t('update_later');
    laterBtn.addEventListener('click', clearUpdateToast);
    actions.appendChild(reloadBtn);
    actions.appendChild(laterBtn);

    toast.appendChild(content);
    toast.appendChild(actions);
    toastContainer.appendChild(toast);
    updateToastEl = toast;
}

function openModal(modal) {
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    trapFocus(modal);
}

function closeModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    releaseFocus(modal);
}

function closeReleaseNotesModal() {
    closeModal(releaseNotesModal);
}

function normalizeReleaseNotes(notes) {
    if (!notes) return [];
    if (Array.isArray(notes)) return notes.filter(Boolean);
    if (typeof notes === 'string') {
        return notes.split('\n').map(item => item.trim()).filter(Boolean);
    }
    if (typeof notes === 'object' && Array.isArray(notes.items)) {
        return notes.items.filter(Boolean);
    }
    return [];
}

function showReleaseNotesModal(version, notes = []) {
    if (!releaseNotesModal || !releaseNotesList) return;
    const noteItems = normalizeReleaseNotes(notes);
    const finalNotes = noteItems.length ? noteItems : [t('release_notes_default')];
    if (releaseNotesTitle) {
        releaseNotesTitle.textContent = t('release_notes_title');
    }
    if (releaseNotesVersion) {
        releaseNotesVersion.textContent = version ? t('release_notes_version', { version }) : '';
    }
    if (releaseNotesReloadBtn) {
        releaseNotesReloadBtn.textContent = t('update_reload_now');
    }
    if (releaseNotesLaterBtn) {
        releaseNotesLaterBtn.textContent = t('update_later');
    }
    releaseNotesList.innerHTML = '';
    finalNotes.forEach(note => {
        const li = document.createElement('li');
        li.textContent = note;
        releaseNotesList.appendChild(li);
    });
    openModal(releaseNotesModal);
}

function trapFocus(modal) {
    const focusableSelectors = 'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])';
    const focusableElements = Array.from(modal.querySelectorAll(focusableSelectors))
        .filter(el => !el.hasAttribute('disabled'));
    if (focusableElements.length === 0) return;

    const firstEl = focusableElements[0];
    const lastEl = focusableElements[focusableElements.length - 1];
    const handleKeydown = (event) => {
        if (event.key === 'Escape') {
            if (modal === modalNewChat) closeNewChatModal();
            if (modal === modalCreateGroup) closeCreateGroupModal();
            if (modal === groupMembersModal) closeGroupMembersModal();
            if (modal === reactionModal) closeReactionModal();
            if (modal === document.getElementById('deleteModal')) closeDeleteModal();
            if (modal === confirmModal) closeModal(confirmModal);
        }
        if (event.key !== 'Tab') return;
        if (event.shiftKey && document.activeElement === firstEl) {
            event.preventDefault();
            lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
            event.preventDefault();
            firstEl.focus();
        }
    };
    modal._focusHandler = handleKeydown;
    modal.addEventListener('keydown', handleKeydown);
    setTimeout(() => firstEl.focus(), 0);
}

function releaseFocus(modal) {
    if (modal && modal._focusHandler) {
        modal.removeEventListener('keydown', modal._focusHandler);
        delete modal._focusHandler;
    }
}

function showConfirm(message) {
    return new Promise((resolve) => {
        if (!confirmModal || !confirmModalConfirm || !confirmModalCancel || !confirmModalMessage) {
            resolve(false);
            return;
        }
        confirmModalMessage.textContent = message;
        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        const onCancel = () => {
            cleanup();
            resolve(false);
        };
        const cleanup = () => {
            confirmModalConfirm.removeEventListener('click', onConfirm);
            confirmModalCancel.removeEventListener('click', onCancel);
            closeModal(confirmModal);
        };
        confirmModalConfirm.addEventListener('click', onConfirm);
        confirmModalCancel.addEventListener('click', onCancel);
        openModal(confirmModal);
    });
}

function debounce(fn, delay = 200) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function renderListInBatches(items, container, renderItem, batchSize = 30, onComplete, renderToken) {
    if (!container) return;
    const token = renderToken || String(++renderSequence);
    container.dataset.renderToken = token;
    container.innerHTML = '';
    let index = 0;
    const renderBatch = () => {
        if (container.dataset.renderToken !== token) {
            return;
        }
        const fragment = document.createDocumentFragment();
        const end = Math.min(index + batchSize, items.length);
        for (; index < end; index++) {
            fragment.appendChild(renderItem(items[index]));
        }
        container.appendChild(fragment);
        if (index < items.length) {
            requestAnimationFrame(renderBatch);
        } else if (typeof onComplete === 'function') {
            onComplete();
        }
    };
    requestAnimationFrame(renderBatch);
}

function shouldIncludeRecord(record) {
    if (!record) return false;
    if (!currentUserContext) {
        if (record.user) {
            currentUserContext = record.user;
            localStorage.setItem('username', record.user);
        } else if (record.url) {
            const match = record.url.match(/[?&]user=([^&]+)/);
            if (match && match[1]) {
                currentUserContext = decodeURIComponent(match[1]);
                localStorage.setItem('username', currentUserContext);
            }
        }
    }
    if (!currentUserContext) return false;
    const currentLower = String(currentUserContext).toLowerCase();
    const recordUser = record.user ? String(record.user).toLowerCase() : '';
    if (recordUser && recordUser === currentLower) return true;
    if (record.url) {
        return record.url.toLowerCase().includes(`user=${encodeURIComponent(currentLower)}`);
    }
    return false;
}

function upsertMessageInMemory(record) {
    if (!record) return false;
    const messageId = record.messageId || record.clientMessageId;
    let index = -1;
    if (messageId) {
        index = allHistoryData.findIndex(m => m.messageId === messageId || m.clientMessageId === messageId);
    }
    if (index < 0) {
        const senderKey = String(record.sender || '').trim().toLowerCase();
        index = allHistoryData.findIndex(m =>
            String(m.sender || '').trim().toLowerCase() === senderKey &&
            m.timestamp === record.timestamp &&
            (m.body || '') === (record.body || '') &&
            (m.reply || '') === (record.reply || '')
        );
    }
    if (index >= 0) {
        allHistoryData[index] = { ...allHistoryData[index], ...record };
        return true;
    }
    allHistoryData.push(record);
    return true;
}

function applyReadReceiptUpdate(messageIds, readAt) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    const appliedAt = readAt || Date.now();
    let updated = false;
    messageIds.forEach((messageId) => {
        if (!messageId) return;
        const message = allHistoryData.find(m => m.messageId === messageId || m.clientMessageId === messageId);
        if (message && !message.readAt) {
            message.readAt = appliedAt;
            updated = true;
        }
    });
    if (!updated) return;
    if (typeof renderChatMessages === 'function' && !viewChatRoom.classList.contains('hidden')) {
        renderChatMessages();
    }
}

function formatContactTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((startOfToday - startOfDate) / (24 * 60 * 60 * 1000));

    if (diffDays <= 0) {
        return date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
    }
    if (diffDays === 1) {
        return t('date_yesterday');
    }
    if (diffDays === 2) {
        return t('date_two_days_ago');
    }
    return date.toLocaleDateString('he-IL');
}

function updateNetworkStatus() {
    const isOnline = navigator.onLine;
    const statusText = isOnline ? t('network_online') : t('network_offline');
    [networkStatus, networkStatusChat].forEach((el) => {
        if (!el) return;
        el.textContent = statusText;
        el.classList.toggle('online', isOnline);
        el.classList.toggle('offline', !isOnline);
    });
    if (isOnline) {
        requestOutboxFlush();
        requestServiceWorkerUpdate('online');
    }
}

function isOutgoingMessage(msg) {
    return msg && (msg.direction === 'outgoing' || msg.reply);
}

function updateAppBadgeFromUnread() {
    if (!navigator.setAppBadge) return;
    const totalUnread = allHistoryData.reduce((count, msg) => {
        if (msg && !isOutgoingMessage(msg) && !msg.readAt) {
            return count + 1;
        }
        return count;
    }, 0);
    if (totalUnread > 0) {
        navigator.setAppBadge(totalUnread).catch(() => {});
    } else {
        navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {});
    }
}

function getDeliveryStatusMarkup(status, isRead) {
    if (status === 'failed') {
        return `<span class="material-icons msg-status msg-status-failed" title="${t('status_failed_title')}">error</span>`;
    }
    if (status === 'queued' || status === 'pending') {
        return `<span class="material-icons msg-status msg-status-pending" title="${t('status_pending_title')}">schedule</span>`;
    }
    if (isRead) {
        return `<span class="material-icons msg-status msg-status-read" title="${t('status_read_title')}">done_all</span>`;
    }
    return `<span class="material-icons msg-status msg-status-delivered" title="${t('status_sent_title')}">done_all</span>`;
}

async function sendReadReceipt(senderName, messageIds, readAt) {
    if (!senderName || !currentUserContext || !messageIds.length) return;
    if (!navigator.onLine) return;
    try {
        await fetchWithRetry('https://www.tzmc.co.il/notify/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reader: currentUserContext,
                sender: senderName,
                messageIds,
                readAt
            })
        }, { timeoutMs: 8000, retries: 1 });
    } catch (err) {
        console.warn('Read receipt failed', err);
    }
}

async function markChatAsRead(senderName) {
    if (!senderName) return;
    const senderKey = String(senderName).toLowerCase();
    const toUpdate = allHistoryData.filter(msg =>
        !isOutgoingMessage(msg) &&
        !msg.readAt &&
        String(msg.sender || '').toLowerCase() === senderKey
    );
    if (!toUpdate.length) return;

    const readAt = Date.now();
    const messageIds = [];
    toUpdate.forEach(msg => {
        msg.readAt = readAt;
        if (msg.messageId) messageIds.push(msg.messageId);
    });

    renderContactList();
    if (!viewChatRoom.classList.contains('hidden') && activeChatSender) {
        renderChatMessages();
    }
    updateAppBadgeFromUnread();

    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        toUpdate.forEach(msg => {
            if (msg.id) {
                store.put(msg);
                return;
            }
            if (msg.messageId && store.indexNames.contains('messageId')) {
                const req = store.index('messageId').get(msg.messageId);
                req.onsuccess = () => {
                    const record = req.result;
                    if (record) {
                        record.readAt = readAt;
                        store.put(record);
                    }
                };
            }
        });
    } catch (err) {
        console.warn('Failed to mark read', err);
    }

    if (messageIds.length) {
        sendReadReceipt(senderName, messageIds, readAt);
    }
}

async function logClientEvent(eventName, payload = {}) {
    const body = JSON.stringify({
        event: eventName,
        payload,
        user: currentUserContext || null,
        timestamp: Date.now()
    });
    if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(LOG_SERVER_URL, blob);
        return;
    }
    try {
        await fetchWithRetry(LOG_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        }, { timeoutMs: 8000, retries: 1 });
    } catch (e) {
        console.warn('Telemetry failed', e);
    }
}

// --- HELPER: DETECT BASE64, LINKS, AND IMAGES ---
// --- HELPER: DETECT BASE64, LINKS, IMAGES, AND VIDEOS ---
function stripGroupMessagePrefix(text, senderName) {
    if (!text || !senderName) return text;
    const prefix = `${senderName}:`;
    if (text.startsWith(prefix)) {
        return text.slice(prefix.length).trimStart();
    }
    return text;
}

function formatMessageText(text) {
    if (!text) return '';
    let processedText = text;

    // --- 1. BASE64 DETECTION (Images & PDFs) ---
    const base64Regex = /(data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,[a-zA-Z0-9+/=]+)/g;
    processedText = processedText.replace(base64Regex, function(match, fullDataUri, mimeType) {
        if (mimeType.match(/^image\/(png|jpeg|jpg|gif|webp)/i)) {
             return `<br><img src="${fullDataUri}" class="msg-image" data-open-url="${fullDataUri}" loading="lazy"><br>`;
        }
        if (mimeType === 'application/pdf') {
             return `<a href="${fullDataUri}" download="document.pdf" class="msg-attachment">
                       <div class="msg-attachment-icon"><span class="material-icons">description</span></div>
                       <div class="msg-attachment-meta">
                           <span class="msg-attachment-title">${t('attachment_pdf_title')}</span>
                           <span class="msg-attachment-subtitle">${t('attachment_download')}</span>
                       </div>
                    </a>`;
        }
        return `<a href="${fullDataUri}" download="file" class="msg-file-link">
                    <span class="material-icons msg-file-icon">download</span> ${t('attachment_download_file')}
                </a>`;
    });

    // --- 2. STANDARD URL DETECTION ---
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return processedText.replace(urlRegex, function(url) {
        const cleanUrl = url.trim();
        const lowerUrl = cleanUrl.toLowerCase();

        // A. IMAGE LINKS
        if (lowerUrl.match(/\.(jpeg|jpg|gif|png|webp)($|\?)/)) {
            return `<img src="${cleanUrl}" class="msg-image" data-open-url="${cleanUrl}" loading="lazy">`;
        }

        // B. DIRECT VIDEO FILES
        if (lowerUrl.match(/\.(mp4|webm|ogg)($|\?)/)) {
            return `<video controls src="${cleanUrl}" style="width:100%; max-width:300px; border-radius:8px; background:#000; margin-top:5px;"></video>`;
        }

        // B.1 DOCUMENT LINKS
        if (lowerUrl.match(/\.(pdf|doc|docx)($|\?)/)) {
            const fileName = decodeURIComponent(cleanUrl.split('/').pop().split('?')[0] || 'file');
            return `<a href="${cleanUrl}" target="_blank" class="msg-attachment" download>
                       <div class="msg-attachment-icon"><span class="material-icons">description</span></div>
                       <div class="msg-attachment-meta">
                           <span class="msg-attachment-title">${fileName}</span>
                           <span class="msg-attachment-subtitle">${t('attachment_download')}</span>
                       </div>
                    </a>`;
        }

        // C. [NEW] YOUTUBE PLAYLISTS (The link in your screenshot)
        // Matches: youtube.com/playlist?list=ID
        const playlistMatch = cleanUrl.match(/[?&]list=([^#\&\?]+)/);
        if (playlistMatch && playlistMatch[1]) {
            const listId = playlistMatch[1];
            return `<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; min-width: 250px; border-radius: 8px; margin-top: 5px;">
                        <iframe src="https://www.youtube.com/embed/videoseries?list=${listId}" frameborder="0" allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe>
                    </div>`;
        }

        // D. [UPDATED] YOUTUBE SINGLE VIDEOS / SHORTS
        const ytIdMatch = cleanUrl.match(/(?:youtube(?:-nocookie)?\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (ytIdMatch && ytIdMatch[1]) {
            const ytId = ytIdMatch[1];
            return `<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; min-width: 250px; border-radius: 8px; margin-top: 5px;">
                        <iframe src="https://www.youtube.com/embed/${ytId}" frameborder="0" allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe>
                    </div>`;
        }

        // E. GOOGLE MAPS
        if (lowerUrl.includes('maps.google.com') || lowerUrl.includes('google.com/maps') || lowerUrl.includes('maps.app.goo.gl')) {
             return `<a href="${cleanUrl}" target="_blank" class="msg-link">
                        <span class="material-icons msg-link-icon-location">location_on</span> 
                        <span class="msg-link-label">${t('location_my_label')}</span>
                     </a>`;
        }

        // F. DEFAULT LINK
        return `<a href="${cleanUrl}" target="_blank" class="msg-link-default">${cleanUrl}</a>`;
    });
}

// --- INIT ---
window.addEventListener('load', async () => {
    const savedUser = localStorage.getItem('username');
    const urlParams = new URLSearchParams(window.location.search);
    const userParam = urlParams.get('user');
    const chatFromUrl = urlParams.get('chat');
    if ('serviceWorker' in navigator) {
        try {
            const swUrl = new URL('sw.js', window.location.href).toString();
            const hadController = Boolean(navigator.serviceWorker.controller);
            const registration = await navigator.serviceWorker.register(swUrl);

            let skipControllerChange = !hadController;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (skipControllerChange) {
                    skipControllerChange = false;
                    return;
                }
                if (isHardReloading) {
                    return;
                }
                pendingUpdateReload = true;
                console.log('[Update] New service worker activated.');
                ensureUpdateToast();
            });

            if (registration) {
                registration.addEventListener('updatefound', () => {
                    const installing = registration.installing;
                    if (!installing) return;
                    installing.addEventListener('statechange', () => {
                        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                            setWaitingServiceWorker(registration, 'install');
                        }
                    });
                });
            }
            
            // [NEW] Listen for navigation messages from SW (iOS Fix)
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.action === 'refresh') {
                    console.log("Refreshing view due to background update...");
                    if (event.data.record && shouldIncludeRecord(event.data.record)) {
                        ensureGroupFromRecord(event.data.record);
                        upsertMessageInMemory(event.data.record);
                        renderContactList();
                        if (!viewChatRoom.classList.contains('hidden') && activeChatSender) {
                            renderChatMessages();
                        }
                        updateAppBadgeFromUnread();
                    }
                    loadAndGroupHistory();
                }
                if (event.data && event.data.action === 'outbox-updated') {
                    loadAndGroupHistory();
                }
                if (event.data && event.data.action === 'navigate-route') {
                    console.log("iOS Routing via SW Message:", event.data.url);
                    // This changes the page while keeping the PWA wrapper active
                    window.location.href = event.data.url;
                }
                if (event.data && event.data.action === 'group-update') {
                    const record = event.data.record || event.data;
                    applyGroupUpdate(record);
                }
                if (event.data && event.data.action === 'reaction') {
                    const record = event.data.record || event.data;
                    applyReactionRecord(record, { persist: false, render: true });
                }
                if (event.data && event.data.action === 'read-receipt') {
                    const messageIds = event.data.messageIds || [];
                    const readAt = event.data.readAt;
                    applyReadReceiptUpdate(messageIds, readAt);
                }
            });

            const urlParams = new URLSearchParams(window.location.search);
            const userParam = urlParams.get('user');
            if(userParam) localStorage.setItem('username', userParam);
            
        } catch (e) { console.error("SW Error:", e); }
    }
    
    verifyAndReactivate();
    updateNetworkStatus();
    if (navigator.onLine) {
        requestOutboxFlush();
    }
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    
    // --- SETUP TEXTAREA ENTER KEY ---
    const chatInput = document.getElementById('chatInputBar');
    if (chatInput) {
       // chatInput.addEventListener('keydown', function(e) {
         //   if (e.key === 'Enter' && !e.shiftKey) {
         ////       e.preventDefault(); // Stop new line
          //      sendMessage();
          //      this.style.height = 'auto'; // Reset height
           // }
        //});
    }
    const messagesArea = document.getElementById('messagesArea');
    if (messagesArea) {
        messagesArea.addEventListener('scroll', () => {
            shouldAutoScroll = isMessagesAreaNearBottom();
        });
        messagesArea.addEventListener('click', (event) => {
            const target = event.target;
            if (target && target.classList && target.classList.contains('msg-image')) {
                const url = target.dataset.openUrl || target.dataset.full || target.src;
                if (url) window.open(url, '_blank');
            }
        });
        messagesArea.addEventListener('load', (event) => {
            if (event.target && event.target.classList && event.target.classList.contains('msg-image')) {
                if (shouldAutoScroll) {
                    scrollToBottom();
                }
            }
        }, true);
    }
    chatInput.addEventListener('input', function() {
        autoResize(chatInput);
    });
    chatInput.addEventListener('focus', function() {
        // Small delay to allow keyboard to fully open
        setTimeout(() => {
            if (shouldAutoScroll) {
                scrollToBottom();
            }
        }, 300);
    });
    if (usernameInput) {
        usernameInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, '');
            if (value.length > 10) {
                value = value.slice(0, 10);
            }
            e.target.value = value;
            validateUsernameInput(false);
        });
        if (!localStorage.getItem('username')) {
            setTimeout(() => usernameInput.focus(), 500);
        }
    }
    if (savedUser || userParam) {
        currentUserContext = savedUser || userParam;
        
        loadLocalContacts();
        loadLocalGroups();
        fetchGroupsFromServer(true);

        setTimeout(() => {
            loadingDiv.classList.add('hidden');
            
            // [FIX] Priority Routing Logic:
            // 1. If clicked notification (?chat=...), open that chat.
            // 2. Else if was already in a chat, reopen it.
            // 3. Else show contact list.
            
            const lastChat = localStorage.getItem('activeChat');

            if (chatFromUrl) {
                console.log("Routing to chat from notification:", chatFromUrl);
                showChatRoom(chatFromUrl);
            } else if (lastChat) {
                showChatRoom(lastChat);
            } else {
                showContacts();
            }
            
            fetchUsersFromSheet();
            loadAndGroupHistory();
        }, 500);
    } else {
        loadingDiv.classList.add('hidden');
        viewSetup.classList.remove('hidden');
    }
    restorePendingUpdate();
    setTimeout(clearAppBadge, 2000);
});

function scheduleStatusCheck(username, subscription) {
    if (!username || !subscription) {
        console.warn("Cannot schedule status check: Missing username or subscription.");
        return;
    }

    console.log("🕒 Status check scheduled for 70 seconds from now...");

    // 70000 milliseconds = 70 seconds
    setTimeout(async () => {
        console.log("⏰ Executing 70s Status Check...");
        try {
            const res = await fetchWithRetry(VERIFY_STATUS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username: username,
                    subscription: subscription
                })
            }, { timeoutMs: 8000, retries: 2 });
            const data = await res.json();
            if (data.status === 'blocked') {
                console.warn("User is blocked. Notification should arrive shortly.");
            } else {
                console.log("User status verified: Active.");
            }
        } catch (err) {
            console.error("Error checking status:", err);
        }
    }, 70000); 
}

// --- CLEAR FUNCTION ---
function clearBotChatHistory() {
    return new Promise((resolve) => {
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = request.result;
                const botRecords = records.filter(r => 
                    r.sender === 'Bot' || 
                    r.sender === 'Support' ||
                    r.user === 'Setup_User'
                );

                if (botRecords.length === 0) {
                    resolve();
                    return;
                }

                let count = 0;
                botRecords.forEach(record => {
                    const delReq = store.delete(record.id);
                    delReq.onsuccess = () => {
                        count++;
                        if (count === botRecords.length) resolve();
                    };
                    delReq.onerror = () => {
                        count++;
                        if (count === botRecords.length) resolve();
                    };
                });
            };
            request.onerror = () => resolve(); 
        });
    });
}

// ==========================================================
// [NEW] MAIN MENU & BACKUP LOGIC
// ==========================================================

// 1. Toggle the Home Screen Menu
function toggleMainMenu() {
    const menu = document.getElementById('mainMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

async function clearAllChats() { 
    const confirmed = await showConfirm(t('confirm_clear_all'));
    if (!confirmed) return;

    try {
        const db = await openDB();
        const transaction = db.transaction([STORE_NAME, OUTBOX_STORE], "readwrite");
        transaction.objectStore(STORE_NAME).clear();
        if (db.objectStoreNames.contains(OUTBOX_STORE)) {
            transaction.objectStore(OUTBOX_STORE).clear();
        }
        transaction.oncomplete = () => {
            showToast(t('status_all_cleared'), 'success');
            localStorage.removeItem('activeChat');
            location.reload();
        };
        transaction.onerror = (e) => {
            console.error("DB Error", e);
            showToast(t('status_db_error'), 'error');
        };
    } catch (e) {
        console.error("DB Error", e);
        showToast(t('status_db_error'), 'error');
    }
}

// 3. The Backup Function (Chunked Upload)
async function backupChats() {
    if (!currentUserContext) {
        showToast(t('status_login_required_backup'), 'error');
        return;
    }

    const btn = backupChatsBtn;
    const originalText = btn ? btn.innerHTML : '';
    
    function updateStatus(text) {
        if(btn) btn.innerHTML = `<span>⏳</span> ${text}`;
    }

    updateStatus(t('status_backup_start'));

    try {
        updateStatus(t('status_loading'));
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = async () => {
            const rawRecords = request.result;

            if (!rawRecords || rawRecords.length === 0) {
                showToast(t('status_backup_empty'), 'info');
                if(btn) btn.innerHTML = originalText;
                return;
            }

            updateStatus(t('status_found_messages', { count: rawRecords.length }));
            await new Promise(r => setTimeout(r, 100)); 

            // 1. Format Data
            const allChats = rawRecords.map(r => {
                const isOutgoing = (r.direction === 'outgoing');
                return {
                    from: isOutgoing ? r.user : r.sender,
                    to: isOutgoing ? r.sender : r.user,
                    message: r.body || (r.image ? '[Image]' : ''),
                    time: new Date(r.timestamp).toLocaleString()
                };
            });

            // 2. SEND IN BATCHES (Chunks of 50)
            const BATCH_SIZE = 50; 
            const totalBatches = Math.ceil(allChats.length / BATCH_SIZE);
            
            for (let i = 0; i < totalBatches; i++) {
                const start = i * BATCH_SIZE;
                const end = start + BATCH_SIZE;
                const batch = allChats.slice(start, end);
                
                updateStatus(t('status_sending_batch', { current: i + 1, total: totalBatches }));

                try {
                    const response = await fetchWithRetry('https://www.tzmc.co.il/notify/backup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chats: batch })
                    }, { timeoutMs: 12000, retries: 2 });

                    if (!response.ok) {
                        throw new Error(`Batch ${i+1} failed (Error ${response.status})`);
                    }
                } catch (batchErr) {
                    console.error(batchErr);
                    showToast(t('status_backup_failed'), 'error');
                    if(btn) btn.innerHTML = originalText;
                    return; 
                }
                
                await new Promise(r => setTimeout(r, 200));
            }

            // 3. Success
            updateStatus(t('status_done'));
            setTimeout(() => { showToast(t('status_backup_done'), 'success'); }, 100);
            
            setTimeout(() => { if(btn) btn.innerHTML = originalText; }, 2000);
        };

        request.onerror = () => {
            showToast(t('status_backup_failed'), 'error');
            if(btn) btn.innerHTML = originalText;
        };

    } catch (e) {
        console.error(e);
        showToast(t('status_backup_failed'), 'error');
        if(btn) btn.innerHTML = originalText;
    }
}

function hideAllViews() {
    viewSetup.classList.add('hidden');
    viewContacts.classList.add('hidden');
    viewChatRoom.classList.add('hidden');
}

function showContacts() {
    localStorage.removeItem('activeChat');
    activeChatSender = null;
    hideAllViews();
    viewContacts.classList.remove('hidden');
    closeNewChatModal();
    updateHeaderOffset();

    const fabButton = document.getElementById('myFloatingButton');
    if (fabButton) {
        fabButton.style.display = 'flex';
    }

    loadAndGroupHistory();
}

function showChatRoom(senderName) {
    localStorage.setItem('activeChat', senderName);
    hideAllViews();
    viewChatRoom.classList.remove('hidden');
    updateHeaderOffset();

    const fabButton = document.getElementById('myFloatingButton');
    if (fabButton) {
        if (senderName === 'Bot' || senderName === 'Support' || isGroupId(senderName)) {
            fabButton.style.display = 'none';
        } else {
            fabButton.style.display = 'flex';
        }
    }

    activeChatSender = senderName; 
    const activeGroup = getGroupById(senderName);

    if (groupMembersTrigger) {
        const iconEl = groupMembersTrigger.querySelector('.material-icons');
        if (activeGroup) {
            groupMembersTrigger.classList.add('chat-header-avatar--group');
            if (iconEl) {
                const type = normalizeGroupType(activeGroup.type || 'group');
                iconEl.textContent = type === 'community' ? 'campaign' : 'group';
            }
        } else {
            groupMembersTrigger.classList.remove('chat-header-avatar--group');
            if (iconEl) iconEl.textContent = 'person';
        }
    }

    updateGroupComposerState(activeGroup);
    
    const titleEl = document.getElementById('chatRoomTitle');
    if(titleEl) {
        titleEl.textContent = activeGroup ? activeGroup.name : getDisplayName(senderName);
    }

    // ============================================================
    // [NEW] HANDLE CALL BUTTON LOGIC
    // ============================================================
    const callBtn = document.getElementById('headerCallBtn');
    if (callBtn) {
        if (activeGroup) {
            callBtn.href = '#';
            callBtn.style.display = 'none';
        } else {
            // 1. Check if the senderName looks like a phone number 
            // (removes non-digits to check length)
            const cleanNumber = senderName.replace(/[^0-9]/g, '');

            // 2. Toggle Visibility
            // If it has at least 3 digits and is NOT a system user, show the button
            if (cleanNumber.length > 3 && !isSystemSenderName(senderName)) {
                callBtn.href = `tel:${senderName}`; // Set the phone number
                callBtn.style.display = 'block';    // Show the button
            } else {
                callBtn.href = '#';
                callBtn.style.display = 'none';     // Hide the button
            }
        }
    }
    // ============================================================
    
    const msgArea = document.getElementById('messagesArea');
    if(msgArea) msgArea.innerHTML = ''; 
    
    justOpenedChat = true; 
    if (window.HR_CHAT && typeof window.HR_CHAT.handleChatOpen === 'function') {
        window.HR_CHAT.handleChatOpen(senderName);
    }
    loadAndGroupHistory(); 
    
}

function updateGroupComposerState(group) {
    const isReadOnlyGroup = group && normalizeGroupType(group.type || 'group') === 'community' && !isGroupAdmin(group);
    const chatInput = document.getElementById('chatInputBar');
    const chatFooter = document.querySelector('.chat-footer');
    if (chatFooter) {
        chatFooter.style.display = isReadOnlyGroup ? 'none' : '';
    }
    if (chatInput) {
        chatInput.disabled = Boolean(isReadOnlyGroup);
        chatInput.placeholder = isReadOnlyGroup ? t('group_send_denied') : t('chat_placeholder');
    }
    if (sendBtn) sendBtn.disabled = Boolean(isReadOnlyGroup);
    if (toggleAttachBtn) toggleAttachBtn.disabled = Boolean(isReadOnlyGroup);
    if (attachFileBtn) attachFileBtn.disabled = Boolean(isReadOnlyGroup);
    if (shareLocationBtn) shareLocationBtn.disabled = Boolean(isReadOnlyGroup);
}
function logoutUser() {
    logClientEvent('logout', { deviceType: getDeviceType() });
    // 1. Clear Data
    localStorage.removeItem('username');
    localStorage.removeItem('activeChat');
    localStorage.removeItem('cachedContacts'); 
    localStorage.removeItem(GROUPS_STORAGE_KEY);
    cachedGroups = [];
    groupMap = {};

    // 2. Construct Clean URL (Origin + Path, no Query Params)
    // Example: changes "site.com/?user=123" to "site.com/"
    const cleanUrl = window.location.origin + window.location.pathname;

    // 3. Force Navigation to Clean URL
    window.location.href = cleanUrl;
    
   
    //location.reload();

}

// --- MODAL & SEARCH ---
function openNewChatModal() {
    openModal(modalNewChat);
    userSearchInput.value = ''; 
    userSearchInput.focus();
    if (cachedUserList.length > 0) { renderUserList(cachedUserList); } 
    else { fetchUsersFromSheet(); }
}
function closeNewChatModal() { closeModal(modalNewChat); }
function filterUserList() {
    const filter = (userSearchInput.value || '').toLowerCase();
    const items = modalUserList.getElementsByClassName('contact-item');
    for (let i = 0; i < items.length; i++) {
        const nameDiv = items[i].getElementsByClassName('contact-name')[0];
        if (nameDiv) {
            const txtValue = nameDiv.textContent || nameDiv.innerText;
            items[i].style.display = txtValue.toLowerCase().indexOf(filter) > -1 ? "" : "none";
        }
    }
}

const debouncedFilterUserList = debounce(filterUserList, 200);
if (userSearchInput) {
    userSearchInput.addEventListener('input', debouncedFilterUserList);
}

const debouncedFilterGroupList = debounce(() => renderGroupUserList(cachedUserList), 200);
if (groupSearchInput) {
    groupSearchInput.addEventListener('input', debouncedFilterGroupList);
}
if (groupTypeInput) {
    groupTypeInput.addEventListener('change', () => updateGroupTypeHint());
}

// [NEW] Load contacts from Local Storage
function loadLocalContacts() {
    try {
        const rawData = localStorage.getItem('cachedContacts');
        if (rawData) {
            const users = JSON.parse(rawData);
            if (Array.isArray(users)) {
                console.log(`[Cache] Loaded ${users.length} contacts.`);
                cachedUserList = users;
                
                // Rebuild the map immediately
                userMap = {};
                cachedUserList.forEach(u => {
                    if(u.username) userMap[u.username.toLowerCase()] = u.displayName;
                });
            }
        }
    } catch (e) {
        console.error("Error parsing cached contacts:", e);
    }
}

function loadLocalGroups() {
    try {
        const rawData = localStorage.getItem(GROUPS_STORAGE_KEY);
        if (rawData) {
            const groups = JSON.parse(rawData);
            if (Array.isArray(groups)) {
                cachedGroups = groups
                    .filter(group => group && group.id && group.name)
                    .map(group => ({
                        ...group,
                        createdBy: group.createdBy || null,
                        type: normalizeGroupType(group.type || 'group')
                    }));
            }
        }
    } catch (e) {
        console.error('Error parsing cached groups:', e);
    }
    rebuildGroupMap();
}

async function fetchGroupsFromServer(force = false) {
    if (!currentUserContext) return;
    if (!navigator.onLine) return;
    const now = Date.now();
    if (!force && now - lastGroupsFetch < GROUPS_TTL_MS) return;
    lastGroupsFetch = now;
    try {
        const res = await fetchWithRetry(`${GROUPS_URL}?user=${encodeURIComponent(currentUserContext)}`, {}, { timeoutMs: 10000, retries: 2 });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.groups || !Array.isArray(data.groups)) return;
        const serverGroups = data.groups
            .map(group => ({
                id: group.id || group.groupId,
                name: group.name || group.groupName,
                members: group.members || group.groupMembers || [],
                createdBy: group.createdBy || group.groupCreatedBy || null,
                createdAt: group.createdAt || group.groupCreatedAt || Date.now(),
                updatedAt: group.updatedAt || group.groupUpdatedAt || Date.now(),
                type: normalizeGroupType(group.type || group.groupType || 'group')
            }))
            .filter(group => group.id && group.name);
        cachedGroups = serverGroups;
        saveLocalGroups();
        rebuildGroupMap();

        const activeGroupMissing = activeChatSender && isGroupId(activeChatSender) && !serverGroups.some(group => normalizeGroupValue(group.id) === normalizeGroupValue(activeChatSender));
        if (activeGroupMissing) {
            showContacts();
        } else {
            renderContactList();
            if (activeChatSender && isGroupId(activeChatSender)) {
                updateGroupComposerState(getGroupById(activeChatSender));
            }
        }
    } catch (err) {
        console.warn('Failed to fetch groups:', err);
    }
}

function saveLocalGroups() {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(cachedGroups));
}

function rebuildGroupMap() {
    groupMap = {};
    cachedGroups.forEach(group => {
        if (group && group.id) {
            groupMap[group.id] = group;
            groupMap[group.id.toLowerCase()] = group;
        }
    });
}

function createGroupId() {
    return `${GROUP_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
}

function isGroupId(value) {
    return typeof value === 'string' && value.startsWith(GROUP_ID_PREFIX);
}

function getGroupById(value) {
    if (!value) return null;
    return groupMap[value] || groupMap[String(value).toLowerCase()] || null;
}

function isGroupAdmin(group) {
    if (!group || !currentUserContext) return false;
    return normalizeGroupValue(group.createdBy) === normalizeGroupValue(currentUserContext);
}

function ensureGroupFromRecord(record, { save = true } = {}) {
    if (!record || !record.groupId || !record.groupName) return false;
    const groupId = record.groupId;
    const existing = getGroupById(groupId);
    let changed = false;
        const recordUpdatedAt = record.groupUpdatedAt || 0;
        const recordType = normalizeGroupType(record.groupType || record.group_type || 'group');
    if (!existing) {
        const newGroup = {
            id: groupId,
            name: record.groupName,
            members: Array.isArray(record.groupMembers) ? record.groupMembers : [],
            createdBy: record.groupCreatedBy || null,
            createdAt: record.groupCreatedAt || record.timestamp || Date.now(),
            updatedAt: recordUpdatedAt || record.timestamp || Date.now(),
                type: recordType,
            isRemote: true
        };
        cachedGroups.push(newGroup);
        groupMap[groupId] = newGroup;
        groupMap[String(groupId).toLowerCase()] = newGroup;
        changed = true;
    } else {
        if (record.groupName && existing.name !== record.groupName) {
            if (!existing.updatedAt || recordUpdatedAt >= existing.updatedAt) {
                existing.name = record.groupName;
                changed = true;
            }
        }
        if (Array.isArray(record.groupMembers) && record.groupMembers.length) {
            existing.members = record.groupMembers;
            changed = true;
        }
        if (record.groupCreatedBy && !existing.createdBy) {
            existing.createdBy = record.groupCreatedBy;
            changed = true;
        }
        if (recordType && existing.type !== recordType) {
            existing.type = recordType;
            changed = true;
        }
        if (recordUpdatedAt && recordUpdatedAt > (existing.updatedAt || 0)) {
            existing.updatedAt = recordUpdatedAt;
            changed = true;
        }
        if (!groupMap[existing.id]) {
            groupMap[existing.id] = existing;
            groupMap[String(existing.id).toLowerCase()] = existing;
        }
    }
    if (changed && save) {
        saveLocalGroups();
    }
    return changed;
}

function openCreateGroupModal() {
    if (!modalCreateGroup) return;
    activeGroupEditId = null;
    activeGroupSelection = new Set();
    if (groupNameInput) {
        groupNameInput.value = '';
        groupNameInput.placeholder = t('group_name_placeholder');
    }
    if (groupSearchInput) {
        groupSearchInput.value = '';
    }
    if (groupTypeInput) {
        groupTypeInput.value = 'group';
    }
    const titleEl = document.getElementById('createGroupTitle');
    if (titleEl) titleEl.textContent = t('group_create_title');
    if (createGroupSaveBtn) createGroupSaveBtn.textContent = t('group_create_action');
    if (createGroupCancelBtn) createGroupCancelBtn.textContent = t('group_cancel_action');
    updateGroupTypeHint();
    renderGroupUserList(cachedUserList);
    openModal(modalCreateGroup);
}

function closeCreateGroupModal() {
    closeModal(modalCreateGroup);
}

function updateGroupTypeHint() {
    if (!groupTypeInput || !groupTypeHint) return;
    const type = normalizeGroupType(groupTypeInput.value);
    groupTypeHint.textContent = type === 'community' ? t('group_type_hint_community') : t('group_type_hint_standard');
    if (groupTypeLabel) {
        groupTypeLabel.textContent = t('group_type_label');
    }
    if (groupTypeInput && groupTypeInput.options && groupTypeInput.options.length >= 2) {
        groupTypeInput.options[0].textContent = t('group_type_standard');
        groupTypeInput.options[1].textContent = t('group_type_community');
    }
}

function openGroupMembersModal() {
    if (!groupMembersModal) return;
    if (!activeChatSender || !isGroupId(activeChatSender)) return;
    const group = getGroupById(activeChatSender);
    if (!group) {
        showToast(t('group_not_found'), 'error');
        return;
    }
    const titleEl = document.getElementById('groupMembersTitle');
    if (titleEl) titleEl.textContent = t('group_members_title');
    renderGroupMembersList(group);
    openModal(groupMembersModal);
}

function closeGroupMembersModal() {
    closeModal(groupMembersModal);
}

function openReactionModal(message) {
    if (!reactionModal || !reactionList) return;
    if (!message) return;
    const messageId = message.messageId || message.clientMessageId || message.id;
    if (!messageId) return;
    activeReactionMessage = message;
    activeReactionMessageId = messageId;
    reactionList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    REACTION_EMOJIS.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'reaction-item';
        button.textContent = emoji;
        button.addEventListener('click', () => {
            handleReactionSelection(emoji, messageId);
        });
        fragment.appendChild(button);
    });
    reactionList.appendChild(fragment);
    openModal(reactionModal);
}

function closeReactionModal() {
    activeReactionMessage = null;
    activeReactionMessageId = null;
    closeModal(reactionModal);
}

function openReactionDetailModal(message) {
    if (!reactionDetailModal || !reactionDetailList || !message) return;
    const activeGroup = message.groupId ? getGroupById(message.groupId) : null;
    if (!activeGroup || !isGroupAdmin(activeGroup)) return;
    reactionDetailList.innerHTML = '';
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    if (!reactions.length) {
        reactionDetailList.innerHTML = `<div class="modal-loading">${t('reactions_empty')}</div>`;
        openModal(reactionDetailModal);
        return;
    }
    const sorted = [...reactions].sort((a, b) => getDisplayName(a.reactor).localeCompare(getDisplayName(b.reactor)));
    const fragment = document.createDocumentFragment();
    sorted.forEach(reaction => {
        const row = document.createElement('div');
        row.className = 'reaction-detail-item';
        const name = document.createElement('span');
        name.textContent = getDisplayName(reaction.reactor);
        const emoji = document.createElement('span');
        emoji.className = 'reaction-detail-emoji';
        emoji.textContent = reaction.emoji;
        row.appendChild(name);
        row.appendChild(emoji);
        fragment.appendChild(row);
    });
    reactionDetailList.appendChild(fragment);
    openModal(reactionDetailModal);
}

function closeReactionDetailModal() {
    closeModal(reactionDetailModal);
}

function handleReactionSelection(emoji, messageIdOverride = null) {
    const messageId = messageIdOverride || activeReactionMessageId;
    const message = messageId ? allHistoryData.find(m => m.messageId === messageId || m.clientMessageId === messageId || m.id === messageId) : activeReactionMessage;
    if (!message) return;
    const group = message.groupId
        ? getGroupById(message.groupId)
        : (isGroupId(activeChatSender) ? getGroupById(activeChatSender) : null);
    if (!group || normalizeGroupType(group.type || 'group') !== 'community') {
        closeReactionModal();
        return;
    }
    const targetMessageId = message.messageId || message.clientMessageId || message.id;
    if (!targetMessageId) {
        closeReactionModal();
        return;
    }
    closeReactionModal();
    const record = {
        recordType: 'reaction',
        reactionId: generateMessageId(),
        targetMessageId: targetMessageId,
        messageId: targetMessageId,
        emoji,
        user: currentUserContext,
        sender: group.id,
        reactor: currentUserContext,
        reactorName: getDisplayName(currentUserContext),
        groupId: group.id,
        groupName: group.name,
        groupMembers: Array.isArray(group.members) && group.members.length ? group.members : (message.groupMembers || []),
        groupCreatedBy: group.createdBy || message.groupCreatedBy || null,
        groupUpdatedAt: group.updatedAt || message.groupUpdatedAt || Date.now(),
        groupType: normalizeGroupType(group.type || 'group'),
        timestamp: Date.now()
    };
    applyReactionRecord(record, { persist: true, render: true }).catch(err => {
        console.warn('Failed to apply reaction record', err);
    });
    sendReactionToServer(record).catch(() => {
        showToast(t('reaction_submit_failed'), 'error');
    });
}

async function sendReactionToServer(record) {
    if (!record || !record.groupId || !record.targetMessageId) return;
    if (!navigator.onLine) {
        throw new Error('Offline');
    }
    const response = await fetchWithRetry(REACTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            groupId: record.groupId,
            groupName: record.groupName,
            groupMembers: record.groupMembers,
            groupCreatedBy: record.groupCreatedBy,
            groupUpdatedAt: record.groupUpdatedAt,
            groupType: record.groupType,
            targetMessageId: record.targetMessageId,
            emoji: record.emoji,
            reactor: record.reactor,
            reactorName: record.reactorName
        })
    }, { timeoutMs: 8000, retries: 1 });
    if (response && response.ok === false) {
        throw new Error('Reaction submit failed');
    }
    return response;
}

function buildReactionSummary(reactions) {
    if (!Array.isArray(reactions) || !reactions.length) return '';
    const counts = reactions.reduce((acc, reaction) => {
        if (!reaction || !reaction.emoji) return acc;
        acc[reaction.emoji] = (acc[reaction.emoji] || 0) + 1;
        return acc;
    }, {});
    const total = reactions.length;
    const chips = Object.entries(counts)
        .map(([emoji, count]) => `<span class="reaction-chip">${emoji}${count > 1 ? ` ${count}` : ''}</span>`)
        .join('');
    return `${chips}${chips ? `<span class="reaction-total">${total}</span>` : ''}`;
}

function applyReactionToMessage(message, reaction) {
    if (!message || !reaction) return false;
    if (!message.reactions) message.reactions = [];
    const reactorKey = normalizeGroupValue(reaction.reactor);
    const existingIndex = message.reactions.findIndex(item => normalizeGroupValue(item.reactor) === reactorKey);
    const nextReaction = {
        emoji: reaction.emoji,
        reactor: reaction.reactor,
        reactorName: reaction.reactorName
    };
    if (existingIndex >= 0) {
        message.reactions[existingIndex] = nextReaction;
    } else {
        message.reactions.push(nextReaction);
    }
    return true;
}

function getDisplayNameOrPhone(value) {
    if (!value) return '';
    return getDisplayName(value);
}

async function saveReactionRecord(record) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch (err) {
        console.warn('Failed to save reaction record', err);
    }
}

async function applyReactionRecord(record, { persist = false, render = false } = {}) {
    if (!record) return;
    const targetId = record.targetMessageId || record.messageId;
    if (!targetId) return;
    let updated = false;
    allHistoryData.forEach(message => {
        if (message.messageId === targetId || message.clientMessageId === targetId) {
            if (applyReactionToMessage(message, record)) {
                updated = true;
            }
        }
    });
    if (render && updated) {
        renderContactList();
        if (!viewChatRoom.classList.contains('hidden') && activeChatSender) {
            renderChatMessages();
        }
        const group = record.groupId ? getGroupById(record.groupId) : null;
        const reactorKey = normalizeGroupValue(record.reactor);
        const isSelf = reactorKey && normalizeGroupValue(currentUserContext) === reactorKey;
        if (group && isGroupAdmin(group) && !isSelf) {
            const name = record.reactorName || getDisplayName(record.reactor);
            showToast(t('reaction_toast', { name, emoji: record.emoji }), 'info');
        }
    }
    if (persist) {
        await saveReactionRecord(record);
    }
}
function renderGroupMembersList(group) {
    if (!groupMembersList) return;
    groupMembersList.innerHTML = '';
    const members = Array.isArray(group.members) ? group.members : [];
    if (groupMembersMeta) {
        const typeLabel = normalizeGroupType(group.type) === 'community' ? t('group_type_community') : t('group_type_standard');
        const modeLabel = normalizeGroupType(group.type) === 'community' ? t('group_read_only') : t('group_everyone_can_send');
        groupMembersMeta.textContent = `${t('group_type_label')}: ${typeLabel} · ${modeLabel}`;
    }
    if (!members.length) {
        groupMembersList.innerHTML = `<div class="modal-loading">${t('contacts_not_found')}</div>`;
        return;
    }
    const fragment = document.createDocumentFragment();
    members.forEach(member => {
        const row = document.createElement('div');
        row.className = 'group-member-item';
        const name = document.createElement('span');
        name.textContent = getDisplayName(member);
        row.appendChild(name);
        if (normalizeGroupValue(member) === normalizeGroupValue(group.createdBy)) {
            const role = document.createElement('span');
            role.className = 'group-member-role';
            role.textContent = t('group_role_admin');
            row.appendChild(role);
        }
        fragment.appendChild(row);
    });
    groupMembersList.appendChild(fragment);
}

function openEditGroupModal(groupId) {
    const group = getGroupById(groupId);
    if (!group) {
        showToast(t('group_not_found'), 'error');
        return;
    }
    if (!isGroupAdmin(group)) {
        showToast(t('group_edit_denied'), 'error');
        return;
    }
    activeGroupEditId = group.id;
    activeGroupSelection = new Set((group.members || []).map(member => String(member)));
    if (groupNameInput) {
        groupNameInput.value = group.name || '';
    }
    if (groupSearchInput) {
        groupSearchInput.value = '';
    }
    if (groupTypeInput) {
        groupTypeInput.value = normalizeGroupType(group.type || 'group');
    }
    const titleEl = document.getElementById('createGroupTitle');
    if (titleEl) titleEl.textContent = t('group_edit_title');
    if (createGroupSaveBtn) createGroupSaveBtn.textContent = t('group_save_action');
    if (createGroupCancelBtn) createGroupCancelBtn.textContent = t('group_cancel_action');
    updateGroupTypeHint();
    renderGroupUserList(cachedUserList);
    openModal(modalCreateGroup);
}

function renderGroupUserList(users) {
    if (!groupUserList) return;
    groupUserList.innerHTML = '';
    const currentLower = currentUserContext ? String(currentUserContext).toLowerCase() : '';
    const query = groupSearchInput ? groupSearchInput.value.trim().toLowerCase() : '';
    const list = (users || []).filter(u => u.username && u.username.toLowerCase() !== currentLower)
        .filter(u => {
            if (!query) return true;
            const displayName = (u.displayName || '').toLowerCase();
            const username = (u.username || '').toLowerCase();
            return displayName.includes(query) || username.includes(query);
        });
    if (!list.length) {
        groupUserList.innerHTML = `<div class="modal-loading">${t('contacts_not_found')}</div>`;
        return;
    }
    const fragment = document.createDocumentFragment();
    list.forEach(user => {
        const row = document.createElement('label');
        row.className = 'group-list-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = user.username;
        checkbox.className = 'group-list-checkbox';
        checkbox.checked = activeGroupSelection.has(String(user.username));
        checkbox.addEventListener('change', (event) => {
            const value = String(event.target.value);
            if (event.target.checked) {
                activeGroupSelection.add(value);
            } else {
                activeGroupSelection.delete(value);
            }
        });
        const name = document.createElement('span');
        name.className = 'group-list-name';
        const displayName = user.displayName || user.username;
        name.textContent = `${displayName} (${user.username})`;
        row.appendChild(checkbox);
        row.appendChild(name);
        fragment.appendChild(row);
    });
    groupUserList.appendChild(fragment);
}

async function deleteGroupHistory(groupId) {
    if (!groupId) return;
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const records = request.result || [];
                const idsToDelete = new Set();
                records.forEach(record => {
                    if (record && String(record.sender || '').toLowerCase() === String(groupId).toLowerCase()) {
                        if (record.id !== undefined && record.id !== null) {
                            store.delete(record.id);
                            idsToDelete.add(record.id);
                        }
                    }
                });
                tx.oncomplete = () => {
                    if (idsToDelete.size) {
                        allHistoryData = allHistoryData.filter(msg => !idsToDelete.has(msg.id));
                    }
                    resolve();
                };
                tx.onerror = () => resolve();
            };
            request.onerror = () => resolve();
        });
    } catch (err) {
        console.warn('Failed to delete group history', err);
    }
}

async function deleteGroupById(groupId, { showToastMessage = true, ignorePermission = false } = {}) {
    const group = getGroupById(groupId);
    if (!group) return;
    if (!ignorePermission && !isGroupAdmin(group)) {
        showToast(t('group_delete_denied'), 'error');
        return;
    }
    cachedGroups = cachedGroups.filter(item => item.id !== groupId);
    saveLocalGroups();
    rebuildGroupMap();
    await deleteGroupHistory(groupId);
    if (activeChatSender === groupId) {
        showContacts();
    } else {
        renderContactList();
    }
    if (showToastMessage) {
        showToast(t('group_deleted'), 'success');
    }
}

async function notifyGroupUpdate(group, membersToNotify) {
    if (!group || !Array.isArray(membersToNotify) || !membersToNotify.length) return;
    if (!navigator.onLine) return;
    try {
        await fetchWithRetry(GROUP_UPDATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                groupId: group.id,
                groupName: group.name,
                groupMembers: group.members || [],
                groupCreatedBy: group.createdBy || currentUserContext,
                groupUpdatedAt: group.updatedAt || Date.now(),
                groupType: normalizeGroupType(group.type || 'group'),
                membersToNotify
            })
        }, { timeoutMs: 10000, retries: 2 });
    } catch (err) {
        console.warn('Group update failed', err);
    }
}

async function applyGroupUpdate(record) {
    if (!record || !record.groupId) return;
    const changed = ensureGroupFromRecord(record);
    const group = getGroupById(record.groupId);
    const members = Array.isArray(record.groupMembers) ? record.groupMembers : (group ? group.members : []);
    const currentKey = normalizeGroupValue(currentUserContext);
    const isMember = members && currentKey ? members.map(normalizeGroupValue).includes(currentKey) : true;
    if (!isMember) {
        await deleteGroupById(record.groupId, { showToastMessage: false, ignorePermission: true });
        showToast(t('group_removed'), 'info');
        return;
    }
    if (changed) {
        rebuildGroupMap();
    }
    renderContactList();
    if (activeChatSender === record.groupId && !viewChatRoom.classList.contains('hidden')) {
        renderChatMessages();
    }
    if (activeChatSender === record.groupId) {
        updateGroupComposerState(getGroupById(record.groupId));
    }
    if (groupMembersModal && !groupMembersModal.classList.contains('hidden') && activeChatSender === record.groupId) {
        const group = getGroupById(record.groupId);
        if (group) renderGroupMembersList(group);
    }
}

async function saveGroupFromModal() {
    const name = groupNameInput ? groupNameInput.value.trim() : '';
    if (!name) {
        showToast(t('group_name_required'), 'error');
        return;
    }
    const existing = cachedGroups.find(group => group.name && group.name.toLowerCase() === name.toLowerCase());
    if (existing && existing.id !== activeGroupEditId) {
        showToast(t('group_name_exists'), 'error');
        return;
    }
    const selectedSet = new Set(activeGroupSelection);
    if (currentUserContext) {
        selectedSet.add(String(currentUserContext));
    }
    const selected = Array.from(selectedSet);
    if (!selected.length) {
        showToast(t('group_members_required'), 'error');
        return;
    }
    const selectedType = groupTypeInput ? normalizeGroupType(groupTypeInput.value) : 'group';
    if (activeGroupEditId) {
        const group = getGroupById(activeGroupEditId);
        if (!group) {
            showToast(t('group_not_found'), 'error');
            return;
        }
        if (!isGroupAdmin(group)) {
            showToast(t('group_edit_denied'), 'error');
            return;
        }
        const previousMembers = Array.isArray(group.members) ? [...group.members] : [];
        group.name = name;
        group.members = selected;
        group.type = selectedType;
        group.updatedAt = Date.now();
        cachedGroups = cachedGroups.map(item => item.id === group.id ? group : item);
        saveLocalGroups();
        rebuildGroupMap();
        closeCreateGroupModal();
        renderContactList();
        showToast(t('group_updated'), 'success');
        showChatRoom(group.id);
        const membersToNotify = Array.from(new Set([...previousMembers, ...group.members]));
        await notifyGroupUpdate(group, membersToNotify);
        return;
    }
    const group = {
        id: createGroupId(),
        name,
        members: selected,
        createdBy: currentUserContext,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        type: selectedType
    };
    cachedGroups.push(group);
    saveLocalGroups();
    rebuildGroupMap();
    closeCreateGroupModal();
    renderContactList();
    showToast(t('group_created'), 'success');
    showChatRoom(group.id);
    await notifyGroupUpdate(group, group.members);
}
function normalizeContactList(users) {
    if (!Array.isArray(users)) return [];
    const seen = new Set();
    return users.reduce((acc, user) => {
        if (!user || !user.username) return acc;
        const username = String(user.username).trim();
        const key = username.toLowerCase();
        if (!key || seen.has(key)) return acc;
        seen.add(key);
        acc.push({
            ...user,
            username,
            displayName: user.displayName || username
        });
        return acc;
    }, []);
}

function normalizeGroupValue(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeGroupType(value) {
    return value === 'community' ? 'community' : 'group';
}

// [UPDATED] Fetch from Sheet & Save to Local
async function fetchUsersFromSheet() {
    try {
        const currentUser = localStorage.getItem('username'); 

        if (!currentUser) {
            console.warn("fetchUsersFromSheet: No user found. Skipping.");
            return;
        }
        if (Date.now() - lastContactsFetch < CONTACTS_TTL_MS) {
            return;
        }
        const url = SUBSCRIPTION_URL + '?action=get_contacts&user=' + encodeURIComponent(currentUser);
        
        const res = await fetchWithRetry(url, {}, { timeoutMs: 10000, retries: 2 });
        const data = await res.json();
        
        if (data.users && Array.isArray(data.users)) {
            cachedUserList = normalizeContactList(data.users);
            lastContactsFetch = Date.now();
            
            // Save to Local Storage
            localStorage.setItem('cachedContacts', JSON.stringify(cachedUserList));
            
            userMap = {};
            cachedUserList.forEach(u => {
                if (u.username) userMap[u.username.toLowerCase()] = u.displayName;
            });

            if (!modalNewChat.classList.contains('hidden')) renderUserList(cachedUserList);
            if (modalCreateGroup && !modalCreateGroup.classList.contains('hidden')) renderGroupUserList(cachedUserList);

            if (typeof viewContacts !== 'undefined' && !viewContacts.classList.contains('hidden')) {
                renderContactList();
            }
            
        } else {
            // User blocked or empty list
            cachedUserList = []; 
            localStorage.removeItem('cachedContacts');
            lastContactsFetch = Date.now();
            if (modalUserList) {
                modalUserList.innerHTML = `<div class="modal-loading">${t('contacts_not_found')}</div>`;
            }
        }
    } catch (e) {
        console.error("User fetch error:", e);
    }
}

function renderUserList(users) {
    const currentLower = currentUserContext ? String(currentUserContext).toLowerCase() : '';
    const filteredUsers = users.filter(u => u.username && u.username.toLowerCase() !== currentLower);
    renderListInBatches(filteredUsers, modalUserList, (u) => {
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.addEventListener('click', () => { showChatRoom(u.username); closeNewChatModal(); });
        div.innerHTML = `
            <div class="avatar"><span class="material-icons">person</span></div>
            <div class="contact-info">
                <div class="contact-name">${u.displayName}</div>
                <div class="contact-meta contact-meta-secondary">${u.username}</div>
            </div>`;
        return div;
    }, 40, filterUserList);
}
async function loadAndGroupHistory() {
    if (!currentUserContext) {
        const stored = localStorage.getItem('username');
        if (stored) currentUserContext = stored;
    }
    if(!currentUserContext) return;
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
        const rawData = request.result;
        
        // Filter for current user
        const currentLower = String(currentUserContext).toLowerCase();
        let filtered = rawData.filter(item => {
            const u = String(item.user || '').toLowerCase();
            return u === currentLower || (item.url && item.url.toLowerCase().includes(`user=${encodeURIComponent(currentLower)}`));
        });

        const groupUpdateRecords = filtered.filter(item => item && item.recordType === 'group-update');
        const reactionRecords = filtered.filter(item => item && item.recordType === 'reaction');
        if (groupUpdateRecords.length) {
            groupUpdateRecords.forEach(record => ensureGroupFromRecord(record));
        }
        filtered = filtered.filter(item => !item || (item.recordType !== 'group-update' && item.recordType !== 'reaction'));

        // Sort by time
        filtered.sort((a,b) => a.timestamp - b.timestamp);

        // --- DEDUPLICATION LOGIC ---
        const uniqueData = [];
        const seenKeys = new Set();
        for (let i = 0; i < filtered.length; i++) {
            const current = filtered[i];
            const stableKey = current.messageId || current.clientMessageId;
            const senderKey = String(current.sender || '').trim().toLowerCase();
            const fallbackKey = `${senderKey}|${current.timestamp}|${current.body || ''}|${current.reply || ''}`;
            const messageKey = stableKey || fallbackKey;
            if (seenKeys.has(messageKey)) continue;
            seenKeys.add(messageKey);
            uniqueData.push(current);
        }

        if (reactionRecords.length) {
            const reactionMap = {};
            reactionRecords
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                .forEach(record => {
                    const targetId = record.targetMessageId || record.messageId;
                    if (!targetId || !record.emoji) return;
                    const reactorKey = normalizeGroupValue(record.reactor);
                    if (!reactionMap[targetId]) reactionMap[targetId] = {};
                    reactionMap[targetId][reactorKey] = {
                        emoji: record.emoji,
                        reactor: record.reactor,
                        reactorName: record.reactorName
                    };
                });
            uniqueData.forEach(message => {
                const targetId = message.messageId || message.clientMessageId;
                if (!targetId || !reactionMap[targetId]) return;
                message.reactions = Object.values(reactionMap[targetId]);
            });
        }

        allHistoryData = uniqueData;
        let groupChanged = false;
        uniqueData.forEach(record => {
            if (ensureGroupFromRecord(record, { save: false })) {
                groupChanged = true;
            }
        });
        if (groupChanged) {
            saveLocalGroups();
            rebuildGroupMap();
        }

        // Update UI
        if (typeof renderContactList === 'function') {
            renderContactList();
        }
        if (!viewChatRoom.classList.contains('hidden') && activeChatSender) {
            renderChatMessages();
            markChatAsRead(activeChatSender);
        }
        updateAppBadgeFromUnread();
    };
}
function renderContactList() {
    const listContainer = document.getElementById('contactsListContainer');
    const scrollTop = listContainer.scrollTop; 
    listContainer.innerHTML = '';

    const groups = {};
    
    allHistoryData.forEach(msg => {
        const rawSender = msg.sender || 'System';
        const senderKey = String(rawSender).toLowerCase(); 
        if(!groups[senderKey]) groups[senderKey] = { displayName: rawSender, msgs: [], isGroup: false, groupId: null };
        groups[senderKey].displayName = rawSender; 
        groups[senderKey].msgs.push(msg);
    });

    cachedGroups.forEach(group => {
        const key = String(group.id || '').toLowerCase();
        if (!key) return;
        if (!groups[key]) {
            groups[key] = { displayName: group.name, msgs: [], isGroup: true, groupId: group.id };
        }
        groups[key].displayName = group.name;
        groups[key].isGroup = true;
        groups[key].groupId = group.id;
    });

    getPinnedChatEntries().forEach(entry => {
        const key = normalizeGroupValue(entry.name);
        if (!key) return;
        if (!groups[key]) {
            groups[key] = { displayName: entry.name, msgs: [], isGroup: false, groupId: null };
        }
        groups[key].displayName = entry.name;
        groups[key].pinned = true;
    });

    const sortedSenders = Object.values(groups).map(group => {
        const msgs = group.msgs;
        const lastMsg = msgs[msgs.length - 1];
        const hasMessages = Boolean(lastMsg);
        const isOutgoing = hasMessages ? isOutgoingMessage(lastMsg) : false;
        const unreadCount = msgs.reduce((count, msg) => {
            if (!isOutgoingMessage(msg) && !msg.readAt) {
                return count + 1;
            }
            return count;
        }, 0);
        
        let lastText = '';
        if (hasMessages) {
            const outgoingBody = lastMsg.body || lastMsg.reply || '';
            lastText = isOutgoing ? t('you_prefix', { message: outgoingBody }) : lastMsg.body;
            const hasImage = lastMsg.image || (lastMsg.body && lastMsg.body.includes('/uploads/'));
            if (hasImage && (!lastText || lastText === lastMsg.image)) {
                lastText = isOutgoing ? t('you_sent_image') : t('image_message');
            }
            lastText = sanitizePreviewText(lastText);
        } else if (group.isGroup) {
            lastText = t('group_empty');
        }

        return {
            name: group.groupId || group.displayName, 
            lastMsg: lastText,
            timestamp: lastMsg ? lastMsg.timestamp : 0,
            msgs: msgs,
            unreadCount,
            isGroup: group.isGroup,
            pinned: Boolean(group.pinned)
        };
    }).sort((a,b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.timestamp - a.timestamp;
    });

    if(sortedSenders.length === 0) {
        listContainer.innerHTML = `<div class="empty-state">${t('chats_empty')}</div>`;
        return;
    }

    renderListInBatches(sortedSenders, listContainer, (contact) => {
        const timeStr = contact.timestamp ? formatContactTimestamp(contact.timestamp) : '';
        const displayName = getDisplayName(contact.name); 
        const menuId = `menu-${contact.name.replace(/[^a-zA-Z0-9]/g, '')}`;

        const div = document.createElement('div');
        div.className = 'contact-item';
        div.addEventListener('click', () => showChatRoom(contact.name));

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        let avatarIcon = 'person';
        if (contact.isGroup) {
            const group = getGroupById(contact.name);
            avatarIcon = group && normalizeGroupType(group.type || 'group') === 'community' ? 'campaign' : 'group';
        }
        avatar.innerHTML = `<span class="material-icons">${avatarIcon}</span>`;

        const info = document.createElement('div');
        info.className = 'contact-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'contact-name';
        nameEl.textContent = displayName;
        const lastMsgEl = document.createElement('div');
        lastMsgEl.className = 'contact-last-msg';
        lastMsgEl.textContent = contact.lastMsg || '';
        info.appendChild(nameEl);
        info.appendChild(lastMsgEl);

        const meta = document.createElement('div');
        meta.className = 'contact-meta';
        const timeEl = document.createElement('span');
        timeEl.className = 'contact-meta-time';
        timeEl.textContent = timeStr;
        meta.appendChild(timeEl);
        if (contact.unreadCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'unread-badge';
            badge.textContent = contact.unreadCount > 99 ? '99+' : String(contact.unreadCount);
            meta.appendChild(badge);
        }

        const actions = document.createElement('div');
        actions.className = 'contact-actions';
        const moreBtn = document.createElement('button');
        moreBtn.className = 'material-icons more-btn';
        moreBtn.type = 'button';
        moreBtn.setAttribute('aria-label', t('actions_menu'));
        moreBtn.setAttribute('title', t('actions_menu'));
        moreBtn.textContent = 'more_vert';
        moreBtn.addEventListener('click', (event) => toggleContactMenu(event, menuId));
        actions.appendChild(moreBtn);

        const menu = document.createElement('div');
        menu.id = menuId;
        menu.className = 'context-menu';

        if (contact.isGroup) {
            const group = getGroupById(contact.name);
            const canEdit = group && isGroupAdmin(group);
            if (canEdit) {
                const editGroupBtn = document.createElement('button');
                const editIcon = document.createElement('span');
                editIcon.className = 'material-icons menu-icon menu-icon-primary';
                editIcon.textContent = 'edit';
                editGroupBtn.appendChild(editIcon);
                editGroupBtn.append(` ${t('group_edit_action')}`);
                editGroupBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    openEditGroupModal(contact.name);
                });
                menu.appendChild(editGroupBtn);

                const deleteGroupBtn = document.createElement('button');
                deleteGroupBtn.className = 'text-danger';
                const deleteIcon = document.createElement('span');
                deleteIcon.className = 'material-icons menu-icon menu-icon-delete';
                deleteIcon.textContent = 'delete';
                deleteGroupBtn.appendChild(deleteIcon);
                deleteGroupBtn.append(` ${t('group_delete_action')}`);
                deleteGroupBtn.addEventListener('click', (event) => deleteGroupFromList(event, contact.name));
                menu.appendChild(deleteGroupBtn);
            }
        } else {
            if (!isSystemSenderName(contact.name)) {
                const callBtn = document.createElement('button');
                const callIcon = document.createElement('span');
                callIcon.className = 'material-icons menu-icon menu-icon-call';
                callIcon.textContent = 'call';
                callBtn.appendChild(callIcon);
                callBtn.append(` ${t('call_action')}`);
                callBtn.addEventListener('click', (event) => callUser(event, contact.name));
                menu.appendChild(callBtn);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'text-danger';
            const deleteIcon = document.createElement('span');
            deleteIcon.className = 'material-icons menu-icon menu-icon-delete';
            deleteIcon.textContent = 'delete';
            deleteBtn.appendChild(deleteIcon);
            deleteBtn.append(` ${t('chat_delete_action')}`);
            deleteBtn.addEventListener('click', (event) => deleteChatFromList(event, contact.name));

            menu.appendChild(deleteBtn);
        }

        div.appendChild(avatar);
        div.appendChild(info);
        div.appendChild(meta);
        if (menu.childElementCount > 0) {
            div.appendChild(actions);
            div.appendChild(menu);
        }
        return div;
    }, 30, () => {
        listContainer.scrollTop = scrollTop;
    });
}
// --- TOGGLE CONTACT MENU (3-Dots) ---
function toggleContactMenu(event, menuId) {
    // Stop the click from opening the chat
    event.stopPropagation();
    
    const menu = document.getElementById(menuId);
    const isCurrentlyOpen = menu.classList.contains('show');

    // 1. Close ALL open menus first
    document.querySelectorAll('.context-menu').forEach(el => el.classList.remove('show'));

    // 2. If it wasn't open, open it now
    if (!isCurrentlyOpen) {
        const trigger = event.currentTarget;
        const rect = trigger.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = '12px';
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.classList.add('show');
        const menuHeight = menu.offsetHeight;
        let top = rect.bottom + 6;
        if (top + menuHeight > window.innerHeight) {
            top = rect.top - menuHeight - 6;
        }
        menu.style.top = `${Math.max(8, top)}px`;
    }
}
async function deleteChatFromList(event, senderName) {
    // 1. STOP the click from bubbling up to the row (which would open the chat)
    if (event) {
        event.stopPropagation();
    }

    const confirmed = await showConfirm(t('confirm_delete_chat', { name: getDisplayName(senderName) }));
    if (!confirmed) return;

    openDB().then(db => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            const records = request.result;
            
            // Find all messages from this specific sender
            const toDelete = records.filter(r => 
                String(r.sender || 'System').toLowerCase() === String(senderName || '').toLowerCase()
            );

            if (toDelete.length === 0) return;

            let count = 0;
            toDelete.forEach(record => {
                store.delete(record.id).onsuccess = () => {
                    count++;
                    if (count === toDelete.length) {
                        showToast(t('status_chat_deleted'), 'success');
                        // Reload history to update the UI
                        loadAndGroupHistory(); 
                    }
                };
            });
        };
    });
}

async function deleteGroupFromList(event, groupId) {
    if (event) {
        event.stopPropagation();
    }
    const group = getGroupById(groupId);
    const groupName = group ? group.name : groupId;
    const confirmed = await showConfirm(t('confirm_delete_group', { name: groupName }));
    if (!confirmed) return;
    await deleteGroupById(groupId);
}
function renderChatMessages() {
    const area = document.getElementById('messagesArea');
    if (!area) return;

    // Filter messages for this specific chat
    const chatMsgs = allHistoryData.filter(m => String(m.sender || 'System').toLowerCase() === String(activeChatSender || '').toLowerCase());
    const activeGroup = isGroupId(activeChatSender) ? getGroupById(activeChatSender) : null;
    const allowReactions = activeGroup && normalizeGroupType(activeGroup.type || 'group') === 'community';
    
    // --- NEW: GARBAGE COLLECTION ---
    // Remove any messages from the screen that are NOT in our data list anymore
    // (This fixes the "UI shows duplicate but DB is clean" bug)
    const validIds = new Set(chatMsgs.map(m => getMessageDomId(m)));
    const existingRows = Array.from(area.getElementsByClassName('msg-row'));
    
    existingRows.forEach(row => {
        // If the row on screen isn't in our valid data list, delete it
        if (row.id && !validIds.has(row.id)) {
            row.remove();
        }
    });
    // -------------------------------

    let lastDateStr = '';
    let hasNewMessage = false; 
    let firstUnreadIndex = -1;

    chatMsgs.forEach((msg, index) => {
        if (firstUnreadIndex < 0 && !isOutgoingMessage(msg) && !msg.readAt) {
            firstUnreadIndex = index;
        }
        const msgId = getMessageDomId(msg);
        const d = new Date(msg.timestamp);
        const dateStr = d.toLocaleDateString();
        
        // Date Badge Logic
        if (dateStr !== lastDateStr) {
            const dateId = `date-${dateStr.replace(/[^a-zA-Z0-9]/g, '')}`;
            if (!document.getElementById(dateId)) {
                const badge = document.createElement('div');
                badge.className = 'date-badge';
                badge.id = dateId;
                badge.textContent = dateStr;
                // Insert carefully to maintain order (optional complexity, usually append is fine)
                area.appendChild(badge);
            }
            lastDateStr = dateStr;
        }

        const isOutgoing = isOutgoingMessage(msg);
        const existingRow = document.getElementById(msgId);
        if (existingRow) {
            if (isOutgoing) {
                const timeEl = existingRow.querySelector('.msg-time');
                if (timeEl) {
                    const existingStatus = timeEl.querySelector('.msg-status');
                    const statusMarkup = getDeliveryStatusMarkup(msg.deliveryStatus || 'sent', !!msg.readAt);
                    if (existingStatus) {
                        const temp = document.createElement('span');
                        temp.innerHTML = statusMarkup;
                        const newNode = temp.firstChild;
                        if (newNode) existingStatus.replaceWith(newNode);
                    } else {
                        timeEl.insertAdjacentHTML('beforeend', statusMarkup);
                    }
                }
            }
            const bubbleEl = existingRow.querySelector('.msg-bubble');
            if (bubbleEl) {
                const reactionsMarkup = buildReactionSummary(msg.reactions);
                const reactionsEl = bubbleEl.querySelector('.msg-reactions');
                if (reactionsMarkup) {
                    if (reactionsEl) {
                        reactionsEl.innerHTML = reactionsMarkup;
                    } else {
                        const timeEl = bubbleEl.querySelector('.msg-time');
                        const wrapper = document.createElement('div');
                        wrapper.className = 'msg-reactions';
                        wrapper.innerHTML = reactionsMarkup;
                        if (timeEl) {
                            bubbleEl.insertBefore(wrapper, timeEl);
                        } else {
                            bubbleEl.appendChild(wrapper);
                        }
                    }
                } else if (reactionsEl) {
                    reactionsEl.remove();
                }
                if (reactionsEl) {
                    reactionsEl.onclick = null;
                }
                if (reactionsMarkup) {
                    const reactionsTarget = reactionsEl || bubbleEl.querySelector('.msg-reactions');
                    if (reactionsTarget) {
                        reactionsTarget.onclick = (event) => {
                            event.stopPropagation();
                            openReactionDetailModal(msg);
                        };
                    }
                }
            }
            return;
        }

        // --- RENDER NEW MESSAGE ---
        hasNewMessage = true;
        const timeStr = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        let bodyText = (msg.direction === 'outgoing' ? msg.body : msg.reply) || msg.body || '';
        if (msg.groupId) {
            bodyText = stripGroupMessagePrefix(bodyText, msg.groupSenderName);
        }
        const attachmentUrl = msg.image || (bodyText && bodyText.includes('/uploads/') ? bodyText : null);
        const thumbUrl = msg.thumbnail || msg.thumbUrl || null;
        let mediaHtml = '';

        if (attachmentUrl) {
            const lowerUrl = attachmentUrl.toLowerCase();
            if (lowerUrl.endsWith('.pdf')) {
                mediaHtml = `
                    <a href="${attachmentUrl}" target="_blank" class="msg-attachment">
                        <div class="msg-attachment-icon"><span class="material-icons">description</span></div>
                        <div class="msg-attachment-meta">
                            <span class="msg-attachment-title">${t('attachment_pdf_filename')}</span>
                            <span class="msg-attachment-subtitle">${t('attachment_open')}</span>
                        </div>
                    </a>`;
                if (bodyText === attachmentUrl) bodyText = '';
            } else {
                const previewUrl = thumbUrl || attachmentUrl;
                mediaHtml = `<img src="${previewUrl}" class="msg-image" data-full="${attachmentUrl}" loading="lazy">`;
                if (bodyText === attachmentUrl) bodyText = '';
            }
        }

        const div = document.createElement('div');
        div.id = msgId; 
        div.className = isOutgoing ? 'msg-row row-outgoing' : 'msg-row row-incoming';

        // Add Bubble
        const bubble = document.createElement('div');
        bubble.className = `msg-bubble ${isOutgoing ? 'bubble-outgoing' : 'bubble-incoming'}`;
        
        // Attach Long Press (Delete) Event
        if (typeof addLongPressEvent === 'function') {
            addLongPressEvent(bubble, () => showDeleteOptions(msg.id, msg));
        }

        const incomingTitle = msg.groupId ? (msg.groupSenderName || getDisplayName(msg.sender)) : getDisplayName(msg.sender);
        const reactionsMarkup = buildReactionSummary(msg.reactions);
        bubble.innerHTML = 
            (!isOutgoing ? `<span class="msg-title">${incomingTitle}</span>` : '') +
            (mediaHtml || '') +
            (bodyText ? `<div>${formatMessageText(bodyText)}</div>` : '') +
            (reactionsMarkup ? `<div class="msg-reactions">${reactionsMarkup}</div>` : '') +
            `<div class="msg-time">` +
                `${timeStr}` +
                (isOutgoing ? getDeliveryStatusMarkup(msg.deliveryStatus || 'sent', !!msg.readAt) : '') +
            `</div>`;

        if (allowReactions) {
            bubble.addEventListener('click', (event) => {
                const target = event.target;
                if (target && (target.closest('a') || target.classList.contains('msg-image'))) {
                    return;
                }
                openReactionModal(msg);
            });
        }
        const reactionsTarget = bubble.querySelector('.msg-reactions');
        if (reactionsTarget) {
            reactionsTarget.onclick = (event) => {
                event.stopPropagation();
                openReactionDetailModal(msg);
            };
        }

        div.appendChild(bubble);
        area.appendChild(div);
    });

    let anchor = document.getElementById('scrollAnchor');
    if (!anchor) {
        anchor = document.createElement('div');
        anchor.id = 'scrollAnchor';
        area.appendChild(anchor);
    } else {
        area.appendChild(anchor);
    }

    if (justOpenedChat) {
        if (firstUnreadIndex >= 0) {
            const didScroll = scrollToLastReadMessage(chatMsgs, firstUnreadIndex);
            shouldAutoScroll = false;
            justOpenedChat = false;
            if (!didScroll) return;
        } else {
            scrollToBottom();
            justOpenedChat = false;
        }
        return;
    }
    if (hasNewMessage && shouldAutoScroll) {
        scrollToBottom();
    }
}// --- DELETE SPECIFIC CHAT ---
async function deleteCurrentChat() {
    if (!activeChatSender) return;
    if (isGroupId(activeChatSender)) {
        const group = getGroupById(activeChatSender);
        const groupName = group ? group.name : activeChatSender;
        const confirmed = await showConfirm(t('confirm_delete_group', { name: groupName }));
        if (!confirmed) return;
        await deleteGroupById(activeChatSender);
        return;
    }
    
    // Confirm with user
    const confirmed = await showConfirm(t('confirm_delete_current'));
    if (!confirmed) return;

    openDB().then(db => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            const records = request.result;
            
            // Filter messages for the current chat only
            const toDelete = records.filter(r => 
                String(r.sender || 'System').toLowerCase() === String(activeChatSender || '').toLowerCase()
            );

            if (toDelete.length === 0) {
                showToast(t('no_messages_to_delete'), 'info');
                return;
            }

            let count = 0;
            toDelete.forEach(record => {
                // Delete each message by ID
                store.delete(record.id).onsuccess = () => {
                    count++;
                    // When all are deleted, return to contact list
                    if (count === toDelete.length) {
                        showToast(t('status_chat_deleted'), 'success');
                        showContacts(); 
                    }
                };
            });
        };
    });
}
// --- DB HELPER FUNCTION ---
function upgradeDb(version, resolve, reject) {
    const upgradeRequest = indexedDB.open(DB_NAME, version);
    upgradeRequest.onerror = (event) => reject(event);
    upgradeRequest.onupgradeneeded = (event) => {
        const db = event.target.result;
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        } else {
            store = event.target.transaction.objectStore(STORE_NAME);
        }
        if (store && !store.indexNames.contains('messageId')) {
            store.createIndex('messageId', 'messageId', { unique: false });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
            db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
        }
    };
    upgradeRequest.onsuccess = (event) => resolve(event.target.result);
}

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onerror = (e) => reject(e);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            let store;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            } else {
                store = e.target.transaction.objectStore(STORE_NAME);
            }
            if (store && !store.indexNames.contains('messageId')) {
                store.createIndex('messageId', 'messageId', { unique: false });
            }
            if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
                db.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = (e) => {
            const db = e.target.result;
            const hasHistory = db.objectStoreNames.contains(STORE_NAME);
            const hasOutbox = db.objectStoreNames.contains(OUTBOX_STORE);
            let hasIndex = true;
            if (hasHistory) {
                try {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const store = tx.objectStore(STORE_NAME);
                    hasIndex = store.indexNames.contains('messageId');
                } catch (err) {
                    hasIndex = true;
                }
            }
            if (hasHistory && hasOutbox && hasIndex) {
                resolve(db);
                return;
            }
            const nextVersion = db.version + 1;
            db.close();
            upgradeDb(nextVersion, resolve, reject);
        };
    });
}

const AUTO_SCROLL_THRESHOLD_PX = 24;

function isMessagesAreaNearBottom(threshold = AUTO_SCROLL_THRESHOLD_PX) {
    const area = document.getElementById('messagesArea');
    if (!area) return true;
    return (area.scrollHeight - area.scrollTop - area.clientHeight) < threshold;
}

function scrollToLastReadMessage(chatMsgs, firstUnreadIndex = -1) {
    const area = document.getElementById('messagesArea');
    if (!area || !Array.isArray(chatMsgs) || chatMsgs.length === 0) return false;
    let unreadIndex = firstUnreadIndex;
    if (unreadIndex < 0) {
        unreadIndex = chatMsgs.findIndex(msg => !isOutgoingMessage(msg) && !msg.readAt);
    }
    if (unreadIndex < 0) return false;
    const targetIndex = Math.max(unreadIndex - 1, 0);
    let targetMsg = chatMsgs[targetIndex];
    let targetEl = document.getElementById(getMessageDomId(targetMsg));
    if (!targetEl) {
        targetMsg = chatMsgs[unreadIndex];
        targetEl = document.getElementById(getMessageDomId(targetMsg));
    }
    if (!targetEl) return false;
    const padding = 16;
    const desiredTop = targetEl.offsetTop + targetEl.offsetHeight - area.clientHeight + padding;
    area.scrollTop = Math.max(0, desiredTop);
    return true;
}

function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    shouldAutoScroll = true;
    requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
    });
}

// --- LOCATION FUNCTION ---
function shareLocation() {
    if (!navigator.geolocation) {
        showToast(t('location_not_supported'), 'error');
        return;
    }
    
    const area = document.getElementById('messagesArea');
    const tempId = 'loc-temp-' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.className = 'msg-row row-outgoing';
    tempDiv.innerHTML = `<div class="msg-bubble bubble-outgoing"><i>${t('status_fetching_location')}</i></div>`;
    area.appendChild(tempDiv);
    scrollToBottom();

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const mapLink = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
            
            document.getElementById(tempId).remove(); 
            sendMessage(mapLink);
        },
        (error) => {
            if(document.getElementById(tempId)) document.getElementById(tempId).remove();
            console.error(error);
            showToast(t('status_location_error'), 'error');
        }
    );
}

async function sendGroupMessage(group, messageId, finalBody, imageUrl) {
    if (!group) return;
    const recipients = (group.members || []).filter(member =>
        String(member).toLowerCase() !== String(currentUserContext || '').toLowerCase()
    );
    if (!recipients.length) {
        showToast(t('group_members_required'), 'error');
        return;
    }

    const myName = getDisplayName(currentUserContext);
    const payloadBase = {
        user: currentUserContext,
        senderName: myName,
        reply: finalBody || '',
        imageUrl: imageUrl || null,
        messageId,
        groupId: group.id,
        groupName: group.name,
        groupMembers: group.members || [],
        groupCreatedBy: group.createdBy || currentUserContext,
        groupUpdatedAt: group.updatedAt || Date.now(),
        groupType: normalizeGroupType(group.type || 'group'),
        groupSenderName: myName
    };

    if (!navigator.onLine) {
        for (const recipient of recipients) {
            await queueOutboxMessage(messageId, { ...payloadBase, originalSender: recipient });
        }
        await updateMessageDeliveryStatus(messageId, 'queued');
        showToast(t('status_offline_queue'), 'info');
        return;
    }

    let hadFailure = false;
    for (const recipient of recipients) {
        try {
            const response = await fetchWithRetry(NOTIFY_SERVER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payloadBase, originalSender: recipient })
            }, { timeoutMs: 10000, retries: 2 });

            if (!response.ok) {
                throw new Error(`Send failed ${response.status}`);
            }
        } catch (err) {
            hadFailure = true;
            await queueOutboxMessage(messageId, { ...payloadBase, originalSender: recipient });
        }
    }

    if (hadFailure) {
        await updateMessageDeliveryStatus(messageId, 'queued');
        showToast(t('group_send_partial'), 'info');
    } else {
        await updateMessageDeliveryStatus(messageId, 'sent');
    }
}

// --- SEND MESSAGE ---
async function sendMessage(text = null, imageUrl = null, thumbnailUrl = null) {
    let finalBody = text;
    if (!finalBody && !imageUrl) {
        const input = document.getElementById('chatInputBar');
        finalBody = input.value.trim();
        if(!finalBody) return;
        input.value = '';
        input.style.height = 'auto';
    }

    const messageId = generateMessageId();
    const activeGroup = isGroupId(activeChatSender) ? getGroupById(activeChatSender) : null;
    if (isGroupId(activeChatSender) && !activeGroup) {
        showToast(t('group_not_found'), 'error');
        return;
    }
    if (activeGroup && normalizeGroupType(activeGroup.type || 'group') === 'community' && !isGroupAdmin(activeGroup)) {
        showToast(t('group_send_denied'), 'error');
        return;
    }
    const newRecord = {
        messageId,
        sender: activeChatSender,
        user: currentUserContext,
        body: finalBody || (imageUrl ? imageUrl : ''),
        image: imageUrl, 
        thumbnail: thumbnailUrl || null,
        direction: 'outgoing', 
        deliveryStatus: navigator.onLine ? 'pending' : 'queued',
        timestamp: new Date().getTime(),
        dateString: new Date().toLocaleString(),
        groupId: activeGroup ? activeGroup.id : null,
        groupName: activeGroup ? activeGroup.name : null,
        groupMembers: activeGroup ? activeGroup.members : null,
        groupCreatedBy: activeGroup ? activeGroup.createdBy : null,
        groupUpdatedAt: activeGroup ? activeGroup.updatedAt : null,
        groupType: activeGroup ? normalizeGroupType(activeGroup.type || 'group') : null,
        groupSenderName: activeGroup ? getDisplayName(currentUserContext) : null
    };
    
    const savedRecord = await saveNewMessageToDB(newRecord);
    allHistoryData.push(savedRecord); 
    renderChatMessages(); 
    scrollToBottom();

    if (activeGroup) {
        await sendGroupMessage(activeGroup, messageId, finalBody, imageUrl);
        return;
    }

    if (window.HR_CHAT && typeof window.HR_CHAT.isHrChat === 'function' && window.HR_CHAT.isHrChat(activeChatSender)) {
        if (typeof window.HR_CHAT.handleOutgoing === 'function') {
            const handled = await window.HR_CHAT.handleOutgoing(finalBody);
            if (handled) {
                await updateMessageDeliveryStatus(messageId, 'delivered');
                return;
            }
        }
    }

    // --- BOT INTERCEPTION ---
    if (typeof botFlowStep !== 'undefined' && botFlowStep) {
        setTimeout(() => handleBotRegistrationStep(finalBody), 600);
        return; 
    }

    const myName = getDisplayName(currentUserContext); 
    const payload = {
        user: currentUserContext, 
        senderName: myName,
        reply: finalBody,
        imageUrl: imageUrl, 
        originalSender: activeChatSender,
        messageId
    };

    if (!navigator.onLine) {
        await queueOutboxMessage(messageId, payload);
        await updateMessageDeliveryStatus(messageId, 'queued');
        showToast(t('status_offline_queue'), 'info');
        return;
    }

    try {
        const response = await fetchWithRetry(NOTIFY_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, { timeoutMs: 10000, retries: 2 });

        if (!response.ok) {
            throw new Error(`Send failed ${response.status}`);
        }
        await updateMessageDeliveryStatus(messageId, 'sent');
    } catch(e) {
        console.error("Send failed", e);
        await queueOutboxMessage(messageId, payload);
        await updateMessageDeliveryStatus(messageId, 'queued');
        showToast(t('status_send_failed'), 'error');
    }
}

async function resizeImageFile(file, maxDimension, quality = 0.82) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
        return file;
    }
    const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : null;
    const imageWidth = bitmap ? bitmap.width : 0;
    const imageHeight = bitmap ? bitmap.height : 0;
    if (!bitmap || !imageWidth || !imageHeight) {
        return file;
    }
    const scale = Math.min(1, maxDimension / Math.max(imageWidth, imageHeight));
    if (scale >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(imageWidth * scale);
    canvas.height = Math.round(imageHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    const newName = file.name.replace(/\.[^/.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: blob.type });
}

async function handleFileUpload(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        const formData = new FormData();
        
        const area = document.getElementById('messagesArea');
        const tempId = 'temp-' + Date.now();
        const tempDiv = document.createElement('div');
        tempDiv.id = tempId;
        tempDiv.className = 'msg-row row-outgoing';
        tempDiv.innerHTML = `<div class="msg-bubble bubble-outgoing"><i>${t('status_uploading')} ${file.name}...</i></div>`;
        area.appendChild(tempDiv);
        scrollToBottom();

        try {
            let uploadFile = file;
            let thumbnailFile = null;
            if (file.type && file.type.startsWith('image/')) {
                uploadFile = await resizeImageFile(file, 1280, 0.85);
                thumbnailFile = await resizeImageFile(file, 320, 0.7);
            }

            formData.append('file', uploadFile, uploadFile.name);
            if (thumbnailFile && thumbnailFile !== uploadFile) {
                formData.append('thumbnail', thumbnailFile, thumbnailFile.name);
            }

            const res = await fetchWithRetry(UPLOAD_SERVER_URL, { method: 'POST', body: formData }, { timeoutMs: 20000, retries: 2 });
            const data = await res.json();
            
            const tempEl = document.getElementById(tempId);
            if(tempEl) tempEl.remove();

            if (data.status === 'success') { 
                const isPdf = data.url.toLowerCase().endsWith('.pdf');
                if (isPdf) {
                    sendMessage(data.url, null); 
                } else {
                    sendMessage(null, data.url, data.thumbUrl || null); 
                }
            } else { 
                showToast(t('status_upload_failed'), 'error');
            }
        } catch (e) {
            const tempEl = document.getElementById(tempId);
            if(tempEl) tempEl.remove();
            console.error(e); 
            showToast(t('status_upload_failed'), 'error');
        }
        input.value = '';
    }
}

function saveNewMessageToDB(record) {
    return new Promise((resolve, reject) => {
        if (!record.messageId) {
            record.messageId = generateMessageId();
        }
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.add(record);
            request.onsuccess = () => {
                record.id = request.result;
                resolve(record);
            };
            request.onerror = () => reject(request.error);
        }).catch(reject);
    });
}

async function updateMessageDeliveryStatus(messageId, status) {
    if (!messageId) return;
    const inMemory = allHistoryData.find(m => m.messageId === messageId);
    if (inMemory) {
        inMemory.deliveryStatus = status;
    }
    if (!viewChatRoom.classList.contains('hidden')) {
        renderChatMessages();
    }
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let request;
        if (store.indexNames.contains('messageId')) {
            request = store.index('messageId').get(messageId);
        } else {
            request = store.get(messageId);
        }
        request.onsuccess = () => {
            const record = request.result;
            if (record) {
                record.deliveryStatus = status;
                store.put(record);
            }
            tx.oncomplete = () => resolve();
        };
        request.onerror = () => resolve();
    });
}

async function queueOutboxMessage(messageId, payload) {
    const db = await openDB();
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    const store = tx.objectStore(OUTBOX_STORE);
    store.add({
        messageId,
        payload,
        url: NOTIFY_SERVER_URL,
        headers: { 'Content-Type': 'application/json' },
        createdAt: Date.now(),
        attempts: 0
    });
    await registerOutboxSync();
}

async function registerOutboxSync() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        if ('sync' in reg) {
            await reg.sync.register('outbox-sync');
        } else {
            requestOutboxFlush();
        }
    } catch (e) {
        console.warn('Failed to register outbox sync', e);
    }
}

function requestOutboxFlush() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ action: 'flush-outbox' });
    }
}


// --- BADGE MANAGEMENT ---
function clearAppBadge() {
   // 1. Clear locally (iOS/Android)
    if ('setAppBadge' in navigator) {
        navigator.setAppBadge(0).catch(e => console.error(e));
    } else if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(e => console.error(e));
    }

    // 2. [NEW] Tell Server to reset counter to 0
    if (currentUserContext) {
        fetchWithRetry('https://www.tzmc.co.il/notify/reset-badge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: currentUserContext })
        }, { timeoutMs: 8000, retries: 1 }).catch(err => console.error("Failed to reset server badge:", err));
    }
}

// Clear badge when the app becomes visible
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        clearAppBadge();
        refreshOnVisible();
        if (pendingUpdateReload) {
            pendingUpdateReload = false;
            ensureUpdateToast();
        }
        ensureUpdateToast();
    } else {
        requestServiceWorkerUpdate('background');
    }
});


window.addEventListener('beforeinstallprompt', (e) => { 
    e.preventDefault(); deferredPrompt = e; document.getElementById('installContainer').classList.remove('hidden'); 
});
if(installBtn) { 
    installBtn.addEventListener('click', async () => { 
        if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; document.getElementById('installContainer').classList.add('hidden'); 
        } 
    }); 
}

// ==========================================================
// [UPDATED] REGISTER SUBSCRIPTION (Handles PC vs Mobile)
// ==========================================================
document.getElementById('subscribeButton').addEventListener('click', async () => {
    if (!validateUsernameInput(true)) return;
    let user = (usernameInput.value || '').trim().toLowerCase();
    if(!user) {
        setStatusMessage(t('status_empty_input'), 'error');
        return;
    }
    console.log(user);
    setStatusMessage(t('status_requesting_permission'));
    
    if (!('serviceWorker' in navigator)) {
        setStatusMessage(t('status_failed_install'), 'error');
        return;
    }
    
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ 
            userVisibleOnly: true, 
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) 
        });

        const deviceType = getDeviceType(); 

        let payload = { 
            username: user+'', 
            subscription: sub, 
            deviceType: deviceType 
        };

        if (deviceType === 'PC') {
            payload.subscriptionPC = sub;
        }

        await fetchWithRetry(SUBSCRIPTION_URL, { 
            method: 'POST', 
            mode: 'no-cors', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        }, { timeoutMs: 10000, retries: 2 });
        
        scheduleStatusCheck(user, sub);
        localStorage.setItem('username', user);
        currentUserContext = user;
        showContacts();
        fetchUsersFromSheet();
    } catch (e) {
        console.error(e);
        setStatusMessage(t('status_failed_install'), 'error');
    }
});

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}

// --- TIMERS ---
function refreshOnVisible() {
    if (currentUserContext && !document.hidden) {
        loadAndGroupHistory();
        fetchUsersFromSheet();
        fetchGroupsFromServer();
    }
}
window.addEventListener('focus', refreshOnVisible);

// --- UPDATE EXPERIENCE ---
let currentAppVersion = null;
let isHardReloading = false;
let pendingUpdateReload = false;
let pendingUpdateVersion = null;
let waitingServiceWorker = null;
let lastSwUpdateCheck = 0;
const SW_UPDATE_THROTTLE_MS = 60 * 1000;
const UPDATE_PENDING_KEY = 'pendingUpdateVersion';
const RELEASE_NOTES_SEEN_KEY = 'releaseNotesSeenVersion';

function ensureUpdateToast() {
    if (pendingUpdateVersion) {
        showUpdateToast(pendingUpdateVersion);
        return;
    }
    if (pendingUpdateReload) {
        showUpdateToast('');
    }
}

function setWaitingServiceWorker(registration, reason = 'update') {
    if (!registration || !registration.waiting) return;
    waitingServiceWorker = registration.waiting;
    pendingUpdateReload = true;
    console.log(`[Update] New SW waiting (${reason}).`);
    ensureUpdateToast();
}

async function activateWaitingServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
        const registration = await navigator.serviceWorker.getRegistration();
        const waiting = waitingServiceWorker || (registration ? registration.waiting : null);
        if (waiting) {
            waiting.postMessage({ type: 'SKIP_WAITING' });
        }
    } catch (e) {
        console.warn('Failed to activate waiting SW:', e);
    }
}

function handleReloadNow(reason = 'update') {
    pendingUpdateReload = false;
    pendingUpdateVersion = null;
    localStorage.removeItem(UPDATE_PENDING_KEY);
    clearUpdateToast();
    forceHardReload(reason);
}

async function requestServiceWorkerUpdate(reason = 'manual') {
    if (!('serviceWorker' in navigator)) return;
    if (!navigator.onLine) return;
    const now = Date.now();
    if (now - lastSwUpdateCheck < SW_UPDATE_THROTTLE_MS) return;
    lastSwUpdateCheck = now;
    try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) return;
        await registration.update();
        setWaitingServiceWorker(registration, reason);
        console.log(`[Update] Background SW check (${reason}).`);
    } catch (e) {
        console.warn('SW update check failed:', e);
    }
}

async function forceHardReload(reason = 'update') {
    if (isHardReloading) return;
    isHardReloading = true;
    console.log(`[Update] Forcing hard reload (${reason}).`);
    try {
        await activateWaitingServiceWorker();
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration) {
                await registration.update().catch(() => {});
            }
        }
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => caches.delete(key)));
        }
    } catch (e) {
        console.warn('Hard reload prep failed:', e);
    } finally {
        const url = new URL(window.location.href);
        url.searchParams.set('__reload', Date.now().toString());
        window.location.replace(url.toString());
    }
}

function maybeShowReleaseNotes(version, notes) {
    if (!version) return;
    const lastSeen = localStorage.getItem(RELEASE_NOTES_SEEN_KEY);
    if (lastSeen === version) return;
    showReleaseNotesModal(version, notes);
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, version);
}

function handleUpdateAvailable(version, notes) {
    if (version) {
        pendingUpdateVersion = version;
        localStorage.setItem(UPDATE_PENDING_KEY, version);
    }
    ensureUpdateToast();
    maybeShowReleaseNotes(version, notes);
    requestServiceWorkerUpdate('version-change');
}

function restorePendingUpdate() {
    const stored = localStorage.getItem(UPDATE_PENDING_KEY);
    if (stored) {
        pendingUpdateVersion = stored;
        ensureUpdateToast();
    }
}

async function checkVersion() {
    if (document.hidden || !navigator.onLine) return;

    try {
        // Add timestamp to prevent caching of the version check itself
        const res = await fetchWithRetry(VERSION_CHECK_URL + '?t=' + Date.now(), {}, { timeoutMs: 8000, retries: 1 });
        
        if (res.status === 429) {
            console.warn("Too many requests. Skipping version check.");
            return;
        }

        const data = await res.json();
        const serverVersion = data.version;
        const releaseNotes = data.notes || data.releaseNotes || [];

        // 1. First Load: Just set the variable
        if (currentAppVersion === null) {
            currentAppVersion = serverVersion;
            return;
        }

        // 2. Update Detected: Notify user and preload update
        if (currentAppVersion !== serverVersion) {
            console.log(`Update detected: ${currentAppVersion} -> ${serverVersion}`);
            currentAppVersion = serverVersion;
            handleUpdateAvailable(serverVersion, releaseNotes);
        }
    } catch (e) { 
        console.error('Version check failed:', e); 
    }
}
setInterval(checkVersion, 30000);
checkVersion();

function toggleAttachMenu() {
    const menu = document.getElementById('attachMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

// 2. Close menus if clicked outside
document.addEventListener('click', function(event) {
    // ... existing attachMenu logic ...
    const attachMenu = document.getElementById('attachMenu');
    const attachBtn = toggleAttachBtn;
    if (attachMenu && !attachMenu.classList.contains('hidden')) {
        if (!attachMenu.contains(event.target) && (!attachBtn || !attachBtn.contains(event.target))) {
            attachMenu.classList.add('hidden');
        }
    }

    // ... existing mainMenu logic ...
    const mainMenu = document.getElementById('mainMenu');
    const mainBtn = mainMenuToggleBtn; 
    
    if (mainMenu && !mainMenu.classList.contains('hidden')) {
        if (!mainMenu.contains(event.target) && (mainBtn && !mainBtn.contains(event.target))) {
            mainMenu.classList.add('hidden');
        }
    }

    // [NEW] Close Contact 3-Dot Menus if clicked outside
    if (!event.target.classList.contains('more-btn')) {
        document.querySelectorAll('.context-menu').forEach(el => el.classList.remove('show'));
    }
});
// --- DELETE MESSAGE LOGIC ---

// 1. Open the Modal
function showDeleteOptions(msgId, msgData) {
    selectedMessageId = msgId;
    selectedMessageData = msgData;
    
    const modal = document.getElementById('deleteModal');
    const btnEveryone = document.getElementById('btnDeleteEveryone');
    
    // Only show "Delete for Everyone" if YOU sent the message
    if (btnEveryone) {
        if (msgData.direction === 'outgoing' || msgData.sender === currentUserContext) {
            btnEveryone.style.display = 'block';
        } else {
            btnEveryone.style.display = 'none';
        }
    }
    
    openModal(modal);
}

// 2. Close Modal
function closeDeleteModal() {
    closeModal(document.getElementById('deleteModal'));
    selectedMessageId = null;
    selectedMessageData = null;
}

// 3. Perform Deletion
async function confirmDelete(type) {
    if (!selectedMessageId) return;
    
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    if (type === 'me') {
        // DELETE FOR ME: Remove strictly from local DB
        store.delete(selectedMessageId);
        // Remove from UI immediately
        const el = document.getElementById(getMessageDomId(selectedMessageData));
        if(el) el.remove();
        
        // Remove from memory array
        allHistoryData = allHistoryData.filter(m => m.id !== selectedMessageId);
    } 
    else if (type === 'everyone') {
        // DELETE FOR EVERYONE: Update text to "הודעה זו נמחקה"
        const updatedRecord = { ...selectedMessageData, body: t('message_deleted'), image: null, thumbnail: null };
        store.put(updatedRecord);
        
        // Tell Server to notify recipient
        fetchWithRetry('https://www.tzmc.co.il/notify/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timestamp: selectedMessageData.timestamp,
                messageId: selectedMessageData.messageId || null,
                sender: currentUserContext,
                recipient: activeChatSender 
            })
        }, { timeoutMs: 8000, retries: 1 }).catch(err => console.error('Delete notify failed', err));
        
        // Update UI
        loadAndGroupHistory();
    }
    
    closeDeleteModal();
}

// 4. Long Press Helper
function addLongPressEvent(element, callback) {
    let timer;
    
    // Mobile: Touch
    element.addEventListener('touchstart', (e) => {
        timer = setTimeout(() => {
            timer = null;
            callback();
        }, 600); // 600ms long press
    });
    
    element.addEventListener('touchend', () => {
        if (timer) clearTimeout(timer);
    });
    
    element.addEventListener('touchmove', () => {
        if (timer) clearTimeout(timer);
    });

    // Desktop: Right Click
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault(); // Stop standard menu
        callback();
    });
}  
// ==========================================================
// [UPDATED] REACTIVATE (Handles PC vs Mobile)
// ==========================================================
async function verifyAndReactivate() {
    let user = localStorage.getItem('username');
    if (!user) return; 
    user = user.toLowerCase();
    
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();

            if (!sub) {
                console.log("[Auto-Fix] User logged in but Push missing. Reactivating...");
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });

                const deviceType = getDeviceType();
                
                let payload = {
                    username: user,
                    subscription: sub,
                    action: 'reactivate_silent',
                    deviceType: deviceType
                };

                if (deviceType === 'PC') {
                    payload.subscriptionPC = sub;
                }

                await fetchWithRetry(SUBSCRIPTION_URL, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }, { timeoutMs: 10000, retries: 2 });
                console.log("[Auto-Fix] Reactivation sent.");
            }
        } catch (e) {
            console.error("[Auto-Fix] Failed:", e);
        }
    }
}
// --- CALL USER FUNCTION ---
function callUser(event, phoneNumber) {
    // 1. Stop click from bubbling to the row (opening chat)
    if (event) {
        event.stopPropagation();
    }

    // 2. Close the menu
    document.querySelectorAll('.context-menu').forEach(el => el.classList.remove('show'));

    // 3. Check if it's a valid number (basic check)
    // Assuming 'phoneNumber' is the username like '054...'
    const normalized = normalizePhoneInput(phoneNumber);
    if (!normalized || !isValidPhoneNumber(normalized)) {
        showToast(t('call_invalid_number'), 'error');
        return;
    }

    // 4. Open the dialer
    window.location.href = `tel:${normalized}`;
}