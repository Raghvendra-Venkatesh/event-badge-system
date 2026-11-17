const ExcelJS = require('exceljs');
const { Readable } = require('node:stream');
const path = require('node:path');

function worksheetToRows(worksheet) {
  if (!worksheet) throw new Error('The spreadsheet has no worksheets.');

  const headerRow = worksheet.getRow(1);
  const headers = [];
  for (let column = 1; column <= headerRow.cellCount; column++) {
    headers.push(headerRow.getCell(column).text.replace(/^\uFEFF/, '').trim());
  }

  const rows = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const values = {};
    let hasValue = false;

    headers.forEach((header, index) => {
      if (!header) return;
      const value = row.getCell(index + 1).text;
      values[header] = value;
      if (value !== '') hasValue = true;
    });

    if (hasValue) rows.push(values);
  }
  return rows;
}

async function parseParticipantRows(buffer, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  const workbook = new ExcelJS.Workbook();

  if (extension === '.csv') {
    const worksheet = await workbook.csv.read(Readable.from([buffer]));
    return worksheetToRows(worksheet);
  }
  if (extension !== '.xlsx') {
    throw new Error('Unsupported file type. Please use CSV or XLSX format.');
  }

  await workbook.xlsx.load(buffer);
  return worksheetToRows(workbook.worksheets[0]);
}

async function createImportTemplate() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Participants');
  worksheet.columns = [
    { header: 'id', key: 'id', width: 10 },
    { header: 'badge id', key: 'badge_id', width: 28 },
    { header: 'name', key: 'name', width: 28 },
    { header: 'participant type', key: 'type', width: 18 },
    { header: 'place of work', key: 'company', width: 36 },
    { header: 'tnmc number', key: 'tnmc_no', width: 18 },
    { header: 'email', key: 'email', width: 32 },
    { header: 'phone number', key: 'phone', width: 20 }
  ];
  worksheet.addRow({});
  return workbook.xlsx.writeBuffer();
}

module.exports = { parseParticipantRows, createImportTemplate };
