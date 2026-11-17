const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { createImportTemplate, parseParticipantRows } = require('../src/services/participantSpreadsheet');

test('parses participant rows from the first XLSX worksheet', async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Participants');
  worksheet.addRow(['Name', 'Phone Number']);
  worksheet.addRow(['Asha', 12345]);
  worksheet.addRow([]);
  worksheet.addRow(['Ravi', 67890]);
  workbook.addWorksheet('Ignored').addRow(['Not imported']);

  const buffer = await workbook.xlsx.writeBuffer();
  const rows = await parseParticipantRows(buffer, 'participants.xlsx');

  assert.deepEqual(rows, [
    { Name: 'Asha', 'Phone Number': '12345' },
    { Name: 'Ravi', 'Phone Number': '67890' }
  ]);
});

test('parses CSV headers and values', async () => {
  const rows = await parseParticipantRows(
    Buffer.from('name,email\nAsha,asha@example.com\n', 'utf8'),
    'participants.csv'
  );

  assert.deepEqual(rows, [{ name: 'Asha', email: 'asha@example.com' }]);
});

test('generates a downloadable XLSX import template', async () => {
  const buffer = await createImportTemplate();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), [
    'id', 'badge id', 'name', 'participant type',
    'place of work', 'tnmc number', 'email', 'phone number'
  ]);
});

test('rejects legacy XLS files rather than using the vulnerable parser', async () => {
  await assert.rejects(
    parseParticipantRows(Buffer.from('not an xls'), 'participants.xls'),
    /Unsupported file type/
  );
});
