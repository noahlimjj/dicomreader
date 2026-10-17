# App Store Submission & Distribution Guide

Your iOS application is fully configured, signed with your Apple Distribution Certificate, and uploaded directly to **App Store Connect**.

Once Apple finishes processing the build (usually 5–15 minutes), it will appear in **App Store Connect** under your app's **TestFlight** and **App Store** tabs.

---

## 1. App Store Connect Information (Copy & Paste)

### App Information
- **Name**: `DICOM Mobile` (or `DICOM Aperture`)
- **Subtitle** *(max 30 chars)*: `Medical DICOM & CT Viewer`
- **Primary Category**: `Medical`
- **Secondary Category**: `Utilities` or `Education`
- **Bundle ID**: `app.dicomreader.viewer`
- **SKU**: `dicom-mobile-ios`

### Links
- **Privacy Policy URL**: `https://noahlimjj.github.io/dicomreader/privacy.html`
  *(Already live, meets Apple's requirement: discloses 100% on-device processing and zero data collection).*
- **Support URL**: `https://noahlimjj.github.io/dicomreader/` or `https://github.com/noahlimjj/dicomreader/issues`
- **Marketing URL** *(Optional)*: `https://noahlimjj.github.io/dicomreader/`

---

## 2. App Store Description & Keywords

### Promotional Text *(max 170 chars)*:
> High-performance, offline DICOM viewer for personal medical imaging. Fast CT, MRI, and X-ray inspection with zero tracking.

### Description:
```
DICOM Mobile is a fast, secure, and private medical image viewer built specifically for your iPhone and iPad. Easily open, inspect, and analyze your own medical scans directly on your device without uploading anything to the cloud.

KEY FEATURES:
• High-Performance Volume Navigation: Smoothly scroll through hundreds of CT and MRI slices with instantaneous loading and fluid scrubber controls.
• True Scout / Localizer Synchronization: Interactive reference lines show exact cross-sectional levels across axial, sagittal, and coronal planes. Tap or scrub the scout to jump across slices in real time.
• Interactive Two-View Layout: Inspect companion views side by side (e.g., Scout next to Axial or Sagittal next to Coronal) with synchronized crosshair locators.
• Precision Measurement Tools: Calibrated distance measurements, elliptical ROI statistics (area, mean, min/max HU, standard deviation), and Cobb angles.
• Comprehensive DICOM Format Support: Uncompressed, RLE, JPEG Baseline/Lossless, JPEG 2000, and JPEG-LS. Supports multi-frame series and dynamic cine playback.
• 100% Private & Offline: All image parsing and rendering happens locally on your device. No user accounts, no analytics, no third-party tracking, and zero cloud uploads.
• Flexible Import: Open files directly from the Files app, iCloud Drive, Google Drive, AirDrop, or local ZIP archives.

DISCLAIMER:
DICOM Mobile is designed for personal reference, research, and educational purposes. It is not intended for primary diagnostic interpretation or clinical treatment planning.
```

### Keywords *(max 100 chars)*:
```
dicom,dicom viewer,ct scan,mri,xray,medical imaging,radiology,pacs,scout localizer,medical viewer
```

---

## 3. App Store Screenshots

Pixel-perfect screenshots matching Apple's exact display specifications are located in:
`app/store/screenshots/`

- **6.9" Display** (iPhone 16 Pro Max / 15 Pro Max):
  - `iphone-6.9-1-start.png`
  - `iphone-6.9-2-measure.png`
  - `iphone-6.9-3-two-views.png`
  - `iphone-6.9-4-coronal.png`
  - `iphone-6.9-5-series.png`
- **6.5" / 6.7" Display** (iPhone 14 Plus / 13 Pro Max / 11 Pro Max):
  - `iphone-6.5-1-start.png` to `iphone-6.5-5-series.png`
- **13" iPad Pro Display** (if iPad is enabled):
  - `ipad-13-1-start.png` to `ipad-13-5-series.png`

---

## 4. App Review Notes (Crucial for Medical App Approval)

Under App Store Review Guideline 1.4.1, Apple requires medical apps to specify their clinical scope. Paste this into **App Review Notes**:

```
DICOM Mobile is a personal medical image viewer designed exclusively for educational, reference, and informational viewing of personal DICOM files.

1. All image decoding and measurements are performed strictly locally on the user's device (no servers, no cloud storage, no network transmission of patient files).
2. The application does not provide automated diagnostic recommendations, automated pathology detection, or treatment algorithms.
3. Prominent disclaimers are visible within the application confirming it is not intended for primary diagnostic use.
4. Testing: A built-in synthetic phantom scan is accessible by tapping 'Open sample study' on the home screen.
```

---

## 5. App Privacy Questionnaire Answers

When Apple asks about data collection:
- **Do you collect data from this app?**: Select **No, we do not collect data from this app**.
- **Tracking**: Select **No, this app does not track users**.

---

## 6. How to Submit

1. Log into [App Store Connect](https://appstoreconnect.apple.com/).
2. Go to **My Apps** → **DICOM Mobile**.
3. Under **iOS App - 1.0 Prepare for Submission**:
   - Drag and drop the screenshots from `app/store/screenshots/` into the respective display size tabs.
   - Fill in Description, Keywords, Support URL, and Privacy Policy URL.
   - Scroll down to **Build**: Click **+** and select the build that just uploaded (e.g., `1.0 (105)`).
   - In **App Review Information**, paste the review notes above.
4. Click **Save** and then click **Add for Review** / **Submit for Review**.
