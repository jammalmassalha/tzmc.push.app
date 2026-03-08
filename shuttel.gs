var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
var formID = "1vd8BSr2igB55n9sHm7MZ4xIjWCEklKawjjzhNJ29n-w"
var wsData = SpreadsheetApp.openById(ssID).getSheetByName("עובדים")
var wsDataPark = SpreadsheetApp.openById(ssID).getSheetByName("תחנות")
var wsShuttleLog = SpreadsheetApp.openById(ssID).getSheetByName("לוג נסיעות")
//var form = FormApp.openById(formID)
function doGet(e) {
  let data = "";
  var action = String((e.parameter && e.parameter.action) || '').trim();
  var debugMode = resolveShuttleDebugFlag(e && e.parameter ? e.parameter.debug : '');

  if (action === 'get_user_orders' || action === 'get_shuttle_orders') {
    var currentUser = (e.parameter && (e.parameter.user || e.parameter.username || e.parameter.phone)) || '';
    data = getCurrentUserOrders(currentUser, {
      debug: debugMode,
      includeBuckets: resolveShuttleIncludeBucketsFlag(e && e.parameter ? e.parameter.includeBuckets : '')
    });
    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'check_get_user_orders' || action === 'check_user_orders') {
    var checkUser = (e.parameter && (e.parameter.user || e.parameter.username || e.parameter.phone)) || '';
    data = checkGetUserOrders(checkUser, { debug: debugMode });
    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'normalize_duplicate_display_flags' || action === 'admin_normalize_duplicate_display_flags') {
    if (!isShuttleAdminActionAuthorized(e)) {
      return ContentService
        .createTextOutput(JSON.stringify({
          result: 'error',
          message: 'Unauthorized admin action'
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    data = normalizeHistoricalDuplicateStatusToDisplayFlags();
    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameters.emp != null && e.parameters.emp != '') {
    data = getWorker();
    return ContentService.createTextOutput(JSON.stringify(data));
  } else if (e.parameters.park != null && e.parameters.park != '') {
    data = getParks();
    return ContentService.createTextOutput(JSON.stringify(data));
  }else if(e.parameter["entry.1035269960"] != null && e.parameter["entry.1035269960"] != ""){
    var sheet = SpreadsheetApp.openById("1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g").getSheetByName("לוג נסיעות");
    let time = e.parameter["entry.1992732561"];
    var incomingStatus = String(e.parameter["entry.798637322"] || '').trim();
    var incomingOrder = {
      employee: e.parameter["entry.1035269960"],
      date: e.parameter["entry.794242217"],
      time: time,
      station: e.parameter["entry.1096369604"],
      status: incomingStatus
    };
    if (!isShuttleEmployeeAllowedToOrder(incomingOrder.employee)) {
      return ContentService
        .createTextOutput(JSON.stringify({
          result: 'error',
          message: 'המשתמש לא מורשה להזמין הסעה'
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var conflictResult = checkAndResolveShuttleOrderConflict(sheet, incomingOrder);
    var displayFlag = resolveShuttleDisplayFlagByStatus(incomingStatus);
    
    var entries = [
      new Date(),
      incomingOrder.employee,
      incomingOrder.date,
      time,
      incomingOrder.station,
      incomingStatus,
      displayFlag
    ];
    if (conflictResult.action === 'insert') {
      sheet.appendRow(entries);
    }
    invalidateCurrentUserOrdersCache(incomingOrder.employee);
    
    return ContentService.createTextOutput("Success");
  }
}

function resolveShuttleDebugFlag(value) {
  var normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'debug';
}

function resolveShuttleIncludeBucketsFlag(value) {
  var normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'buckets';
}

function getShuttleAdminToken() {
  return String(
    (PropertiesService.getScriptProperties().getProperty('SHUTTLE_ADMIN_TOKEN') || '')
  ).trim();
}

function isShuttleAdminActionAuthorized(e) {
  var expectedToken = getShuttleAdminToken();
  if (!expectedToken) return false;
  var providedToken = String(
    (e && e.parameter && (e.parameter.token || e.parameter.adminToken)) || ''
  ).trim();
  return Boolean(providedToken && providedToken === expectedToken);
}

function invalidateCurrentUserOrdersCache(userValue) {
  var normalizedUser = normalizeShuttlePhone(userValue);
  if (!normalizedUser) return;
  var cache = CacheService.getScriptCache();
  cache.removeAll([
    'current_user_orders_' + normalizedUser,
    'current_user_orders_' + normalizedUser + '_b0',
    'current_user_orders_' + normalizedUser + '_b1'
  ]);
}

function checkAndResolveShuttleOrderConflict(sheet, incomingOrder) {
  var normalizedIncoming = normalizeShuttleOrderLookupPayload(incomingOrder);
  if (!normalizedIncoming.employee || !normalizedIncoming.date || !normalizedIncoming.time || !normalizedIncoming.station) {
    return { action: 'insert', matchedRows: [] };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { action: 'insert', matchedRows: [] };
  }

  var values = sheet.getRange(2, 2, lastRow - 1, 6).getValues(); // B..G
  var matchedRows = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var existingOrder = normalizeShuttleOrderLookupPayload({
      employee: row[0], // B
      date: row[1],     // C
      time: row[2],     // D
      station: row[3],  // E
      status: row[4],   // F
      display: row[5]   // G
    });

    if (
      existingOrder.employee === normalizedIncoming.employee &&
      existingOrder.date === normalizedIncoming.date &&
      existingOrder.time === normalizedIncoming.time &&
      existingOrder.station === normalizedIncoming.station
    ) {
      matchedRows.push({
        row: i + 2,
        status: existingOrder.status
      });
    }
  }

  if (!matchedRows.length) {
    return { action: 'insert', matchedRows: [] };
  }

  var incomingStatus = String(incomingOrder && incomingOrder.status || '').trim();
  var displayFlag = resolveShuttleDisplayFlagByStatus(incomingStatus);
  updateShuttleRowsStatusAndDisplay(
    sheet,
    matchedRows.map(function(match) { return match.row; }),
    incomingStatus,
    displayFlag
  );

  var hasSameStatus = matchedRows.some(function(match) {
    return match.status === normalizedIncoming.status;
  });
  if (hasSameStatus) {
    return {
      action: 'updated-existing-same-status',
      matchedRows: matchedRows,
      displayFlag: displayFlag
    };
  }

  return {
    action: 'updated-existing-new-status',
    matchedRows: matchedRows,
    displayFlag: displayFlag
  };
}

function normalizeShuttleOrderLookupPayload(order) {
  var employee = normalizeShuttlePhone(order && order.employee);
  var dateIso = toShuttleIsoDate(order && order.date);
  var timeLabel = formatShuttleShift(order && order.time);
  var station = normalizeShuttleOrderLookupText(order && order.station);
  var status = normalizeShuttleOrderLookupText(order && order.status);
  var display = normalizeShuttleDisplayFlag(order && order.display);

  return {
    employee: employee,
    date: dateIso,
    time: timeLabel,
    station: station,
    status: status,
    display: display
  };
}

function normalizeShuttleOrderLookupText(value) {
  var text = String(value || '').trim();
  if (text.charAt(0) === "'") {
    text = text.substring(1);
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeShuttleDisplayFlag(value) {
  var text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return '1';
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return '0';
  var numeric = Number(text);
  if (!isNaN(numeric)) {
    return numeric === 0 ? '0' : '1';
  }
  return '';
}

function isShuttleDisplayVisible(value) {
  return normalizeShuttleDisplayFlag(value) !== '0';
}

function isShuttleActiveStatusValue(value) {
  var normalized = normalizeShuttleOrderLookupText(value);
  if (!normalized) return false;
  return normalized.indexOf('פעיל') >= 0 || normalized.indexOf('актив') >= 0;
}

function resolveShuttleDisplayFlagByStatus(statusValue) {
  return isShuttleActiveStatusValue(statusValue) ? '1' : '0';
}

function updateShuttleRowsStatusAndDisplay(sheet, rows, statusValue, displayFlag) {
  if (!sheet || !rows || !rows.length) return;
  var safeStatus = String(statusValue || '').trim();
  var safeDisplay = normalizeShuttleDisplayFlag(displayFlag) || resolveShuttleDisplayFlagByStatus(safeStatus);
  var uniqueRows = {};
  rows.forEach(function(row) {
    var rowIndex = Number(row || 0);
    if (rowIndex >= 2) {
      uniqueRows[rowIndex] = true;
    }
  });
  Object.keys(uniqueRows).forEach(function(rowKey) {
    var rowIndex = Number(rowKey || 0);
    if (rowIndex < 2) return;
    if (safeStatus) {
      sheet.getRange(rowIndex, 6).setValue(safeStatus); // F: status
    }
    sheet.getRange(rowIndex, 7).setValue(safeDisplay); // G: display flag
  });
}

function deleteRowsByDescendingIndex(sheet, rows) {
  if (!rows || !rows.length) return;
  var uniqueRows = {};
  rows.forEach(function(row) {
    var rowIndex = Number(row || 0);
    if (rowIndex >= 2) {
      uniqueRows[rowIndex] = true;
    }
  });
  var sortedRows = Object.keys(uniqueRows)
    .map(function(value) { return Number(value); })
    .sort(function(a, b) { return b - a; });
  sortedRows.forEach(function(rowIndex) {
    // Soft delete: keep history row and hide it from queries/UI.
    sheet.getRange(rowIndex, 7).setValue('0');
  });
}

function main() {
  /*
   var item = form.getItemById(716547780)
  Logger.log(item)
  var items = form.getItems()
  Logger.log(items[0].getId().toString())
  */
  var labels = wsData.getRange(1, 1, 1, wsData.getLastColumn()).getValues();
  Logger.log(labels)
  labels.forEach(function (label, i) {
    var options = wsData.getRange(2, label.length, wsData.getLastRow() - 1, 1).getValues().map(function (o) { return o[0] });
    Logger.log(options)
    updateDropDown(716547780, options)
  })
}
function getWorker() {
  var labels = wsData.getRange(1, 1, 1, wsData.getLastColumn()).getValues();
  var options = [];
  labels.forEach(function (label, i) {
    options = wsData.getRange(2, label.length, wsData.getLastRow() - 1, 1).getValues().map(function (o) { return o[0] });

  })
  return options;
}
function getParks() {
  var labels = wsDataPark.getRange(1, 1, 1, 1).getValues();
  var options = [];
  labels.forEach(function (label, i) {
    options = wsDataPark.getRange(2, label.length, wsDataPark.getLastRow() - 1, 1).getValues().map(function (o) {
      let io = 0;
      return o[0];
    });

  })
  return options;
}

function isShuttleEmployeeAllowedToOrder(employeeValue) {
  var normalizedEmployeeText = normalizeShuttleOrderLookupText(employeeValue);
  var normalizedEmployeePhone = normalizeShuttlePhone(employeeValue);
  if (!normalizedEmployeeText && !normalizedEmployeePhone) {
    return false;
  }

  var workers = getWorker();
  if (!Array.isArray(workers) || !workers.length) {
    return false;
  }

  for (var i = 0; i < workers.length; i++) {
    var workerRaw = String(workers[i] || '').trim();
    if (!workerRaw) continue;

    var workerText = normalizeShuttleOrderLookupText(workerRaw);
    var workerPhone = normalizeShuttlePhone(workerRaw);

    if (normalizedEmployeePhone && workerPhone && normalizedEmployeePhone === workerPhone) {
      return true;
    }
    if (normalizedEmployeeText && workerText && normalizedEmployeeText === workerText) {
      return true;
    }
  }
  return false;
}

function updateDropDown(id, values) {
 // var item = form.getItemById(id)
 // Logger.log(item.asListItem().setChoiceValues(values))
  //var items = form.getItems()
  //Logger.log(items[0].getId().toString())
}
function findAndDeleteDuplicateRowsOLD() {
  return;
  var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
  var sheet = SpreadsheetApp.openById(ssID).getSheetByName("לוג נסיעות")
  // Get the range of data to search.
  const dataRange = sheet.getRange("B:G");;
  const values = dataRange.getValues();
  const length = values.length;
  console.log(length)
  const duplicateRows = [];

  for (var i = 1; i < length; i++) {
    var _val = values.find((val, index) => {
      if (i != index && val[0] != null) {
        if (values[i][0] == val[0] && values[i][2].toString() == val[2].toString() && values[i][1].toString() == val[1].toString() && values[i][3] == val[3] && values[i][4].toString() != val[4].toString()) {
          sheet.getRange("G" + (index + 1)).setValue("0");
          sheet.getRange("G" + (i + 1)).setValue("0");
        }
        // if (values[i][0] == val[0]   && values[i][2].toString() == val[2].toString() && values[i][1].toString() == val[1].toString() && values[i][3] == val[3] && values[i][4].toString() == val[4].toString() &&   val[5].toString().trim().length == 0) {
        //   sheet.getRange("G"+(index+1)).setValue("0");
        //   sheet.getRange("G"+(i+1)).setValue("1");
        // }


      }
    })
  }
  for (var i = 1; i < length; i++) {
    var _val = values.find((val, index) => {
      if (i != index && val[0] != null) {

        if (values[i][0] == val[0] && values[i][2].toString() == val[2].toString() && values[i][1].toString() == val[1].toString() && values[i][3] == val[3] && values[i][4].toString() == val[4].toString() && val[5].toString().trim().length == 0) {
          sheet.getRange("G" + (index + 1)).setValue("0");
          sheet.getRange("G" + (i + 1)).setValue("1");
        }


      }
    })
  }
  for (var i = 1; i < length; i++) {
    var _val = values.find((val, index) => {
      if (i != index && val[0] != null && index != 0) {

        if (val[5].toString().trim().length == 0 && val[4].toString() == "ביטול נסיעה отмена поездки") {
          sheet.getRange("G" + (index + 1)).setValue("0");
        }


      }
    })
  }
  for (var i = 1; i < length; i++) {
    var _val = values.find((val, index) => {
      if (i != index && val[0] != null && index != 0) {

        if (val[4].toString() == "פעיל активный" && val[5].toString().trim().length == 0) {
          sheet.getRange("G" + (index + 1)).setValue("1");
        }


      }
    })
  }

}

function findAndDeleteDuplicateRows() {
  return;
  var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
  var sheet = SpreadsheetApp.openById(ssID).getSheetByName("לוג נסיעות")
  // Get the range of data to search.
  const last50Rows = 100;
  const dataRangeAll = sheet.getRange("B:G");;
  const valuesAll = dataRangeAll.getValues();
  const length = valuesAll.length;
  console.log(length);
  const duplicateRows = [];
  for (var i = length - last50Rows; i < length; i++) {
    sheet.getRange("G" + (i + 1)).setValue(null);
  }
  for (var i = length - last50Rows; i < length; i++) {
    var cell = sheet.getRange("G" + (i + 1));
    var isCellEmptyOrValueEmptys = isCellEmptyOrValueEmpty(cell);
    var indexToSet = []
    valuesAll.forEach((val, index) => {
      if ((index) > i) {
        if (
          val[0].toString().trim() == valuesAll[i][0].toString().trim()
          && val[1].toString().trim() == valuesAll[i][1].toString().trim()
          && val[2].toString().trim() == valuesAll[i][2].toString().trim()
          && val[3].toString().trim() == valuesAll[i][3].toString().trim()
          && (
            (valuesAll[i][4].toString().trim() == "פעיל активный")
            &&
            (val[4].toString().trim() == "פעיל активный")
          )
        ) {
          indexToSet.push(index)

        }
      }
    })
    if (isCellEmptyOrValueEmptys)
      for (var t = 0; t < indexToSet.length; t++) {
        sheet.getRange("G" + (i + 1)).setValue("1");
        sheet.getRange("G" + (indexToSet[t] + 1)).setValue("0");
      }
  }
  for (var i = length - last50Rows; i < length; i++) {
    valuesAll.forEach((val, index) => {
      if (index > i) {
        if (
          val[0].toString().trim() == valuesAll[i][0].toString().trim()
          && val[1].toString().trim() == valuesAll[i][1].toString().trim()
          && val[2].toString().trim() == valuesAll[i][2].toString().trim()
          && val[3].toString().trim() == valuesAll[i][3].toString().trim()
          && (
            (val[4].toString().trim() == "ביטול נסיעה отмена поездки" && valuesAll[i][4].toString().trim() == "פעיל активный")
            ||
            (valuesAll[i][4].toString().trim() == "ביטול נסיעה отмена поездки" && val[4].toString().trim() == "פעיל активный")
          )
        ) {
          sheet.getRange("G" + (index + 1)).setValue("0");
          sheet.getRange("G" + (i + 1)).setValue("0");
        }
      }
    })
  }


  for (var i = length - last50Rows; i < length; i++) {
    var cell = sheet.getRange("G" + (i + 1));
    var isCellEmptyOrValueEmptys = isCellEmptyOrValueEmpty(cell);
    if (valuesAll[i][4].toString() == "ביטול נסיעה отмена поездки" && isCellEmptyOrValueEmptys) {
      sheet.getRange("G" + (i + 1)).setValue("0");
    }
  }
  for (var i = length - last50Rows; i < length; i++) {
    var cell = sheet.getRange("G" + (i + 1));
    var isCellEmptyOrValueEmptys = isCellEmptyOrValueEmpty(cell);
    if (valuesAll[i][4].toString() == "פעיל активный" && isCellEmptyOrValueEmptys) {
      sheet.getRange("G" + (i + 1)).setValue("1");
    }

  }

}

function checkForDuplicates() {
  var sheet = SpreadsheetApp.openById(ssID).getSheetByName("test");
  var data = sheet.getDataRange().getValues();
  var numRows = sheet.getLastRow();
  var numCols = sheet.getLastColumn();
  var duplicateRows = [];
  var duplicateColumns = [];

  for (var i = 1; i < numRows; i++) {
    for (var j = 0; j < i; j++) {
      var duplicate = true;
      for (var k = 1; k < numCols - 1; k++) {
        if (data[i][k] !== data[j][k]) {
          duplicate = false;
          break;
        }
      }
      if (duplicate) {
        duplicateRows.push(i + 1);
        duplicateColumns.push(j + 1);
      }
    }
  }
  if (duplicateRows.length > 0) {
    var rangeList = [];
    for (var l = 0; l < duplicateRows.length; l++) {
      var rowRange = sheet.getRange(duplicateRows[l], 1, 1, numCols - 1);
      var columnRange = sheet.getRange(1, duplicateColumns[l], numRows, 1);
      rangeList.push(rowRange);
      rangeList.push(columnRange);
    }
    var range = sheet.getRangeList(rangeList).setBackground("yellow");
    //Browser.msgBox("Duplicate entries have been highlighted.");
  } else {
    //Browser.msgBox("No duplicate entries were found.");
  }
}

function isCellEmptyOrValueEmpty(cell) {
  // Get the value of the cell.
  var value = cell.getValue();

  // Check if the value is empty or null.
  return value === '' || value === null;
}

function backfillShuttleDisplayFlags() {
  if (!wsShuttleLog) {
    return {
      result: 'error',
      message: 'Sheet לוג נסיעות not found',
      updatedRows: 0
    };
  }

  var lastRow = wsShuttleLog.getLastRow();
  if (lastRow < 2) {
    return {
      result: 'success',
      message: 'No historical rows to process',
      updatedRows: 0
    };
  }

  var rowCount = lastRow - 1;
  var rows = wsShuttleLog.getRange(2, 1, rowCount, 7).getValues(); // A..G
  var nextDisplayValues = [];
  var updatedRows = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var normalizedDisplay = normalizeShuttleDisplayFlag(row[6]); // G
    var hasHistoricalOrderData = String(row[0] || '').trim() !== '' || // A
      String(row[1] || '').trim() !== '' || // B
      String(row[2] || '').trim() !== '' || // C
      String(row[3] || '').trim() !== '' || // D
      String(row[4] || '').trim() !== '' || // E
      String(row[5] || '').trim() !== '';   // F

    if (!normalizedDisplay && hasHistoricalOrderData) {
      nextDisplayValues.push(['1']);
      updatedRows += 1;
      continue;
    }

    nextDisplayValues.push([normalizedDisplay || '']);
  }

  if (updatedRows > 0) {
    wsShuttleLog.getRange(2, 7, rowCount, 1).setValues(nextDisplayValues);
  }

  return {
    result: 'success',
    message: 'Backfill completed',
    updatedRows: updatedRows,
    scannedRows: rowCount
  };
}

function normalizeHistoricalDuplicateStatusToDisplayFlags() {
  if (!wsShuttleLog) {
    return {
      result: 'error',
      message: 'Sheet לוג נסיעות not found',
      updatedRows: 0,
      duplicateGroups: 0
    };
  }

  var lastRow = wsShuttleLog.getLastRow();
  if (lastRow < 2) {
    return {
      result: 'success',
      message: 'No historical rows to process',
      updatedRows: 0,
      duplicateGroups: 0,
      scannedRows: 0
    };
  }

  var rows = wsShuttleLog.getRange(2, 2, lastRow - 1, 6).getValues(); // B..G
  var groupsByKey = {};
  var scannedRows = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var normalized = normalizeShuttleOrderLookupPayload({
      employee: row[0], // B
      date: row[1],     // C
      time: row[2],     // D
      station: row[3],  // E
      status: row[4],   // F
      display: row[5]   // G
    });

    if (!normalized.employee || !normalized.date || !normalized.time || !normalized.station) {
      continue;
    }

    scannedRows += 1;
    var key = [
      normalized.employee,
      normalized.date,
      normalized.time,
      normalized.station
    ].join('|');
    if (!groupsByKey[key]) {
      groupsByKey[key] = [];
    }
    groupsByKey[key].push({
      rowIndex: i + 2,
      statusValue: String(row[4] || '').trim(),
      currentDisplay: normalizeShuttleDisplayFlag(row[5])
    });
  }

  var duplicateGroups = 0;
  var updates = [];
  Object.keys(groupsByKey).forEach(function(key) {
    var groupRows = groupsByKey[key];
    if (!groupRows || groupRows.length < 2) return;
    duplicateGroups += 1;
    groupRows.forEach(function(groupRow) {
      var expectedDisplay = resolveShuttleDisplayFlagByStatus(groupRow.statusValue);
      if (groupRow.currentDisplay !== expectedDisplay) {
        updates.push({
          rowIndex: groupRow.rowIndex,
          displayValue: expectedDisplay
        });
      }
    });
  });

  for (var u = 0; u < updates.length; u++) {
    wsShuttleLog.getRange(updates[u].rowIndex, 7).setValue(updates[u].displayValue);
  }

  return {
    result: 'success',
    message: 'Duplicate-group display normalization completed',
    scannedRows: scannedRows,
    duplicateGroups: duplicateGroups,
    updatedRows: updates.length
  };
}

function getCurrentUserOrders(userValue, options) {
  var startedAt = Date.now();
  var includeBuckets = Boolean(
    options &&
    (options.includeBuckets === true || options.debug === true)
  );
  var debugInfo = (options && options.debug === true)
    ? {
      enabled: true,
      requestStartedAt: new Date(startedAt).toISOString(),
      phasesMs: {},
      cacheHit: false
    }
    : null;
  var normalizedUser = normalizeShuttlePhone(userValue);
  if (!normalizedUser) {
    return attachShuttleDebugTimings({
      result: 'error',
      message: 'Missing or invalid user'
    }, debugInfo, startedAt);
  }

  if (!wsShuttleLog) {
    return attachShuttleDebugTimings({
      result: 'error',
      message: 'Sheet לוג נסיעות not found'
    }, debugInfo, startedAt);
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'current_user_orders_' + normalizedUser + '_' + (includeBuckets ? 'b1' : 'b0');
  var cacheLookupStartedAt = Date.now();
  var cached = cache.get(cacheKey);
  if (debugInfo) {
    debugInfo.phasesMs.cacheLookup = Date.now() - cacheLookupStartedAt;
  }
  if (cached) {
    var cachedResponse = JSON.parse(cached);
    if (!debugInfo) {
      return cachedResponse;
    }
    debugInfo.cacheHit = true;
    debugInfo.path = 'cache';
    debugInfo.counts = {
      groupedOrders: Array.isArray(cachedResponse.orders) ? cachedResponse.orders.length : 0
    };
    return attachShuttleDebugTimings(cachedResponse, debugInfo, startedAt);
  }

  var collectStats = {};
  var collectStartedAt = Date.now();
  var orders = collectCurrentUserRawOrders(normalizedUser, collectStats);
  if (debugInfo) {
    debugInfo.phasesMs.collectRawOrders = Date.now() - collectStartedAt;
    debugInfo.rawCollection = collectStats;
    debugInfo.counts = {
      rawOrders: orders.length
    };
  }

  var pairingStartedAt = Date.now();
  orders = applyShuttleCancelPairingLogic(orders);
  if (debugInfo) {
    debugInfo.phasesMs.applyGrouping = Date.now() - pairingStartedAt;
  }

  var sortStartedAt = Date.now();
  orders.sort(function(a, b) {
    var delta = getShuttleOrderDateTimeSortKey(a) - getShuttleOrderDateTimeSortKey(b);
    if (delta !== 0) return delta;
    return Number(a.sheetRow || 0) - Number(b.sheetRow || 0);
  });
  if (debugInfo) {
    debugInfo.phasesMs.sortOrders = Date.now() - sortStartedAt;
  }

  var buildResponseStartedAt = Date.now();
  var response = buildCurrentUserOrdersResponse(normalizedUser, orders, {
    includeBuckets: includeBuckets
  });
  if (debugInfo) {
    debugInfo.phasesMs.buildResponse = Date.now() - buildResponseStartedAt;
    debugInfo.counts.groupedOrders = orders.length;
    debugInfo.path = 'fresh';
  }

  var cacheWriteStartedAt = Date.now();
  cache.put(cacheKey, JSON.stringify(response), 120);
  if (debugInfo) {
    debugInfo.phasesMs.cacheWrite = Date.now() - cacheWriteStartedAt;
  }
  return attachShuttleDebugTimings(response, debugInfo, startedAt);
}

function attachShuttleDebugTimings(response, debugInfo, startedAt) {
  if (!debugInfo) {
    return response;
  }
  debugInfo.requestFinishedAt = new Date().toISOString();
  debugInfo.totalMs = Date.now() - startedAt;
  response.debug = debugInfo;
  return response;
}

function checkGetUserOrders(userValue, options) {
  var debugMode = Boolean(options && options.debug === true);
  var normalizedUser = normalizeShuttlePhone(userValue);
  if (!normalizedUser) {
    return {
      result: 'error',
      message: 'Missing or invalid user'
    };
  }

  if (!wsShuttleLog) {
    return {
      result: 'error',
      message: 'Sheet לוג נסיעות not found'
    };
  }

  invalidateCurrentUserOrdersCache(normalizedUser);

  var endpointResponse = getCurrentUserOrders(normalizedUser, { debug: debugMode });
  if (!endpointResponse || endpointResponse.result !== 'success') {
    return endpointResponse || {
      result: 'error',
      message: 'Unable to check get_user_orders'
    };
  }

  var rawCollectionDebug = {};
  var rawOrders = collectCurrentUserRawOrders(normalizedUser, rawCollectionDebug);
  var groupChecks = summarizeCurrentUserOrderGroups(rawOrders);
  var mismatchedGroups = groupChecks.filter(function(groupCheck) {
    return groupCheck.matchesMajorityRule !== true;
  });

  var result = {
    result: 'success',
    user: normalizedUser,
    checkedAt: new Date().toISOString(),
    cacheCleared: true,
    rawOrdersCount: rawOrders.length,
    groupedOrdersCount: (endpointResponse.orders || []).length,
    mismatchedGroupsCount: mismatchedGroups.length,
    groupChecks: groupChecks,
    getUserOrders: endpointResponse
  };
  if (debugMode) {
    result.debug = {
      rawCollection: rawCollectionDebug
    };
  }

  Logger.log(JSON.stringify(result));
  return result;
}

function collectCurrentUserRawOrders(normalizedUser, debugInfo) {
  var lastRow = wsShuttleLog.getLastRow();
  if (debugInfo) {
    debugInfo.lastRow = lastRow;
  }
  if (lastRow < 2) {
    if (debugInfo) {
      debugInfo.scanStrategy = 'empty';
      debugInfo.scannedRowsCount = 0;
      debugInfo.candidateRowsCount = 0;
      debugInfo.batchCount = 0;
    }
    return [];
  }

  var readStartedAt = Date.now();
  var rows = wsShuttleLog.getRange(2, 1, lastRow - 1, 7).getValues(); // A..G
  var readRowsMs = Date.now() - readStartedAt;

  var tokenBuildStartedAt = Date.now();
  var digitTokens = buildUserDigitSearchTokens(normalizedUser);
  var buildTokensMs = Date.now() - tokenBuildStartedAt;

  var filterStartedAt = Date.now();
  var orders = [];
  var candidateRowsCount = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!rowMayMatchUserPhone(row, digitTokens)) {
      continue;
    }
    candidateRowsCount += 1;
    var order = mapShuttleOrderRow(row, i + 2);
    if (!order) continue;
    var employeePhone = String(order.employeePhone || '').trim();
    if (!employeePhone || employeePhone !== normalizedUser) {
      continue;
    }
    if (!isShuttleDisplayVisible(order.display)) {
      continue;
    }
    orders.push(order);
  }
  var filterRowsMs = Date.now() - filterStartedAt;

  if (debugInfo) {
    debugInfo.scanStrategy = 'single-pass-full-read';
    debugInfo.batchCount = 1;
    debugInfo.scannedRowsCount = rows.length;
    debugInfo.candidateRowsCount = candidateRowsCount;
    debugInfo.readRowsMs = readRowsMs;
    debugInfo.buildTokensMs = buildTokensMs;
    debugInfo.filterRowsMs = filterRowsMs;
  }
  return orders;
}

function collectUserCandidateRows(normalizedUser, lastRow) {
  var rowSet = {};
  var searchTokens = buildUserSearchTokens(normalizedUser);
  for (var i = 0; i < searchTokens.length; i++) {
    var token = searchTokens[i];
    if (!token) continue;
    addCandidateRowsFromColumn(rowSet, 1, lastRow, token); // A: current / legacy employee
    addCandidateRowsFromColumn(rowSet, 2, lastRow, token); // B: employee in legacy rows
  }
  return Object.keys(rowSet)
    .map(function(value) { return Number(value); })
    .filter(function(value) { return Number.isFinite(value) && value >= 2 && value <= lastRow; })
    .sort(function(a, b) { return a - b; });
}

function buildUserSearchTokens(normalizedUser) {
  var tokens = {};
  var normalized = String(normalizedUser || '').trim();
  if (!normalized) {
    return [];
  }
  tokens[normalized] = true; // 0501234567
  if (/^05\d{8}$/.test(normalized)) {
    tokens['972' + normalized.substring(1)] = true; // 972501234567
    tokens['+972' + normalized.substring(1)] = true; // +972501234567
  }
  return Object.keys(tokens);
}

function buildUserDigitSearchTokens(normalizedUser) {
  var tokens = buildUserSearchTokens(normalizedUser);
  var uniqueDigits = {};
  var addTokenDigits = function(tokenValue) {
    var digits = String(tokenValue || '').replace(/\D/g, '').trim();
    if (digits) {
      uniqueDigits[digits] = true;
    }
  };
  for (var i = 0; i < tokens.length; i++) {
    var token = String(tokens[i] || '').trim();
    addTokenDigits(token);
    var tokenDigits = token.replace(/\D/g, '');
    if (/^05\d{8}$/.test(tokenDigits)) {
      addTokenDigits(tokenDigits.substring(1)); // Numeric cells may drop the leading zero.
    } else if (/^9725\d{8}$/.test(tokenDigits)) {
      addTokenDigits(tokenDigits.substring(3)); // Local Israeli format without country code.
    } else if (/^97205\d{8}$/.test(tokenDigits)) {
      addTokenDigits(tokenDigits.substring(4));
    }
  }
  return Object.keys(uniqueDigits);
}

function rowMayMatchUserPhone(row, digitTokens) {
  if (!digitTokens || !digitTokens.length) {
    return true;
  }
  var colADigits = String(row && row[0] || '').replace(/\D/g, '');
  var colBDigits = String(row && row[1] || '').replace(/\D/g, '');
  if (!colADigits && !colBDigits) {
    return false;
  }
  for (var i = 0; i < digitTokens.length; i++) {
    var token = String(digitTokens[i] || '').trim();
    if (!token) continue;
    if (colADigits.indexOf(token) >= 0 || colBDigits.indexOf(token) >= 0) {
      return true;
    }
  }
  return false;
}

function addCandidateRowsFromColumn(rowSet, column, lastRow, token) {
  if (!token || !lastRow || lastRow < 2) return;
  var searchRange = wsShuttleLog.getRange(2, column, lastRow - 1, 1);
  var finder = searchRange.createTextFinder(String(token || '').trim()).matchCase(false);
  var matches = finder.findAll() || [];
  for (var i = 0; i < matches.length; i++) {
    var rowNumber = Number(matches[i].getRow() || 0);
    if (rowNumber >= 2 && rowNumber <= lastRow) {
      rowSet[String(rowNumber)] = true;
    }
  }
}

function buildContiguousRowBatches(sortedRows) {
  if (!sortedRows || !sortedRows.length) {
    return [];
  }
  var batches = [];
  var startRow = sortedRows[0];
  var previousRow = sortedRows[0];

  for (var i = 1; i < sortedRows.length; i++) {
    var row = sortedRows[i];
    if (row === previousRow + 1) {
      previousRow = row;
      continue;
    }
    batches.push({
      startRow: startRow,
      rowCount: (previousRow - startRow) + 1
    });
    startRow = row;
    previousRow = row;
  }

  batches.push({
    startRow: startRow,
    rowCount: (previousRow - startRow) + 1
  });
  return batches;
}

function collectCurrentUserRawOrdersByFullScan(normalizedUser, lastRow, debugInfo) {
  if (debugInfo) {
    debugInfo.scanStrategy = 'full-scan';
    debugInfo.scannedRowsCount = Math.max(0, Number(lastRow || 0) - 1);
  }
  var rows = wsShuttleLog.getRange(2, 1, lastRow - 1, 7).getValues(); // A..G
  var orders = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var order = mapShuttleOrderRow(row, i + 2);
    if (!order) continue;
    var employeePhone = String(order.employeePhone || '').trim();
    if (!employeePhone || employeePhone !== normalizedUser) {
      continue;
    }
    if (!isShuttleDisplayVisible(order.display)) {
      continue;
    }
    orders.push(order);
  }
  return orders;
}

function buildCurrentUserOrdersResponse(normalizedUser, orders, options) {
  var includeBuckets = Boolean(options && options.includeBuckets === true);
  var ongoing = includeBuckets ? [] : null;
  var past = includeBuckets ? [] : null;
  var ongoingCount = 0;
  var pastCount = 0;
  for (var i = 0; i < orders.length; i++) {
    if (orders[i].isOngoing) {
      ongoingCount += 1;
      if (includeBuckets) {
        ongoing.push(orders[i]);
      }
    } else {
      pastCount += 1;
      if (includeBuckets) {
        past.push(orders[i]);
      }
    }
  }

  var response = {
    result: 'success',
    user: normalizedUser,
    counts: {
      total: orders.length,
      ongoing: ongoingCount,
      past: pastCount
    },
    orders: orders
  };
  if (includeBuckets) {
    response.ongoing = ongoing;
    response.past = past;
  }
  return response;
}

function summarizeCurrentUserOrderGroups(rawOrders) {
  var grouped = {};
  for (var i = 0; i < rawOrders.length; i++) {
    var order = rawOrders[i];
    var key = buildShuttleOrderKey(order) || ('no-key-' + String(order.sheetRow || i));
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(order);
  }

  var keys = Object.keys(grouped);
  var summary = [];
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var group = grouped[key];
    if (!group || !group.length) continue;

    var activeCount = 0;
    var nonActiveCount = 0;
    for (var j = 0; j < group.length; j++) {
      if (isShuttleOrderCancelledState(group[j])) {
        nonActiveCount += 1;
      } else {
        activeCount += 1;
      }
    }

    var representative = selectGroupRepresentative(group);
    var expectedActive = activeCount > nonActiveCount;
    var actualActive = representative ? !isShuttleOrderCancelledState(representative) : false;

    summary.push({
      key: key,
      total: group.length,
      activeCount: activeCount,
      nonActiveCount: nonActiveCount,
      expectedMajorityStatus: expectedActive ? 'active' : 'not_active',
      actualRepresentativeStatus: actualActive ? 'active' : 'not_active',
      representativeSheetRow: representative ? Number(representative.sheetRow || 0) : 0,
      matchesMajorityRule: expectedActive === actualActive
    });
  }

  summary.sort(function(a, b) {
    return String(a.key || '').localeCompare(String(b.key || ''));
  });
  return summary;
}

function applyShuttleCancelPairingLogic(orders) {
  var grouped = {};
  var passthrough = [];

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    var key = buildShuttleOrderKey(order);
    if (!key) {
      passthrough.push(order);
      continue;
    }
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(order);
  }

  var result = passthrough.slice();
  var groupKeys = Object.keys(grouped);
  for (var k = 0; k < groupKeys.length; k++) {
    var group = grouped[groupKeys[k]];
    if (!group || !group.length) continue;

    var representative = selectGroupRepresentative(group);
    if (!representative) continue;
    result.push(representative);
  }

  return result;
}

function buildShuttleOrderKey(order) {
  if (!order) return '';
  var dateIso = normalizeOrderKeySegment(order.dateIso || toShuttleIsoDate(order.date || ''));
  var shift = normalizeOrderKeySegment(formatShuttleShift(order.shift || order.shiftValue || ''));
  var station = normalizeOrderKeySegment(order.station || '');
  if (!dateIso || !shift || !station) return '';
  return [dateIso, shift, station].join('|');
}

function selectGroupRepresentative(group) {
  var latestOrder = null;
  var activeCount = 0;
  var nonActiveCount = 0;

  for (var i = 0; i < group.length; i++) {
    var order = group[i];
    var orderTs = Number(order.submittedAt || 0);
    var isCancelled = isShuttleOrderCancelledState(order);
    if (isCancelled) {
      nonActiveCount += 1;
    } else {
      activeCount += 1;
    }
    var orderRow = Number(order.sheetRow || 0);
    var latestTs = latestOrder ? Number(latestOrder.submittedAt || 0) : -1;
    var latestRow = latestOrder ? Number(latestOrder.sheetRow || 0) : -1;

    if (!latestOrder || orderTs > latestTs || (orderTs === latestTs && orderRow > latestRow)) {
      latestOrder = order;
    }
  }

  if (!latestOrder) return null;

  var groupIsActive = activeCount > nonActiveCount;
  var next = cloneShuttleOrder(latestOrder);
  if (!groupIsActive) {
    next.isCancelled = true;
    next.isOngoing = false;
    if (!String(next.status || '').trim()) {
      next.status = 'ביטול נסיעה отмена поезд';
    }
    next.statusValue = String(next.status || '').trim() || 'ביטול נסיעה отмена поезд';
    if (!next.cancelledAt) {
      next.cancelledAt = Number(next.submittedAt || Date.now());
    }
    return next;
  }

  next.isCancelled = false;
  next.status = 'פעיל активный';
  next.statusValue = 'פעיל активный';
  next.cancelledAt = '';
  next.isOngoing = isIsoDateTodayOrFuture(next.dateIso);
  return next;
}

function isShuttleOrderCancelledState(order) {
  if (!order) return false;
  if (order.isCancelled === true) return true;
  var statusText = String(order.statusValue || order.status || '').toLowerCase();
  return statusText.indexOf('ביטול') >= 0 ||
    statusText.indexOf('בוטל') >= 0 ||
    statusText.indexOf('отмена') >= 0 ||
    statusText.indexOf('отмен') >= 0;
}

function cloneShuttleOrder(order) {
  var next = {};
  for (var key in order) {
    if (Object.prototype.hasOwnProperty.call(order, key)) {
      next[key] = order[key];
    }
  }
  return next;
}

function normalizeOrderKeySegment(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getShuttleOrderDateTimeSortKey(order) {
  if (!order) return 0;
  var dateIso = String(order.dateIso || toShuttleIsoDate(order.date || '') || '').trim();
  var baseTs = 0;
  if (dateIso) {
    var parsedDate = new Date(dateIso + 'T00:00:00');
    if (!isNaN(parsedDate.getTime())) {
      baseTs = parsedDate.getTime();
    }
  }
  if (!baseTs) {
    baseTs = Number(order.submittedAt || 0) || 0;
  }

  var shiftLabel = formatShuttleShift(order.shift || order.shiftValue || '');
  var shiftMinutes = parseShiftMinutes(shiftLabel);
  if (baseTs && shiftMinutes >= 0) {
    return baseTs + (shiftMinutes * 60 * 1000);
  }
  return baseTs;
}

function parseShiftMinutes(value) {
  var text = String(value || '').trim();
  var match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) return -1;
  var hh = Number(match[1]);
  var mm = Number(match[2]);
  if (isNaN(hh) || isNaN(mm)) return -1;
  return (hh * 60) + mm;
}

function mapShuttleOrderRow(row, sheetRow) {
  var candidateColA = String(row[0] || '').trim();
  var candidateColB = String(row[1] || '').trim();
  var phoneColA = extractPhoneFromEmployeeCell(candidateColA);
  var phoneColB = extractPhoneFromEmployeeCell(candidateColB);
  var isLegacyLogRow =
    (Object.prototype.toString.call(row[0]) === '[object Date]' && !isNaN(row[0].getTime())) ||
    (!phoneColA && Boolean(phoneColB));

  var employee = '';
  var employeePhone = '';
  var dateSource = '';
  var shiftSource = '';
  var station = '';
  var statusText = '';
  var display = '';
  var submittedAt = 0;

  if (isLegacyLogRow) {
    employee = candidateColB;
    employeePhone = phoneColB;
    dateSource = row[2];
    shiftSource = row[3];
    station = String(row[4] || '').trim();
    statusText = String(row[5] || '').trim();
    display = String(row[6] || '').trim();
    submittedAt = (Object.prototype.toString.call(row[0]) === '[object Date]' && !isNaN(row[0].getTime()))
      ? row[0].getTime()
      : 0;
  } else {
    // Fallback supports previous DataToShow-like layout if still present.
    employee = candidateColA;
    employeePhone = phoneColA;
    dateSource = row[1];
    shiftSource = row[2];
    station = String(row[3] || '').trim();
    statusText = String(row[4] || '').trim();
    display = String(row[5] || '').trim();
  }

  if (!employeePhone) return null;

  var dateDisplay = formatShuttleDate(dateSource);
  var dateIso = toShuttleIsoDate(dateSource);
  var shift = formatShuttleShift(shiftSource);
  var shiftValue = formatShuttleShiftValue(shiftSource);

  if (!submittedAt) {
    submittedAt = dateIso ? new Date(dateIso + 'T00:00:00').getTime() : Date.now();
    if (isNaN(submittedAt)) submittedAt = Date.now();
  }

  var isCancelled = isShuttleOrderCancelledState({
    status: statusText,
    statusValue: statusText
  });
  var isOngoing = !isCancelled && isIsoDateTodayOrFuture(dateIso);

  var normalizedDisplay = normalizeShuttleDisplayFlag(display);

  return {
    id: 'sheet-' + sheetRow,
    sheetRow: sheetRow,
    employee: employee,
    employeePhone: employeePhone,
    date: dateDisplay,
    dateIso: dateIso,
    dayName: getShuttleDayName(dateIso),
    shift: shift,
    shiftValue: shiftValue,
    station: station,
    status: statusText,
    statusValue: statusText,
    display: normalizedDisplay || '1',
    submittedAt: submittedAt,
    isCancelled: isCancelled,
    isOngoing: isOngoing
  };
}

function extractPhoneFromEmployeeCell(employeeCellValue) {
  var text = String(employeeCellValue || '').trim();
  if (!text) return '';
  if (text.charAt(0) === "'") text = text.substring(1);

  var direct = normalizeShuttlePhone(text);
  if (direct) return direct;

  var matches = text.match(/\d{9,15}/g) || [];
  for (var i = 0; i < matches.length; i++) {
    var normalized = normalizeShuttlePhone(matches[i]);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeShuttlePhone(value) {
  var digits = String(value || '').replace(/\D/g, '').trim();
  if (!digits) return '';

  if (/^9725\d{8}$/.test(digits)) {
    return '0' + digits.substring(3);
  }
  if (/^97205\d{8}$/.test(digits)) {
    return digits.substring(3);
  }
  if (/^5\d{8}$/.test(digits)) {
    return '0' + digits;
  }
  if (/^05\d{8}$/.test(digits)) {
    return digits;
  }
  if (digits.length > 10) {
    var tail = digits.slice(-10);
    if (/^05\d{8}$/.test(tail)) {
      return tail;
    }
  }
  return '';
}

function toShuttleIsoDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  var slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slashMatch) return '';
  var mm = ('0' + slashMatch[1]).slice(-2);
  var dd = ('0' + slashMatch[2]).slice(-2);
  var yyyy = slashMatch[3];
  return yyyy + '-' + mm + '-' + dd;
}

function formatShuttleDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'M/d/yyyy');
  }
  return String(value || '').trim();
}

function formatShuttleShift(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }

  var raw = String(value || '').trim();
  if (!raw) return '';

  var match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return ('0' + Number(match[1])).slice(-2) + ':' + match[2];
  }

  var parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'HH:mm');
  }

  var embedded = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (embedded) {
    return ('0' + Number(embedded[1])).slice(-2) + ':' + embedded[2];
  }

  return raw;
}

function formatShuttleShiftValue(value) {
  var label = formatShuttleShift(value);
  if (!label) return '';
  return "'" + label;
}

function isIsoDateTodayOrFuture(isoDate) {
  if (!isoDate) return true;
  var todayIso = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return isoDate >= todayIso;
}

function getShuttleDayName(isoDate) {
  if (!isoDate) return '';
  var parsed = new Date(isoDate + 'T00:00:00');
  if (isNaN(parsed.getTime())) return '';
  var dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return dayNames[parsed.getDay()] || '';
}
