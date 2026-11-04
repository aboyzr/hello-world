package com.aboy.canbus;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Jambatan Bluetooth untuk dongle OBD2 ELM327 (window.ObdBridge dalam WebView).
 * - Bluetooth Classic (SPP / RFCOMM): dongle mesti dipair dulu di Tetapan Android
 * - Bluetooth Low Energy (BLE): imbas & sambung terus, guna servis UART (FFF0 / FFE0 / 18F0 dll.)
 * Data dihantar balik ke JavaScript melalui window.obdNative.onData(teks).
 */
@SuppressLint("MissingPermission")
public class ObdBluetooth {
    static final int REQ_PERM = 40;
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final Activity act;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Runnable afterPermission;

    // Classic
    private BluetoothSocket socket;
    private OutputStream out;
    // BLE
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic txChar;
    private final ConcurrentLinkedQueue<byte[]> bleQueue = new ConcurrentLinkedQueue<>();
    private volatile boolean bleWriting;
    private volatile boolean connected;

    ObdBluetooth(Activity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    // ---------- Panggilan ke JavaScript ----------
    private void js(String fn, String arg) {
        String code = "window.obdNative && obdNative." + fn + " && obdNative." + fn + "(" + (arg == null ? "" : JSONObject.quote(arg)) + ")";
        main.post(() -> web.evaluateJavascript(code, null));
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    // ---------- Kebenaran ----------
    private String[] neededPermissions(boolean scan) {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            need.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (scan) need.add(Manifest.permission.BLUETOOTH_SCAN);
        } else if (scan) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        List<String> missing = new ArrayList<>();
        for (String p : need) if (act.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        return missing.toArray(new String[0]);
    }

    private void withPermission(boolean scan, Runnable r) {
        String[] missing = neededPermissions(scan);
        if (missing.length == 0) { r.run(); return; }
        afterPermission = r;
        main.post(() -> act.requestPermissions(missing, REQ_PERM));
    }

    void onPermissionResult(int[] results) {
        boolean ok = results.length > 0;
        for (int r : results) ok &= r == PackageManager.PERMISSION_GRANTED;
        Runnable r = afterPermission;
        afterPermission = null;
        js("onPermission", ok ? "1" : "");
        if (ok && r != null) io.execute(r);
        else if (!ok) js("onError", "Kebenaran Bluetooth ditolak. Benarkan di Tetapan > Apps > Aboy Canbus.");
    }

    private boolean checkAdapter() {
        BluetoothAdapter a = adapter();
        if (a == null) { js("onError", "Telefon ini tiada Bluetooth"); return false; }
        if (!a.isEnabled()) { js("onError", "Bluetooth dimatikan. Hidupkan Bluetooth dulu."); return false; }
        return true;
    }

    // ---------- Senarai peranti ----------
    @JavascriptInterface
    public void listDevices(boolean scanBle) {
        withPermission(scanBle, () -> {
            if (!checkAdapter()) { js("onDevices", "[]"); return; }
            if (scanBle) scanBle();
            else {
                JSONArray arr = new JSONArray();
                for (BluetoothDevice d : adapter().getBondedDevices()) arr.put(device(d, d.getType() == BluetoothDevice.DEVICE_TYPE_LE ? "ble" : "classic"));
                js("onDevices", arr.toString());
            }
        });
    }

    private JSONObject device(BluetoothDevice d, String type) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", d.getName() == null ? "" : d.getName());
            o.put("address", d.getAddress());
            o.put("type", type);
        } catch (Exception ignored) { }
        return o;
    }

