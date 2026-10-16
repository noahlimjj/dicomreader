#!/bin/sh
# Xcode Cloud: build the web app and sync it into the iOS project before Xcode
# resolves the Swift packages (Package.swift points into node_modules).
set -e

echo "=== DICOM Reader: post clone ==="
APP_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"   # .../app
echo "App dir: $APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js with Homebrew"
  export HOMEBREW_NO_AUTO_UPDATE=1
  export HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node@22
  export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
fi
node --version
npm --version

cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npx cap sync ios

# Xcode Cloud build number -> CFBundleVersion
if [ -n "$CI_BUILD_NUMBER" ]; then
  sed -i '' "s/CURRENT_PROJECT_VERSION = [0-9]*;/CURRENT_PROJECT_VERSION = $CI_BUILD_NUMBER;/" ios/App/App.xcodeproj/project.pbxproj
  echo "Build number: $CI_BUILD_NUMBER"
fi
echo "=== post clone done ==="
