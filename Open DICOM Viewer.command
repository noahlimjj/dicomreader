#!/bin/bash
# Double-click this file in Finder to open the DICOM viewer.
cd "$(dirname "$0")"
for py in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3 python3; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 7))' 2>/dev/null; then
    exec "$py" server.py "$@"
  fi
done
echo "Python 3 was not found. Install it with:  xcode-select --install"
read -n 1 -s -r -p "Press any key to close..."