    private void scanBle() {
        BluetoothLeScanner sc = adapter().getBluetoothLeScanner();
        if (sc == null) { js("onDevices", "[]"); return; }
        Map<String, JSONObject> found = new LinkedHashMap<>();
        ScanCallback cb = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult r) {
                BluetoothDevice d = r.getDevice();
                String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
                if (name == null) name = d.getName();
                if (name == null || name.isEmpty()) return; // abaikan peranti tanpa nama
                JSONObject o = device(d, "ble");
                try { o.put("name", name); o.put("rssi", r.getRssi()); } catch (Exception ignored) { }
                synchronized (found) { found.put(d.getAddress(), o); }
            }
        };
        main.post(() -> {
            try { sc.startScan(cb); } catch (Exception e) { js("onError", "Gagal imbas BLE: " + e.getMessage()); }
        });
        main.postDelayed(() -> {
            try { sc.stopScan(cb); } catch (Exception ignored) { }
            JSONArray arr = new JSONArray();
            synchronized (found) { for (JSONObject o : found.values()) arr.put(o); }
            js("onDevices", arr.toString());
        }, 8000);
    }

    // ---------- Sambung ----------
    @JavascriptInterface
    public void connect(String address, String type) {
        withPermission(false, () -> io.execute(() -> {
            if (!checkAdapter()) return;
            closeQuietly();
            BluetoothDevice dev;
            try { dev = adapter().getRemoteDevice(address); }
            catch (Exception e) { js("onError", "Alamat tidak sah"); return; }
            if ("ble".equals(type)) connectBle(dev);
            else connectClassic(dev);
        }));
    }

    private void connectClassic(BluetoothDevice dev) {
        BluetoothAdapter a = adapter();
        try { a.cancelDiscovery(); } catch (Exception ignored) { }
        BluetoothSocket s = null;
        try {
            s = dev.createRfcommSocketToServiceRecord(SPP);
            s.connect();
        } catch (Exception first) {
            try { if (s != null) s.close(); } catch (Exception ignored) { }
            // Kebanyakan dongle klon murah: cuba saluran RFCOMM 1 terus
            try {
                Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
                s = (BluetoothSocket) m.invoke(dev, 1);
                s.connect();
            } catch (Exception second) {
                try { if (s != null) s.close(); } catch (Exception ignored) { }
                js("onError", "Gagal sambung ke " + nameOf(dev) + ". Pastikan dongle dicucuk, kunci ON, dan tidak disambung ke app lain.");
                return;
            }
        }
        final BluetoothSocket sock = s;
        try {
            socket = sock;
            out = sock.getOutputStream();
            InputStream in = sock.getInputStream();
            connected = true;
            js("onConnect", null);
            Thread reader = new Thread(() -> {
                byte[] buf = new byte[1024];
                try {
                    int n;
                    while ((n = in.read(buf)) > 0) js("onData", new String(buf, 0, n, StandardCharsets.ISO_8859_1));
                } catch (Exception ignored) { }
                if (connected && socket == sock) { connected = false; js("onClose", null); }
            }, "obd-reader");
            reader.setDaemon(true);
            reader.start();
        } catch (Exception e) {
            js("onError", "Ralat sambungan: " + e.getMessage());
        }
    }

    private String nameOf(BluetoothDevice d) {
        String n = d.getName();
        return n == null ? d.getAddress() : n;
    }

    // ---------- BLE ----------
    private void connectBle(BluetoothDevice dev) {
        main.post(() -> gatt = dev.connectGatt(act, false, new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
                if (state == BluetoothProfile.STATE_CONNECTED) {
                    g.discoverServices();
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    g.close();
                    if (gatt != g) return; // diputuskan oleh pengguna
                    gatt = null;
                    boolean was = connected;
                    connected = false;
                    if (was) js("onClose", null);
                    else js("onError", "Gagal sambung BLE ke " + nameOf(dev) + " (status " + status + ")");
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
                BluetoothGattCharacteristic rx = null, tx = null;
                for (BluetoothGattService s : g.getServices()) {
                    String u = s.getUuid().toString();
                    // langkau servis standard (Generic Access/Attribute, Device Info, Battery)
                    if (u.startsWith("00001800") || u.startsWith("00001801") || u.startsWith("0000180a") || u.startsWith("0000180f")) continue;
                    BluetoothGattCharacteristic r = null, t = null;
                    for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                        int p = c.getProperties();
                        if (r == null && (p & (BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0) r = c;
                        if (t == null && (p & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) t = c;
                    }
                    if (r != null && t != null) { rx = r; tx = t; break; }
                }
                if (rx == null) {
                    js("onError", "Dongle BLE ini tiada servis UART dikenali");
                    g.disconnect();
                    return;
                }
                txChar = tx;
                g.setCharacteristicNotification(rx, true);
                BluetoothGattDescriptor d = rx.getDescriptor(CCCD);
                byte[] val = (rx.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                        ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
                if (d == null) { bleReady(); return; }
                if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, val);
                else { d.setValue(val); g.writeDescriptor(d); }
            }

            @Override
            public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
                bleReady();
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
                byte[] v = c.getValue();
                if (v != null) js("onData", new String(v, StandardCharsets.ISO_8859_1));
            }

            @Override
            public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] v) {
                js("onData", new String(v, StandardCharsets.ISO_8859_1));
            }

            @Override
            public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
                bleWriting = false;
                bleNext();
            }
        }, BluetoothDevice.TRANSPORT_LE));
    }

    private void bleReady() {
        if (connected) return;
        connected = true;
        js("onConnect", null);
    }

    @SuppressWarnings("deprecation")
    private synchronized void bleNext() {
        if (bleWriting || gatt == null || txChar == null) return;
        byte[] chunk = bleQueue.poll();
        if (chunk == null) return;
        bleWriting = true;
        int type = (txChar.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        boolean ok;
        if (Build.VERSION.SDK_INT >= 33) {
            ok = gatt.writeCharacteristic(txChar, chunk, type) == 0; // BluetoothStatusCodes.SUCCESS
        } else {
            txChar.setWriteType(type);
            txChar.setValue(chunk);
            ok = gatt.writeCharacteristic(txChar);
        }
        if (!ok) {
            // Cuba lagi sekejap lagi
            bleQueue.add(chunk);
            bleWriting = false;
            main.postDelayed(this::bleNext, 30);
        }
    }

    // ---------- Tulis / putus ----------
    @JavascriptInterface
    public void write(String text) {
        byte[] bytes = text.getBytes(StandardCharsets.ISO_8859_1);
        if (gatt != null) {
            for (int i = 0; i < bytes.length; i += 20) {
                int len = Math.min(20, bytes.length - i);
                byte[] c = new byte[len];
                System.arraycopy(bytes, i, c, 0, len);
                bleQueue.add(c);
            }
            main.post(this::bleNext);
            return;
        }
        io.execute(() -> {
            try {
                if (out == null) throw new Exception("tidak bersambung");
                out.write(bytes);
                out.flush();
            } catch (Exception e) {
                if (connected) { connected = false; js("onClose", null); }
            }
        });
    }

    @JavascriptInterface
    public void disconnect() {
        io.execute(this::closeQuietly);
    }

    @JavascriptInterface
    public boolean isConnected() {
        return connected;
    }

    private void closeQuietly() {
        connected = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null;
        out = null;
        BluetoothGatt g = gatt;
        gatt = null;
        txChar = null;
        bleQueue.clear();
        bleWriting = false;
        if (g != null) main.post(() -> { try { g.disconnect(); g.close(); } catch (Exception ignored) { } });
    }

    void shutdown() {
        closeQuietly();
        io.shutdown();
    }
}
