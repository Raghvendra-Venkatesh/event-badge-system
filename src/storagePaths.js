const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../data'));
const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(__dirname, '../exports'));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

module.exports = { DATA_DIR, EXPORTS_DIR };
