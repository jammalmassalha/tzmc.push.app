// --- CONFIGURATION ---
var SPREADSHEET_ID = '1eQ9r491jTVz7RZJFoUxRRT23QLAJKWbWuKKTrh0NJKE';
var CACHE_TTL_SECONDS = 300;
var CONTACTS_CACHE_TTL_SECONDS = 60;
var CHECK_QUEUE_SERVER_TOKEN_PROPERTY = 'CHECK_QUEUE_SERVER_TOKEN';

function normalizePhone(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text) && text.charAt(0) !== '0') {
    text = '0' + text;
  }
  return text;
}

function normalizeSheetPhone(value) {
  var text = String(value || '').trim();
  if (text.charAt(0) === "'") text = text.substring(1);
  return normalizePhone(text);
}

function getCheckQueueServerToken() {
  try {
    var configured = PropertiesService.getScriptProperties().getProperty(CHECK_QUEUE_SERVER_TOKEN_PROPERTY);
    return String(configured || '').trim();
  } catch (err) {
    return '';
  }
}

function getLastDataRow(sheet) {
  var lastRow = sheet.getLastRow();
  return lastRow < 2 ? 0 : lastRow;
}

function getRangeValues(sheet, startRow, startCol, numRows, numCols) {
  if (numRows <= 0) return [];
  return sheet.getRange(startRow, startCol, numRows, numCols).getValues();
}

function getCachedResponse(cache, key) {
  var cached = cache.get(key);
  if (!cached) return null;
  return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
}

