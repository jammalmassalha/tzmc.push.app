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
const VERSION_CHECK_URL = config.VERSION_CHECK_URL || 'https://www.tzmc.co.il/notify/version';
const VERIFY_STATUS_URL = config.VERIFY_STATUS_URL || 'https://www.tzmc.co.il/notify/verify-status';
const LOG_SERVER_URL = config.LOG_SERVER_URL || 'https://www.tzmc.co.il/notify/log';

// --- STATE ---
let currentUserContext = null; 
let activeChatSender = null;
let allHistoryData = [];
let cachedUserList = [];
let deferredPrompt;
let justOpenedChat = false; 
let lastContactsFetch = 0;
const CONTACTS_TTL_MS = 5 * 60 * 1000;

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
const toastContainer = document.getElementById('toastContainer');
const networkStatus = document.getElementById('networkStatus');
const networkStatusChat = document.getElementById('networkStatusChat');

if (mainMenuToggleBtn) mainMenuToggleBtn.addEventListener('click', toggleMainMenu);
if (backupChatsBtn) backupChatsBtn.addEventListener('click', () => { backupChats(); toggleMainMenu(); });
if (clearChatsBtn) clearChatsBtn.addEventListener('click', () => { clearAllChats(); toggleMainMenu(); });
if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);
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

// --- HELPER: GET DISPLAY NAME ---
function getDisplayName(username) {
    if (!username) return 'Unknown';
    if (username === 'Bot' || username === 'Support' || username === 'System') return username;
    return userMap[username.toLowerCase()] || username;
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
    const trimmed = value.trim();
    if (trimmed.startsWith('+')) {
        return '+' + trimmed.slice(1).replace(/\D/g, '');
    }
    return trimmed.replace(/\D/g, '');
}

function isValidPhoneNumber(value) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 15;
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

function renderListInBatches(items, container, renderItem, batchSize = 30, onComplete) {
    if (!container) return;
    container.innerHTML = '';
    let index = 0;
    const renderBatch = () => {
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
    }
}

function getDeliveryStatusMarkup(status) {
    if (status === 'failed') {
        return '<span class="material-icons msg-status msg-status-failed" title="נכשל">error</span>';
    }
    if (status === 'queued' || status === 'pending') {
        return '<span class="material-icons msg-status msg-status-pending" title="ממתין">schedule</span>';
    }
    return '<span class="material-icons msg-status msg-status-sent" title="נשלח">done_all</span>';
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
                       <div class="msg-attachment-icon">📄</div>
                       <div class="msg-attachment-meta">
                           <span class="msg-attachment-title">מסמך PDF</span>
                           <span class="msg-attachment-subtitle">לחץ להורדה</span>
                       </div>
                    </a>`;
        }
        return `<a href="${fullDataUri}" download="file" class="msg-file-link">
                    <span class="material-icons msg-file-icon">download</span> הורד קובץ
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
                        <span class="msg-link-label">📍 המיקום שלי</span>
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
            await navigator.serviceWorker.register(swUrl);
            
            // [NEW] Listen for navigation messages from SW (iOS Fix)
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.action === 'refresh') {
                    console.log("Refreshing view due to background update...");
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
        messagesArea.addEventListener('click', (event) => {
            const target = event.target;
            if (target && target.classList && target.classList.contains('msg-image')) {
                const url = target.dataset.openUrl || target.dataset.full || target.src;
                if (url) window.open(url, '_blank');
            }
        });
        messagesArea.addEventListener('load', (event) => {
            if (event.target && event.target.classList && event.target.classList.contains('msg-image')) {
                scrollToBottom();
            }
        }, true);
    }
    chatInput.addEventListener('input', function() {
        autoResize(chatInput);
    });
    chatInput.addEventListener('focus', function() {
        // Small delay to allow keyboard to fully open
        setTimeout(() => {
            scrollToBottom();
        }, 300);
    });
    if (usernameInput) {
        usernameInput.addEventListener('input', () => {
            validateUsernameInput(false);
        });
    }
    if (savedUser || userParam) {
        currentUserContext = savedUser || userParam;
        
        loadLocalContacts();

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
            showToast('שגיאת מסד נתונים', 'error');
        };
    } catch (e) {
        console.error("DB Error", e);
        showToast('שגיאת מסד נתונים', 'error');
    }
}

