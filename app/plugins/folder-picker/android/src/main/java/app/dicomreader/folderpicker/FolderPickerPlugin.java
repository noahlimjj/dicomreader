package app.dicomreader.folderpicker;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Lets the user pick a folder, pick files (including directly from Google Drive
 * via Android's Storage Access Framework), or download a shared Google Drive link.
 */
@CapacitorPlugin(name = "FolderPicker")
public class FolderPickerPlugin extends Plugin {

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "onFolderPicked");
    }

    @PluginMethod
    public void pickFiles(PluginCall call) {
        boolean drive = Boolean.TRUE.equals(call.getBoolean("drive", false));
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        if (drive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(
                DocumentsContract.EXTRA_INITIAL_URI,
                Uri.parse("content://com.google.android.apps.docs.storage/root")
            );
        }
        startActivityForResult(call, intent, "onFilesPicked");
    }

    @PluginMethod
    public void downloadUrl(PluginCall call) {
        String urlStr = call.getString("url");
        String suggestedName = call.getString("filename", "");
        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Invalid URL");
            return;
        }
        new Thread(() -> {
            try {
                File dest = freshImportDir();
                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(120000);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14)");
                int status = conn.getResponseCode();
                if (status >= 400) {
                    throw new Exception("HTTP " + status + " from server");
                }
                String name = suggestedName != null ? suggestedName : "";
                String disp = conn.getHeaderField("Content-Disposition");
                if (disp != null) {
                    int idx = disp.indexOf("filename*=");
                    if (idx >= 0) {
                        String part = disp.substring(idx + 10).split(";")[0].trim();
                        if (part.toLowerCase().startsWith("utf-8''")) part = part.substring(7);
                        name = URLDecoder.decode(part, "UTF-8");
                    } else {
                        int idx2 = disp.indexOf("filename=");
                        if (idx2 >= 0) {
                            String part = disp.substring(idx2 + 9).split(";")[0].trim();
                            part = part.replaceAll("^\"|\"$", "");
                            if (!part.isEmpty()) name = part;
                        }
                    }
                }
                if (name.isEmpty()) name = "gdrive_scan";

                File rawTarget = new File(dest, "raw_download");
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(rawTarget)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }

                byte[] head = new byte[512];
                int headLen = 0;
                try (FileInputStream fis = new FileInputStream(rawTarget)) {
                    headLen = fis.read(head);
                }
                if (headLen > 0) {
                    String headStr = new String(head, 0, headLen, StandardCharsets.UTF_8).trim().toLowerCase();
                    if (headStr.startsWith("<!doctype html") || headStr.startsWith("<html")) {
                        throw new Exception("Google Drive returned a web page instead of a file. Make sure the file's sharing is set to 'Anyone with the link', or use 'Browse Google Drive' above.");
                    }
                    if (headLen >= 4 && head[0] == 0x50 && head[1] == 0x4b && head[2] == 0x03 && head[3] == 0x04) {
                        if (!name.toLowerCase().endsWith(".zip")) name += ".zip";
                    }
                }

                File finalTarget = new File(dest, name);
                rawTarget.renameTo(finalTarget);

                JSObject f = new JSObject();
                f.put("path", finalTarget.getAbsolutePath());
                f.put("name", name);
                f.put("size", finalTarget.length());
                JSArray files = new JSArray();
                files.put(f);
                JSObject r = new JSObject();
                r.put("files", files);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not download from link: " + e.getMessage(), e);
            }
        }).start();
    }

    @ActivityCallback
    private void onFilesPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject r = new JSObject();
            r.put("files", new JSArray());
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            JSObject r = new JSObject();
            r.put("files", new JSArray());
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        new Thread(() -> {
            try {
                File dest = freshImportDir();
                ContentResolver resolver = getContext().getContentResolver();
                JSArray files = new JSArray();
                for (int i = 0; i < uris.size(); i++) {
                    Uri u = uris.get(i);
                    String name = "scan_" + (i + 1) + ".dcm";
                    long size = 0;
                    try (Cursor c = resolver.query(u, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                        if (c != null && c.moveToFirst()) {
                            String dn = c.getString(0);
                            if (dn != null && !dn.isEmpty()) name = dn;
                            if (!c.isNull(1)) size = c.getLong(1);
                        }
                    } catch (Exception ignored) {}
                    File target = new File(dest, name);
                    if (target.exists()) target = new File(dest, (i + 1) + "_" + name);
                    try (InputStream in = resolver.openInputStream(u); OutputStream os = new FileOutputStream(target)) {
                        if (in == null) continue;
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    if (size <= 0) size = target.length();
                    JSObject f = new JSObject();
                    f.put("path", target.getAbsolutePath());
                    f.put("name", name);
                    f.put("size", size);
                    files.put(f);
                }
                JSObject r = new JSObject();
                r.put("files", files);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read selected files: " + e.getMessage(), e);
            }
        }).start();
    }

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("files", new JSArray());
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        Uri tree = data.getData();
        new Thread(() -> {
            try {
                File dest = freshImportDir();
                String rootId = DocumentsContract.getTreeDocumentId(tree);
                String folderName = rootId;
                int colon = folderName.lastIndexOf(':');
                if (colon >= 0) folderName = folderName.substring(colon + 1);
                int slash = folderName.lastIndexOf('/');
                if (slash >= 0) folderName = folderName.substring(slash + 1);
                if (folderName.isEmpty()) folderName = "folder";
                JSArray files = new JSArray();
                copyChildren(tree, rootId, "", dest, files, folderName);
                JSObject r = new JSObject();
                r.put("files", files);
                r.put("folder", folderName);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Could not read the folder: " + e.getMessage(), e);
            }
        }).start();
    }

    private File freshImportDir() throws Exception {
        File base = new File(getContext().getCacheDir(), "folder-import");
        deleteRecursive(base);
        File dest = new File(base, UUID.randomUUID().toString());
        if (!dest.mkdirs()) throw new Exception("cannot create " + dest);
        return dest;
    }

    private void copyChildren(Uri tree, String parentId, String relative, File dest, JSArray out, String folderName) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        };
        try (Cursor c = resolver.query(children, columns, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.isNull(3) ? 0 : c.getLong(3);
                if (name == null || name.startsWith(".")) continue;
                String rel = relative.isEmpty() ? name : relative + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    copyChildren(tree, id, rel, dest, out, folderName);
                    continue;
                }
                File target = new File(dest, rel);
                File parent = target.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                try (InputStream in = resolver.openInputStream(doc); OutputStream os = new FileOutputStream(target)) {
                    if (in == null) continue;
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                JSObject f = new JSObject();
                f.put("path", target.getAbsolutePath());
                f.put("name", folderName + "/" + rel);
                f.put("size", size);
                out.put(f);
            }
        }
    }

    private static void deleteRecursive(File f) {
        if (!f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        f.delete();
    }
}
