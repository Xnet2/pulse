package il.offlineplayer.music;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final Pattern DATA_FILE = Pattern.compile("^(catalog|status|covers)-(\\d+)-(\\d+)\\.\\w+$");

    private WebView web;
    private volatile boolean alive = true;
    private volatile File catalogFile;
    private volatile long catalogStamp;
    private volatile String statusText = "";
    private volatile long statusStamp;
    private volatile long statusSeenAt;
    private volatile int coversVersion;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(Color.rgb(15, 20, 25));
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setTextZoom(100);
        web.setVerticalScrollBarEnabled(false);
        web.addJavascriptInterface(new Bridge(), "Native");
        // Keypad phones (no touch screen) drive the page with the D-pad, so the WebView must hold focus.
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);
        web.requestFocus();
        web.loadUrl("file:///android_asset/index.html");
        for (File dir : dirs()) touch(new File(dir, "hello-" + System.currentTimeMillis() + ".txt"));
        new Thread(new Runnable() {
            @Override public void run() { pollLoop(); }
        }).start();
    }

    // A focused WebView can swallow the back key on keypad phones, so it is caught before the WebView sees it.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int key = event.getKeyCode();
        if (key == KeyEvent.KEYCODE_BACK || key == KeyEvent.KEYCODE_ESCAPE) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) onBackPressed();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.goBack()", new ValueCallback<String>() {
            @Override public void onReceiveValue(String closed) {
                if (!"true".equals(closed)) MainActivity.super.onBackPressed();
            }
        });
    }

    @Override
    protected void onDestroy() {
        alive = false;
        super.onDestroy();
    }

    private List<File> dirs() {
        List<File> out = new ArrayList<File>();
        File[] all = getExternalFilesDirs(null);
        if (all == null) return out;
        for (File f : all) {
            if (f == null) continue;
            f.mkdirs();
            if (f.isDirectory()) out.add(f);
        }
        return out;
    }

    // Without a media scan, a file the app creates stays invisible to the PC until the cable is replugged.
    private void publish(File file) {
        MediaScannerConnection.scanFile(this, new String[] { file.getAbsolutePath() }, null, null);
    }

    private void touch(File file) {
        try {
            FileOutputStream out = new FileOutputStream(file);
            out.write('1');
            out.close();
            publish(file);
        } catch (Exception ignored) {}
    }

    private void remove(File file) {
        if (file.delete()) publish(file);
    }

    private void pollLoop() {
        while (alive) {
            try { pollOnce(); } catch (Exception ignored) {}
            try { Thread.sleep(800); } catch (InterruptedException e) { return; }
        }
    }

    private void pollOnce() throws Exception {
        File bestCatalog = catalogFile;
        long bestCatalogStamp = catalogStamp;
        File bestStatus = null;
        long bestStatusStamp = statusStamp;
        List<File> covers = new ArrayList<File>();
        List<File> stale = new ArrayList<File>();

        for (File dir : dirs()) {
            File[] files = dir.listFiles();
            if (files == null) continue;
            for (File f : files) {
                Matcher m = DATA_FILE.matcher(f.getName());
                if (!m.matches() || f.length() != Long.parseLong(m.group(3))) continue;
                long stamp = Long.parseLong(m.group(2));
                String kind = m.group(1);
                if (kind.equals("covers")) {
                    covers.add(f);
                } else if (kind.equals("catalog")) {
                    if (stamp > bestCatalogStamp) {
                        if (bestCatalog != null) stale.add(bestCatalog);
                        bestCatalog = f;
                        bestCatalogStamp = stamp;
                    } else if (!f.equals(bestCatalog)) {
                        stale.add(f);
                    }
                } else if (stamp > bestStatusStamp) {
                    if (bestStatus != null) stale.add(bestStatus);
                    bestStatus = f;
                    bestStatusStamp = stamp;
                } else {
                    stale.add(f);
                }
            }
        }

        catalogFile = bestCatalog;
        catalogStamp = bestCatalogStamp;
        if (bestStatus != null) {
            String text = new String(readAll(bestStatus), "UTF-8");
            statusText = text;
            statusStamp = bestStatusStamp;
            statusSeenAt = System.currentTimeMillis();
            applyAcks(text);
            stale.add(bestStatus);
        }
        for (File f : covers) {
            extractCovers(f);
            remove(f);
        }
        for (File f : stale) remove(f);
    }

    private void applyAcks(String text) throws Exception {
        JSONArray acks = new JSONObject(text).optJSONArray("ack");
        if (acks == null) return;
        for (int i = 0; i < acks.length(); i++) {
            for (File dir : dirs()) {
                File f = new File(dir, acks.getString(i));
                if (f.exists()) remove(f);
            }
        }
    }

    private File coverDir() {
        File dir = new File(getFilesDir(), "covers");
        dir.mkdirs();
        return dir;
    }

    private void extractCovers(File pack) throws Exception {
        RandomAccessFile in = new RandomAccessFile(pack, "r");
        try {
            int headLength = in.readInt();
            byte[] head = new byte[headLength];
            in.readFully(head);
            long base = 4L + headLength;
            JSONObject index = new JSONObject(new String(head, "UTF-8"));
            Iterator<String> keys = index.keys();
            File dir = coverDir();
            while (keys.hasNext()) {
                String id = keys.next();
                JSONArray range = index.getJSONArray(id);
                byte[] data = new byte[range.getInt(1)];
                in.seek(base + range.getLong(0));
                in.readFully(data);
                FileOutputStream out = new FileOutputStream(new File(dir, id + ".jpg"));
                out.write(data);
                out.close();
            }
        } finally {
            in.close();
        }
        coversVersion++;
    }

    private byte[] readAll(File file) throws Exception {
        FileInputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length());
            byte[] buffer = new byte[65536];
            for (int n; (n = in.read(buffer)) > 0;) out.write(buffer, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private boolean usbConnected() {
        Intent state = registerReceiver(null, new IntentFilter("android.hardware.usb.action.USB_STATE"));
        if (state != null && state.getBooleanExtra("connected", false)) return true;
        Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        return battery != null && battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) == BatteryManager.BATTERY_PLUGGED_USB;
    }

    private class Bridge {
        @JavascriptInterface
        public String poll() {
            try {
                JSONObject o = new JSONObject();
                o.put("usb", usbConnected());
                o.put("catalog", String.valueOf(catalogStamp));
                o.put("status", statusText);
                o.put("statusStamp", String.valueOf(statusStamp));
                o.put("statusAge", statusSeenAt == 0 ? -1 : System.currentTimeMillis() - statusSeenAt);
                o.put("covers", coversVersion);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String readCatalog() {
            try {
                return catalogFile == null ? "" : new String(readAll(catalogFile), "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String coverBase() {
            return "file://" + coverDir().getAbsolutePath() + "/";
        }

        @JavascriptInterface
        public void request(String id, int storage) {
            String name = "req-" + System.currentTimeMillis() + "-" + storage + "-" + id.replaceFirst(":", "_") + ".txt";
            for (File dir : dirs()) touch(new File(dir, name));
        }

        @JavascriptInterface
        public void setAuto(boolean on, int storage) {
            String name = "cfg-" + System.currentTimeMillis() + "-auto-" + (on ? 1 : 0) + "-" + storage + ".txt";
            for (File dir : dirs()) touch(new File(dir, name));
        }

        @JavascriptInterface
        public void requestCovers(String serials) {
            String name = "cov-" + System.currentTimeMillis() + "-" + serials + ".txt";
            for (File dir : dirs()) touch(new File(dir, name));
        }
    }
}
