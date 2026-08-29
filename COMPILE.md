# Compile

## Setup

```sh
npm install
```

## Develop

```sh
npm run dev
npm run icons
npm run typecheck
```

## Bundle

```sh
npm run dist:appimage          # Linux x86_64 AppImage → dist/StarDoering-<version>-x86_64.AppImage
npm run dist:appimage:arm64    # Linux arm64 AppImage
npm run dist:linux             # AppImage + deb
npm run dist:mac               # dmg + zip (unsigned, see below)
npm run dist:win               # NSIS installer + portable exe
npm run dist                   # host platform, all its targets
```

## macOS: unsigned for now

There is no Developer ID certificate yet, so `npm run dist:mac` builds an unsigned, un-notarized
app (`identity: null`, `notarize: false` under `mac:` in `electron-builder.yml`). Gatekeeper blocks
it on first start: right-click the app → Open, or `xattr -dr com.apple.quarantine "/Applications/StarDöring.app"`.

To sign and notarize once a *Developer ID Application* certificate is in the login keychain
(`security find-identity -v -p codesigning`), set under `mac:` in `electron-builder.yml`:

```yaml
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.inherit.plist
  notarize: true          # and remove `identity: null`
```

and export the App Store Connect key before building:

```sh
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
npm run dist:mac            # signs, hardens, notarizes
```

This is Developer ID distribution, not the App Store.

## macOS certificate, from the CLI

```sh
node scripts/mac-signing-cert.mjs list     # what the team already has
node scripts/mac-signing-cert.mjs csr      # private key + signing request
node scripts/mac-signing-cert.mjs create   # Apple signs it
node scripts/mac-signing-cert.mjs import   # .p12 + install into the login keychain
```

Uses the same App Store Connect key as notarization; creating a Developer ID certificate needs the Account Holder role.

