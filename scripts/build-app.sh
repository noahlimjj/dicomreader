#!/bin/bash
# Rebuilds "DICOM Viewer.app" (a small AppleScript launcher for launch.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf "DICOM Viewer.app"
osacompile -o "DICOM Viewer.app" scripts/launcher.applescript
echo "Built: $(pwd)/DICOM Viewer.app"
