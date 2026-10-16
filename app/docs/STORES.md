# Getting DICOM Reader onto the App Store and Google Play

## What is already done in this repo

- iOS project `ios/App`: bundle id `app.dicomreader.viewer`, team `44BP374T6C`
  (same as SleepSensor), automatic signing, iOS 15+, iPhone + iPad.
- Xcode Cloud script `ios/App/ci_scripts/ci_post_clone.sh`: installs Node,
  builds the web app, runs `cap sync ios`, sets the build number from
  `CI_BUILD_NUMBER`.
- Info.plist: opens `.dcm` and `.zip` from Files / Mail / AirDrop ("Open in…"),
  `ITSAppUsesNonExemptEncryption = NO` (no export compliance question), and
  usage strings for the system picker's camera / photo options.
- Android project `android`: `app.dicomreader.viewer`, "Open with" for DICOM
  and ZIP, `allowBackup=false`.
- Icons and splash screens (`assets/` → `npx capacitor-assets generate`).
- Privacy policy page: `public/privacy.html`, published with the web version
  at `https://noahlimjj.github.io/dicomreader/privacy.html` once GitHub Pages is on.
- In-app sample study for reviewers (synthetic, no patient data).

## Steps that need you (logins)

### Apple

1. **Developer account type.** Apple asks apps in health care to come from an
   *organization* account (guideline 5.1.1(ix)). A pure viewer for your own images
   with a "not for diagnosis" label often passes from an individual account,
   but reviewers have rejected similar apps. If it gets rejected under
   5.1.1(ix), enrol as an organization (an LLC + a free D-U-N-S number) or ask
   Apple to convert the account.
2. **App Store Connect → Apps → +**: new iOS app, bundle id
   `app.dicomreader.viewer` (register it under Certificates, Identifiers &
   Profiles if it is not offered), SKU `dicomreader`.
   The name "DICOM Reader" may be taken: pick a distinct one (e.g. "ScanSlice",
   "Slice: CT & MRI Viewer"). Change `appName` in `capacitor.config.json` and
   `CFBundleDisplayName` in `ios/App/App/Info.plist` to match.
3. **Xcode Cloud workflow** (in Xcode: Integrate → Create Workflow, or App Store
   Connect → Xcode Cloud): repository `noahlimjj/dicomreader`, project
   `app/ios/App/App.xcodeproj`, scheme `App`, start condition: branch
   `main` (or `mobile-app`), action **Archive – iOS**, post-action **TestFlight
   (internal testing)**. The post-clone script runs automatically.
4. **TestFlight**: install TestFlight on your iPhone, add yourself as an
   internal tester.
5. **Submission**:
   - Category: Medical (or Health & Fitness); Age rating: 4+ (or 17+ "medical
     information" if asked; answer "Medical/Treatment information: infrequent").
   - Privacy: "Data not collected".
   - Privacy policy URL: the GitHub Pages link above.
   - Description must say it is **not for diagnosis** (guideline 1.4.1).
     Suggested text below.
   - Review notes: "Tap 'Try a sample scan' to see a synthetic CT. To test
     your own files, open a .dcm or .zip from the Files app."
   - Screenshots: 6.9" and 6.5" iPhone + 13" iPad. Use the sample scan
     (axial with measurements, two views with reference lines, sagittal).

### Google Play

1. Play Console ($25 once). New *personal* accounts must run a closed test
   with at least 12 testers for 14 days before production; organization
   accounts are exempt.
2. Build a signed release bundle: create an upload key
   (`keytool -genkey -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`),
   then in Android Studio *Build → Generate Signed App Bundle*. Keep the key safe.
3. Health apps declaration: the app is a viewer, not a medical device;
   data safety: no data collected or shared.

## Regulatory note (not legal advice)

A viewer marketed for **primary diagnosis** is a regulated medical device
(FDA 510(k) in the US, CE / MDR in the EU). Keep the wording "for viewing your
own images, education and reference; not intended for diagnosis" in the app
(it is on the start screen and in Help) and in the store listing, and do not
make diagnostic claims.

## Suggested store text

**Subtitle:** View your CT, MRI & X-ray scans

**Description:**
Open the scans from your hospital CD, patient portal ZIP or DICOM files and look
through them on your phone.

• Swipe through CT and MRI slices; pinch to zoom
• Adjust brightness and contrast, with presets for lung, bone, brain and soft tissue
• Measure distances, angles and areas (with HU values on CT); calibrate X-rays
• Two views side by side with reference lines, e.g. where an axial slice sits on the sagittal
• Play ultrasound and other cine loops
• See every DICOM tag
• Reads JPEG, JPEG 2000, JPEG-LS, HTJ2K and RLE compressed files, multi-frame and colour images
• Private: images never leave your device. No account, no tracking.

DICOM Reader is for viewing your own images, for education and reference. It is
not a medical device and is not intended for diagnosis.
