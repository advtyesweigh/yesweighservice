# Android APK (thin shell)

Warehouse / store-room / admin staff use this APK for LAN label printing.
Everyone else keeps using the PWA at https://service.yesweigh.in.

## How it works

- The APK is a Capacitor WebView pointed at the live site (`capacitor.config.ts` → `server.url`).
- Day-to-day UI and label layout changes ship via GitHub Actions → Firebase Hosting (no new APK).
- Rebuild the APK only when native print code or Android config changes.
- Printer IP/port live in Firestore (`appSettings/localPrinterSettings`) — change in **Settings → Local printers**.
- You can configure multiple LAN printers; mark one as **Store label** for bin-label printing (IP, size, gap).

## Build on this laptop

Requires:

- Android SDK at `D:\tools\android-sdk` (command-line tools + API 35/36)
- Microsoft JDK **21** (`winget install Microsoft.OpenJDK.21`)

From repo root:

```powershell
.\build-apk.ps1
```

APK output:

```text
android\app\build\outputs\apk\debug\yesone.apk
```

Install on a phone:

```powershell
adb install -r android\app\build\outputs\apk\debug\yesone.apk
```

Or copy the APK to the phone and open it (allow install from unknown sources).

### Manual equivalent

```powershell
$env:JAVA_HOME = (Get-ChildItem 'C:\Program Files\Microsoft\jdk-21*' -Directory | Select-Object -First 1).FullName
$env:ANDROID_HOME = 'D:\tools\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;" + $env:Path

npm run cap:sync
cd android
.\gradlew.bat assembleDebug
```

## Staff usage

1. Phone on the **same Wi‑Fi** as the label printer.
2. Open the APK → sign in as admin/staff.
3. **Settings → Local printers** → confirm IP (default `192.168.1.39`) → **Save** → **Test print**.

## Windows laptop

The browser cannot open a raw TCP socket. A loopback bridge on the laptop does that, then the page at https://service.yesweigh.in sends the same label bytes to it.

The laptop must be on the same LAN as the printer. From the repo:

```powershell
npm run print-bridge
```

Leave that process running. It listens on `127.0.0.1:47321` only and forwards jobs to the printer on port **9100**. Chrome may ask once to allow local-network access for `service.yesweigh.in`. Reload the site after a hosting deploy so the page knows about the bridge.

The bridge is not deployed. Hosting only needs the page change that calls it. The APK path is unchanged.

## Notes

- Test print sends a small TSPL label over TCP port **9100**.
- If nothing prints, the printer may expect ZPL/EZPL instead of TSPL — we can switch the payload without a new APK once hosting is updated.
- Reserve the printer IP on the router (DHCP is currently on).
- This app uses Capacitor — build command is `gradlew assembleDebug`, not `flutter build apk`.
