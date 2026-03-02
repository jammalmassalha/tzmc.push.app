var ssID = "1OWt0Qty9ljn03U6PP32ftY8_wNy8qPl0FBS_Prwv40g"
var formID = "1vd8BSr2igB55n9sHm7MZ4xIjWCEklKawjjzhNJ29n-w"
var wsData = SpreadsheetApp.openById(ssID).getSheetByName("עובדים")
var wsDataPark = SpreadsheetApp.openById(ssID).getSheetByName("תחנות")
//var form = FormApp.openById(formID)
function doGet(e) {
  let data = "";
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
