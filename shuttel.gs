var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
var formID = "1vd8BSr2igB55n9sHm7MZ4xIjWCEklKawjjzhNJ29n-w"
var wsData = SpreadsheetApp.openById(ssID).getSheetByName("עובדים")
var wsDataPark = SpreadsheetApp.openById(ssID).getSheetByName("תחנות")
var wsShuttleLog = SpreadsheetApp.openById(ssID).getSheetByName("לוג נסיעות")
//var form = FormApp.openById(formID)
function doGet(e) {
  let data = "";
  var action = String((e.parameter && e.parameter.action) || '').trim();

  if (action === 'get_user_orders' || action === 'get_shuttle_orders') {
    var currentUser = (e.parameter && (e.parameter.user || e.parameter.username || e.parameter.phone)) || '';
    data = getCurrentUserOrders(currentUser);
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
    
    var entries = [
      new Date(),
      e.parameter["entry.1035269960"],
      e.parameter["entry.794242217"],
      time,
      e.parameter["entry.1096369604"],
      e.parameter["entry.798637322"]
    ];
    
    sheet.appendRow(entries);
    
    return ContentService.createTextOutput("Success");
  }
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

function getCurrentUserOrders(userValue) {
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

  var cache = CacheService.getScriptCache();
  var cacheKey = 'current_user_orders_' + normalizedUser;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var lastRow = wsShuttleLog.getLastRow();
  if (lastRow < 2) {
    return {
      result: 'success',
      user: normalizedUser,
      counts: { total: 0, ongoing: 0, past: 0 },
      ongoing: [],
      past: [],
      orders: []
    };
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
    orders.push(order);
  }

  orders = applyShuttleCancelPairingLogic(orders);

  orders.sort(function(a, b) {
    var delta = getShuttleOrderDateTimeSortKey(a) - getShuttleOrderDateTimeSortKey(b);
    if (delta !== 0) return delta;
    return Number(a.sheetRow || 0) - Number(b.sheetRow || 0);
  });

  var ongoing = [];
  var past = [];
  for (var j = 0; j < orders.length; j++) {
    if (orders[j].isOngoing) {
      ongoing.push(orders[j]);
    } else {
      past.push(orders[j]);
    }
  }

  var response = {
    result: 'success',
    user: normalizedUser,
    counts: {
      total: orders.length,
      ongoing: ongoing.length,
      past: past.length
    },
    ongoing: ongoing,
    past: past,
    orders: orders
  };

  cache.put(cacheKey, JSON.stringify(response), 45);
  return response;
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
    var statusText = String(order.status || '').toLowerCase();
    var isCancelled = order.isCancelled === true ||
      statusText.indexOf('ביטול') >= 0 ||
      statusText.indexOf('בוטל') >= 0 ||
      statusText.indexOf('отмена') >= 0 ||
      statusText.indexOf('отмен') >= 0;
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

  var statusLower = statusText.toLowerCase();
  var isCancelled = statusLower.indexOf('ביטול') >= 0 || statusLower.indexOf('отмена') >= 0;
  var isOngoing = !isCancelled && isIsoDateTodayOrFuture(dateIso);

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
    display: display,
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
