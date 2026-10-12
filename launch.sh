#!/bin/bash
# Starts the viewer in the background; used by "DICOM Viewer.app".
# The server opens the browser and stops by itself 5 minutes after the last
# viewer tab is closed.
cd "$(dirname "$0")"
for py in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$py" ] && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 7))' 2>/dev/null; then
    nohup "$py" server.py --quit-when-idle 300 > "${TMPDIR:-/tmp}/dicom-viewer.log" 2>&1 &
    exit 0
  fi
done
exit 1
