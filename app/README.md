# DICOM Mobile: iPhone, Android and web

A mobile-first DICOM viewer. It opens CT, MRI, X-ray, ultrasound, mammography,
PET and NM scans from files, folders or a hospital ZIP. Swipe to scroll through
slices, pinch to zoom, adjust brightness and contrast, and measure. Everything
runs on the device; nothing is uploaded.

It is a rewrite of the desktop viewer in [`../web`](../web) for phones. All its
functions are kept (two views with reference lines, numbered levels, locator,
sync, measurements with HU statistics, ratio, X-ray calibration, tags, export,
presets, cine) and the GPL-licensed dwv engine is replaced with permissively
licensed parts, so the app can go on the App Store.

| | |
| --- | --- |
| **Web** | `npm run dev` → http://localhost:5173 (also on your phone over Wi-Fi) |
| **iOS** | Capacitor 8 + Swift Package Manager, built by **Xcode Cloud** (`ios/App/ci_scripts/ci_post_clone.sh`) |
| **Android** | Capacitor 8, `npx cap sync android` then Android Studio / `./gradlew assembleDebug` |
| **CI** | `.github/workflows/app.yml`: tests, web version on GitHub Pages, Android APK, iOS simulator build + screenshot |

## Using it

| Gesture | Does |
| --- | --- |
| Drag up / down (Scroll tool) | next / previous image |
| Slider on the right edge | jump through the stack |
| Pinch, two-finger drag | zoom, move (with any tool) |
| Drag (Contrast tool) | up/down = brightness, left/right = contrast |
| Double tap | zoom in / back to fit; with two views: show that point in the other view |
| Touch and hold | magnifier with the pixel value (HU on CT) |
| Measure → Distance / Angle / Ellipse / Rectangle / Arrow | drag to draw; tap to select, drag its points, delete |

On a computer: mouse wheel scrolls, Ctrl + wheel or pinch zooms, right-drag adjusts
contrast, middle-drag moves, and keyboard shortcuts work as in the desktop viewer (press `?`).

## How it works

```
src/
  engine/   meta.js      header parsing (dicom-parser), enhanced multi-frame, character sets
            pixels.js    frame extraction + all decoders → typed array / RGBA
            codecs.js    OpenJPEG, CharLS, libjpeg-turbo, OpenJPH (WebAssembly), JPEG lossless, 12-bit JPEG
            worker.js    decoding off the main thread
            loader.js    worker pool, priority queue, byte-limited cache, prefetch
            import.js    files, folders, ZIPs (read lazily: low memory on phones)
  model/    study.js     series grouping, spacing / calibration, window presets
            geometry.js  patient coordinates, reference lines, orientation letters
  view/     viewport.js  canvas rendering, zoom / pan / rotate / flip, cine
            gestures.js  touch, pen, mouse, trackpad
            measure.js   measurements: maths, drawing, hit testing
            render.js    VOI LUT (window), MONOCHROME1, sigmoid, auto window
  main.js   app shell, tools, panels, two views
```

Supported: implicit / explicit VR little endian, explicit big endian, deflate,
RLE, JPEG baseline / extended (12 bit) / lossless, JPEG-LS, JPEG 2000, HTJ2K;
MONOCHROME1/2, RGB, YBR_FULL / 422 / RCT / ICT, palette colour; 8/16/32-bit,
1-bit (SEG); multi-frame and enhanced multi-frame (per-frame geometry); files
without the DICM preamble; Japanese, Korean, Chinese and ISO 8859 character sets.

Best practices it follows: modality LUT then VOI LUT per DICOM PS3.3 C.11
(linear and sigmoid), measurements in patient space with anisotropic pixels,
an X-ray magnification warning, and LOSSY marking. It decodes off the main
thread, keeps memory bounded on phones, uses the radiological orientation
markers, and reads the scanner's window presets.

## Tests

```
npm run golden          # once: downloads pydicom test files, writes reference pixels (needs Python + pydicom)
npm test                # 115 unit tests: every decoder vs pydicom, metadata, 15 character sets
npx playwright install chromium webkit
npm run test:e2e        # viewer on emulated iPhone (WebKit), Android (Chrome) and desktop
python -I test/tools/fetch_library.py   # optional: real studies from the OHIF demo server → test/library
```

`test/e2e/library.spec.js` opens every library (pydicom files, a ZIP and
real CT / MR / PET / MG / CR / DX / US / NM studies if fetched) and checks that
the first, middle and last image of every series decodes.

## The sample scan

`public/samples` is a synthetic head CT phantom made by
`test/tools/make_sample.py` (no patient data): axial, sagittal and coronal
series plus a scout in one frame of reference, so reference lines work. It is
what App Store reviewers will see, so keep the "Try a sample scan" button.

## Releasing

See [docs/STORES.md](docs/STORES.md) for the App Store / Google Play checklist.
