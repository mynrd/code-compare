const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fsCore = require('./lib/fs-core');
const { createConfigStore, createTempStore } = require('./lib/store');

let configStore = null;
let tempStore = null;
function stores() {
  if (!configStore) {
    configStore = createConfigStore(path.join(app.getPath('userData'), 'config.json'));
    tempStore = createTempStore(path.join(app.getPath('userData'), '.temp'));
  }
  return { configStore, tempStore };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('load-config', () => stores().configStore.load());
ipcMain.handle('save-config', (_e, cfg) => stores().configStore.save(cfg));

ipcMain.handle('compare-folders', (_e, { left, right, ignores, fileScan, compareOptions }) =>
  fsCore.compareFolders(left, right, { ignores, fileScan, compareOptions }));

ipcMain.handle('compare-files', async (_e, { leftPath, rightPath }) => {
  const result = { leftPath, rightPath, left: null, right: null, error: null };
  try {
    if (leftPath) result.left = await fsCore.readForDiff(leftPath);
    if (rightPath) result.right = await fsCore.readForDiff(rightPath);
  } catch (err) {
    result.error = String(err && err.message || err);
  }
  return result;
});

ipcMain.handle('read-pair', (_e, args) => fsCore.readPair(args));
ipcMain.handle('copy-file', (_e, { src, dst }) => fsCore.copyFileEnsuringDir(src, dst));
ipcMain.handle('delete-file', (_e, { abs }) => fsCore.deleteFile(abs));

ipcMain.handle('temp-write', (_e, args) => stores().tempStore.write(args));
ipcMain.handle('temp-read', (_e, args) => stores().tempStore.read(args));
ipcMain.handle('temp-delete', (_e, args) => stores().tempStore.remove(args));
ipcMain.handle('temp-list', () => stores().tempStore.list());
ipcMain.handle('apply-temp', (_e, args) => stores().tempStore.apply(args));
