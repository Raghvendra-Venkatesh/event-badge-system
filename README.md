# Event Badge & Scan System

A self-hosted, full-stack event management system designed to easily handle participant data import, badge generation with QR codes, and real-time attendance tracking with scanners. 

## Features

- **XLSX/CSV Import Integration:** Seamlessly import participant lists with validation.
- **Dynamic Badge Generation:** Automatically generate customizable, print-ready PDF badges with QR codes using `puppeteer` and `pdf-lib`.
- **QR Code Scanning & Analytics:** Scan participant badges to log attendance dynamically.
- **Real-time Syncing:** Employs WebSockets (`ws`) to show instant scan updates across connected clients.
- **Data Export:** Export detailed scan logs and participant reports as formatted files (`archiver` & `xlsx`).
- **Lightweight Backend:** Built entirely on Node.js / Express with `node-sqlite3-wasm` for a robust, cross-platform SQLite database that does not require native build tools.

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** SQLite (`node-sqlite3-wasm`)
- **PDF/Printing:** Puppeteer, pdf-lib
- **WebSockets:** `ws` (for live scan updates)
- **Utilities:** `qrcode`, `xlsx`, `express-fileupload`, `archiver`

## Installation

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **NPM**

### 2. Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/Raghvendra-Venkatesh/event-badge-system.git
cd event-badge-system
npm install
```

### 3. Database Initialization

To set up your SQLite database tables, run the setup script:

```bash
npm run setup
```

## Running the Application

To start the server, simply run:

```bash
npm start
```

The application will be accessible by default on **localhost:3000** (or whatever port is defined in your environment file).

## Project Structure

- `src/server.js`: Main Express application entry point.
- `src/setup-db.js`: Database initialization scripts.
- `src/routes/`: Express route handlers for API logic (e.g., imports, badges, scanning).
- `data/`: Contains the SQLite database file (ignored in source control).
- `public/`: Frontend static assets (HTML, CSS, JS).
- `exports/` & `media/`: Processed outputs and graphical resources.
