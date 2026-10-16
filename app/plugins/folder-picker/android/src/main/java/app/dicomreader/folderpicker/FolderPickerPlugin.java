package app.dicomreader.folderpicker;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

/**
 * Lets the user pick a folder (e.g. a copied hospital CD). Its files, including
 * sub folders, are copied into the app's cache, which the web view can read;
 * the previous import is deleted first.
 */
@CapacitorPlugin(name = "FolderPicker")
public class FolderPickerPlugin extends Plugin {

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "onFolderPicked");
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
                File base = new File(getContext().getCacheDir(), "folder-import");
                deleteRecursive(base);
                File dest = new File(base, UUID.randomUUID().toString());
                if (!dest.mkdirs()) throw new Exception("cannot create " + dest);
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
