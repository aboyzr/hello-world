'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Jambatan selamat ke proses utama (contextIsolation)
contextBridge.exposeInMainWorld('ElectronBridge', {
  isElectron: true,
  onSerialPortList: cb => ipcRenderer.on('serial-port-list', (e, list) => cb(list)),
  chooseSerialPort: id => ipcRenderer.send('serial-port-selected', id || ''),
  onBluetoothDeviceList: cb => ipcRenderer.on('bluetooth-device-list', (e, list) => cb(list)),
  chooseBluetoothDevice: id => ipcRenderer.send('bluetooth-device-selected', id || '')
});
