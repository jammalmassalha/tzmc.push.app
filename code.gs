// --- CONFIGURATION ---
var SPREADSHEET_ID = '1eQ9r491jTVz7RZJFoUxRRT23QLAJKWbWuKKTrh0NJKE';
var CACHE_TTL_SECONDS = 300;
var CONTACTS_CACHE_TTL_SECONDS = 60;
var APP_SERVER_TOKEN_PROPERTY = 'APP_SERVER_TOKEN';
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

function getServerGuardToken() {
  try {
    var properties = PropertiesService.getScriptProperties();
    var appToken = String(properties.getProperty(APP_SERVER_TOKEN_PROPERTY) || '').trim();
    if (appToken) return appToken;
    var queueToken = String(properties.getProperty(CHECK_QUEUE_SERVER_TOKEN_PROPERTY) || '').trim();
    if (queueToken) return queueToken;
    return '';
  } catch (err) {
    return '';
  }
}

function getCheckQueueServerToken() {
  return getServerGuardToken();
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

function normalizeLoginCode(value) {
  var text = String(value || '').replace(/\D/g, '').trim();
  if (text.length !== 6) return '';
  return text;
}

function normalizeStoredLoginCode(value) {
  var text = String(value || '').trim();
  if (text.charAt(0) === "'") {
    text = text.substring(1);
  }
  return normalizeLoginCode(text);
}

function ensureSubscribeOtpHeader(sheet) {
  if (!sheet) return;
  var headerLabel = String(sheet.getRange(1, 11).getValue() || '').trim();
  if (!headerLabel) {
    sheet.getRange(1, 11).setValue('Login Code');
  }
}

// Columns L (12) and M (13) on the Subscribe sheet record Flutter app
// connections: L = Flutter Mobile (Android/iOS), M = Flutter Web (PWA/browser).
// The cell stores the most recently registered FCM token so the row can be
// audited per device.
var FLUTTER_MOBILE_COL = 12; // L
var FLUTTER_WEB_COL = 13;    // M

function ensureFlutterColumnsHeader(sheet) {
  if (!sheet) return;
  var mobileHeader = String(sheet.getRange(1, FLUTTER_MOBILE_COL).getValue() || '').trim();
  if (!mobileHeader) {
    sheet.getRange(1, FLUTTER_MOBILE_COL).setValue('Flutter Mobile');
  }
  var webHeader = String(sheet.getRange(1, FLUTTER_WEB_COL).getValue() || '').trim();
  if (!webHeader) {
    sheet.getRange(1, FLUTTER_WEB_COL).setValue('Flutter Web');
  }
}

// Returns 12 (L) for mobile / android / ios / unknown, 13 (M) for web/pwa/browser.
// Honors an explicit `targetColumn` ('L' or 'M') if the caller provided one.
function resolveFlutterColumn(data) {
  var explicit = String((data && (data.targetColumn || data.column)) || '').trim().toUpperCase();
  if (explicit === 'L') return FLUTTER_MOBILE_COL;
  if (explicit === 'M') return FLUTTER_WEB_COL;
  var kind = String((data && (data.flutterPlatform || data.platform || data.deviceType)) || '')
    .trim()
    .toLowerCase();
  if (kind === 'web' || kind === 'pwa' || kind === 'browser') return FLUTTER_WEB_COL;
  return FLUTTER_MOBILE_COL;
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

function parseLogDetailsMap(detailsRawValue) {
  var detailsText = String(detailsRawValue || '').trim();
  if (!detailsText) return {};

  // First try JSON payloads for forward compatibility.
  try {
    var parsed = JSON.parse(detailsText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      var jsonResult = {};
      for (var jsonKey in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, jsonKey)) continue;
        jsonResult[String(jsonKey)] = String(parsed[jsonKey] == null ? '' : parsed[jsonKey]).trim();
      }
      return jsonResult;
    }
  } catch (err) {
    // Fallback to key=value parser below.
  }

  var result = {};
  var segments = detailsText.split('|');
  for (var i = 0; i < segments.length; i++) {
    var segment = String(segments[i] || '').trim();
    if (!segment) continue;
    var equalsIndex = segment.indexOf('=');
    if (equalsIndex <= 0) continue;
    var key = String(segment.substring(0, equalsIndex) || '').trim();
    var value = String(segment.substring(equalsIndex + 1) || '').trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
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
    // 0. GET SHUTTLE ORDERS (From Sheet: לוג נסיעות)
    // ======================================================
    if (action === 'get_shuttle_orders') {
      if (typeof getCurrentUserOrders !== 'function') {
        return createError('Shuttle orders handler not found');
      }
      var shuttleUser = (e.parameter && (e.parameter.user || e.parameter.username || e.parameter.phone)) || '';
      return createJSON(getCurrentUserOrders(shuttleUser));
    }

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
      var data = getRangeValues(sheet, 2, 1, lastRow - 1, 5); // A..E
      var steps = [];

      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        if (!row[0] || !row[1]) continue;
        var showToAllUsersRaw = String(row[4] || '').trim();
        var showToAllUsers = (showToAllUsersRaw === '1' || showToAllUsersRaw.toLowerCase() === 'true') ? 1 : 0;
        steps.push({
          id: row[0],
          name: row[1],
          subject: row[2] || '',
          order: row[3] || 0,
          showToAllUsers: showToAllUsers,
          show_to_all_users: showToAllUsers
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
      var configuredContactsToken = getServerGuardToken();
      var providedContactsToken = String(e.parameter.token || e.parameter.serverToken || '').trim();
      if (configuredContactsToken && providedContactsToken !== configuredContactsToken) {
        return createError('Unauthorized get_contacts read');
      }

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
        var statusColG = String(data[i][5] || '').trim(); // Col G (Index 6)
        var exceptionStatusColH = String(data[i][6] || '').trim(); // Col H (Index 7)
        var nameColI = String(data[i][7] || '').trim(); // Col I (Index 8) - Fallback
        var upic = String(data[i][8] || '').trim();
        // Use F if it exists, otherwise try I
        var finalName = nameColF !== "" ? nameColF : nameColI;
        var normalizedStatus = (statusColG === '1' || exceptionStatusColH === '1') ? 1 : 0;

        users.push({
          username: user,
          // Display the found name, or fallback to phone number if both F and I are empty
          displayName: finalName !== "" ? finalName : user,
          fullName: finalName,
          upic: upic,
          status: normalizedStatus
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
    // 4. GET LOGS DUMP (From Sheet: Logs, raw rows)
    // ======================================================
    if (action === 'get_logs_dump') {
      var configuredDumpToken = getServerGuardToken();
      var providedDumpToken = String(e.parameter.token || e.parameter.serverToken || '').trim();
      if (configuredDumpToken && providedDumpToken !== configuredDumpToken) {
        return createError('Unauthorized get_logs_dump read');
      }

      var dumpSheet = spreadsheet.getSheetByName('Logs');
      if (!dumpSheet) {
        return createJSON({
          result: 'success',
          rows: [],
          offset: 0,
          nextOffset: 0,
          count: 0,
          totalRows: 0,
          hasMore: false
        });
      }

      var dumpLastRow = getLastDataRow(dumpSheet);
      if (!dumpLastRow) {
        return createJSON({
          result: 'success',
          rows: [],
          offset: 0,
          nextOffset: 0,
          count: 0,
          totalRows: 0,
          hasMore: false
        });
      }

      var dumpOffsetRaw = parseInt(String(e.parameter.offset || '0'), 10);
      var dumpOffset = isNaN(dumpOffsetRaw) ? 0 : Math.max(0, dumpOffsetRaw);
      var dumpLimitRaw = parseInt(String(e.parameter.limit || '1000'), 10);
      var dumpLimit = isNaN(dumpLimitRaw) ? 1000 : Math.max(1, Math.min(dumpLimitRaw, 5000));
      var dumpTotalRows = Math.max(0, dumpLastRow - 1);
      var dumpRemaining = Math.max(0, dumpTotalRows - dumpOffset);
      var dumpFetchRows = Math.min(dumpLimit, dumpRemaining);

      if (dumpFetchRows <= 0) {
        return createJSON({
          result: 'success',
          rows: [],
          offset: dumpOffset,
          nextOffset: dumpOffset,
          count: 0,
          totalRows: dumpTotalRows,
          hasMore: false
        });
      }

      var dumpValues = getRangeValues(dumpSheet, 2 + dumpOffset, 1, dumpFetchRows, 8);
      var dumpRows = dumpValues.map(function (row) {
        var rowDate = row[0];
        var dateTimeText = '';
        if (rowDate && Object.prototype.toString.call(rowDate) === '[object Date]') {
          dateTimeText = rowDate.toISOString();
        } else {
          dateTimeText = String(rowDate || '').trim();
        }
        return {
          dateTime: dateTimeText,
          toUser: String(row[1] || '').trim(),
          fromUser: String(row[2] || '').trim(),
          messagePreview: String(row[3] || '').trim(),
          successOrFailed: String(row[4] || '').trim(),
          errorMessageOrSuccessCount: String(row[5] || '').trim(),
          recipientAuthJson: String(row[6] || '').trim(),
          msgId: String(row[7] || '').trim()
        };
      });

      var dumpNextOffset = dumpOffset + dumpRows.length;
      return createJSON({
        result: 'success',
        rows: dumpRows,
        offset: dumpOffset,
        nextOffset: dumpNextOffset,
        count: dumpRows.length,
        totalRows: dumpTotalRows,
        hasMore: dumpNextOffset < dumpTotalRows
      });
    }

    // ======================================================
    // 5. GET LOGS MESSAGES (From Sheet: Logs)
    // ======================================================
    if (action === 'get_logs_messages') {
      var requestedLogsUser = normalizePhone(e.parameter.user || e.parameter.username || '');
      var configuredLogsToken = getServerGuardToken();
      var providedLogsToken = String(e.parameter.token || e.parameter.serverToken || '').trim();
      if (configuredLogsToken && providedLogsToken !== configuredLogsToken) {
        return createError('Unauthorized get_logs_messages read');
      }
      if (!requestedLogsUser) {
        return createJSON({ result: 'success', messages: [] });
      }

      var logsSheet = spreadsheet.getSheetByName('Logs');
      if (!logsSheet) {
        return createJSON({ result: 'success', messages: [] });
      }

      var logsLastRow = getLastDataRow(logsSheet);
      if (!logsLastRow) {
        return createJSON({ result: 'success', messages: [] });
      }

      var rawLimit = parseInt(String(e.parameter.limit || '700'), 10);
      var limit = isNaN(rawLimit) ? 700 : Math.max(1, Math.min(rawLimit, 2000));
      var excludeSystem = String(e.parameter.excludeSystem || '1').toLowerCase() !== '0';

      // A..F => Date, Recipient, Sender, Message, Status, Details
      var logsRows = getRangeValues(logsSheet, 2, 1, logsLastRow - 1, 6);
      var messages = [];

      for (var rowIndex = logsRows.length - 1; rowIndex >= 0 && messages.length < limit; rowIndex--) {
        var row = logsRows[rowIndex];
        var recipientRaw = row[1];
        var recipients = parseRecipientUsernames(recipientRaw);
        if (recipients.indexOf(requestedLogsUser) === -1) {
          continue;
        }

        var senderRaw = String(row[2] || '').trim();
        var sender = normalizePhone(senderRaw) || senderRaw;
        if (!sender) continue;
        if (excludeSystem && String(sender).trim().toLowerCase() === 'system') {
          continue;
        }

        var status = String(row[4] || '').trim().toLowerCase();
        if (status.indexOf('fail') === 0 || status.indexOf('error') === 0) {
          continue;
        }
        var details = String(row[5] || '').trim();
        var parsedDetails = parseLogDetailsMap(details);
        var actionTypeFromDetails = String(
          parsedDetails.type || parsedDetails.actionType || parsedDetails.action_type || ''
        ).trim().toLowerCase();
        var isDeletedStatus = status.indexOf('deleted') === 0;
        var resolvedActionType = isDeletedStatus ? 'delete-action' : actionTypeFromDetails;

        var body = String(row[3] || '').trim();
        if (!resolvedActionType) {
          if (!body) continue;
          var normalizedBody = body.toLowerCase();
          if (normalizedBody === 'new notification') {
            continue;
          }
        }

        var timestamp = 0;
        if (row[0] && Object.prototype.toString.call(row[0]) === '[object Date]') {
          timestamp = row[0].getTime();
        } else {
          var parsedTimestamp = new Date(row[0]).getTime();
          timestamp = isNaN(parsedTimestamp) ? 0 : parsedTimestamp;
        }
        if (!timestamp || isNaN(timestamp)) {
          timestamp = Date.now();
        }

        var absoluteRow = rowIndex + 2;
        var messageId = String(
          parsedDetails.messageId || parsedDetails.message_id || parsedDetails.targetMessageId || ''
        ).trim();
        if (!messageId) {
          messageId = 'logs-' + absoluteRow;
        }
        var deletedAtRaw = Number(parsedDetails.deletedAt || parsedDetails.deleted_at || timestamp);
        var deletedAt = isNaN(deletedAtRaw) ? timestamp : deletedAtRaw;

        messages.push({
          id: 'logs-' + absoluteRow,
          messageId: messageId,
          sender: sender,
          body: body,
          timestamp: timestamp,
          recipient: requestedLogsUser,
          status: status,
          details: details,
          type: resolvedActionType || undefined,
          deletedAt: resolvedActionType === 'delete-action' ? deletedAt : undefined,
          groupId: String(parsedDetails.groupId || parsedDetails.group_id || '').trim() || undefined,
          messageIds: String(parsedDetails.messageIds || parsedDetails.message_ids || '').trim() || undefined
        });
      }

      messages.reverse();
      return createJSON({ result: 'success', messages: messages });
    }

    // ======================================================
    // 6. CHECK QUEUE (Polling)
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
        var seenKeys = {};

        for (var i = 0; i < values.length; i++) {
          var row = values[i];

          if (row[0] && row[2]) {
            var recipient = normalizeSheetPhone(row[0]);
            if (!recipient) continue;
            if (requestedUser && recipient !== requestedUser) continue;

            var senderVal = String(row[1]).trim();
            var contentVal = String(row[2]).trim();
            // Deduplicate identical rows within the same batch
            var dedupKey = recipient + '|' + senderVal.toLowerCase() + '|' + contentVal.replace(/\s+/g, ' ').trim().toLowerCase();
            if (seenKeys[dedupKey]) {
              // Mark for deletion but don't add to messages (duplicate)
              rowsToDelete.push(i + 2);
              continue;
            }
            seenKeys[dedupKey] = true;

            messages.push({
              recipient: recipient,
              sender: senderVal,
              content: contentVal
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
    // GET HELPDESK LOCATIONS (From Sheet: HelpDeskLocations)
    // ======================================================
    if (action === 'get_helpdesk_locations') {
      var cache = CacheService.getScriptCache();
      var cachedLocations = getCachedResponse(cache, 'helpdesk_locations');
      if (cachedLocations) return cachedLocations;

      var locationsSheet = spreadsheet.getSheetByName('HelpDeskLocations');
      if (!locationsSheet) {
        return createJSON({ result: 'success', locations: [] });
      }

      var lastRow = getLastDataRow(locationsSheet);
      if (!lastRow || lastRow < 2) {
        return createJSON({ result: 'success', locations: [] });
      }

      // Read column A (locations) starting from row 2 (skip header)
      var data = getRangeValues(locationsSheet, 2, 1, lastRow - 1, 1);
      var locations = [];

      for (var i = 0; i < data.length; i++) {
        var loc = String(data[i][0] || '').trim();
        if (loc) {
          locations.push(loc);
        }
      }

      return cacheResponse(cache, 'helpdesk_locations', { result: 'success', locations: locations }, CACHE_TTL_SECONDS);
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
    if (!e || !e.postData || !e.postData.contents) {
      return createJSON({ result: 'error', message: 'Missing request body' });
    }
    var data = JSON.parse(e.postData.contents);
    var configuredServerToken = getServerGuardToken();
    var providedServerToken = String(data.token || data.serverToken || '').trim();

    if (data.action === 'set_login_code') {
      if (configuredServerToken && providedServerToken !== configuredServerToken) {
        return createJSON({ result: 'error', message: 'Unauthorized set_login_code request' });
      }
      var setCodeSheet = spreadsheet.getSheetByName('Subscribe');
      if (!setCodeSheet) {
        return createJSON({ result: 'error', message: 'Sheet Subscribe not found' });
      }

      var setCodeUser = normalizePhone(data.user || data.username || data.phone || '');
      var setCodeValue = normalizeLoginCode(data.code || data.otp || '');
      if (!setCodeUser || !setCodeValue) {
        return createJSON({ result: 'error', message: 'Invalid user or verification code' });
      }

      var setCodeRow = findUserRow(setCodeSheet, setCodeUser);
      ensureSubscribeOtpHeader(setCodeSheet);
      if (!setCodeRow) {
        setCodeSheet.appendRow([
          new Date(),             // A DateTime
          "'" + setCodeUser,      // B RegistrationUser
          '',                     // C Push Type
          '',                     // D Auth JSON
          '',                     // E Auth JSON PC
          '',                     // F Full name (legacy/fallback)
          '1',                    // G Status (active by default for SMS registration flow)
          '',                     // H Exception status
          '',                     // I Alt name
          '',                     // J Reserved
          "'" + setCodeValue      // K Login Code
        ]);
        return createJSON({ result: 'success', updatedRows: 1, action: 'created' });
      }

      setCodeSheet.getRange(setCodeRow, 11).setValue("'" + setCodeValue); // K
      return createJSON({ result: 'success', updatedRows: 1, action: 'updated' });
    }

    if (data.action === 'verify_login_code') {
      if (configuredServerToken && providedServerToken !== configuredServerToken) {
        return createJSON({ result: 'error', message: 'Unauthorized verify_login_code request' });
      }
      var verifyCodeSheet = spreadsheet.getSheetByName('Subscribe');
      if (!verifyCodeSheet) {
        return createJSON({ result: 'error', message: 'Sheet Subscribe not found' });
      }

      var verifyCodeUser = normalizePhone(data.user || data.username || data.phone || '');
      var verifyCodeValue = normalizeLoginCode(data.code || data.otp || '');
      if (!verifyCodeUser || !verifyCodeValue) {
        return createJSON({ result: 'success', verified: false });
      }

      var verifyCodeRow = findUserRow(verifyCodeSheet, verifyCodeUser);
      if (!verifyCodeRow) {
        return createJSON({ result: 'success', verified: false });
      }

      ensureSubscribeOtpHeader(verifyCodeSheet);
      var storedCode = normalizeStoredLoginCode(verifyCodeSheet.getRange(verifyCodeRow, 11).getValue()); // K
      var isCodeValid = storedCode === verifyCodeValue;
      if (isCodeValid) {
        verifyCodeSheet.getRange(verifyCodeRow, 11).setValue(''); // consume OTP once
      }
      return createJSON({ result: 'success', verified: isCodeValid });
    }

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
    // 6. FLUTTER APP CONNECTION (column L = mobile, M = web)
    // ======================================================
    // Triggered by the backend `/flutter/register-fcm` and
    // `/flutter/unregister-fcm` routes which POST a payload tagged with
    //   { source: 'flutter', flutterPlatform: 'mobile'|'web',
    //     targetColumn: 'L'|'M', action: 'subscribe'|'unsubscribe',
    //     username, fcmToken }
    // The matching Subscribe row is created if missing; the cell in column
    // L or M is set to the FCM token on subscribe and cleared on unsubscribe.
    if (data && (data.source === 'flutter' || data.client === 'flutter')) {
      var flutterSheet = spreadsheet.getSheetByName('Subscribe');
      if (!flutterSheet) {
        flutterSheet = spreadsheet.insertSheet('Subscribe');
        flutterSheet.appendRow(['DateTime', 'RegistrationUser', 'Push Type', 'Auth JSON', 'Auth JSON PC']);
      }
      ensureFlutterColumnsHeader(flutterSheet);

      var flutterUser = normalizePhone(data.username || data.user || '');
      if (!flutterUser) {
        return createJSON({ result: 'error', message: 'Flutter sync: missing username' });
      }

      var flutterColumn = resolveFlutterColumn(data);
      var flutterAction = String((data.action || 'subscribe')).toLowerCase();
      var flutterToken = String(data.fcmToken || data.token || '').trim();
      var flutterTimestamp = new Date();
      var flutterRow = findUserRow(flutterSheet, flutterUser);

      if (!flutterRow) {
        // Create a minimal row so we can record the Flutter cell. Mirrors
        // the row layout used by the OTP/PWA flows above (A=DateTime,
        // B=user with leading-zero quote, K reserved for OTP, L/M for Flutter).
        var newRow = new Array(Math.max(flutterColumn, 11));
        for (var fci = 0; fci < newRow.length; fci++) newRow[fci] = '';
        newRow[0] = flutterTimestamp;          // A
        newRow[1] = "'" + flutterUser;         // B
        newRow[flutterColumn - 1] = (flutterAction === 'unsubscribe') ? '' : (flutterToken || '1');
        flutterSheet.appendRow(newRow);
        return createJSON({
          result: 'success',
          action: 'created',
          source: 'flutter',
          column: flutterColumn === FLUTTER_WEB_COL ? 'M' : 'L'
        });
      }

      if (flutterAction === 'unsubscribe') {
        flutterSheet.getRange(flutterRow, flutterColumn).setValue('');
      } else {
        flutterSheet.getRange(flutterRow, flutterColumn).setValue(flutterToken || '1');
      }
      flutterSheet.getRange(flutterRow, 1).setValue(flutterTimestamp); // refresh DateTime

      return createJSON({
        result: 'success',
        action: flutterAction === 'unsubscribe' ? 'cleared' : 'updated',
        source: 'flutter',
        column: flutterColumn === FLUTTER_WEB_COL ? 'M' : 'L'
      });
    }

    // ======================================================
    // 7. [REVISED] PWA SUBSCRIPTION (To Sheet: Subscribe)
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
