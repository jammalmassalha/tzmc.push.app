var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
var formID = "1vd8BSr2igB55n9sHm7MZ4xIjWCEklKawjjzhNJ29n-w"
var wsData = SpreadsheetApp.openById(ssID).getSheetByName("עובדים")
var wsDataPark = SpreadsheetApp.openById(ssID).getSheetByName("תחנות")
var wsDataToShow = SpreadsheetApp.openById(ssID).getSheetByName("DataToShow")
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

  if (!wsDataToShow) {
    return {
      result: 'error',
      message: 'Sheet DataToShow not found'
    };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'current_user_orders_' + normalizedUser;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var lastRow = wsDataToShow.getLastRow();
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

  var rows = wsDataToShow.getRange(2, 1, lastRow - 1, 6).getValues(); // A..F
  var orders = [];
  var ongoing = [];
  var past = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var employee = String(row[0] || '').trim();
    var employeePhone = extractPhoneFromEmployeeCell(employee);
    if (!employeePhone || employeePhone !== normalizedUser) {
      continue;
    }

    var dateDisplay = formatShuttleDate(row[1]);
    var dateIso = toShuttleIsoDate(row[1]);
    var statusText = String(row[4] || '').trim();
    var statusLower = statusText.toLowerCase();
    var isCancelled = statusLower.indexOf('ביטול') >= 0 || statusLower.indexOf('отмена') >= 0;
    var isOngoing = !isCancelled && isIsoDateTodayOrFuture(dateIso);

    var order = {
      sheetRow: i + 2,
      employee: employee,
      employeePhone: employeePhone,
      date: dateDisplay,
      dateIso: dateIso,
      shift: formatShuttleShift(row[2]),
      shiftValue: formatShuttleShiftValue(row[2]),
      station: String(row[3] || '').trim(),
      status: statusText,
      display: String(row[5] || '').trim(),
      isCancelled: isCancelled,
      isOngoing: isOngoing
    };

    orders.push(order);
    if (isOngoing) {
      ongoing.push(order);
    } else {
      past.push(order);
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
