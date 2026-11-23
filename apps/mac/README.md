# @paperbrew/mac

The Paperbrew menu-bar app: pairs with your Paperbrew account and prints queued issues on this Mac.

## PAPERBREW_API_URL

The app needs to know which Paperbrew it talks to when someone types a code into **Paste code…** (a pairing link
carries its own address, a typed code does not). The address is fixed at build time:

- `npm run build` writes `dist/defaults.json` with `{ "api": "<origin>" }`, taken from the `PAPERBREW_API_URL`
  environment variable, or `http://localhost:5173` when it is not set (local development).
- The value must be `https://...` (or `http://localhost...`). Anything else fails the build.
- `npm run dist` (and `npm run dist:mac` from the repo root) refuses to run unless `PAPERBREW_API_URL` is an `https`
  URL, so a shipped `.dmg` can never carry the localhost default:

  ```
  PAPERBREW_API_URL=https://paperbrew.example npm run dist:mac
  ```

At runtime, **Paste code…** uses the origin saved by an earlier pairing, else this built-in default.

## Building the .dmg

From the repo root:

```
PAPERBREW_API_URL=https://paperbrew.example npm run dist:mac
```

(Use your real https address.) This needs internet the first time: it downloads Electron for both Intel and Apple
Silicon. The result is one universal installer:

```
apps/mac/release/Paperbrew-<version>-universal.dmg
```

`release/` and `dist/` are not committed. Settings live in `electron-builder.yml`; the app icon is
`assets/icon.icns` (regenerate with `node apps/mac/scripts/make-app-icon.js`, macOS only).

The app is **not signed with a Developer ID or notarized yet**, so macOS warns the first time. Whoever installs it
must drag Paperbrew to Applications, then **right-click it and choose Open** (once). Signing is a later step:
set `CSC_NAME` to the "Developer ID Application: ..." certificate name when building, then add notarization.

## Offering the download in Paperbrew

The .dmg has to be hosted somewhere people can download it, for example as a file on a GitHub Release. Then set
`MAC_APP_URL` on the API to that download address. Settings shows the **Printer** section only while
`MAC_APP_URL` is set.

## Manual test checklist (UNVERIFIED)

None of this has been run. It needs a person at a Mac with a printer. Tick each line as you go and write down
anything odd.

1. **Install.** Open the .dmg, drag Paperbrew to Applications, right-click it and choose Open. A small paper icon
   appears in the menu bar and there is no Dock icon.
2. **Connect this Mac.** In Paperbrew Settings click **Connect this Mac**. The browser asks to open Paperbrew; allow
   it. The menu-bar icon shows "Ready - <your printer>" and Settings lists this Mac as a device.
3. **Connect from a cold start.** Quit Paperbrew from its menu-bar icon, then click **Connect this Mac** again. macOS
   starts the app and it connects without any extra step.
4. **Only one icon.** Open Paperbrew a second time from Applications. There is still just one menu-bar icon.
5. **Starts at login.** Log out and back in. Paperbrew is running again.
6. **Print for real.** Make an issue come due: set the schedule to the current hour, then trigger the check with
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-api-address>/cron/tick`. Within about a minute a
   notification appears and the printer prints a two-sided A4 booklet (flipped on the short edge). Settings shows
   **Printed** and the articles are archived.
7. **Printer goes missing.** Choose a printer in the menu, then delete that printer in System Settings > Printers
   & Scanners. Queue another issue as in step 6. A failure notification appears and Settings shows **Failed** with
   the printer's error. Click **Print again**: it prints on the default printer.
8. **Remove the device.** In Settings remove this Mac. Within a minute the menu-bar icon says "Not connected".