function cacheResponse(cache, key, obj, ttlSeconds) {
  var json = JSON.stringify(obj);
  try {
    cache.put(key, json, ttlSeconds);
  } catch (err) {
    Logger.log('Cache put failed for ' + key + ': ' + err);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function findUserRow(sheet, username) {
  var lastRow = getLastDataRow(sheet);
  if (!lastRow) return null;
  var range = sheet.getRange(2, 2, lastRow - 1, 1);
  var finder = range.createTextFinder(username).matchEntireCell(true);
  var match = finder.findNext();
  if (!match && username.charAt(0) !== "'") {
    finder = range.createTextFinder("'" + username).matchEntireCell(true);
    match = finder.findNext();
  }
  return match ? match.getRow() : null;
}

function safeParseSubscriptionJson(rawValue) {
  var text = String(rawValue || '').trim();
  if (!text) return null;
  try {
    var parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.endpoint) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function getSubscriptionEndpointFromJson(rawValue) {
  var parsed = safeParseSubscriptionJson(rawValue);
  return parsed && parsed.endpoint ? String(parsed.endpoint).trim() : '';
}

function normalizeEndpointsInput(rawValue) {
  var values = [];
  if (Array.isArray(rawValue)) {
    values = rawValue;
  } else if (typeof rawValue === 'string') {
    values = rawValue.split(',');
  }
  var result = {};
  for (var i = 0; i < values.length; i++) {
    var endpoint = String(values[i] || '').trim();
    if (endpoint) result[endpoint] = true;
  }
  return result;
}

function parseRecipientUsernames(recipientRawValue) {
  var parts = [];
  if (Array.isArray(recipientRawValue)) {
    parts = recipientRawValue;
  } else if (recipientRawValue && typeof recipientRawValue === 'object') {
    if (Array.isArray(recipientRawValue.usernames)) {
      parts = recipientRawValue.usernames;
    } else if (Array.isArray(recipientRawValue.users)) {
      parts = recipientRawValue.users;
    } else {
      var objectText = String(recipientRawValue || '').trim();
      if (!objectText) return [];
      if (objectText.toLowerCase() === 'all' || objectText === '*') return [];
      parts = objectText.split(',');
    }
  } else {
    var raw = String(recipientRawValue || '').trim();
    if (!raw) return [];
    if (raw.toLowerCase() === 'all' || raw === '*') return [];
    parts = raw.split(',');
  }

  var seen = {};
  var users = [];
  for (var i = 0; i < parts.length; i++) {
    var normalized = normalizePhone(parts[i]);
    if (!normalized) continue;
    if (seen[normalized]) continue;
    seen[normalized] = true;
    users.push(normalized);
  }
  return users;
}

function getRecipientAuthJsonForLog(spreadsheet, recipientRawValue) {
  var users = parseRecipientUsernames(recipientRawValue);
  if (!users.length) return '';

  var subscribeSheet = spreadsheet.getSheetByName('Subscribe');
  if (!subscribeSheet) return '';

  var result = [];
  for (var i = 0; i < users.length; i++) {
    var user = users[i];
    var userRow = findUserRow(subscribeSheet, user);
    if (!userRow) continue;
    var authJsonMobile = String(subscribeSheet.getRange(userRow, 4).getValue() || '').trim(); // D only
    if (!authJsonMobile) continue;

    result.push({
      username: user,
      authJson: authJsonMobile
    });
  }

  if (!result.length) return '';
  if (result.length === 1) {
    return result[0].authJson;
  }
  return JSON.stringify(result);
}

function ensureLogsSheetHasAuthJsonColumn(logsSheet) {
  var lastCol = Math.max(1, logsSheet.getLastColumn());
  var headerValues = logsSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var normalizedHeaders = headerValues.map(function (value) {
    return String(value || '').trim().toLowerCase();
  });

  var hasColumn = false;
  for (var i = 0; i < normalizedHeaders.length; i++) {
    if (normalizedHeaders[i] === 'recipient auth json' || normalizedHeaders[i] === 'recipientauthjson') {
      hasColumn = true;
      break;
    }
  }
  if (!hasColumn) {
    logsSheet.getRange(1, lastCol + 1).setValue('Recipient Auth JSON');
  }
}

function doGet(e) {
  try {
    var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    var action = e.parameter.action;

    // ======================================================
    // 1. GET DEPARTMENTS (From Sheet: ServiceIDFK)
    // ======================================================
    if (action === 'get_departments') {
      var cache = CacheService.getScriptCache();
      var cachedDepartments = false;//getCachedResponse(cache, 'departments');
      if (cachedDepartments) return cachedDepartments;

      var sheet = spreadsheet.getSheetByName('ServiceIDFK');
      if (!sheet) return createError('Sheet ServiceIDFK not found');

      var lastRow = getLastDataRow(sheet);
      if (!lastRow) return createJSON({ result: 'success', data: [] });
      var data = getRangeValues(sheet, 2, 1, lastRow - 1, 2);
      var departments = [];

      for (var i = 0; i < data.length; i++) {
        if (data[i][0] && data[i][1]) {
          departments.push({
            id: data[i][0],
            name: data[i][1]
          });
        }
      }
      return cacheResponse(cache, 'departments', { result: 'success', data: departments }, CACHE_TTL_SECONDS);
    }
    // 2. Handle 'check_auth' Action
    if (action === 'check_auth') {
      return handleCheckAuth(e.parameter.user);
    }

    // ======================================================
    // 2. GET ACTIONS (From Sheet: Actions)
    // ======================================================
    if (action === 'get_actions') {
      var deptId = e.parameter.deptId;
      if (!deptId) return createError('Missing deptId');
      var cache = CacheService.getScriptCache();
      var cacheKey = 'actions_' + deptId;
      var cachedActions = getCachedResponse(cache, cacheKey);
      if (cachedActions) return cachedActions;

      var sheet = spreadsheet.getSheetByName('Actions');
      if (!sheet) return createError('Sheet Actions not found');

      var lastRow = getLastDataRow(sheet);
      if (!lastRow) return createJSON({ result: 'success', data: [] });
      var data = getRangeValues(sheet, 2, 1, lastRow - 1, 4);
      var actions = [];

      for (var i = 0; i < data.length; i++) {
        if (String(data[i][3]) == String(deptId)) {
          actions.push({
            id: data[i][0],
            name: data[i][1]
          });
        }
      }
      return cacheResponse(cache, cacheKey, { result: 'success', data: actions }, CACHE_TTL_SECONDS);
    }

    // ======================================================
    // 2. GET HR STEPS (From Sheet: Hr-Steps)
    // ======================================================
    if (action === 'get_hr_steps') {
      var cache = CacheService.getScriptCache();
      var cachedSteps = getCachedResponse(cache, 'hr_steps');
      if (cachedSteps) return cachedSteps;

      var sheet = spreadsheet.getSheetByName('Hr-Steps');
      if (!sheet) return createError('Sheet Hr-Steps not found');

      var lastRow = getLastDataRow(sheet);
      if (!lastRow) return createJSON({ result: 'success', data: [] });
      var data = getRangeValues(sheet, 2, 1, lastRow - 1, 4); // A..D
      var steps = [];

      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        if (!row[0] || !row[1]) continue;
        steps.push({
          id: row[0],
          name: row[1],
          subject: row[2] || '',
          order: row[3] || 0
        });
      }

      steps.sort(function (a, b) {
        var orderA = Number(a.order) || 0;
        var orderB = Number(b.order) || 0;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.name).localeCompare(String(b.name));
      });

      return cacheResponse(cache, 'hr_steps', { result: 'success', data: steps }, CACHE_TTL_SECONDS);
    }

    // ======================================================
    // 3. GET HR STEP ACTIONS (From Sheet: Hr-Steps Action)
    // ======================================================
    if (action === 'get_hr_steps_action') {
      var serviceId = parseInt(String(e.parameter.serviceId || e.parameter.service_id || '').trim());
      var cache = CacheService.getScriptCache();
      var cacheKey = serviceId ? ('hr_steps_action_' + serviceId) : 'hr_steps_action_all';
      var cachedActions = getCachedResponse(cache, cacheKey);
      if (cachedActions) return cachedActions;

      var sheet = spreadsheet.getSheetByName('Hr-Steps Action');
      if (!sheet) return createError('Sheet Hr-Steps Action not found');

      var lastRow = getLastDataRow(sheet);
      if (!lastRow) return createJSON({ result: 'success', data: [] });
      var data = getRangeValues(sheet, 2, 1, lastRow - 1, 5); // A..E
      var actions = [];

      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        var rowServiceId = parseInt(String(row[1] || '').trim());
        
        var status = String(row[2] || '').trim();
        if (serviceId && rowServiceId !== serviceId) continue;
        if (status && status !== '1') continue;
        console.log('rowServiceId --> ', rowServiceId)
        console.log('serviceId --> ', serviceId)
        actions.push({
          order: row[0],
          serviceId: rowServiceId,
          status: status,
          stepName: row[3] || '',
          returnValue: row[4] || ''
        });
      }

      actions.sort(function (a, b) {
        var orderA = Number(a.order) || 0;
        var orderB = Number(b.order) || 0;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.stepName).localeCompare(String(b.stepName));
      });
      console.log(actions)
      return cacheResponse(cache, cacheKey, { result: 'success', data: actions }, CACHE_TTL_SECONDS);
    }

    // ======================================================
    // 3. [UPDATED] GET CONTACTS (Modified for New Schema)
    // ======================================================
    if (e.parameter.action === 'get_contacts') {
      var sheet = spreadsheet.getSheetByName('Subscribe');
      if (!sheet) return createError('Sheet Subscribe not found');
      var cache = CacheService.getScriptCache();

      // --- Check Requesting User Status ---
      var requestingUser = normalizePhone(e.parameter.user || '');
      var cacheKey = requestingUser ? ('contacts_' + requestingUser) : null;
      if (cacheKey) {
        var cachedContacts = getCachedResponse(cache, cacheKey);
        if (cachedContacts) return cachedContacts;
      }

      var isAllowed = false;
      if (requestingUser) {
        var userRow = findUserRow(sheet, requestingUser);
        if (userRow) {
          var statusValues = sheet.getRange(userRow, 7, 1, 2).getValues();
          var status = String(statusValues[0][0]).trim();          // Col G
          var exceptionStatus = String(statusValues[0][1]).trim(); // Col H
          if (status === '1' || exceptionStatus === '1') {
            isAllowed = true;
          }
        }
      }

      if (!isAllowed) {
        var emptyResponse = { 'result': 'success', 'users': [] };
        if (cacheKey) {
          return cacheResponse(cache, cacheKey, emptyResponse, CONTACTS_CACHE_TTL_SECONDS);
        }
        return createJSON(emptyResponse);
      }
      // ----------------------------------------

      // Standard Logic: Get all contacts
      var lastRow = getLastDataRow(sheet);
      if (!lastRow) return createJSON({ 'result': 'success', 'users': [] });
      var data = getRangeValues(sheet, 2, 2, lastRow - 1, 9); // B..I
      var users = [];
      for (var i = 0; i < data.length; i++) {
        var user = normalizeSheetPhone(data[i][0]); // Col B
        if (!user || user === 'undefined') continue;

        // --- NEW NAME LOGIC ---
        var nameColF = String(data[i][4] || '').trim(); // Col F (Index 5)
        var nameColI = String(data[i][7] || '').trim(); // Col I (Index 8) - Fallback
        var upic = String(data[i][8] || '').trim();
        // Use F if it exists, otherwise try I
        var finalName = nameColF !== "" ? nameColF : nameColI;

        users.push({
          username: user,
          // Display the found name, or fallback to phone number if both F and I are empty
          displayName: finalName !== "" ? finalName : user,
          fullName: finalName,
          upic: upic
        });
      }

      users.sort(function (a, b) {
        return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
      });

      var response = { 'result': 'success', 'users': users };
      if (cacheKey) {
        return cacheResponse(cache, cacheKey, response, CONTACTS_CACHE_TTL_SECONDS);
      }
      return createJSON(response);
    }

    // ======================================================
    // 4. CHECK QUEUE (Polling)
    // ======================================================
    if (action === 'check_queue') {
      var requestedUser = normalizePhone(e.parameter.user || e.parameter.username || '');
      var configuredQueueToken = getCheckQueueServerToken();
      var providedQueueToken = String(e.parameter.token || e.parameter.serverToken || '').trim();
      var isAllUsersRead = !requestedUser;
      if (isAllUsersRead && configuredQueueToken && providedQueueToken !== configuredQueueToken) {
        return createError('Unauthorized check_queue read');
      }
      var queueSheet = spreadsheet.getSheetByName('ToSend');

      if (!queueSheet) {
        queueSheet = spreadsheet.insertSheet('ToSend');
        queueSheet.appendRow(['Recipient', 'Sender', 'Message_Content']);
        return createJSON({ 'messages': [] });
      }

      var lock = LockService.getScriptLock();
      lock.waitLock(10000);

      try {
        var lastRow = queueSheet.getLastRow();
        if (lastRow < 2) return createJSON({ 'messages': [] });

        var range = queueSheet.getRange(2, 1, lastRow - 1, 3);
        var values = range.getValues();
        var messages = [];
        var rowsToDelete = [];

        for (var i = 0; i < values.length; i++) {
          var row = values[i];

          if (row[0] && row[2]) {
            var recipient = normalizeSheetPhone(row[0]);
            if (!recipient) continue;
            if (requestedUser && recipient !== requestedUser) continue;

            messages.push({
              recipient: recipient,
              sender: String(row[1]).trim(),
              content: String(row[2]).trim()
            });
            rowsToDelete.push(i + 2);
          }
        }

        if (rowsToDelete.length > 0) {
          rowsToDelete.sort(function (a, b) { return b - a; });
          for (var d = 0; d < rowsToDelete.length; d++) {
            queueSheet.deleteRow(rowsToDelete[d]);
          }
        }
        return createJSON({ 'messages': messages });

      } finally {
        lock.releaseLock();
      }
    }

    // ======================================================
    // 5. GET SUBSCRIPTIONS
    // ======================================================
    var sheet = spreadsheet.getSheetByName('Subscribe');
    var isAllSubscriptionsAction = action === 'get_all_subscriptions' || action === 'get_subscriptions';
    var param = isAllSubscriptionsAction ? 'all' : (e.parameter.usernames || e.parameter.username);

    if (!param) throw new Error("Usernames parameter is missing.");

    var normalizedParam = String(param || '').trim().toLowerCase();
    var fetchAllUsers = normalizedParam === 'all' || normalizedParam === '*' || normalizedParam === '%' || normalizedParam === 'all_users';
    var targetUsers = fetchAllUsers ? [] : param.split(',').map(function (u) { return u.trim().toLowerCase(); });
    var targetSet = {};
    targetUsers.forEach(function (u) {
      if (u) targetSet[u] = true;
    });

    var lastRow = getLastDataRow(sheet);
    if (!lastRow) return createJSON({ 'result': 'success', 'subscriptions': [] });
    var data = getRangeValues(sheet, 2, 2, lastRow - 1, 4); // B..E
    var subscriptions = [];

    // New Schema: A=DateTime, B=RegistrationUser, C=PushType, D=AuthJSON, E=AuthJSON PC
    for (var i = 0; i < data.length; i++) {
      var rowUser = String(data[i][0] || '').trim().toLowerCase(); // Col B
      if (rowUser.charAt(0) === "'") rowUser = rowUser.substring(1);

      if (fetchAllUsers || targetSet[rowUser]) {
        // Grab Mobile/Default Sub (Col D / Index 3)
        try {
          var subStr = data[i][2];
          if (subStr && subStr !== "") {
            var subObj = JSON.parse(subStr);
            subObj.username = rowUser;
            subObj.type = "mobile"; // Optional tag
            if (subObj.endpoint) subscriptions.push(subObj);
          }
        } catch (e) { Logger.log("Err parsing mobile sub row " + i); }

        // Grab PC Sub (Col E / Index 4) - OPTIONAL
        try {
          var subStrPC = data[i][3];
          if (subStrPC && subStrPC !== "") {
            var subObjPC = JSON.parse(subStrPC);
            subObjPC.username = rowUser;
            subObjPC.type = "pc"; // Optional tag
            if (subObjPC.endpoint) subscriptions.push(subObjPC);
          }
        } catch (e) { Logger.log("Err parsing PC sub row " + i); }
      }
    }

    return createJSON({ 'result': 'success', 'subscriptions': subscriptions });

  } catch (error) {
    return createJSON({ 'result': 'error', 'message': error.toString() });
  }
}
function handleCheckAuth(userParam) {
  if (!userParam) {
    return createJsonResponse({ status: 'error', message: 'Missing user parameter' });
  }

  let searchUser = normalizePhone(userParam);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("Subscribe");

  if (!sheet) {
    return createJsonResponse({ status: 'error', message: 'Sheet Subscribe not found' });
  }

  const rowIndex = findUserRow(sheet, searchUser);
  if (rowIndex) {
    const values = sheet.getRange(rowIndex, 2, 1, 6).getValues()[0]; // B..G
    const sheetPhone = normalizeSheetPhone(values[0]);
    const fullName = values[4];
    const sheetStatus = String(values[5]).trim();

    if (sheetPhone === searchUser) {
      if (sheetStatus === '1') {
        // SUCCESS: User found and active
        return createJsonResponse({
          status: 'success',
          fullName: fullName, // Return Name from Col F
          isActive: true
        });
      }
      // FAIL: User exists but blocked (Status 0)
      return createJsonResponse({
        status: 'error',
        message: 'User inactive',
        isActive: false
      });
    }
  }

  // FAIL: User not found in sheet
  return createJsonResponse({
    status: 'error',
    message: 'User not registered',
    isActive: false
  });
}

