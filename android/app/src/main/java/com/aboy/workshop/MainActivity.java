package com.aboy.workshop;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Membungkus aplikasi web Akaun Kedai (assets/kedai) supaya boleh dipasang sebagai APK.
 * Semua data disimpan dalam app ini (IndexedDB WebView).
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/assets/kedai/index.html";
    private static final int REQ_FILE = 1;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                // Link luar (WhatsApp, dll.) dibuka dengan app lain
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    toast("Tiada app untuk buka link ini");
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                cameraUri = null;

                String[] types = params.getAcceptTypes();
                boolean wantsImage = types != null && types.length > 0 && types[0].startsWith("image");
                Intent pick = params.createIntent();
                Intent chooser;
                if (wantsImage) {
                    // Pilihan: ambil gambar dengan kamera atau pilih dari galeri
                    chooser = Intent.createChooser(pick, "Gambar resit");
                    try {
                        File dir = new File(getCacheDir(), "camera");
                        dir.mkdirs();
                        File photo = new File(dir, "resit-" + System.currentTimeMillis() + ".jpg");
                        cameraUri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", photo);
                        Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                        camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
                    } catch (Exception ignored) {
                        cameraUri = null;
                    }
                } else {
                    chooser = pick;
                }
                try {
                    startActivityForResult(chooser, REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    toast("Tiada app untuk pilih fail");
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(HOME);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            } else if (cameraUri != null) {
                result = new Uri[]{cameraUri};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Butang Back: tutup borang / balik ke Utama dulu sebelum keluar app
        web.evaluateJavascript("window.nativeBack ? nativeBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private File writeCache(String name, byte[] bytes) throws Exception {
        File dir = new File(getCacheDir(), "share");
        dir.mkdirs();
        File f = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
        return f;
    }

    /** Fungsi yang boleh dipanggil dari JavaScript: window.AndroidBridge.* */
    private class Bridge {
        @JavascriptInterface
        public void shareFile(String name, String mime, String base64, String text) {
            try {
                File f = writeCache(name, Base64.decode(base64, Base64.DEFAULT));
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, "Hantar ke");
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(chooser));
            } catch (Exception e) {
                toast("Gagal kongsi: " + e.getMessage());
            }
        }

        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Aboy Workshop");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("tiada ruang");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                    toast("Disimpan: Download/Aboy Workshop/" + name);
                    return;
                } catch (Exception e) {
                    toast("Gagal simpan, cuba kongsi: " + e.getMessage());
                }
            }
            // Android 9 ke bawah: guna menu kongsi (contoh: simpan ke Drive / Files)
            shareFile(name, mime, base64, "");
        }

        @JavascriptInterface
        public void print(String jobName) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String job = jobName == null || jobName.isEmpty() ? "Resit" : jobName;
                pm.print(job, web.createPrintDocumentAdapter(job), new PrintAttributes.Builder().build());
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.toast(msg);
        }
    }
}