// 3. The Backup Function (Chunked Upload)
async function backupChats() {
    if (!currentUserContext) {
        showToast('יש להתחבר כדי לגבות', 'error');
        return;
    }

    const btn = backupChatsBtn;
    const originalText = btn ? btn.innerHTML : '';
    
    function updateStatus(text) {
        if(btn) btn.innerHTML = `<span>⏳</span> ${text}`;
    }

    updateStatus(t('status_backup_start'));

    try {
        updateStatus('טוען...');
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

            updateStatus(`נמצאו ${rawRecords.length} הודעות...`);
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
                
                updateStatus(`שולח ${i + 1}/${totalBatches}...`);

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
            updateStatus('הסתיים ✅');
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

    const fabButton = document.getElementById('myFloatingButton');
    if (fabButton) {
        if (senderName === 'Bot' || senderName === 'Support') {
            fabButton.style.display = 'none';
        } else {
            fabButton.style.display = 'flex';
        }
    }

    activeChatSender = senderName; 
    
    const titleEl = document.getElementById('chatRoomTitle');
    if(titleEl) {
        titleEl.textContent = getDisplayName(senderName);
    }

    // ============================================================
    // [NEW] HANDLE CALL BUTTON LOGIC
    // ============================================================
    const callBtn = document.getElementById('headerCallBtn');
    if (callBtn) {
        // 1. Check if the senderName looks like a phone number 
        // (removes non-digits to check length)
        const cleanNumber = senderName.replace(/[^0-9]/g, '');
        
        // 2. Define system users that should NOT have a call button
        const systemUsers = ['Bot', 'Support', 'System', 'Setup_User'];

        // 3. Toggle Visibility
        // If it has at least 3 digits and is NOT a system user, show the button
        if (cleanNumber.length > 3 && !systemUsers.includes(senderName)) {
            callBtn.href = `tel:${senderName}`; // Set the phone number
            callBtn.style.display = 'block';    // Show the button
        } else {
            callBtn.href = '#';
            callBtn.style.display = 'none';     // Hide the button
        }
    }
    // ============================================================
    
    const msgArea = document.getElementById('messagesArea');
    if(msgArea) msgArea.innerHTML = ''; 
    
    justOpenedChat = true; 
    loadAndGroupHistory(); 
    
    // Focus the input area immediately
    setTimeout(() => {
        const input = document.getElementById('chatInputBar');
        if (input) {
           input.focus();
        }
    }, 100); 
}
function logoutUser() {
    logClientEvent('logout', { deviceType: getDeviceType() });
    // 1. Clear Data
    localStorage.removeItem('username');
    localStorage.removeItem('activeChat');
    localStorage.removeItem('cachedContacts'); 

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
            cachedUserList = data.users; 
            lastContactsFetch = Date.now();
            
            // Save to Local Storage
            localStorage.setItem('cachedContacts', JSON.stringify(cachedUserList));
            
            userMap = {};
            cachedUserList.forEach(u => {
                if(u.username) userMap[u.username.toLowerCase()] = u.displayName;
            });

            if (!modalNewChat.classList.contains('hidden')) renderUserList(cachedUserList);
            if (typeof viewContacts !== 'undefined' && !viewContacts.classList.contains('hidden')) renderContactList();
            
        } else {
            // User blocked or empty list
            cachedUserList = []; 
            localStorage.removeItem('cachedContacts');
            lastContactsFetch = Date.now();
            if (modalUserList) {
                modalUserList.innerHTML = '<div class="modal-loading">לא נמצאו אנשי קשר.</div>';
            }
        }
    } catch (e) {
        console.error("User fetch error:", e);
    }
}

