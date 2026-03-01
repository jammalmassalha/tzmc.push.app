// shuttle.js - Shuttle booking pinned chat logic
(() => {
    const SHUTTLE_CHAT_NAME = 'הזמנת הסעה';
    const SHUTTLE_ENDPOINT =
        'https://script.google.com/macros/s/AKfycbwQ9A-CDiyDA-upacWeVG-ZAbFLowpWyOMiYWwERyL8q82oqvp2IJWjYT1NwREX3Kxk/exec';

    const SHUTTLE_WELCOME_KEY_PREFIX = 'shuttle_welcome_sent_';
    const SHUTTLE_STATE_KEY_PREFIX = 'shuttle_state_';
    const SHUTTLE_ORDERS_KEY_PREFIX = 'shuttle_orders_';

    const ENTRY_EMPLOYEE = 'entry.1035269960';
    const ENTRY_DATE = 'entry.794242217';
    const ENTRY_DATE_ALT = 'entry.794242217_22';
    const ENTRY_SHIFT = 'entry.1992732561';
    const ENTRY_STATION = 'entry.1096369604';
    const ENTRY_STATUS = 'entry.798637322';

    const STATUS_ACTIVE_VALUE = 'פעיל активный';
    const STATUS_CANCEL_VALUE = 'ביטול נסיעה отмена поезд';
    const STATUS_ACTIVE_LABEL = 'פעיל';
    const STATUS_CANCEL_LABEL = 'בוטל';

    const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
    const DATE_CHOICES_COUNT = 10;
    const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

    const SHIFT_OPTIONS = [
        { label: '05:00', value: "'05:00" },
        { label: '06:00', value: "'06:00" },
        { label: '12:00', value: "'12:00" },
        { label: '14:00', value: "'14:00" },
        { label: '22:00', value: "'22:00" }
    ];

    let stationsCache = { at: 0, items: [] };
    let employeesCache = { at: 0, items: [] };

    const shuttleFetch = window.fetchWithRetry ? window.fetchWithRetry : fetch;

    const normalizeKey = (value) => String(value || '').trim().toLowerCase();
    const toText = (value) => String(value == null ? '' : value).trim();

    function normalizePhone(value) {
        const raw = String(value || '').replace(/\D/g, '');
        if (!raw) return '';

        const embeddedIsraeli = raw.match(/05\d{8}/);
        if (embeddedIsraeli && embeddedIsraeli[0]) {
            return embeddedIsraeli[0];
        }
        if (/^05\d{8}$/.test(raw)) return raw;
        if (/^5\d{8}$/.test(raw)) return `0${raw}`;
        if (/^9725\d{8}$/.test(raw)) return `0${raw.slice(3)}`;
        if (/^97205\d{8}$/.test(raw)) return `0${raw.slice(4)}`;
        if (raw.length > 10) {
            const tail = raw.slice(-10);
            if (/^05\d{8}$/.test(tail)) return tail;
        }
        return raw;
    }

    function toIsoDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function parseJsonArray(payloadText) {
        try {
            const parsed = JSON.parse(payloadText);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .map((item) => toText(item))
                .filter(Boolean);
        } catch (err) {
            return [];
        }
    }

    function isShuttleChat(senderName) {
        return normalizeKey(senderName) === normalizeKey(SHUTTLE_CHAT_NAME);
    }

    function getPinnedChat() {
        return { name: SHUTTLE_CHAT_NAME, pinned: true, isGroup: false };
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

    function defaultState() {
        return { awaiting: 'menu', draft: null, cancelCandidates: [] };
    }

    function getStateKey(userKey) {
        return SHUTTLE_STATE_KEY_PREFIX + normalizeKey(userKey);
    }

    function loadState(userKey) {
        const raw = localStorage.getItem(getStateKey(userKey));
        if (!raw) return defaultState();
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return defaultState();
            return {
                awaiting: parsed.awaiting || 'menu',
                draft: parsed.draft || null,
                cancelCandidates: Array.isArray(parsed.cancelCandidates) ? parsed.cancelCandidates : []
            };
        } catch (err) {
            return defaultState();
        }
    }

    function saveState(userKey, state) {
        localStorage.setItem(getStateKey(userKey), JSON.stringify(state));
    }

    function resetState(userKey) {
        localStorage.removeItem(getStateKey(userKey));
    }

    function getOrdersKey(userKey) {
        return SHUTTLE_ORDERS_KEY_PREFIX + normalizeKey(userKey);
    }

    function loadOrders(userKey) {
        const raw = localStorage.getItem(getOrdersKey(userKey));
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((item) => item && typeof item === 'object');
        } catch (err) {
            return [];
        }
    }

    function saveOrders(userKey, orders) {
        localStorage.setItem(getOrdersKey(userKey), JSON.stringify(Array.isArray(orders) ? orders : []));
    }

    function getDateChoices() {
        const today = new Date();
        const choices = [];
        for (let i = 0; i < DATE_CHOICES_COUNT; i += 1) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            const iso = toIsoDate(date);
            choices.push({
                value: iso,
                dayName: DAY_NAMES[date.getDay()],
                label: `${DAY_NAMES[date.getDay()]} ${iso}`
            });
        }
        return choices;
    }

    function buildNumberedList(items, renderItem) {
        let list = "<ul class='bot-list'>";
        items.forEach((item, index) => {
            list += `<li class='bot-list-item'><b>${index + 1}.</b> ${renderItem(item, index)}</li>`;
        });
        list += '</ul>';
        return list;
    }

    function statusLabelFromValue(statusValue) {
        return statusValue === STATUS_CANCEL_VALUE ? STATUS_CANCEL_LABEL : STATUS_ACTIVE_LABEL;
    }

    function buildMainMenuMessage() {
        return (
            'היי, זהו חדר הזמנת ההסעה.<br>' +
            'בחר פעולה:<br>' +
            buildNumberedList(
                ['הזמנה חדשה', 'הצגת הבקשות שלי', 'ביטול הזמנה קיימת'],
                (item) => item
            ) +
            '<br>אפשר להקליד <b>0</b> בכל שלב כדי לחזור לתפריט הראשי.'
        );
    }

    function buildDateSelectionMessage() {
        const choices = getDateChoices();
        return (
            'בחר תאריך נסיעה:<br>' +
            buildNumberedList(choices, (choice) => choice.label)
        );
    }

    function buildShiftSelectionMessage() {
        return (
            'בחר משמרת (הסעה לעבודה):<br>' +
            buildNumberedList(SHIFT_OPTIONS, (option) => option.label)
        );
    }

    function buildStationSelectionMessage(stations) {
        return (
            'בחר תחנה:<br>' +
            buildNumberedList(stations, (station) => station)
        );
    }

    function buildStatusSelectionMessage() {
        const options = [
            { label: 'פעיל', value: STATUS_ACTIVE_VALUE },
            { label: 'ביטול נסיעה', value: STATUS_CANCEL_VALUE }
        ];
        return (
            'בחר סטטוס הזמנה:<br>' +
            buildNumberedList(options, (option) => option.label)
        );
    }

    function buildOrderSummary(order, includeIndex = false, index = 0) {
        const prefix = includeIndex ? `<b>${index + 1}.</b> ` : '';
        const statusLabel = order.statusLabel || statusLabelFromValue(order.statusValue);
        return (
            `${prefix}[${statusLabel}] ` +
            `${order.dayName || ''} ${order.date || ''}`.trim() +
            ` | ${order.shiftLabel || ''}` +
            ` | ${order.station || ''}`
        );
    }

    function buildOrdersMessage(orders, title) {
        if (!orders.length) {
            return `${title}<br>לא נמצאו בקשות עבור המשתמש הנוכחי.`;
        }
        return (
            `${title}<br>` +
            buildNumberedList(orders, (order, index) => buildOrderSummary(order, false, index))
        );
    }

    function hasWelcomeMessage(userKey) {
        const storageKey = SHUTTLE_WELCOME_KEY_PREFIX + normalizeKey(userKey);
        if (localStorage.getItem(storageKey)) {
            return true;
        }
        if (typeof allHistoryData !== 'undefined' && Array.isArray(allHistoryData)) {
            return allHistoryData.some((record) =>
                record &&
                record.recordType === 'shuttle-welcome' &&
                normalizeKey(record.sender) === normalizeKey(SHUTTLE_CHAT_NAME) &&
                normalizeKey(record.user) === normalizeKey(userKey)
            );
        }
        return false;
    }

    async function saveSystemMessage(messageBody, userKey, recordType = 'shuttle-message', options = {}) {
        const record = {
            recordType,
            sender: SHUTTLE_CHAT_NAME,
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
        if (typeof activeChatSender !== 'undefined' && isShuttleChat(activeChatSender)) {
            if (typeof renderChatMessages === 'function') {
                renderChatMessages();
            }
            if (typeof scrollToBottom === 'function') {
                scrollToBottom();
            }
        }
    }

    async function saveWelcomeMessage(messageBody, userKey) {
        await saveSystemMessage(messageBody, userKey, 'shuttle-welcome');
        localStorage.setItem(SHUTTLE_WELCOME_KEY_PREFIX + normalizeKey(userKey), '1');
    }

    async function fetchStations() {
        const now = Date.now();
        if (stationsCache.items.length && now - stationsCache.at < LIST_CACHE_TTL_MS) {
            return stationsCache.items;
        }
        try {
            const res = await shuttleFetch(`${SHUTTLE_ENDPOINT}?park=test`, {}, { timeoutMs: 10000, retries: 2 });
            const payloadText = await res.text();
            const stations = parseJsonArray(payloadText);
            if (stations.length) {
                stationsCache = { at: now, items: stations };
                return stations;
            }
        } catch (err) {
            console.warn('Failed to fetch shuttle stations', err);
        }
        return [];
    }

    async function fetchEmployees() {
        const now = Date.now();
        if (employeesCache.items.length && now - employeesCache.at < LIST_CACHE_TTL_MS) {
            return employeesCache.items;
        }
        try {
            const res = await shuttleFetch(`${SHUTTLE_ENDPOINT}?emp=test`, {}, { timeoutMs: 10000, retries: 2 });
            const payloadText = await res.text();
            const employees = parseJsonArray(payloadText);
            if (employees.length) {
                employeesCache = { at: now, items: employees };
                return employees;
            }
        } catch (err) {
            console.warn('Failed to fetch shuttle employees', err);
        }
        return [];
    }

    async function resolveEmployeeValue(userKey) {
        const employees = await fetchEmployees();
        const normalizedUser = normalizeKey(userKey);
        const userPhone = normalizePhone(userKey);
        const displayName = typeof getDisplayName === 'function' ? toText(getDisplayName(userKey)) : toText(userKey);

        if (employees.length) {
            const exact = employees.find((entry) => normalizeKey(entry) === normalizedUser);
            if (exact) return exact;

            if (userPhone) {
                const byPhone = employees.find((entry) => normalizePhone(entry) === userPhone);
                if (byPhone) return byPhone;
            }

            if (displayName) {
                const displayNorm = normalizeKey(displayName);
                const byName = employees.find((entry) => normalizeKey(entry).includes(displayNorm));
                if (byName) return byName;
            }
        }

        if (displayName && userPhone) return `${displayName} ${userPhone}`;
        if (displayName) return displayName;
        return toText(userKey);
    }

    function parsePositiveIndex(text, maxLength) {
        const index = parseInt(String(text || '').trim(), 10) - 1;
        if (Number.isNaN(index) || index < 0 || index >= maxLength) {
            return -1;
        }
        return index;
    }

    function parseMenuCommand(input) {
        const trimmed = toText(input);
        if (!trimmed) return '';
        if (trimmed === '1') return 'new';
        if (trimmed === '2') return 'show';
        if (trimmed === '3') return 'cancel';
        if (trimmed.includes('חדש')) return 'new';
        if (trimmed.includes('הצג')) return 'show';
        if (trimmed.includes('ביטול') || trimmed.includes('מחק')) return 'cancel';
        return '';
    }

    function createOrderId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `shuttle_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    async function submitOrderToEndpoint(userKey, draft, statusValue) {
        const employeeValue = await resolveEmployeeValue(userKey);
        const todayIso = toIsoDate(new Date());
        const params = new URLSearchParams();
        params.set(ENTRY_EMPLOYEE, employeeValue);
        params.set(ENTRY_DATE, draft.date);
        params.set(ENTRY_DATE_ALT, todayIso);
        params.set(ENTRY_SHIFT, draft.shiftValue);
        params.set(ENTRY_STATION, draft.station);
        params.set(ENTRY_STATUS, statusValue);

        const url = `${SHUTTLE_ENDPOINT}?${params.toString()}`;
        const response = await shuttleFetch(url, {}, { timeoutMs: 12000, retries: 2 });
        if (response && typeof response.ok === 'boolean' && !response.ok) {
            throw new Error(`Shuttle submit failed (${response.status})`);
        }
        return employeeValue;
    }

    async function sendMenu(userKey) {
        saveState(userKey, defaultState());
        await saveSystemMessage(buildMainMenuMessage(), userKey, 'shuttle-menu');
    }

    async function startOrderFlow(userKey) {
        const nextState = { awaiting: 'date', draft: {}, cancelCandidates: [] };
        saveState(userKey, nextState);
        await saveSystemMessage(buildDateSelectionMessage(), userKey, 'shuttle-date');
    }

    async function showUserOrders(userKey) {
        const orders = loadOrders(userKey)
            .slice()
            .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        await saveSystemMessage(buildOrdersMessage(orders, 'הבקשות שלך:'), userKey, 'shuttle-orders');
    }

    async function startCancelFlow(userKey) {
        const activeOrders = loadOrders(userKey)
            .filter((order) => order.statusValue !== STATUS_CANCEL_VALUE)
            .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

        if (!activeOrders.length) {
            await saveSystemMessage('אין בקשות פעילות לביטול.', userKey, 'shuttle-cancel-empty');
            return;
        }

        const message =
            'בחר את מספר ההזמנה שתרצה לבטל:<br>' +
            buildNumberedList(activeOrders, (order) => buildOrderSummary(order));

        saveState(userKey, {
            awaiting: 'cancel-select',
            draft: null,
            cancelCandidates: activeOrders.map((order) => order.id)
        });
        await saveSystemMessage(message, userKey, 'shuttle-cancel-select');
    }

    async function handleMenuSelection(userKey, trimmed) {
        const command = parseMenuCommand(trimmed);
        if (!command) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור 1, 2 או 3.', userKey, 'shuttle-invalid');
            await sendMenu(userKey);
            return true;
        }

        if (command === 'new') {
            await startOrderFlow(userKey);
            return true;
        }
        if (command === 'show') {
            await showUserOrders(userKey);
            await sendMenu(userKey);
            return true;
        }
        if (command === 'cancel') {
            await startCancelFlow(userKey);
            return true;
        }
        return true;
    }

    async function handleDateSelection(userKey, state, trimmed) {
        const choices = getDateChoices();
        const pickedIndex = parsePositiveIndex(trimmed, choices.length);
        if (pickedIndex < 0) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור מספר תאריך מהרשימה.', userKey, 'shuttle-invalid');
            return true;
        }
        const pickedDate = choices[pickedIndex];
        const nextState = {
            awaiting: 'shift',
            draft: {
                date: pickedDate.value,
                dayName: pickedDate.dayName
            },
            cancelCandidates: []
        };
        saveState(userKey, nextState);
        await saveSystemMessage(buildShiftSelectionMessage(), userKey, 'shuttle-shift');
        return true;
    }

    async function handleShiftSelection(userKey, state, trimmed) {
        const pickedIndex = parsePositiveIndex(trimmed, SHIFT_OPTIONS.length);
        if (pickedIndex < 0) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור מספר משמרת מהרשימה.', userKey, 'shuttle-invalid');
            return true;
        }

        const pickedShift = SHIFT_OPTIONS[pickedIndex];
        const stations = await fetchStations();
        if (!stations.length) {
            await saveSystemMessage('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', userKey, 'shuttle-error');
            await sendMenu(userKey);
            return true;
        }

        const nextState = {
            awaiting: 'station',
            draft: {
                ...(state.draft || {}),
                shiftLabel: pickedShift.label,
                shiftValue: pickedShift.value
            },
            cancelCandidates: []
        };
        saveState(userKey, nextState);
        await saveSystemMessage(buildStationSelectionMessage(stations), userKey, 'shuttle-station');
        return true;
    }

    async function handleStationSelection(userKey, state, trimmed) {
        const stations = await fetchStations();
        if (!stations.length) {
            await saveSystemMessage('לא ניתן לטעון תחנות כרגע. נסה שוב מאוחר יותר.', userKey, 'shuttle-error');
            await sendMenu(userKey);
            return true;
        }
        const pickedIndex = parsePositiveIndex(trimmed, stations.length);
        if (pickedIndex < 0) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור מספר תחנה מהרשימה.', userKey, 'shuttle-invalid');
            return true;
        }
        const station = stations[pickedIndex];
        const nextState = {
            awaiting: 'status',
            draft: {
                ...(state.draft || {}),
                station
            },
            cancelCandidates: []
        };
        saveState(userKey, nextState);
        await saveSystemMessage(buildStatusSelectionMessage(), userKey, 'shuttle-status');
        return true;
    }

    async function handleStatusSelection(userKey, state, trimmed) {
        const statusOptions = [STATUS_ACTIVE_VALUE, STATUS_CANCEL_VALUE];
        const pickedIndex = parsePositiveIndex(trimmed, statusOptions.length);
        if (pickedIndex < 0) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור 1 או 2.', userKey, 'shuttle-invalid');
            return true;
        }

        const statusValue = statusOptions[pickedIndex];
        const draft = state.draft || {};
        if (!draft.date || !draft.shiftValue || !draft.station) {
            await saveSystemMessage('חסרים נתוני הזמנה. מתחילים מחדש.', userKey, 'shuttle-error');
            await sendMenu(userKey);
            return true;
        }

        try {
            const employee = await submitOrderToEndpoint(userKey, draft, statusValue);
            const orders = loadOrders(userKey);
            const now = Date.now();
            const nextOrder = {
                id: createOrderId(),
                employee,
                date: draft.date,
                dayName: draft.dayName || '',
                shiftLabel: draft.shiftLabel || '',
                shiftValue: draft.shiftValue,
                station: draft.station,
                statusValue,
                statusLabel: statusLabelFromValue(statusValue),
                submittedAt: now
            };
            orders.unshift(nextOrder);
            saveOrders(userKey, orders);

            await saveSystemMessage(
                `הבקשה נשלחה בהצלחה ✅<br>${buildOrderSummary(nextOrder)}`,
                userKey,
                'shuttle-submit-success'
            );
        } catch (err) {
            console.warn('Shuttle submit failed', err);
            await saveSystemMessage('שליחת הבקשה נכשלה. נסה שוב בעוד מספר רגעים.', userKey, 'shuttle-submit-failed');
        }

        await sendMenu(userKey);
        return true;
    }

    async function handleCancelSelection(userKey, state, trimmed) {
        const candidateIds = Array.isArray(state.cancelCandidates) ? state.cancelCandidates : [];
        const pickedIndex = parsePositiveIndex(trimmed, candidateIds.length);
        if (pickedIndex < 0) {
            await saveSystemMessage('בחירה לא תקינה. נא לבחור מספר הזמנה לביטול.', userKey, 'shuttle-invalid');
            return true;
        }
        const orderId = candidateIds[pickedIndex];
        const orders = loadOrders(userKey);
        const targetOrder = orders.find((item) => item.id === orderId);
        if (!targetOrder) {
            await saveSystemMessage('ההזמנה לא נמצאה. נסה שוב.', userKey, 'shuttle-cancel-missing');
            await sendMenu(userKey);
            return true;
        }

        const cancelDraft = {
            date: targetOrder.date,
            dayName: targetOrder.dayName,
            shiftLabel: targetOrder.shiftLabel,
            shiftValue: targetOrder.shiftValue,
            station: targetOrder.station
        };

        try {
            await submitOrderToEndpoint(userKey, cancelDraft, STATUS_CANCEL_VALUE);
            const updatedOrders = orders.map((order) => {
                if (order.id !== orderId) return order;
                return {
                    ...order,
                    statusValue: STATUS_CANCEL_VALUE,
                    statusLabel: STATUS_CANCEL_LABEL,
                    cancelledAt: Date.now()
                };
            });
            saveOrders(userKey, updatedOrders);
            await saveSystemMessage(
                `ההזמנה בוטלה בהצלחה ✅<br>${buildOrderSummary({ ...targetOrder, statusValue: STATUS_CANCEL_VALUE, statusLabel: STATUS_CANCEL_LABEL })}`,
                userKey,
                'shuttle-cancel-success'
            );
        } catch (err) {
            console.warn('Shuttle cancel failed', err);
            await saveSystemMessage('ביטול ההזמנה נכשל. נסה שוב בעוד מספר רגעים.', userKey, 'shuttle-cancel-failed');
        }

        await sendMenu(userKey);
        return true;
    }

    async function ensureWelcomeAndMenu(userKey) {
        const displayName = typeof getDisplayName === 'function' ? toText(getDisplayName(userKey)) : toText(userKey);
        if (!hasWelcomeMessage(userKey)) {
            await saveWelcomeMessage(
                `שלום <b>${displayName || userKey}</b>, ברוך/ה הבא/ה להזמנת הסעה.`,
                userKey
            );
            await sendMenu(userKey);
            return;
        }
        const state = loadState(userKey);
        if (!state.awaiting) {
            saveState(userKey, defaultState());
        }
    }

    async function handleChatOpen(senderName) {
        if (!isShuttleChat(senderName)) return;
        const userKey = getCurrentUser();
        if (!userKey) return;
        await ensureWelcomeAndMenu(userKey);
    }

    async function handleOutgoing(messageBody) {
        const trimmed = toText(messageBody);
        if (!trimmed) return false;

        const userKey = getCurrentUser();
        if (!userKey) return false;

        if (trimmed === '0') {
            resetState(userKey);
            await sendMenu(userKey);
            return true;
        }

        const state = loadState(userKey);
        switch (state.awaiting) {
            case 'menu':
                return handleMenuSelection(userKey, trimmed);
            case 'date':
                return handleDateSelection(userKey, state, trimmed);
            case 'shift':
                return handleShiftSelection(userKey, state, trimmed);
            case 'station':
                return handleStationSelection(userKey, state, trimmed);
            case 'status':
                return handleStatusSelection(userKey, state, trimmed);
            case 'cancel-select':
                return handleCancelSelection(userKey, state, trimmed);
            default:
                await sendMenu(userKey);
                return true;
        }
    }

    window.SHUTTLE_CHAT = {
        name: SHUTTLE_CHAT_NAME,
        isShuttleChat,
        getPinnedChat,
        handleChatOpen,
        handleOutgoing
    };
})();
