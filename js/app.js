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

var userMap = {};        // Fast lookup { "36826717": "Jamal Massalha" }
var selectedMessageId = null; // Store ID of message being deleted
var selectedMessageData = null; // Store the full message object
// --- CONFIG ---
const DB_NAME = 'PushNotificationsDB';
const STORE_NAME = 'history';
const DB_VERSION = 2;
const VAPID_PUBLIC_KEY = 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk';
const SUBSCRIPTION_URL = 'https://script.google.com/macros/s/AKfycbw70tnIlHsQTke8BxFhEbEQQJxMhKzN85cCTkJOuS_L7zUnCxNYLX-r2cxYU2j8jIn5/exec';

const NOTIFY_SERVER_URL = 'https://www.tzmc.co.il/notify/reply';
const UPLOAD_SERVER_URL = 'https://www.tzmc.co.il/notify/upload';
const VERSION_CHECK_URL = 'https://www.tzmc.co.il/notify/version';
const VERIFY_STATUS_URL = 'https://www.tzmc.co.il/notify/verify-status'; // Added specific URL variable

// --- STATE ---
var currentUserContext = null; 
var activeChatSender = null;
var allHistoryData = [];
var cachedUserList = [];
var deferredPrompt;
var justOpenedChat = false; 

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

// --- HELPER: DETECT BASE64, LINKS, AND IMAGES ---
// --- HELPER: DETECT BASE64, LINKS, IMAGES, AND VIDEOS ---
function formatMessageText(text) {
    if (!text) return '';
    let processedText = text;

    // --- 1. BASE64 DETECTION (Images & PDFs) ---
    const base64Regex = /(data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,[a-zA-Z0-9+/=]+)/g;
    processedText = processedText.replace(base64Regex, function(match, fullDataUri, mimeType) {
        if (mimeType.match(/^image\/(png|jpeg|jpg|gif|webp)/i)) {
             return `<br><img src="${fullDataUri}" class="msg-image" onclick="window.open(this.src)" onload="scrollToBottom()"><br>`;
        }
        if (mimeType === 'application/pdf') {
             return `<a href="${fullDataUri}" download="document.pdf" style="display:flex; align-items:center; gap:10px; text-decoration:none; color:#333; background:#f0f2f5; padding:8px 12px; border-radius:8px; margin-top:5px; border:1px solid #ddd;">
                        <div style="font-size:28px;">📄</div> 
                        <div style="display:flex; flex-direction:column;">
                            <span style="font-weight:500; font-size:14px;">PDF Document</span>
                            <span style="font-size:11px; color:#666;">Tap to download</span>
                        </div>
                     </a>`;
        }
        return `<a href="${fullDataUri}" download="file" style="color:#027eb5; text-decoration:underline;">
                    <span class="material-icons" style="font-size:14px; vertical-align:middle;">download</span> Download File
                </a>`;
    });

    // --- 2. STANDARD URL DETECTION ---
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return processedText.replace(urlRegex, function(url) {
        const cleanUrl = url.trim();
        const lowerUrl = cleanUrl.toLowerCase();

        // A. IMAGE LINKS
        if (lowerUrl.match(/\.(jpeg|jpg|gif|png|webp)($|\?)/)) {
            return `<img src="${cleanUrl}" class="msg-image" onclick="window.open(this.src)" onload="scrollToBottom()">`;
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
                        <span class="material-icons" style="font-size:18px; color:#e91e63;">location_on</span> 
                        <span style="font-weight:500;">📍 My Location</span>
                     </a>`;
        }

        // F. DEFAULT LINK
        return `<a href="${cleanUrl}" target="_blank" style="color:#027eb5; text-decoration:underline; word-break:break-all;">${cleanUrl}</a>`;
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
            await navigator.serviceWorker.register('./sw.js');
            
            // [NEW] Listen for navigation messages from SW (iOS Fix)
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.action === 'refresh') {
                    console.log("Refreshing view due to background update...");
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
    chatInput.addEventListener('focus', function() {
        // Small delay to allow keyboard to fully open
        setTimeout(() => {
            scrollToBottom();
        }, 300);
    });
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
    setTimeout(() => {
        console.log("⏰ Executing 70s Status Check...");

        fetch(VERIFY_STATUS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: username,
                subscription: subscription
            })
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'blocked') {
                console.warn("User is blocked. Notification should arrive shortly.");
            } else {
                console.log("User status verified: Active.");
            }
        })
        .catch(err => console.error("Error checking status:", err));

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

// 2. Close menu if clicked outside
document.addEventListener('click', function(event) {
    const attachMenu = document.getElementById('attachMenu');
    const attachBtn = document.querySelector('.attach-dropdown .icon-btn');
    if (attachMenu && !attachMenu.classList.contains('hidden')) {
        if (!attachMenu.contains(event.target) && !attachBtn.contains(event.target)) {
            attachMenu.classList.add('hidden');
        }
    }

    const mainMenu = document.getElementById('mainMenu');
    const mainBtn = document.querySelector('#viewContacts .app-header .icon-btn'); 
    
    if (mainMenu && !mainMenu.classList.contains('hidden')) {
        if (!mainMenu.contains(event.target) && (mainBtn && !mainBtn.contains(event.target))) {
            mainMenu.classList.add('hidden');
        }
    }
});

function clearAllChats() { 
    if(!confirm("⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL chat history from this phone.\nThis cannot be undone.")) return;

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction([STORE_NAME], "readwrite");
        const objectStore = transaction.objectStore(STORE_NAME);
        const clearRequest = objectStore.clear();

        clearRequest.onsuccess = () => {
            alert("✅ All chats cleared successfully.");
            localStorage.removeItem('activeChat');
            location.reload(); 
        };

        clearRequest.onerror = (e) => {
            alert("❌ Error clearing database: " + e.target.error);
        };
    };
    
    request.onerror = (e) => {
        console.error("DB Error", e);
        alert("Could not open database.");
    };
}

// 3. The Backup Function (Chunked Upload)
async function backupChats() {
    if (!currentUserContext) return alert("Not logged in.");

    const btn = document.querySelector('#mainMenu button');
    const originalText = ' <span class="material-icons" style="color:#00a884;">cloud_upload</span> Backup Chats';
    
    function updateStatus(text) {
        if(btn) btn.innerHTML = `<span>⏳</span> ${text}`;
    }

    updateStatus('Starting...');

    try {
        updateStatus('Reading DB...');
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = async () => {
            const rawRecords = request.result;

            if (!rawRecords || rawRecords.length === 0) {
                alert("No chats found.");
                if(btn) btn.innerHTML = originalText;
                return;
            }

            updateStatus(`Found ${rawRecords.length} msgs...`);
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
                
                updateStatus(`Sending ${i + 1}/${totalBatches}...`);

                try {
                    const response = await fetch('https://www.tzmc.co.il/notify/backup', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chats: batch })
                    });

                    if (!response.ok) {
                        throw new Error(`Batch ${i+1} failed (Error ${response.status})`);
                    }
                } catch (batchErr) {
                    console.error(batchErr);
                    alert(`❌ Upload stopped at batch ${i+1}. Check connection.`);
                    if(btn) btn.innerHTML = originalText;
                    return; 
                }
                
                await new Promise(r => setTimeout(r, 200));
            }

            // 3. Success
            updateStatus('Done! ✅');
            setTimeout(() => { alert(`✅ Backup Complete! Uploaded ${allChats.length} messages.`); }, 100);
            
            setTimeout(() => { if(btn) btn.innerHTML = originalText; }, 2000);
        };

        request.onerror = () => {
            alert("❌ Could not read local database.");
            if(btn) btn.innerHTML = originalText;
        };

    } catch (e) {
        console.error(e);
        alert("❌ Error: " + e.message);
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
    debugger
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
    modalNewChat.classList.remove('hidden');
    userSearchInput.value = ''; 
    userSearchInput.focus();
    if (cachedUserList.length > 0) { renderUserList(cachedUserList); } 
    else { fetchUsersFromSheet(); }
}
function closeNewChatModal() { modalNewChat.classList.add('hidden'); }
function filterUserList() {
    const filter = userSearchInput.value.toLowerCase();
    const items = modalUserList.getElementsByClassName('contact-item');
    for (let i = 0; i < items.length; i++) {
        const nameDiv = items[i].getElementsByClassName('contact-name')[0];
        if (nameDiv) {
            const txtValue = nameDiv.textContent || nameDiv.innerText;
            items[i].style.display = txtValue.toLowerCase().indexOf(filter) > -1 ? "" : "none";
        }
    }
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
        var currentUser = localStorage.getItem('username'); 

        if (!currentUser) {
            console.warn("fetchUsersFromSheet: No user found. Skipping.");
            return;
        }
        const url = SUBSCRIPTION_URL + '?action=get_contacts&user=' + encodeURIComponent(currentUser);
        
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.users && Array.isArray(data.users)) {
            cachedUserList = data.users; 
            
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
            if (modalUserList) {
                modalUserList.innerHTML = '<div style="padding:20px; text-align:center;">No contacts found (Access Denied or Empty).</div>';
            }
        }
    } catch (e) {
        console.error("User fetch error:", e);
    }
}

function renderUserList(users) {
    modalUserList.innerHTML = '';
    users.forEach(u => {
        if (u.username.toLowerCase() === currentUserContext.toLowerCase()) return;
        
        const div = document.createElement('div');
        div.className = 'contact-item';
        div.onclick = () => { showChatRoom(u.username); closeNewChatModal(); };
        
        div.innerHTML = `
            <div class="avatar"><span class="material-icons">person</span></div>
            <div class="contact-info">
                <div class="contact-name">${u.displayName}</div>
                <div class="contact-meta" style="margin:0; font-size:11px;">${u.username}</div>
            </div>`;
        modalUserList.appendChild(div);
    });
    filterUserList(); 
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
        for (let i = 0; i < filtered.length; i++) {
            const current = filtered[i];
            const prev = uniqueData[uniqueData.length - 1];

            // Normalize senders for comparison (fixes "054..." vs "Jamal" mismatch)
            const currSender = (current.sender || '').trim().toLowerCase();
            const prevSender = prev ? (prev.sender || '').trim().toLowerCase() : '';

            if (prev && 
                prev.body === current.body && 
                prevSender === currSender &&
                Math.abs(prev.timestamp - current.timestamp) < 5000) { // 5 second tolerance
                
                // If duplicates found, we skip the 'current' one (keeping the older one).
                // This ensures the ID 'msg-timestamp' stays stable.
                continue; 
            }
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
        
        let lastText = isOutgoing ? `You: ${lastMsg.body || lastMsg.reply}` : lastMsg.body;
        
        const hasImage = lastMsg.image || (lastMsg.body && lastMsg.body.includes('/uploads/'));
        if (hasImage && (!lastText || lastText === lastMsg.image)) {
            lastText = isOutgoing ? "You sent a photo" : "📷 Photo";
        }
        
        return {
            name: group.displayName, 
            lastMsg: lastText,
            timestamp: lastMsg.timestamp,
            msgs: msgs
        };
    }).sort((a,b) => b.timestamp - a.timestamp);

    if(sortedSenders.length === 0) {
        listContainer.innerHTML = '<div style="text-align:center; padding:20px; color:#999;">No active chats.<br>Click + to start one.</div>';
        return;
    }

    sortedSenders.forEach(contact => {
        const dateObj = new Date(contact.timestamp);
        const timeStr = dateObj.getHours() + ':' + String(dateObj.getMinutes()).padStart(2, '0');
        const displayName = getDisplayName(contact.name); 
        const menuId = `menu-${contact.name.replace(/[^a-zA-Z0-9]/g, '')}`;

        const div = document.createElement('div');
        div.className = 'contact-item';
        div.onclick = () => showChatRoom(contact.name);
        
        div.innerHTML = `
            <div class="avatar"><span class="material-icons">person</span></div>
            <div class="contact-info">
                <div class="contact-name">${displayName}</div>
                <div class="contact-last-msg">${contact.lastMsg}</div>
            </div>
            <div class="contact-meta">${timeStr}</div>
            
            <div class="contact-actions">
                <button class="material-icons more-btn" onclick="toggleContactMenu(event, '${menuId}')">more_vert</button>
                
                
            </div>
            <div id="${menuId}" class="context-menu">
                    
                <button onclick="callUser(event, '${contact.name}')">
                    <span class="material-icons" style="font-size:18px; color:#4caf50;">call</span>
                    התקשר
                </button>

                <button onclick="deleteChatFromList(event, '${contact.name}')" class="text-danger">
                    <span class="material-icons" style="font-size:18px;">delete</span>
                    מחק צ'אט
                </button>
            </div>
        `;
        listContainer.appendChild(div);
    });

    listContainer.scrollTop = scrollTop;
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
function deleteChatFromList(event, senderName) {
    // 1. STOP the click from bubbling up to the row (which would open the chat)
    if (event) {
        event.stopPropagation();
    }

    if (!confirm(`Delete chat with ${getDisplayName(senderName)}?`)) return;

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
    const validIds = new Set(chatMsgs.map(m => `msg-${m.timestamp}`));
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
        const msgId = `msg-${msg.timestamp}`;
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
        let mediaHtml = '';

        if (attachmentUrl) {
            const lowerUrl = attachmentUrl.toLowerCase();
            if (lowerUrl.endsWith('.pdf')) {
                mediaHtml = `
                    <a href="${attachmentUrl}" target="_blank" style="display:flex; align-items:center; gap:10px; text-decoration:none; color:#333; background:#f0f2f5; padding:8px 12px; border-radius:8px; margin-top:5px; border:1px solid #ddd;">
                        <div style="font-size:28px;">📄</div> 
                        <div style="display:flex; flex-direction:column;">
                            <span style="font-weight:500; font-size:14px;">Document.pdf</span>
                            <span style="font-size:11px; color:#666;">Tap to open</span>
                        </div>
                    </a>`;
                if (bodyText === attachmentUrl) bodyText = '';
            } else {
                mediaHtml = `<img src="${attachmentUrl}" class="msg-image" onclick="window.open(this.src)" onload="scrollToBottom()">`;
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
                (isOutgoing ? `<span class="material-icons" style="font-size:15px; color:#4fb6ec; vertical-align:middle; margin-right:7px;">done_all</span>` : '') +
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
function deleteCurrentChat() {
    if (!activeChatSender) return;
    
    // Confirm with user
    if (!confirm("Are you sure you want to delete this conversation?")) return;

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
                alert("Chat is empty.");
                return;
            }

            let count = 0;
            toDelete.forEach(record => {
                // Delete each message by ID
                store.delete(record.id).onsuccess = () => {
                    count++;
                    // When all are deleted, return to contact list
                    if (count === toDelete.length) {
                        alert("Conversation deleted.");
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
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}
function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
    });
}

// --- LOCATION FUNCTION ---
function shareLocation() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }
    
    const area = document.getElementById('messagesArea');
    const tempId = 'loc-temp-' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.className = 'msg-row row-outgoing';
    tempDiv.innerHTML = `<div class="msg-bubble bubble-outgoing"><i>Getting location...</i></div>`;
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
            alert('Unable to retrieve location. Please allow permissions.');
        }
    );
}

// --- SEND MESSAGE ---
async function sendMessage(text = null, imageUrl = null) {
    let finalBody = text;
    if (!finalBody && !imageUrl) {
        const input = document.getElementById('chatInputBar');
        finalBody = input.value.trim();
        if(!finalBody) return;
        input.value = '';
    }

    const newRecord = {
        sender: activeChatSender,
        user: currentUserContext,
        body: finalBody || (imageUrl ? imageUrl : ''),
        image: imageUrl, 
        direction: 'outgoing', 
        timestamp: new Date().getTime(),
        dateString: new Date().toLocaleString()
    };
    
    await saveNewMessageToDB(newRecord);
    allHistoryData.push(newRecord); 
    renderChatMessages(); 
    scrollToBottom();

    // --- BOT INTERCEPTION ---
    if (typeof botFlowStep !== 'undefined' && botFlowStep) {
        setTimeout(() => handleBotRegistrationStep(finalBody), 600);
        return; 
    }

    try {
        
        const myName = getDisplayName(currentUserContext); 

        await fetch(NOTIFY_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user: currentUserContext, 
                senderName: myName, // <--- SEND THE NAME
                reply: finalBody,
                imageUrl: imageUrl, 
                originalSender: activeChatSender 
            })
        });
    } catch(e) { console.error("Send failed", e); }
}

async function handleFileUpload(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        const formData = new FormData();
        formData.append('file', file);
        
        const area = document.getElementById('messagesArea');
        const tempId = 'temp-' + Date.now();
        const tempDiv = document.createElement('div');
        tempDiv.id = tempId;
        tempDiv.className = 'msg-row row-outgoing';
        tempDiv.innerHTML = `<div class="msg-bubble bubble-outgoing"><i>Uploading ${file.name}...</i></div>`;
        area.appendChild(tempDiv);
        scrollToBottom();

        try {
            const res = await fetch(UPLOAD_SERVER_URL, { method: 'POST', body: formData });
            const data = await res.json();
            
            const tempEl = document.getElementById(tempId);
            if(tempEl) tempEl.remove();

            if (data.status === 'success') { 
                const isPdf = data.url.toLowerCase().endsWith('.pdf');
                if (isPdf) {
                    sendMessage(data.url, null); 
                } else {
                    sendMessage(null, data.url); 
                }
            } else { 
                alert('Upload failed'); 
            }
        } catch (e) {
            const tempEl = document.getElementById(tempId);
            if(tempEl) tempEl.remove();
            console.error(e); 
            alert('Upload error');
        }
        input.value = '';
    }
}

function saveNewMessageToDB(record) {
    return new Promise((resolve) => {
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add(record);
            resolve();
        });
    });
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
        fetch('https://www.tzmc.co.il/notify/reset-badge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: currentUserContext })
        }).catch(err => console.error("Failed to reset server badge:", err));
    }
}

// Clear badge when the app becomes visible
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        clearAppBadge();
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
    let user = usernameInput.value.trim().toLowerCase();
    if(!user) return alert('Enter username');
    console.log(user);
    document.getElementById('statusMessage').textContent = 'Requesting permission...';
    
    if (!('serviceWorker' in navigator)) return;
    
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

        await fetch(SUBSCRIPTION_URL, { 
            method: 'POST', 
            mode: 'no-cors', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        scheduleStatusCheck(user, sub);
        localStorage.setItem('username', user);
        currentUserContext = user;
        showContacts();
        fetchUsersFromSheet();
    } catch (e) {
        console.error(e);
        document.getElementById('statusMessage').textContent = 'Failed. Try adding to Home Screen first.';
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
setInterval(() => { if(currentUserContext && !document.hidden) loadAndGroupHistory(); }, 5000);

// [UPDATED] Check for contact updates every 60 seconds (1 minute)
setInterval(() => { if(currentUserContext && !document.hidden) fetchUsersFromSheet(); }, 60000);

// --- AUTO RELOAD ON UPDATE ---
let currentAppVersion = null;
async function checkVersion() {
    if (document.hidden) return; 

    try {
        // Add timestamp to prevent caching of the version check itself
        const res = await fetch(VERSION_CHECK_URL + '?t=' + Date.now());
        
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
    const attachBtn = document.querySelector('.attach-dropdown .icon-btn');
    if (attachMenu && !attachMenu.classList.contains('hidden')) {
        if (!attachMenu.contains(event.target) && !attachBtn.contains(event.target)) {
            attachMenu.classList.add('hidden');
        }
    }

    // ... existing mainMenu logic ...
    const mainMenu = document.getElementById('mainMenu');
    const mainBtn = document.querySelector('#viewContacts .app-header .icon-btn'); 
    
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
    if (msgData.direction === 'outgoing' || msgData.sender === currentUserContext) {
        btnEveryone.style.display = 'block';
    } else {
        btnEveryone.style.display = 'none';
    }
    
    modal.classList.remove('hidden');
}

// 2. Close Modal
function closeDeleteModal() {
    document.getElementById('deleteModal').classList.add('hidden');
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
        const el = document.getElementById(`msg-${selectedMessageData.timestamp}`);
        if(el) el.remove();
        
        // Remove from memory array
        allHistoryData = allHistoryData.filter(m => m.id !== selectedMessageId);
    } 
    else if (type === 'everyone') {
        // DELETE FOR EVERYONE: Update text to "You deleted this message"
        const updatedRecord = { ...selectedMessageData, body: '🚫 You deleted this message', image: null };
        store.put(updatedRecord);
        
        // Tell Server to notify recipient
        fetch('https://www.tzmc.co.il/notify/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timestamp: selectedMessageData.timestamp,
                sender: currentUserContext,
                recipient: activeChatSender 
            })
        });
        
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

                await fetch(SUBSCRIPTION_URL, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
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
    if (!phoneNumber || phoneNumber.length < 3 || isNaN(phoneNumber)) {
        alert("לא ניתן להתקשר למספר זה"); // "Cannot call this number"
        return;
    }

    // 4. Open the dialer
    window.location.href = `tel:${phoneNumber}`;
}