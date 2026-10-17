import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers
import Darwin

/// Lets the user pick a folder or files (including from Google Drive / iCloud Drive
/// in the iOS Files sheet), or download a shared Google Drive / direct link.
/// Picked or downloaded files are stored in Application Support/studies/<uuid> so
/// saved studies remain available across app launches without re-importing.
@objc(FolderPickerPlugin)
public class FolderPickerPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "FolderPickerPlugin"
    public let jsName = "FolderPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePaths", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStudiesDir", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    private static let skipNames: Set<String> = [
        "dicomdir", "dirfile", "lockfile", "version", "autorun.inf", "thumbs.db", ".ds_store"
    ]
    private static let skipExtensions: Set<String> = [
        "txt", "htm", "html", "xml", "pdf", "exe", "dll", "ini", "inf", "ico",
        "bmp", "gif", "png", "jpg", "jpeg", "js", "css", "json", "ds_store",
        "plist", "sh", "bat", "cmd", "cab", "msi", "app", "chm", "log", "sys"
    ]

    private static func shouldSkipFile(name: String) -> Bool {
        let lower = name.lowercased()
        if lower.hasPrefix(".") || skipNames.contains(lower) { return true }
        let ext = (lower as NSString).pathExtension
        if !ext.isEmpty && skipExtensions.contains(ext) { return true }
        return false
    }

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

    @objc func deletePaths(_ call: CAPPluginCall) {
        let paths = call.getArray("paths", String.self) ?? []
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            for p in paths {
                try? fm.removeItem(atPath: p)
            }
            call.resolve()
        }
    }

    @objc func getStudiesDir(_ call: CAPPluginCall) {
        do {
            let fm = FileManager.default
            let appSupport = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let base = appSupport.appendingPathComponent("studies", isDirectory: true)
            try fm.createDirectory(at: base, withIntermediateDirectories: true)
            call.resolve(["path": base.path])
        } catch {
            call.reject("Could not get studies directory: \(error.localizedDescription)")
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
                let (fileInfo, batchDir) = try self.fetchRemoteFile(url: url, suggestedName: suggestedName)
                call.resolve(["files": [fileInfo], "batchDir": batchDir])
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
                let (files, batchDir) = try self.copyPickedItems(urls)
                call.resolve([
                    "files": files,
                    "folder": urls.first?.lastPathComponent ?? "import",
                    "batchDir": batchDir
                ])
            } catch {
                call.reject("Could not read the selected items: \(error.localizedDescription)")
            }
        }
    }

    private func makeBatchDir() throws -> URL {
        let fm = FileManager.default
        let appSupport = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let base = appSupport.appendingPathComponent("studies", isDirectory: true)
        let dest = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var mutableBase = base
        try? mutableBase.setResourceValues(rv)
        return dest
    }

    private static func fastCopy(from: URL, to: URL) -> Bool {
        let fromPath = from.path
        let toPath = to.path
        
        unlink(toPath)
        
        // 1. Try APFS clonefile (copy-on-write clone: near 0ms, zero physical flash I/O)
        if copyfile(fromPath, toPath, nil, copyfile_flags_t(COPYFILE_CLONE | COPYFILE_NOFOLLOW_SRC)) == 0 {
            return true
        }
        
        // 2. Try fast kernel copyfile
        if copyfile(fromPath, toPath, nil, copyfile_flags_t(COPYFILE_ALL | COPYFILE_NOFOLLOW_SRC)) == 0 {
            return true
        }
        
        // 3. Fallback to FileManager copyItem
        do {
            try FileManager.default.copyItem(at: from, to: to)
            return true
        } catch {
            return false
        }
    }

    private static func fileSize(at path: String) -> Int {
        var st = stat()
        if stat(path, &st) == 0 {
            return Int(st.st_size)
        }
        return 0
    }

    private func copyPickedItems(_ urls: [URL]) throws -> ([[String: Any]], String) {
        let fm = FileManager.default
        let dest = try makeBatchDir()
        var out: [[String: Any]] = []
        var lastError: Error?
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey]

        var activeScopedUrls: [URL] = []
        for itemUrl in urls {
            if itemUrl.startAccessingSecurityScopedResource() {
                activeScopedUrls.append(itemUrl)
            }
        }
        defer {
            for scopedUrl in activeScopedUrls {
                scopedUrl.stopAccessingSecurityScopedResource()
            }
        }

        var candidates: [(file: URL, target: URL, relative: String, fileName: String)] = []

        for itemUrl in urls {
            var coordinationError: NSError?
            NSFileCoordinator().coordinate(readingItemAt: itemUrl, options: [.withoutChanges], error: &coordinationError) { url in
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                    let basePath = url.standardizedFileURL.path
                    let folderName = url.lastPathComponent.isEmpty ? "folder" : url.lastPathComponent
                    guard let items = fm.enumerator(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
                    
                    var index = 0
                    for case let file as URL in items {
                        let fileName = file.lastPathComponent
                        if fileName.isEmpty || Self.shouldSkipFile(name: fileName) { continue }
                        var childIsDir: ObjCBool = false
                        if fm.fileExists(atPath: file.path, isDirectory: &childIsDir), childIsDir.boolValue { continue }
                        let fullPath = file.standardizedFileURL.path
                        if fullPath.lowercased().contains("/__macosx/") { continue }
                        var relative: String
                        if fullPath.hasPrefix(basePath + "/") {
                            relative = String(fullPath.dropFirst(basePath.count + 1))
                        } else {
                            index += 1
                            relative = "\(index)_\(fileName)"
                        }
                        let target = dest.appendingPathComponent(folderName).appendingPathComponent(relative)
                        candidates.append((file, target, folderName + "/" + relative, fileName))
                    }
                } else {
                    let name = url.lastPathComponent.isEmpty ? "scan.dcm" : url.lastPathComponent
                    if !Self.shouldSkipFile(name: name) {
                        let target = dest.appendingPathComponent(UUID().uuidString + "_" + name)
                        candidates.append((url, target, name, name))
                    }
                }
            }
            if let error = coordinationError { lastError = error }
        }

        let total = candidates.count
        if total == 0 {
            if let error = lastError { throw error }
            return ([], dest.path)
        }

        // 1. Batch pre-create all unique directories upfront (eliminates hundreds of directory creation syscalls)
        var createdDirs = Set<String>()
        for c in candidates {
            let dir = c.target.deletingLastPathComponent().path
            if !createdDirs.contains(dir) {
                createdDirs.insert(dir)
                try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
            }
        }

        self.notifyListeners("folderProgress", data: ["copied": 0, "total": total, "name": "Starting fast transfer..."])

        // 2. High-speed parallel concurrent copying across CPU cores
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 8
        queue.qualityOfService = .userInitiated

        let lock = NSLock()
        var processedCount = 0
        var lastProgressNano = DispatchTime.now().uptimeNanoseconds

        for c in candidates {
            queue.addOperation {
                let success = Self.fastCopy(from: c.file, to: c.target)
                if success {
                    let size = Self.fileSize(at: c.target.path)
                    if size >= 128 || c.fileName.lowercased().hasSuffix(".zip") {
                        lock.lock()
                        out.append(["path": c.target.path, "name": c.relative, "size": size])
                        lock.unlock()
                    } else {
                        unlink(c.target.path)
                    }
                }

                lock.lock()
                processedCount += 1
                let current = processedCount
                let nowNano = DispatchTime.now().uptimeNanoseconds
                let elapsed = nowNano > lastProgressNano ? (nowNano - lastProgressNano) : 0
                let shouldNotify = elapsed >= 80_000_000 || current == total // throttle UI bridge updates to ~12fps
                if shouldNotify {
                    lastProgressNano = nowNano
                }
                lock.unlock()

                if shouldNotify {
                    self.notifyListeners("folderProgress", data: [
                        "copied": current,
                        "total": total,
                        "name": c.fileName
                    ])
                }
            }
        }
        queue.waitUntilAllOperationsAreFinished()

        if out.isEmpty, let error = lastError { throw error }
        return (out, dest.path)
    }


    private func fetchRemoteFile(url: URL, suggestedName: String) throws -> ([String: Any], String) {
        let dest = try makeBatchDir()
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

        let fh = try FileHandle(forReadingFrom: localFile)
        let head = fh.readData(ofLength: 512)
        try? fh.close()
        if let headStr = String(data: head, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           headStr.hasPrefix("<!doctype html") || headStr.hasPrefix("<html") {
            throw NSError(domain: "FolderPicker", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Google Drive returned a web page instead of a file. Make sure the file's sharing is set to 'Anyone with the link', or use 'Browse Google Drive' above."
            ])
        }
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
        return (["path": finalTarget.path, "name": name, "size": size], dest.path)
    }
}

