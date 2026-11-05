'use strict';
// Aboy Canbus untuk Windows: bungkus aplikasi web canbus/ dalam Electron.
// Dongle ELM327 Bluetooth di Windows muncul sebagai port COM (Web Serial);
// dongle BLE melalui Web Bluetooth. Proses utama ini membekalkan senarai
// peranti kepada halaman supaya pengguna boleh pilih.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win = null;
let pendingSerial = null;
let pendingBt = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 840,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0d1218',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const ses = win.webContents.session;
  ses.setPermissionCheckHandler(() => true);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  ses.setDevicePermissionHandler(() => true);

  // Pilih port COM (Web Serial): hantar senarai ke halaman, tunggu pilihan
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    pendingSerial = callback;
    win.webContents.send('serial-port-list', portList.map(p => ({
      portId: p.portId,
      name: p.displayName || p.portName || [p.vendorId, p.productId].filter(Boolean).join(':') || p.portId
    })));
  });

  // Pilih peranti BLE (Web Bluetooth): senarai berkembang semasa imbasan
  ses.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    pendingBt = callback;
    win.webContents.send('bluetooth-device-list', deviceList.map(d => ({
      deviceId: d.deviceId, name: d.deviceName || d.deviceId
    })));
  });

  win.loadFile(path.join(__dirname, 'canbus', 'index.html'));
}

ipcMain.on('serial-port-selected', (e, portId) => { if (pendingSerial) { pendingSerial(portId || ''); pendingSerial = null; } });
ipcMain.on('bluetooth-device-selected', (e, deviceId) => { if (pendingBt) { pendingBt(deviceId || ''); pendingBt = null; } });

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());

// Aboy Canbus Windows build
