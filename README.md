# DICOM Viewer for Mac

A simple, fast viewer for CT, MRI and X-ray images (DICOM), made for MacBooks.
It runs locally in Safari or Chrome. Your images never leave your computer.

- Scroll through slices with the trackpad, pinch to zoom, drag to pan
- Brightness / contrast with presets (soft tissue, lung, bone, brain…)
- Measure distances (mm), angles, and areas with mean / SD of pixel values (HU on CT)
- Measurement list, undo, calibration for X-rays
- Series list with thumbnails, DICOM tag browser, export to PNG
- Reads compressed images (JPEG Lossless, JPEG, JPEG 2000, RLE) and Japanese
  patient names (ISO 2022)

Built on [dwv](https://github.com/ivmartel/dwv).

## Requirements

- macOS with Python 3 (Homebrew Python, or Apple's `xcode-select --install`)
- Safari or Chrome

## Install

```bash
git clone https://github.com/noahlimjj/dicomreader.git
```

If you downloaded the ZIP instead, macOS marks the app as downloaded from the
internet. The first time, right-click **DICOM Viewer.app** and choose **Open**.

## Open it

Double-click **DICOM Viewer.app**. Your browser opens the viewer, and the
small local server stops by itself a few minutes after you close the tab.

Click **Open folder…** and choose the folder with your images, for example a
copied hospital CD.

**On a copied CD:** put the `dicomreader` folder next to the CD's `DICOMDIR`
file (or its `DICOM` folder). The viewer then opens those images straight away.

The first time, macOS may ask whether the app can access a folder such as
Desktop or Downloads. Click **Allow** so it can read the images.

Alternatives:

- `Open DICOM Viewer.command`: same thing, with a Terminal window that stops
  the viewer when closed.
- From a terminal: `python3 server.py /path/to/images`

## Using it

| Action | How |
|---|---|
| Next / previous image | Two-finger scroll, mouse wheel, or ↑ ↓ |
| Zoom | Pinch, or ⌘ + scroll |
| Move the image | **Pan** tool, then drag |
| Brightness / contrast | **Contrast** tool, then drag; or a preset (keys 1–9) |
| Distance | **Distance** (M), then drag |
| Angle | **Angle** (A), then click 3 points (the middle one is the corner) |
| Area and mean value | **Ellipse** (E) or **Rectangle** (B), then drag |
| Edit / delete a measurement | With a measure tool on, click it: drag its handles, or press Delete. ⌘Z undoes. |
| Measurement list, calibration | **Measurements** (L) |
| DICOM tags | **Tags** (T) |
| Save a picture | **Export PNG** (X) |
| Smooth / pixel-exact display | G |

Press **?** in the viewer for all shortcuts.

## Measurement accuracy

Lengths come from the pixel size stored in each image (`PixelSpacing`). The
scale in use is shown at the bottom right of the image and in the Measurements
panel.

- **CT, MRI:** pixel size in the patient. Accurate to about one pixel.
- **X-ray:** the pixel size is often only known at the detector, so anatomy
  measures about 5–15 % too large. The viewer says so. For exact values, draw a
  distance over an object of known size and enter its real length under
  **Calibrate**.
- **Screenshots / secondary captures** and images without a pixel size are
  flagged as unreliable or measured in pixels.

Some fixes on top of dwv make this reliable:

- **Geometry:** slices are shown as the scanner stored them (avoids off-screen
  images for some orientations).
- **Angled slices:** sets such as spine MR disc levels are stacked so they
  scroll as one series.
- **Pixel aspect ratio:** it isn't mistaken for a pixel size.

This viewer is for looking at your own images. It is not a medical device and
must not be used for diagnosis.

## Project layout

| Path | What |
|---|---|
| `DICOM Viewer.app` | Launcher app (rebuild with `scripts/build-app.sh`) |
| `launch.sh` | Starts the server in the background (used by the app) |
| `server.py` | Local web server, listens on 127.0.0.1 only |
| `web/app.js` | The viewer |
| `web/dicom.js` | DICOM byte-level helpers (tag editing, Japanese text) |
| `web/vendor/` | dwv 0.36.4, Konva, JSZip, magic-wand-tool |

## License

GPL-3.0 (see `LICENSE`), because it includes dwv (GPL-3.0). Konva, JSZip and
magic-wand-tool keep their own licenses in `web/vendor/`.
