#!/bin/bash
# Double-click helper for the unsigned macOS build: copies the app to
# /Applications, strips the com.apple.quarantine flag Gatekeeper adds to
# anything downloaded via a browser (the actual cause of the "is damaged and
# can't be opened" dialog — the app isn't actually damaged), then launches
# it. Goes away once the build is code-signed and notarized.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Mova Flow.app"
DEST="/Applications/Mova Flow.app"

if [ ! -d "$APP" ]; then
  echo "Couldn't find Mova Flow.app next to this script — make sure it's still in the mounted disk image."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "Installing Mova Flow to /Applications..."
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST"

echo "Done — opening Mova Flow."
open "$DEST"
