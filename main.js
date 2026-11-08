const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initServer } = require('./backend/server.js');

const frontendPort = Number(process.env.APP_PORT || process.env.PORT || 4173);
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'ZnnCashier - Smart Retail Checkout System',
    backgroundColor: '#121212',
    show: false
  });

  mainWindow.setMenu(null); // Hide default menu

  // Load React App
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL(`http://localhost:${frontendPort}`);
    mainWindow.webContents.openDevTools();
  } else {
    // We can also load from built files when packaged
    mainWindow.loadFile(path.join(__dirname, 'frontend/dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });
}

function startBackend() {
  try {
    initServer(3001);
  } catch (err) {
    console.error('Failed to start backend process:', err);
  }
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
