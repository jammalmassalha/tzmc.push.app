// --- BOT STATE ---
let botFlowStep = null; 
let tempRegistrationData = {
    id: '', firstName: '', lastName: '', phone: '', 
    category: '', 
    deptId: null, deptName: '', 
    actionId: null, actionName: ''
};

// Temp storage for lists so user can select by number
let tempDepartments = []; 
let tempActions = [];

const botTranslate = (key, vars) => (window.I18N && typeof window.I18N.t === 'function' ? window.I18N.t(key, vars) : key);
const botFetchWithRetry = window.fetchWithRetry ? window.fetchWithRetry : fetch;

// ==========================================
//        UPDATED BOT LOGIC (js/bot.js)
// ==========================================

// --- START CHAT ---
// --- START CHAT (FIXED FOR MOBILE FOCUS) ---
async function startBotChat(selectedCategory = 'General') {
    // 1. UI IMMEDIATE UPDATES (Must happen inside the click event loop)
    const btnNewChat = document.getElementById('btnNewChat');
    if(btnNewChat) btnNewChat.classList.add('hidden');
    
    // Visually wipe screen immediately
    const msgArea = document.getElementById('messagesArea');
    if (msgArea) msgArea.innerHTML = ''; 

    // Clear local memory immediately (so old chats don't flash)
    if (typeof allHistoryData !== 'undefined') {
        allHistoryData = allHistoryData.filter(m => m.sender !== 'Bot' && m.sender !== 'Support');
    }

    // Switch View (Synchronous)
    const botName = "Bot";
    showChatRoom(botName);

    // FOCUS NOW (While we still have the user 'click' permission)
    const input = document.getElementById('chatInputBar');
    if (input) {
        // Force focus immediately
        input.focus();
        // Backup for Android quirks
        setTimeout(() => { input.focus(); }, 100); 
    }

    // 2. DATA WORK (Async stuff happens in background now)
    
    // Reset Data
    tempRegistrationData = {
        id: '', firstName: '', lastName: '', phone: '',
        category: selectedCategory,
        deptId: null, deptName: '', actionId: null, actionName: ''
    };
    
    if (!currentUserContext) currentUserContext = "Setup_User";
    
    // Clear DB (This takes time, but keyboard is already opening)
    await clearBotChatHistory();
    
    botFlowStep = 'WAITING_ID';
    
    const welcomeMsg = {
        sender: botName, user: currentUserContext,
        body: botTranslate('bot_welcome', { category: selectedCategory }),
        direction: 'incoming', timestamp: new Date().getTime()
    };
    
    const savedWelcome = await saveNewMessageToDB(welcomeMsg);
    allHistoryData.push(savedWelcome);
    renderChatMessages();
    scrollToBottom();
}
async function handleBotRegistrationStep(userReply) {
    const botName = "Bot";
    let nextQuestion = "";
    let isFinished = false;

    // Helper to send bot message
    const sendBotMsg = async (text) => {
        const msg = { sender: botName, user: currentUserContext, body: text, direction: 'incoming', timestamp: new Date().getTime() };
        const savedMsg = await saveNewMessageToDB(msg);
        allHistoryData.push(savedMsg);
        renderChatMessages();
        scrollToBottom();
    };

    switch (botFlowStep) {
        case 'WAITING_ID':
            tempRegistrationData.id = userReply.trim().toLowerCase();
            currentUserContext = tempRegistrationData.id;
            localStorage.setItem('username', tempRegistrationData.id);
            botFlowStep = 'WAITING_FIRST';
            nextQuestion = botTranslate('bot_first_name');
            break;

        case 'WAITING_FIRST':
            tempRegistrationData.firstName = userReply;
            botFlowStep = 'WAITING_LAST';
            nextQuestion = botTranslate('bot_last_name');
            break;

        case 'WAITING_LAST':
            tempRegistrationData.lastName = userReply;
            botFlowStep = 'WAITING_PHONE';
            nextQuestion = botTranslate('bot_phone');
            break;

        case 'WAITING_PHONE':
            tempRegistrationData.phone = userReply;
            
            // IF CATEGORY IS SUPPORT -> GO TO DEPARTMENTS
            if (tempRegistrationData.category === 'Support') {
                await sendBotMsg(botTranslate('bot_loading_departments'));
                
                try {
                    const res = await botFetchWithRetry(SUBSCRIPTION_URL + '?action=get_departments', {}, { timeoutMs: 10000, retries: 2 });
                    const data = await res.json();
                    
                    if (data.result === 'success' && data.data.length > 0) {
                        tempDepartments = data.data; 
                        
                        // --- CHANGED: Build HTML List (<ul>) ---
                        let listStr = `${botTranslate('bot_select_department')}<br>`;
                        listStr += "<ul class='bot-list'>";
                        
                        tempDepartments.forEach((dept, index) => {
                            listStr += `<li class='bot-list-item'><b>${index + 1}.</b> ${dept.name}</li>`;
                        });
                        listStr += "</ul>";
                        // ---------------------------------------
                        
                        botFlowStep = 'WAITING_DEPT_SELECT';
                        nextQuestion = listStr;
                    } else {
                        nextQuestion = botTranslate('bot_error_departments');
                        botFlowStep = null;
                    }
                } catch (e) {
                    console.error(e);
                    nextQuestion = botTranslate('bot_error_departments');
                    botFlowStep = null;
                }
            } else {
                // Not Support? Just register normally
                isFinished = true;
                nextQuestion = botTranslate('bot_registering');
            }
            break;

        case 'WAITING_DEPT_SELECT':
            const deptIndex = parseInt(userReply) - 1;
            
            if (isNaN(deptIndex) || deptIndex < 0 || deptIndex >= tempDepartments.length) {
                nextQuestion = botTranslate('bot_invalid_number');
            } else {
                // Save Selection
                const selectedDept = tempDepartments[deptIndex];
                tempRegistrationData.deptId = selectedDept.id;
                tempRegistrationData.deptName = selectedDept.name;

                await sendBotMsg(`${botTranslate('bot_loading_actions')} <b>${selectedDept.name}</b>`);

                // FETCH ACTIONS
                try {
                    const res = await botFetchWithRetry(`${SUBSCRIPTION_URL}?action=get_actions&deptId=${selectedDept.id}`, {}, { timeoutMs: 10000, retries: 2 });
                    const data = await res.json();
                    
                    if (data.result === 'success' && data.data.length > 0) {
                        tempActions = data.data;
                        
                        // --- CHANGED: Build HTML List (<ul>) ---
                        let listStr = `${botTranslate('bot_select_action')}<br>`;
                        listStr += "<ul class='bot-list'>";
                        
                        tempActions.forEach((act, index) => {
                            listStr += `<li class='bot-list-item'><b>${index + 1}.</b> ${act.name}</li>`;
                        });
                        listStr += "</ul>";
                        // ---------------------------------------
                        
                        botFlowStep = 'WAITING_ACTION_SELECT';
                        nextQuestion = listStr;
                    } else {
                        isFinished = true;
                        nextQuestion = botTranslate('bot_no_actions');
                    }
                } catch(e) {
                    nextQuestion = botTranslate('bot_error_actions');
                }
            }
            break;

        case 'WAITING_ACTION_SELECT':
            const actIndex = parseInt(userReply) - 1;
            if (isNaN(actIndex) || actIndex < 0 || actIndex >= tempActions.length) {
                nextQuestion = botTranslate('bot_invalid_number');
            } else {
                const selectedAction = tempActions[actIndex];
                tempRegistrationData.actionId = selectedAction.id;
                tempRegistrationData.actionName = selectedAction.name;
                
                isFinished = true;
                nextQuestion = botTranslate('bot_registering');
            }
            break;
    }

    await sendBotMsg(nextQuestion);

    if (isFinished) {
        performBotSupportRegistration();
    }
}
// --- SPECIAL REGISTRATION FOR SUPPORT ---
// --- UPDATED REGISTRATION FUNCTION (js/bot.js) ---
async function performBotSupportRegistration() {
    try {
        let subscription = null;

        // 1. Get Push Subscription
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            subscription = await reg.pushManager.getSubscription();
            
            // If not subscribed yet, force subscription
            if (!subscription) {
                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });
            }
        }

        // 2. Send Data to Server
        await botFetchWithRetry(SUBSCRIPTION_URL, { 
            method: 'POST', 
            mode: 'no-cors', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                action: 'bot_support_register',
                username: tempRegistrationData.id, 
                firstName: tempRegistrationData.firstName,
                lastName: tempRegistrationData.lastName,
                phone: tempRegistrationData.phone,
                department: tempRegistrationData.deptName,
                actionChoice: tempRegistrationData.actionName || 'General',
                subscription: subscription // <--- Sending the key
            }) 
        }, { timeoutMs: 10000, retries: 2 });

        // 3. Success Message
        const successMsg = {
            sender: "Bot", user: currentUserContext,
            body: `✅ ${botTranslate('bot_support_logged')}`,
            direction: 'incoming', timestamp: new Date().getTime() + 100
        };
        const savedSuccess = await saveNewMessageToDB(successMsg);
        allHistoryData.push(savedSuccess);
        renderChatMessages();
        scrollToBottom();

    } catch (e) {
        console.error("Bot Registration Error:", e);
        // Fallback: Show error but assume data might have sent if it was just a network glitch
        const errorMsg = {
             sender: "Bot", user: currentUserContext,
             body: `⚠️ ${botTranslate('bot_support_error')}`,
             direction: 'incoming', timestamp: new Date().getTime() + 100
        };
        const savedError = await saveNewMessageToDB(errorMsg);
        allHistoryData.push(savedError);
        renderChatMessages();
    }
}