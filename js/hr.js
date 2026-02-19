// hr.js - HR (ציפי) pinned chat logic
(() => {
    const HR_CHAT_NAME = 'ציפי';
    const HR_STEPS_ACTION = 'get_hr_steps';
    const HR_STEPS_ACTION_LIST = 'get_hr_steps_action';
    const HR_WELCOME_KEY_PREFIX = 'hr_welcome_sent_';
    const HR_STATE_KEY_PREFIX = 'hr_state_';
    const HR_UPLOAD_BASE_URL = '/notify/uploads/';
    const STEPS_CACHE_TTL_MS = 5 * 60 * 1000;
    const ACTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
    let stepsCache = { at: 0, steps: [] };
    let actionsCache = {};

    const hrFetch = window.fetchWithRetry ? window.fetchWithRetry : fetch;
    const hrTranslate = (key, vars) => (window.I18N && typeof window.I18N.t === 'function' ? window.I18N.t(key, vars) : key);

    const normalizeKey = (value) => String(value || '').trim().toLowerCase();

    function isHrChat(name) {
        return normalizeKey(name) === normalizeKey(HR_CHAT_NAME);
    }

    function getPinnedChat() {
        return { name: HR_CHAT_NAME, pinned: true, isGroup: false };
    }

    function getCurrentUser() {
        if (typeof currentUserContext !== 'undefined' && currentUserContext) {
            return currentUserContext;
        }
        const stored = localStorage.getItem('username');
        if (stored && typeof currentUserContext !== 'undefined') {
            currentUserContext = stored;
        }
        return stored || '';
    }

    function getStateKey(userKey) {
        return HR_STATE_KEY_PREFIX + normalizeKey(userKey);
    }

    function loadHrState(userKey) {
        const raw = localStorage.getItem(getStateKey(userKey));
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    function saveHrState(userKey, state) {
        localStorage.setItem(getStateKey(userKey), JSON.stringify(state));
    }

    function resetHrState(userKey) {
        localStorage.removeItem(getStateKey(userKey));
        localStorage.removeItem(HR_WELCOME_KEY_PREFIX + normalizeKey(userKey));
    }

    function getLastUserMessage(userKey) {
        if (typeof allHistoryData === 'undefined' || !Array.isArray(allHistoryData)) return '';
        const userKeyNorm = normalizeKey(userKey);
        let lastRecord = null;
        allHistoryData.forEach(record => {
            if (!record) return;
            if (normalizeKey(record.sender) !== normalizeKey(HR_CHAT_NAME)) return;
            if (normalizeKey(record.user) !== userKeyNorm) return;
            if (record.direction !== 'outgoing') return;
            if (!lastRecord || (record.timestamp || 0) > (lastRecord.timestamp || 0)) {
                lastRecord = record;
            }
        });
        return lastRecord ? String(lastRecord.body || '').trim() : '';
    }

    function getLastHrIncomingMessage(userKey) {
        if (typeof allHistoryData === 'undefined' || !Array.isArray(allHistoryData)) return null;
        const userKeyNorm = normalizeKey(userKey);
        let lastRecord = null;
        allHistoryData.forEach(record => {
            if (!record) return;
            if (normalizeKey(record.sender) !== normalizeKey(HR_CHAT_NAME)) return;
            if (normalizeKey(record.user) !== userKeyNorm) return;
            if (record.direction !== 'incoming') return;
            if (!lastRecord || (record.timestamp || 0) > (lastRecord.timestamp || 0)) {
                lastRecord = record;
            }
        });
        return lastRecord;
    }

    function getLastHrMessage(userKey) {
        if (typeof allHistoryData === 'undefined' || !Array.isArray(allHistoryData)) return null;
        const userKeyNorm = normalizeKey(userKey);
        let lastRecord = null;
        allHistoryData.forEach(record => {
            if (!record) return;
            if (normalizeKey(record.sender) !== normalizeKey(HR_CHAT_NAME)) return;
            if (normalizeKey(record.user) !== userKeyNorm) return;
            if (!lastRecord || (record.timestamp || 0) > (lastRecord.timestamp || 0)) {
                lastRecord = record;
            }
        });
        return lastRecord;
    }

    async function fetchHrSteps() {
        const now = Date.now();
        if (stepsCache.steps.length && now - stepsCache.at < STEPS_CACHE_TTL_MS) {
            return stepsCache.steps;
        }
        if (typeof SUBSCRIPTION_URL === 'undefined' || !SUBSCRIPTION_URL) {
            return [];
        }
        try {
            const res = await hrFetch(`${SUBSCRIPTION_URL}?action=${HR_STEPS_ACTION}`, {}, { timeoutMs: 10000, retries: 2 });
            const payload = await res.json();
            if (payload && payload.result === 'success' && Array.isArray(payload.data)) {
                stepsCache = { at: now, steps: payload.data };
                return payload.data;
            }
        } catch (err) {
            console.warn('Failed to fetch HR steps', err);
        }
        return [];
    }

    async function fetchHrActions(serviceId) {
        if (!serviceId) return [];
        const now = Date.now();
        const cached = actionsCache[serviceId];
        if (cached && cached.actions && now - cached.at < ACTIONS_CACHE_TTL_MS) {
            return cached.actions;
        }
        if (typeof SUBSCRIPTION_URL === 'undefined' || !SUBSCRIPTION_URL) {
            return [];
        }
        try {
            const res = await hrFetch(`${SUBSCRIPTION_URL}?action=${HR_STEPS_ACTION_LIST}&serviceId=${encodeURIComponent(serviceId)}`, {}, { timeoutMs: 10000, retries: 2 });
            const payload = await res.json();
            if (payload && payload.result === 'success' && Array.isArray(payload.data)) {
                actionsCache[serviceId] = { at: now, actions: payload.data };
                return payload.data;
            }
        } catch (err) {
            console.warn('Failed to fetch HR actions', err);
        }
        return [];
    }

    function buildHrWelcomeMessage(contactName) {
        const safeName = contactName || '';
        const welcomeText = `<b>${safeName}</b> שלום, הגעת ל Tzipi- מערכת הפניות של משאבי אנוש.<br>` +
            'במערכת זו ניתן לקבל ולשלוח טפסים וכן לפנות במלל חופשי למשאבי אנוש ולהמשיך התכתבות. ' +
            '<br><br>';
        return welcomeText;
    }

    function buildHrStepsMessage(steps) {
        if (!steps || !steps.length) return '';
        const prompt = hrTranslate('hr_steps_prompt');
        let listStr = "<ul class='bot-list'>";
        steps.forEach((step, index) => {
            const label = step.subject ? `${step.name}` : step.name;
            listStr += `<li class='bot-list-item'><b>${index + 1}.</b> ${label}</li>`;
        });
        listStr += "</ul>";
        return `${prompt}<br>${listStr}`;
    }

    function buildActionsList(actions) {
        if (!actions || !actions.length) return '';
        let listStr = "<ul class='bot-list'>";
        actions.forEach((action, index) => {
            const label = action.stepName || '';
            listStr += `<li class='bot-list-item'><b>${index + 1}.</b> ${label}</li>`;
        });
        listStr += "</ul>";
        const prompt = hrTranslate('hr_steps_prompt');
        return `${prompt}<br>${listStr}`;
    }

    function buildAssetUrl(value) {
        const trimmed = String(value || '').trim();
        if (!trimmed) return '';
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        const encoded = encodeURIComponent(trimmed).replace(/%2F/g, '/');
        return HR_UPLOAD_BASE_URL + encoded;
    }

    function hasWelcomeMessage(userKey) {
        const storageKey = HR_WELCOME_KEY_PREFIX + normalizeKey(userKey);
        if (localStorage.getItem(storageKey)) {
            return true;
        }
        if (typeof allHistoryData !== 'undefined' && Array.isArray(allHistoryData)) {
            return allHistoryData.some(record =>
                record &&
                record.recordType === 'hr-welcome' &&
                normalizeKey(record.sender) === normalizeKey(HR_CHAT_NAME) &&
                normalizeKey(record.user) === normalizeKey(userKey)
            );
        }
        return false;
    }

    async function saveSystemMessage(messageBody, userKey, recordType, options = {}) {
        const record = {
            recordType: recordType || 'hr-message',
            sender: HR_CHAT_NAME,
            user: userKey,
            body: options.body !== undefined ? options.body : messageBody,
            image: options.image || null,
            direction: 'incoming',
            timestamp: Date.now(),
            dateString: new Date().toLocaleString()
        };
        if (typeof saveNewMessageToDB !== 'function') return;
        const saved = await saveNewMessageToDB(record);
        if (typeof allHistoryData !== 'undefined' && Array.isArray(allHistoryData)) {
            allHistoryData.push(saved || record);
        }
        if (typeof renderContactList === 'function') {
            renderContactList();
        }
        if (typeof activeChatSender !== 'undefined' && isHrChat(activeChatSender)) {
            if (typeof renderChatMessages === 'function') {
                renderChatMessages();
            }
            if (typeof scrollToBottom === 'function') {
                scrollToBottom();
            }
        }
    }

    async function saveWelcomeMessage(messageBody, userKey) {
        await saveSystemMessage(messageBody, userKey, 'hr-welcome');
        const storageKey = HR_WELCOME_KEY_PREFIX + normalizeKey(userKey);
        localStorage.setItem(storageKey, '1');
    }

    async function startNewFlow(userKey, options = {}) {
        const contactName = typeof getDisplayName === 'function' ? getDisplayName(userKey) : userKey;
        const steps = await fetchHrSteps();
        if (!options.skipWelcome) {
            const messageBody = buildHrWelcomeMessage(contactName);
            await saveWelcomeMessage(messageBody, userKey);
        }
        const stepsMessage = buildHrStepsMessage(steps);
        if (stepsMessage) {
            await saveSystemMessage(stepsMessage, userKey, 'hr-steps');
        }
        saveHrState(userKey, { awaiting: 'step', stepId: null, actions: [] });
    }

    function setStepState(userKey) {
        saveHrState(userKey, { awaiting: 'step', stepId: null, actions: [] });
    }

    async function handleChatOpen(senderName) {
        if (!isHrChat(senderName)) return;
        const userKey = getCurrentUser();
        if (!userKey) return;
        const lastMessage = getLastHrMessage(userKey);
        if (lastMessage && lastMessage.direction === 'incoming') {
            return;
        }
        const lastUserMessage = getLastUserMessage(userKey);
        const lastHrMessage = getLastHrIncomingMessage(userKey);
        if (lastUserMessage === '0') {
            resetHrState(userKey);
            if (lastHrMessage && lastHrMessage.recordType === 'hr-welcome') {
                await startNewFlow(userKey, { skipWelcome: true });
                return;
            }
            await startNewFlow(userKey);
            return;
        }
        if (!hasWelcomeMessage(userKey)) {
            await startNewFlow(userKey);
        }
    }

    async function handleOutgoing(messageBody) {
        const trimmed = String(messageBody || '').trim();
        if (!trimmed) return false;
        const userKey = getCurrentUser();
        if (!userKey) return false;

        if (trimmed === '0') {
            resetHrState(userKey);
            const lastHrMessage = getLastHrIncomingMessage(userKey);
            if (lastHrMessage && lastHrMessage.recordType === 'hr-welcome') {
                await startNewFlow(userKey, { skipWelcome: true });
                return true;
            }
            await startNewFlow(userKey);
            return true;
        }

        const state = loadHrState(userKey) || { awaiting: 'step', stepId: null, actions: [] };

        if (state.awaiting === 'step') {
            const steps = await fetchHrSteps();
            const index = parseInt(trimmed, 10) - 1;
            if (!steps.length || Number.isNaN(index) || index < 0 || index >= steps.length) {
                await saveSystemMessage('בחירה לא תקינה, נסה שוב.', userKey);
                return true;
            }
            const selected = steps[index];
            const actions = await fetchHrActions(selected.id);
            if (!actions.length) {
                await saveSystemMessage('לא נמצאו פעולות לשלב זה.', userKey);
                return true;
            }
            const actionItems = actions.map(action => ({
                stepName: action.stepName || '',
                returnValue: action.returnValue || ''
            }));
            saveHrState(userKey, { awaiting: 'action', stepId: selected.id, actions: actionItems });
            await saveSystemMessage(buildActionsList(actions), userKey);
            return true;
        }

        if (state.awaiting === 'action') {
            const index = parseInt(trimmed, 10) - 1;
            if (Number.isNaN(index) || index < 0 || index >= (state.actions || []).length) {
                await saveSystemMessage('בחירה לא תקינה, נסה שוב.', userKey);
                return true;
            }
            const action = state.actions[index];
            const returnValue = String(action.returnValue || '').trim();
            if (returnValue.toUpperCase() === 'FREE TEXT') {
                saveHrState(userKey, { ...state, awaiting: 'free-text' });
                await saveSystemMessage('נא כתוב את הודעתך.', userKey);
                return true;
            }
            if (returnValue) {
                const isHttp = /^https?:\/\//i.test(returnValue);
                const normalizedUrl = buildAssetUrl(returnValue);
                const lowerValue = returnValue.toLowerCase();
                const isImage = lowerValue.match(/\.(jpeg|jpg|gif|png|webp)($|\?)/);
                const isDoc = lowerValue.match(/\.(pdf|doc|docx)($|\?)/);

                if (isImage) {
                    await saveSystemMessage('', userKey, 'hr-asset', { image: normalizedUrl, body: '' });
                    return true;
                }
                if (isDoc) {
                    await saveSystemMessage(normalizedUrl, userKey, 'hr-asset', { body: normalizedUrl });
                    return true;
                }

                await saveSystemMessage(returnValue, userKey);
                return true;
            }
            if (action.stepName) {
                await saveSystemMessage(action.stepName, userKey);
                return true;
            }
            return true;
        }

        if (state.awaiting === 'free-text') {
            return false;
        }

        return false;
    }

    window.HR_CHAT = {
        name: HR_CHAT_NAME,
        isHrChat,
        getPinnedChat,
        handleChatOpen,
        handleOutgoing
    };
})();