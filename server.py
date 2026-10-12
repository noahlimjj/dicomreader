#!/usr/bin/env python3
"""Local DICOM viewer server.

Serves the web viewer in ./web and the DICOM files of a folder. Without a
folder argument it uses the folder containing this app when that looks like a
copied CD/DVD (it has a DICOMDIR or a DICOM folder); otherwise the viewer
starts empty and you pick a folder in the browser. Only listens on 127.0.0.1,
so the scans never leave this computer.

Usage: python3 server.py [dicom_folder] [--port 8765] [--no-browser] [--quit-when-idle SECONDS]
"""
import argparse
import json
import os
import posixpath
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
SKIP_DIRS = {"VIEWER", "IHE_PDI", "VINFO", "DICOM_Viewer", "__MACOSX"}


def default_folder():
    """The parent folder if it looks like a DICOM disc, else None."""
    parent = os.path.dirname(HERE)
    if os.path.isfile(os.path.join(parent, "DICOMDIR")) or \
            os.path.isdir(os.path.join(parent, "DICOM")):
        return parent
    return None


def is_dicom(path):
    """DICOM Part 10 files have 'DICM' at byte offset 128."""
    try:
        with open(path, "rb") as f:
            f.seek(128)
            return f.read(4) == b"DICM"
    except OSError:
        return False


def find_dicom_files(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or name.upper() == "DICOMDIR":
                continue
            full = os.path.join(dirpath, name)
            if is_dicom(full):
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                files.append({"path": rel, "size": os.path.getsize(full)})
    return files


def make_handler(data_root, activity):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=WEB_DIR, **kwargs)

        def log_message(self, fmt, *args):
            pass  # keep the terminal quiet

        def end_headers(self):
            path = urllib.parse.urlparse(self.path).path
            if path.startswith(("/vendor/", "/assets/")):
                # third party code never changes: let the browser keep it
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            elif path.startswith(("/api/", "/data/")):
                self.send_header("Cache-Control", "no-store")
            else:
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def do_GET(self):
            activity["last"] = time.monotonic()
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/ping":
                body = json.dumps({"app": "dicom-viewer", "root": data_root}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == "/api/files":
                body = json.dumps({
                    "root": os.path.basename(os.path.normpath(data_root)) if data_root else None,
                    "files": find_dicom_files(data_root) if data_root else [],
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path.startswith("/data/"):
                self.send_data_file(urllib.parse.unquote(parsed.path[len("/data/"):]))
                return
            super().do_GET()

        def send_data_file(self, rel):
            if not data_root:
                self.send_error(404)
                return
            rel = posixpath.normpath(rel)
            full = os.path.realpath(os.path.join(data_root, rel))
            if not full.startswith(os.path.realpath(data_root) + os.sep) \
                    or not os.path.isfile(full):
                self.send_error(404)
                return
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/dicom")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def running_viewer(port, data_root):
    """URL of a viewer already serving the same folder on this port, if any."""
    url = f"http://127.0.0.1:{port}/"
    try:
        with urllib.request.urlopen(url + "api/ping", timeout=1) as r:
            info = json.load(r)
        if info.get("app") == "dicom-viewer" and info.get("root") == data_root:
            return url
    except (OSError, ValueError):
        pass
    return None


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # same option as the HTTP server, so a recently closed connection
            # does not make the port look busy
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    sys.exit("No free port found")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", nargs="?", default=None,
                        help="folder containing DICOM files (searched recursively); "
                             "default: the disc this app was copied onto, if any")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--quit-when-idle", type=float, default=0, metavar="SECONDS",
                        help="stop when no browser tab has been in touch for this long")
    args = parser.parse_args()

    folder = args.folder or default_folder()
    data_root = os.path.abspath(folder) if folder else None
    if data_root and not os.path.isdir(data_root):
        sys.exit(f"Not a folder: {data_root}")

    existing = running_viewer(args.port, data_root)
    if existing:
        print(f"The viewer is already running at {existing}; opening it.")
        if not args.no_browser:
            webbrowser.open(existing)
        return

    port = free_port(args.port)
    activity = {"last": time.monotonic()}
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(data_root, activity))
    if args.quit_when_idle > 0:
        # open viewer tabs ping the server regularly (see web/app.js)
        def watchdog():
            while True:
                time.sleep(5)
                if time.monotonic() - activity["last"] > args.quit_when_idle:
                    server.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"DICOM viewer running at {url}")
    print(f"Reading scans from: {data_root}" if data_root else
          "No folder given: choose one with \"Open folder…\" in the browser.")
    if args.quit_when_idle > 0:
        print(f"Stops by itself {args.quit_when_idle:.0f} s after the last viewer tab is closed.")
    else:
        print("Close this window (or press Ctrl+C) to stop the viewer.")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
