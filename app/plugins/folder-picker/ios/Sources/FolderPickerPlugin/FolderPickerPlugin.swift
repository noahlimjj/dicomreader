import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Lets the user pick a folder or files (including from Google Drive / iCloud Drive
/// in the iOS Files sheet), or download a shared Google Drive / direct link.
/// Picked or downloaded files are copied into the app's temporary folder so the
/// web view can read them lazily; the previous import is deleted first.
@objc(FolderPickerPlugin)
public class FolderPickerPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "FolderPickerPlugin"
    public let jsName = "FolderPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadUrl", returnType: CAPPluginReturnPromise)
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

    @objc func pickFiles(_ call: CAPPluginCall) {
        pendingCall = call
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.item, UTType.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = true
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    @objc func downloadUrl(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("Invalid URL")
            return
        }
        let suggestedName = call.getString("filename") ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let fileInfo = try self.fetchRemoteFile(url: url, suggestedName: suggestedName)
                call.resolve(["files": [fileInfo]])
            } catch {
                call.reject("Could not download from link: \(error.localizedDescription)")
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingCall?.resolve(["files": [], "cancelled": true])
        pendingCall = nil
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        if urls.isEmpty {
            call.resolve(["files": [], "cancelled": true])
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let files = try self.copyPickedItems(urls)
                call.resolve(["files": files, "folder": urls.first?.lastPathComponent ?? "import"])
            } catch {
                call.reject("Could not read the selected items: \(error.localizedDescription)")
            }
        }
    }

    private func freshImportDir() throws -> URL {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("folder-import", isDirectory: true)
        try? fm.removeItem(at: base)
        let dest = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        return dest
    }

    private func copyPickedItems(_ urls: [URL]) throws -> [[String: Any]] {
        let fm = FileManager.default
        let dest = try freshImportDir()
        var out: [[String: Any]] = []
        var lastError: Error?
        let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey]

        for itemUrl in urls {
            let scoped = itemUrl.startAccessingSecurityScopedResource()
            defer { if scoped { itemUrl.stopAccessingSecurityScopedResource() } }
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(readingItemAt: itemUrl, options: [], error: &coordinationError) { url in
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                    let root = url.standardizedFileURL.resolvingSymlinksInPath().pathComponents
                    guard let items = fm.enumerator(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
                    for case let file as URL in items {
                        guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
                        let parts = file.standardizedFileURL.resolvingSymlinksInPath().pathComponents
                        let relative = parts.dropFirst(root.count).joined(separator: "/")
                        if relative.isEmpty { continue }
                        let target = dest.appendingPathComponent(url.lastPathComponent).appendingPathComponent(relative)
                        do {
                            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                            try fm.copyItem(at: file, to: target)
                            out.append(["path": target.path, "name": url.lastPathComponent + "/" + relative, "size": values.fileSize ?? 0])
                        } catch {
                            lastError = error
                        }
                    }
                } else {
                    let name = url.lastPathComponent.isEmpty ? "scan.dcm" : url.lastPathComponent
                    var target = dest.appendingPathComponent(name)
                    if fm.fileExists(atPath: target.path) {
                        target = dest.appendingPathComponent(UUID().uuidString + "_" + name)
                    }
                    do {
                        try fm.copyItem(at: url, to: target)
                        let attr = try? fm.attributesOfItem(atPath: target.path)
                        let size = (attr?[.size] as? NSNumber)?.intValue ?? 0
                        out.append(["path": target.path, "name": name, "size": size])
                    } catch {
                        lastError = error
                    }
                }
            }
            if let error = coordinationError { lastError = error }
        }
        if out.isEmpty, let error = lastError { throw error }
        return out
    }

    private func fetchRemoteFile(url: URL, suggestedName: String) throws -> [String: Any] {
        let dest = try freshImportDir()
        let sem = DispatchSemaphore(value: 0)
        var downloadedUrl: URL?
        var responseObj: URLResponse?
        var downloadErr: Error?

        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")

        let task = URLSession.shared.downloadTask(with: req) { tmp, resp, err in
            defer { sem.signal() }
            if let err = err {
                downloadErr = err
                return
            }
            responseObj = resp
            if let tmp = tmp {
                let copy = dest.appendingPathComponent("raw_download")
                do {
                    try FileManager.default.moveItem(at: tmp, to: copy)
                    downloadedUrl = copy
                } catch {
                    downloadErr = error
                }
            }
        }
        task.resume()
        sem.wait()

        if let err = downloadErr { throw err }
        guard let localFile = downloadedUrl else {
            throw NSError(domain: "FolderPicker", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty download"])
        }
        if let http = responseObj as? HTTPURLResponse, http.statusCode >= 400 {
            throw NSError(domain: "FolderPicker", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode) from server"])
        }

        // Determine filename from Content-Disposition or URL
        var name = suggestedName
        if let http = responseObj as? HTTPURLResponse,
           let disp = http.value(forHTTPHeaderField: "Content-Disposition") {
            if let range = disp.range(of: "filename\\*=UTF-8''([^;]+)", options: .regularExpression) {
                let raw = String(disp[range]).replacingOccurrences(of: "filename*=UTF-8''", with: "")
                name = raw.removingPercentEncoding ?? raw
            } else if let range = disp.range(of: "filename=\"?([^\";]+)\"?", options: .regularExpression) {
                let raw = String(disp[range])
                    .replacingOccurrences(of: "filename=", with: "")
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\" "))
                if !raw.isEmpty { name = raw }
            }
        }
        if name.isEmpty, let respName = responseObj?.suggestedFilename, respName != "download" && respName != "uc" {
            name = respName
        }
        if name.isEmpty { name = "gdrive_scan" }

        // Check if file starts with HTML (e.g. private Google Drive sign-in page)
        let fh = try FileHandle(forReadingFrom: localFile)
        let head = fh.readData(ofLength: 512)
        try? fh.close()
        if let headStr = String(data: head, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           headStr.hasPrefix("<!doctype html") || headStr.hasPrefix("<html") {
            throw NSError(domain: "FolderPicker", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Google Drive returned a web page instead of a file. Make sure the file's sharing is set to 'Anyone with the link', or use 'Browse Google Drive' above."
            ])
        }
        // If it starts with PK\x03\x04 and doesn't have .zip extension, add .zip so the reader unzips it
        if head.count >= 4 && head[0] == 0x50 && head[1] == 0x4b && head[2] == 0x03 && head[3] == 0x04 {
            if !name.lowercased().hasSuffix(".zip") {
                name += ".zip"
            }
        }

        let finalTarget = dest.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: finalTarget)
        try FileManager.default.moveItem(at: localFile, to: finalTarget)
        let attr = try? FileManager.default.attributesOfItem(atPath: finalTarget.path)
        let size = (attr?[.size] as? NSNumber)?.intValue ?? 0
        return ["path": finalTarget.path, "name": name, "size": size]
    }
}
