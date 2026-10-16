import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Lets the user pick a folder in the Files app (e.g. a copied hospital CD).
/// Its files, including sub folders, are copied into the app's temporary
/// folder, which the web view can read; the previous import is deleted first.
@objc(FolderPickerPlugin)
public class FolderPickerPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "FolderPickerPlugin"
    public let jsName = "FolderPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    @objc func pickFolder(_ call: CAPPluginCall) {
        pendingCall = call
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingCall?.resolve(["files": [], "cancelled": true])
        pendingCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        guard let folder = urls.first else {
            call.resolve(["files": [], "cancelled": true])
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            do {
                let files = try self.copyFolder(folder)
                call.resolve(["files": files, "folder": folder.lastPathComponent])
            } catch {
                call.reject("Could not read the folder: \(error.localizedDescription)")
            }
        }
    }

    private func copyFolder(_ folder: URL) throws -> [[String: Any]] {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("folder-import", isDirectory: true)
        try? fm.removeItem(at: base)
        let dest = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)

        var out: [[String: Any]] = []
        var lastError: Error?
        var coordinationError: NSError?
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        NSFileCoordinator().coordinate(readingItemAt: folder, options: [], error: &coordinationError) { url in
            let root = url.standardizedFileURL.resolvingSymlinksInPath().pathComponents
            guard let items = fm.enumerator(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
            for case let file as URL in items {
                guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
                let parts = file.standardizedFileURL.resolvingSymlinksInPath().pathComponents
                let relative = parts.dropFirst(root.count).joined(separator: "/")
                if relative.isEmpty { continue }
                let target = dest.appendingPathComponent(relative)
                do {
                    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(at: file, to: target)
                    out.append(["path": target.path, "name": folder.lastPathComponent + "/" + relative, "size": values.fileSize ?? 0])
                } catch {
                    lastError = error
                }
            }
        }
        if let error = coordinationError { throw error }
        if out.isEmpty, let error = lastError { throw error }
        return out
    }
}
