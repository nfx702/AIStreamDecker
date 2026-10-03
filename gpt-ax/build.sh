#!/bin/sh
# Builds AIStreamDeckerGPT.app (accessibility reader for the ChatGPT app).
# Signs with your "Apple Development" identity if present (stable identity: the Accessibility grant survives rebuilds);
# falls back to ad-hoc signing, where every rebuild requires re-granting Accessibility. Override with SIGN_ID=...
set -e
cd "$(dirname "$0")"
APP=AIStreamDeckerGPT.app
ID=${SIGN_ID:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -1)}
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/"
swiftc -O main.swift -o "$APP/Contents/MacOS/gpt-ax"
codesign -s "${ID:--}" -f --timestamp=none "$APP"
echo "signed with: ${ID:-ad-hoc}"