function renderUserList(users) {
    const currentLower = currentUserContext ? currentUserContext.toLowerCase() : '';
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
    if(!currentUserContext) return;
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
        const rawData = request.result;
        
        // Filter for current user
        const currentLower = currentUserContext.toLowerCase();
        let filtered = rawData.filter(item => {
            const u = (item.user || '').toLowerCase();
            return u === currentLower || (item.url && item.url.toLowerCase().includes(`user=${encodeURIComponent(currentLower)}`));
        });

        // Sort by time
        filtered.sort((a,b) => a.timestamp - b.timestamp);

        // --- DEDUPLICATION LOGIC ---
        const uniqueData = [];
        const seenKeys = new Set();
        for (let i = 0; i < filtered.length; i++) {
            const current = filtered[i];
            const stableKey = current.messageId || current.clientMessageId;
            const fallbackKey = `${(current.sender || '').trim().toLowerCase()}|${current.timestamp}|${current.body || ''}|${current.reply || ''}`;
            const messageKey = stableKey || fallbackKey;
            if (seenKeys.has(messageKey)) continue;
            seenKeys.add(messageKey);
            uniqueData.push(current);
        }

        allHistoryData = uniqueData;

        // Update UI
        if (!viewContacts.classList.contains('hidden')) renderContactList();
        if (!viewChatRoom.classList.contains('hidden') && activeChatSender) renderChatMessages(); 
    };
}
function renderContactList() {
    const listContainer = document.getElementById('contactsListContainer');
    const scrollTop = listContainer.scrollTop; 
    listContainer.innerHTML = '';

    const groups = {};
    
    allHistoryData.forEach(msg => {
        const rawSender = msg.sender || 'System';
        const senderKey = rawSender.toLowerCase(); 
        if(!groups[senderKey]) groups[senderKey] = { displayName: rawSender, msgs: [] };
        groups[senderKey].displayName = rawSender; 
        groups[senderKey].msgs.push(msg);
    });

    const sortedSenders = Object.values(groups).map(group => {
        const msgs = group.msgs;
        const lastMsg = msgs[msgs.length - 1];
        const isOutgoing = lastMsg.direction === 'outgoing' || lastMsg.reply;
        
        let lastText = isOutgoing ? `אתה: ${lastMsg.body || lastMsg.reply}` : lastMsg.body;
        
        const hasImage = lastMsg.image || (lastMsg.body && lastMsg.body.includes('/uploads/'));
        if (hasImage && (!lastText || lastText === lastMsg.image)) {
            lastText = isOutgoing ? "שלחת תמונה" : "📷 תמונה";
        }
        
        return {
            name: group.displayName, 
            lastMsg: lastText,
            timestamp: lastMsg.timestamp,
            msgs: msgs
        };
    }).sort((a,b) => b.timestamp - a.timestamp);

    if(sortedSenders.length === 0) {
        listContainer.innerHTML = '<div class="empty-state">אין צ׳אטים פעילים.<br>לחץ על + להתחלה.</div>';
        return;
    }

    renderListInBatches(sortedSenders, listContainer, (contact) => {
        const dateObj = new Date(contact.timestamp);
        const timeStr = dateObj.getHours() + ':' + String(dateObj.getMinutes()).padStart(2, '0');
        const displayName = getDisplayName(contact.name); 
        const menuId = `menu-${contact.name.replace(/[^a-zA-Z0-9]/g, '')}`;

        const div = document.createElement('div');
        div.className = 'contact-item';
        div.addEventListener('click', () => showChatRoom(contact.name));

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.innerHTML = '<span class="material-icons">person</span>';

        const info = document.createElement('div');
        info.className = 'contact-info';
        info.innerHTML = `
            <div class="contact-name">${displayName}</div>
            <div class="contact-last-msg">${contact.lastMsg}</div>`;

        const meta = document.createElement('div');
        meta.className = 'contact-meta';
        meta.textContent = timeStr;

        const actions = document.createElement('div');
        actions.className = 'contact-actions';
        const moreBtn = document.createElement('button');
        moreBtn.className = 'material-icons more-btn';
        moreBtn.type = 'button';
        moreBtn.setAttribute('aria-label', 'פעולות');
        moreBtn.setAttribute('title', 'פעולות');
        moreBtn.textContent = 'more_vert';
        moreBtn.addEventListener('click', (event) => toggleContactMenu(event, menuId));
        actions.appendChild(moreBtn);

        const menu = document.createElement('div');
        menu.id = menuId;
        menu.className = 'context-menu';

        const callBtn = document.createElement('button');
        const callIcon = document.createElement('span');
        callIcon.className = 'material-icons menu-icon menu-icon-call';
        callIcon.textContent = 'call';
        callBtn.appendChild(callIcon);
        callBtn.append(' התקשר');
        callBtn.addEventListener('click', (event) => callUser(event, contact.name));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'text-danger';
        const deleteIcon = document.createElement('span');
        deleteIcon.className = 'material-icons menu-icon menu-icon-delete';
        deleteIcon.textContent = 'delete';
        deleteBtn.appendChild(deleteIcon);
        deleteBtn.append(" מחק צ'אט");
        deleteBtn.addEventListener('click', (event) => deleteChatFromList(event, contact.name));

        menu.appendChild(callBtn);
        menu.appendChild(deleteBtn);

        div.appendChild(avatar);
        div.appendChild(info);
        div.appendChild(meta);
        div.appendChild(actions);
        div.appendChild(menu);
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
        menu.classList.add('show');
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
                (r.sender || 'System').toLowerCase() === senderName.toLowerCase()
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
function renderChatMessages() {
    const area = document.getElementById('messagesArea');
    if (!area) return;

    // Filter messages for this specific chat
    const chatMsgs = allHistoryData.filter(m => (m.sender || 'System').toLowerCase() === activeChatSender.toLowerCase());
    
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

    const isAtBottom = (area.scrollHeight - area.scrollTop - area.clientHeight) < 150;
    let lastDateStr = '';
    let hasNewMessage = false; 

    chatMsgs.forEach(msg => {
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

        // Check if message exists to avoid re-rendering
        if (document.getElementById(msgId)) return; 

        // --- RENDER NEW MESSAGE ---
        hasNewMessage = true;
        const timeStr = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        let bodyText = (msg.direction === 'outgoing' ? msg.body : msg.reply) || msg.body || '';
        const attachmentUrl = msg.image || (bodyText && bodyText.includes('/uploads/') ? bodyText : null);
        const thumbUrl = msg.thumbnail || msg.thumbUrl || null;
        let mediaHtml = '';

        if (attachmentUrl) {
            const lowerUrl = attachmentUrl.toLowerCase();
            if (lowerUrl.endsWith('.pdf')) {
                mediaHtml = `
                    <a href="${attachmentUrl}" target="_blank" class="msg-attachment">
                        <div class="msg-attachment-icon">📄</div>
                        <div class="msg-attachment-meta">
                            <span class="msg-attachment-title">מסמך.pdf</span>
                            <span class="msg-attachment-subtitle">לחץ לפתיחה</span>
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
        const isOutgoing = (msg.direction === 'outgoing' || msg.reply);
        div.className = isOutgoing ? 'msg-row row-outgoing' : 'msg-row row-incoming';

        // Add Bubble
        const bubble = document.createElement('div');
        bubble.className = `msg-bubble ${isOutgoing ? 'bubble-outgoing' : 'bubble-incoming'}`;
        
        // Attach Long Press (Delete) Event
        if (typeof addLongPressEvent === 'function') {
            addLongPressEvent(bubble, () => showDeleteOptions(msg.id, msg));
        }

        bubble.innerHTML = 
            (!isOutgoing ? `<span class="msg-title">${getDisplayName(msg.sender)}</span>` : '') +
            (mediaHtml || '') +
            (bodyText ? `<div>${formatMessageText(bodyText)}</div>` : '') +
            `<div class="msg-time">` +
                `${timeStr}` +
                (isOutgoing ? getDeliveryStatusMarkup(msg.deliveryStatus || 'sent') : '') +
            `</div>`;

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

    if (justOpenedChat || (hasNewMessage && isAtBottom)) {
         scrollToBottom();
         justOpenedChat = false; 
    }
}// --- DELETE SPECIFIC CHAT ---
async function deleteCurrentChat() {
    if (!activeChatSender) return;
    
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
                (r.sender || 'System').toLowerCase() === activeChatSender.toLowerCase()
            );

            if (toDelete.length === 0) {
                showToast('אין הודעות למחיקה', 'info');
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
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (e) => reject(e);
        request.onsuccess = (e) => resolve(e.target.result);
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
    });
}
function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
    });
}

// --- LOCATION FUNCTION ---
function shareLocation() {
    if (!navigator.geolocation) {
        showToast('המכשיר לא תומך במיקום', 'error');
        return;
    }
    
    const area = document.getElementById('messagesArea');
    const tempId = 'loc-temp-' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.className = 'msg-row row-outgoing';
    tempDiv.innerHTML = `<div class="msg-bubble bubble-outgoing"><i>משיג מיקום...</i></div>`;
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
    const newRecord = {
        messageId,
        sender: activeChatSender,
        user: currentUserContext,
        body: finalBody || (imageUrl ? imageUrl : ''),
        image: imageUrl, 
        thumbnail: thumbnailUrl || null,
        direction: 'outgoing', 
        deliveryStatus: 'pending',
        timestamp: new Date().getTime(),
        dateString: new Date().toLocaleString()
    };
    
    const savedRecord = await saveNewMessageToDB(newRecord);
    allHistoryData.push(savedRecord); 
    renderChatMessages(); 
    scrollToBottom();

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
    }
}
window.addEventListener('focus', refreshOnVisible);

// --- AUTO RELOAD ON UPDATE ---
let currentAppVersion = null;
async function checkVersion() {
    if (document.hidden) return; 

    try {
        // Add timestamp to prevent caching of the version check itself
        const res = await fetchWithRetry(VERSION_CHECK_URL + '?t=' + Date.now(), {}, { timeoutMs: 8000, retries: 1 });
        
        if (res.status === 429) {
            console.warn("Too many requests. Skipping version check.");
            return;
        }

        const data = await res.json();
        const serverVersion = data.version;

        // 1. First Load: Just set the variable
        if (currentAppVersion === null) {
            currentAppVersion = serverVersion;
            return;
        }

        // 2. Update Detected: Clear Cache and Reload
        if (currentAppVersion !== serverVersion) {
            console.log(`Update detected: ${currentAppVersion} -> ${serverVersion}`);
            
            // A. Update Service Worker
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                for (let registration of registrations) { 
                    await registration.update(); 
                    if (registration.waiting) {
                        // Force the waiting worker to activate
                        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                    }
                }
            }

            // B. Clear Browser Cache Storage (Crucial for PWAs)
            if ('caches' in window) {
                const keys = await caches.keys();
                // Delete all old caches
                await Promise.all(keys.map(key => caches.delete(key)));
            }

            // C. Force Reload from Server (ignoring cache)
            window.location.reload(true);
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
        const updatedRecord = { ...selectedMessageData, body: '🚫 הודעה זו נמחקה', image: null, thumbnail: null };
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
        showToast("לא ניתן להתקשר למספר זה", 'error'); // "Cannot call this number"
        return;
    }

    // 4. Open the dialer
    window.location.href = `tel:${normalized}`;
}