// Helper to return JSON
function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  try {
    var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    var data = JSON.parse(e.postData.contents);

    // ======================================================
    // 1. SAVE LOG (To Sheet: Logs)
    // ======================================================
    if (data.action === 'save_log') {
      var sheet = spreadsheet.getSheetByName('Logs');

      if (!sheet) {
        sheet = spreadsheet.insertSheet('Logs');
        sheet.appendRow(['Date', 'Recipient', 'Message', 'Status', 'Details', 'Sender', 'Recipient Auth JSON']);
      }
      ensureLogsSheetHasAuthJsonColumn(sheet);

      // Primary source: value provided by backend server payload.
      // Fallback keeps compatibility for older senders that don't send recipientAuthJson yet.
      var recipientAuthJson = String(data.recipientAuthJson || '').trim();
      if (!recipientAuthJson) {
        recipientAuthJson = getRecipientAuthJsonForLog(spreadsheet, data.recipient);
      }

      sheet.appendRow([
        new Date(),
        data.recipient,
        data.sender,
        data.message,
        data.status,
        data.details,
        recipientAuthJson
      ]);
      return createJSON({ result: 'success' });
    }
    // [NEW] ACTION: BACKUP CHATS
    // ======================================================
    if (data && data.action === 'backup_chats') {
      var sheet = spreadsheet.getSheetByName('Replay');
      var chats = data.data; // Array of chat objects

      if (chats && chats.length > 0) {
        if (!sheet) {
          sheet = spreadsheet.insertSheet('Replay');
          sheet.appendRow(['From', 'To', 'Message', 'SendTime']);
        }
        // Prepare a 2D array for bulk insertion: [[From, To, Message, SendTime], ...]
        var rows = chats.map(function (chat) {
          return [
            chat.from,
            chat.to,
            chat.message,
            chat.time // Ensure your app sends the time string/timestamp
          ];
        });

        // Write to sheet efficiently (Bulk operation)
        var lastRow = sheet.getLastRow();
        sheet.getRange(lastRow + 1, 1, rows.length, 4).setValues(rows);

        return ContentService.createTextOutput(JSON.stringify({ result: 'success', count: rows.length }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    // ======================================================
    // 2. BOT SUPPORT REGISTRATION (To Sheet: BotSubscribe)
    // ======================================================
    if (data.action === 'bot_support_register') {
      var sheet = spreadsheet.getSheetByName('BotSubscribe');

      if (!sheet) {
        sheet = spreadsheet.insertSheet('BotSubscribe');
        sheet.appendRow(['DateTime Registration', 'UserID', 'Push Type', 'Auth JSON', 'First Name', 'Last Name', 'Depart', 'Depart Action', 'Tel Number']);
      }

      var subEndpoint = "";
      var subJson = "";

      if (data.subscription) {
        subEndpoint = data.subscription.endpoint;
        subJson = JSON.stringify(data.subscription);
      }

      sheet.appendRow([
        new Date(),
        data.username,
        subEndpoint,
        subJson,
        data.firstName,
        data.lastName,
        data.department,
        data.actionChoice,
        data.phone
      ]);
      return createJSON({ result: 'success' });
    }

    // ======================================================
    // 3. SAVE REPLY (To Sheet: Replay)
    // ======================================================
    if (data.action === 'save_reply') {
      var sheet = spreadsheet.getSheetByName('Replay');
      if (!sheet) {
        sheet = spreadsheet.insertSheet('Replay');
        sheet.appendRow(['From', 'To', 'Message', 'SendTime']);
      }
      sheet.appendRow([
        data.fromUser,
        data.toUser,
        data.message,
        new Date()
      ]);
      return createJSON({ result: 'success' });
    }

    // ======================================================
    // 4. TOUCH SUBSCRIPTION DATETIME ON AUTH REFRESH
    // ======================================================
    if (data.action === 'touch_subscription_auth_refresh') {
      var touchSheet = spreadsheet.getSheetByName('Subscribe');
      if (!touchSheet) {
        return createJSON({ result: 'error', message: 'Sheet Subscribe not found' });
      }

      var touchUsers = parseRecipientUsernames(data.usernames || data.users || data.recipient);
      if (!touchUsers.length) {
        return createJSON({ result: 'success', requestedUsers: 0, updatedRows: 0, missingUsers: [] });
      }

      var touchTimestamp = new Date();
      var rowsToUpdate = [];
      var missingUsers = [];
      for (var i = 0; i < touchUsers.length; i++) {
        var touchUser = touchUsers[i];
        var touchRow = findUserRow(touchSheet, touchUser);
        if (!touchRow) {
          missingUsers.push(touchUser);
          continue;
        }
        rowsToUpdate.push(touchRow);
      }

      if (rowsToUpdate.length) {
        var rangeList = touchSheet.getRangeList(rowsToUpdate.map(function(row) { return 'A' + row; }));
        rangeList.setValue(touchTimestamp);
      }

      return createJSON({
        result: 'success',
        requestedUsers: touchUsers.length,
        updatedRows: rowsToUpdate.length,
        missingUsers: missingUsers
      });
    }

    // ======================================================
    // 5. REMOVE STALE SUBSCRIPTIONS BY ENDPOINT
    // ======================================================
    if (data.action === 'remove_subscriptions_by_endpoint') {
      var subscribeSheet = spreadsheet.getSheetByName('Subscribe');
      if (!subscribeSheet) return createJSON({ result: 'success', rowsTouched: 0, clearedSubscriptions: 0 });

      var endpointSet = normalizeEndpointsInput(data.endpoints);
      var endpointKeys = Object.keys(endpointSet);
      if (endpointKeys.length === 0) {
        return createJSON({ result: 'success', rowsTouched: 0, clearedSubscriptions: 0, requestedEndpoints: 0 });
      }

      var subscribeLastRow = getLastDataRow(subscribeSheet);
      if (!subscribeLastRow) {
        return createJSON({ result: 'success', rowsTouched: 0, clearedSubscriptions: 0, requestedEndpoints: endpointKeys.length });
      }

      var subscribeRange = subscribeSheet.getRange(2, 2, subscribeLastRow - 1, 4); // B..E
      var subscribeValues = subscribeRange.getValues();
      var rowsTouched = 0;
      var clearedSubscriptions = 0;

      for (var i = 0; i < subscribeValues.length; i++) {
        var row = subscribeValues[i];
        var mobileEndpoint = getSubscriptionEndpointFromJson(row[2]); // Col D
        var pcEndpoint = getSubscriptionEndpointFromJson(row[3]);     // Col E
        var rowChanged = false;

        if (mobileEndpoint && endpointSet[mobileEndpoint]) {
          row[2] = '';
          rowChanged = true;
          clearedSubscriptions++;
        }
        if (pcEndpoint && endpointSet[pcEndpoint]) {
          row[3] = '';
          rowChanged = true;
          clearedSubscriptions++;
        }

        if (rowChanged) {
          row[1] = getSubscriptionEndpointFromJson(row[2]) || getSubscriptionEndpointFromJson(row[3]) || ''; // Col C
          rowsTouched++;
        }
      }

      if (rowsTouched > 0) {
        subscribeRange.setValues(subscribeValues);
      }

      return createJSON({
        result: 'success',
        rowsTouched: rowsTouched,
        clearedSubscriptions: clearedSubscriptions,
        requestedEndpoints: endpointKeys.length
      });
    }

    // ======================================================
    // 6. [REVISED] PWA SUBSCRIPTION (To Sheet: Subscribe)
    // ======================================================
    // Requested Columns: DateTime | RegistrationUser | Push Type | Auth JSON | Auth JSON PC
    var SHEET_NAME = 'Subscribe';
    var subscribeSheet = spreadsheet.getSheetByName(SHEET_NAME);

    if (!subscribeSheet) {
      subscribeSheet = spreadsheet.insertSheet(SHEET_NAME);
      // Set the NEW Header
      subscribeSheet.appendRow(['DateTime', 'RegistrationUser', 'Push Type', 'Auth JSON', 'Auth JSON PC']);
    }

    // --- FIX 1: Normalize the username to ensure it starts with exactly one '0' ---
    var username = normalizePhone(data.username || '');
    // -----------------------------------------------------------------------------

    var subscriptionMobile = data.subscriptionMobile || data.subscription_mobile || null;
    var subscriptionPC = data.subscriptionPC || data.subscription_pc || null;
    var subscription = data.subscription || subscriptionMobile || subscriptionPC;
    var deviceType = String(data.deviceType || '').trim().toLowerCase();
    var platform = String(data.platform || '').trim().toLowerCase();

    if (!username || !subscription || !subscription.endpoint) {
      throw new Error("Invalid data: Missing Subscription");
    }

    var timestamp = new Date();
    var rowIndex = findUserRow(subscribeSheet, username);
    var existingMobileJson = '';
    var existingPcJson = '';
    if (rowIndex > 0) {
      var existingAuthValues = subscribeSheet.getRange(rowIndex, 4, 1, 2).getValues()[0]; // D..E
      existingMobileJson = String(existingAuthValues[0] || '').trim();
      existingPcJson = String(existingAuthValues[1] || '').trim();
    }

    var isPcUpdate = deviceType === 'pc' || platform === 'desktop' || Boolean(subscriptionPC && subscriptionPC.endpoint);
    var nextMobileJson = existingMobileJson;
    var nextPcJson = existingPcJson;

    if (isPcUpdate) {
      nextPcJson = JSON.stringify(subscriptionPC || subscription);
      if (subscriptionMobile && subscriptionMobile.endpoint) {
        nextMobileJson = JSON.stringify(subscriptionMobile);
      }
    } else {
      nextMobileJson = JSON.stringify(subscriptionMobile || subscription);
      if (subscriptionPC && subscriptionPC.endpoint) {
        nextPcJson = JSON.stringify(subscriptionPC);
      }
    }

    if (!nextMobileJson && !nextPcJson) {
      throw new Error("Invalid data: No subscription JSON to save");
    }
    var primaryEndpoint = getSubscriptionEndpointFromJson(nextMobileJson) || getSubscriptionEndpointFromJson(nextPcJson) || String(subscription.endpoint || '').trim();

    // --- FIX 2: Prepend a single quote (') when saving to sheet ---
    // This forces Google Sheets to treat the number as Text and keep the leading zero.
    var formattedUsername = "'" + username;

    if (rowIndex > 0) {
      // UPDATE EXISTING ROW
      var range = subscribeSheet.getRange(rowIndex, 1, 1, 5);
      range.setValues([[
        timestamp,
        formattedUsername, // Uses the version with the single quote
        primaryEndpoint,
        nextMobileJson,
        nextPcJson
      ]]);

      return createJSON({ 'result': 'success', 'action': 'updated' });

    } else {
      // CREATE NEW ROW
      subscribeSheet.appendRow([
        timestamp,
        formattedUsername, // Uses the version with the single quote
        primaryEndpoint,
        nextMobileJson,
        nextPcJson
      ]);
      return createJSON({ 'result': 'success', 'action': 'created' });
    }

  } catch (error) {
    return createJSON({ 'result': 'error', 'message': error.toString() });
  }
}

// --- HELPER FUNCTIONS ---
function createJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function createError(msg) {
  return createJSON({ 'result': 'error', 'message': msg });
}


function testGetHrStepsAction() {
  // --- CONFIGURATION ---
  // Replace '123' with a real Service ID from your 'Hr-Steps Action' sheet (Col B) to see real data.
  var testServiceId = '2'; 

  // --- MOCK EVENT OBJECTS ---
  
  // Case 1: Testing with a specific Service ID
  var eventWithId = {
    parameter: {
      action: 'get_hr_steps_action',
      serviceId: testServiceId
    }
  };

  // Case 2: Testing without a Service ID (Should return all active steps)
  var eventNoId = {
    parameter: {
      action: 'get_hr_steps_action'
    }
  };

  // --- EXECUTION ---

  Logger.log("=== TEST 1: Specific Service ID (" + testServiceId + ") ===");
  try {
    var response1 = doGet(eventWithId);
    var json1 = response1.getContent(); // Extract string from TextOutput
    Logger.log(json1);
  } catch (err) {
    Logger.log("Error in Test 1: " + err);
  }

  Logger.log("\n=== TEST 2: No Service ID (All Active) ===");
  try {
    var response2 = doGet(eventNoId);
    var json2 = response2.getContent();
    Logger.log(json2);
  } catch (err) {
    Logger.log("Error in Test 2: " + err);
  }
}
