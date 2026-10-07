const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 580,
    backgroundColor: '#0a0b0e',
    title: 'Polyrhythmic Metronome',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Remove default menu for a clean DAW look
  Menu.setApplicationMenu(null);

  // Load the shared root index.html
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // Ensure AudioContext works without gesture block in desktop app
  win.webContents.on('did-finish-load', () => {
    win.setTitle('Polyrhythmic Metronome');
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
