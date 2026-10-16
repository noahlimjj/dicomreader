"""Generate the bundled sample study: a synthetic head CT phantom.

No real patient data: the anatomy is built from ellipsoids with typical CT
values (bone ~1200 HU, grey matter ~38 HU, CSF ~5 HU, fat ~-90 HU, air
-1000 HU) plus noise. Writes public/samples/*.dcm and manifest.json:

  * axial series (2.5 mm), sagittal and coronal reformats of the same
    volume (same frame of reference, so reference lines work)
  * a lateral scout (CT localizer)

Images are JPEG-LS lossless compressed (pyjpegls) to keep the app small.

    python -I test/tools/make_sample.py
"""
import json
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (CTImageStorage, ExplicitVRLittleEndian, JPEGLSLossless,
                         generate_uid)

OUT = Path(__file__).resolve().parent.parent.parent / "public" / "samples"
RNG = np.random.default_rng(7)

# grid (LPS, mm): x = patient left, y = posterior, z = superior
PS = 0.9  # in-plane pixel spacing
N = 256
Z_STEP = 2.5
NZ = 76
xs = (np.arange(N) - (N - 1) / 2) * PS
ys = (np.arange(N) - (N - 1) / 2) * PS
zs = (np.arange(NZ) - (NZ - 1) / 2) * Z_STEP


def ellipsoid(X, Y, Z, c, r, soft=0.8):
    """soft mask (0..1) of an ellipsoid, edge width ~soft mm"""
    d = np.sqrt(((X - c[0]) / r[0]) ** 2 + ((Y - c[1]) / r[1]) ** 2 + ((Z - c[2]) / r[2]) ** 2)
    k = min(r) / soft
    return np.clip((1 - d) * k + 0.5, 0, 1)


def phantom(X, Y, Z):
    v = np.full(X.shape, -1000.0, dtype=np.float32)

    def paint(mask, hu):
        nonlocal v
        v = v * (1 - mask) + hu * mask

    # face (soft tissue + facial bones) below / in front of the cranium
    paint(ellipsoid(X, Y, Z, (0, -46, -50), (56, 50, 40)), 45)
    face_bone = (ellipsoid(X, Y, Z, (0, -48, -52), (50, 44, 33)) -
                 ellipsoid(X, Y, Z, (0, -48, -52), (46.5, 40.5, 29.5))) * (Y < -15)
    paint(np.clip(face_bone, 0, 1), 950)
    paint(ellipsoid(X, Y, Z, (0, -48, -52), (46, 40, 29)) * (Y < -15), 40)
    # cranium: scalp, fat, outer table, diploe, inner table
    c = (0, 4, 12)
    paint(ellipsoid(X, Y, Z, c, (79, 99, 83)), 45)
    paint(ellipsoid(X, Y, Z, c, (76.5, 96.5, 80.5)), -90)
    paint(ellipsoid(X, Y, Z, c, (75, 95, 79)), 1300)
    paint(ellipsoid(X, Y, Z, c, (73, 93, 77)), 650)
    paint(ellipsoid(X, Y, Z, c, (71, 91, 75)), 1300)
    brain = ellipsoid(X, Y, Z, c, (69, 89, 73))
    paint(brain, 8)                                                # CSF over the cortex
    paint(ellipsoid(X, Y, Z, c, (67, 87, 71)), 38)                 # grey matter
    for sx in (-1, 1):                                             # white matter
        paint(ellipsoid(X, Y, Z, (sx * 27, 6, 24), (30, 62, 40)), 27)
        paint(ellipsoid(X, Y, Z, (sx * 17, -2, 10), (7, 11, 9)), 36)   # basal ganglia
        paint(ellipsoid(X, Y, Z, (sx * 9, 14, 10), (8, 10, 9)), 37)    # thalami
        paint(ellipsoid(X, Y, Z, (sx * 9, 2, 26), (5, 30, 8)), 5)      # lateral ventricles
        paint(ellipsoid(X, Y, Z, (sx * 11, -22, 20), (5, 7, 6)), 5)    # frontal horns
        paint(ellipsoid(X, Y, Z, (sx * 14, 30, 18), (6, 8, 7)), 5)     # occipital horns
    paint(ellipsoid(X, Y, Z, (0, 6, 8), (1.8, 12, 8), soft=0.5), 5)  # third ventricle
    fissure = np.clip(1 - np.abs(X) / 1.2, 0, 1) * (Z > 28) * brain
    paint(fissure * 0.7, 10)
    paint(np.clip(1 - np.abs(X) / 0.6, 0, 1) * (Z > 34) * brain * (np.abs(Y - 4) < 82), 70)  # falx
    # posterior fossa
    paint(ellipsoid(X, Y, Z, (0, 50, -36), (44, 26, 18)), 40)        # cerebellum
    paint(ellipsoid(X, Y, Z, (0, 22, -26), (11, 11, 26)), 30)        # brainstem
    paint(ellipsoid(X, Y, Z, (0, 38, -30), (4, 4, 6)), 5)            # fourth ventricle
    # orbits, globes, lenses, sinuses, nasal cavity
    for sx in (-1, 1):
        paint(ellipsoid(X, Y, Z, (sx * 31, -70, -16), (17, 20, 15)), -90)
        paint(ellipsoid(X, Y, Z, (sx * 31, -72, -16), (12, 12, 12)), 12)
        paint(ellipsoid(X, Y, Z, (sx * 31, -83, -16), (4.5, 1.8, 4.5), soft=0.4), 95)
        paint(ellipsoid(X, Y, Z, (sx * 24, -56, -50), (12, 15, 14)), -1000)
    paint(ellipsoid(X, Y, Z, (0, -66, -46), (9, 20, 20)), -1000)
    paint(np.clip(1 - np.abs(X) / 0.8, 0, 1) * (ellipsoid(X, Y, Z, (0, -66, -46), (9, 20, 20)) > 0.5), 300)
    paint(ellipsoid(X, Y, Z, (0, -86, 34), (14, 3, 9)), -1000)       # frontal sinus
    return v


def volume_axial():
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="xy")  # shape (y, x, z)
    v = phantom(X, Y, Z)
    v += RNG.normal(0, 3.5, v.shape).astype(np.float32)
    return v  # [row=y, col=x, slice=z]


UID_ROOT = "1.2.826.0.1.3680043.10.1491."  # pydicom's root for generated examples


def uid(*parts):
    return generate_uid(prefix=None, entropy_srcs=["dicom-reader-sample", *map(str, parts)])


STUDY = uid("study")
FOR = uid("for")


def base_dataset(series_number, series_desc, sop_uid, series_uid, instance):
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = uid("impl")
    ds.file_meta = meta
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.ImageType = ["DERIVED", "SECONDARY", "AXIAL"]
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid
    ds.StudyDate = "20260101"
    ds.SeriesDate = "20260101"
    ds.StudyTime = "090000"
    ds.SeriesTime = f"0900{series_number:02d}"
    ds.Modality = "CT"
    ds.Manufacturer = "Synthetic"
    ds.InstitutionName = "Synthetic phantom - not a real patient"
    ds.StudyDescription = "Head CT (synthetic phantom)"
    ds.SeriesDescription = series_desc
    ds.PatientName = "PHANTOM^DEMO"
    ds.PatientID = "SAMPLE-0001"
    ds.PatientBirthDate = ""
    ds.PatientSex = "O"
    ds.BodyPartExamined = "HEAD"
    ds.SliceThickness = "2.5"
    ds.KVP = "120"
    ds.StudyInstanceUID = STUDY
    ds.SeriesInstanceUID = series_uid
    ds.StudyID = "1"
    ds.SeriesNumber = series_number
    ds.InstanceNumber = instance
    ds.FrameOfReferenceUID = FOR
    ds.PositionReferenceIndicator = ""
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = "-1024"
    ds.RescaleSlope = "1"
    ds.RescaleType = "HU"
    ds.WindowCenter = ["40", "500"]
    ds.WindowWidth = ["80", "2500"]
    ds.WindowCenterWidthExplanation = ["BRAIN", "BONE"]
    ds.LossyImageCompression = "00"
    return ds


def write(ds, pixels_hu, name):
    stored = np.clip(np.round(pixels_hu + 1024), 0, 4095).astype(np.uint16)
    ds.Rows, ds.Columns = stored.shape
    ds.PixelData = stored.tobytes()
    ds.compress(JPEGLSLossless, encoding_plugin="pyjpegls")
    ds.save_as(OUT / name, enforce_file_format=True)
    return name


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*.dcm"):
        f.unlink()
    vol = volume_axial()  # (y, x, z)
    files = []

    # axial: viewed from the feet, rows = y (anterior at top), cols = x (patient right on the left)
    s_uid = uid("axial")
    for k in range(NZ):
        z = zs[NZ - 1 - k]  # top of the head first
        ds = base_dataset(2, "Axial 2.5 mm", uid("axial", k), s_uid, k + 1)
        ds.ImageType = ["DERIVED", "SECONDARY", "AXIAL"]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [f"{xs[0]:.3f}", f"{ys[0]:.3f}", f"{z:.3f}"]
        ds.PixelSpacing = [f"{PS}", f"{PS}"]
        ds.SliceLocation = f"{z:.3f}"
        files.append(write(ds, vol[:, :, NZ - 1 - k], f"axial_{k + 1:03d}.dcm"))

    # sagittal reformat: rows = z (top = superior), cols = y (anterior on the left)
    s_uid = uid("sagittal")
    xi = list(range(40, N - 40, 4))
    for k, i in enumerate(xi):
        ds = base_dataset(3, "Sagittal reformat 3.6 mm", uid("sag", k), s_uid, k + 1)
        ds.ImageType = ["DERIVED", "SECONDARY", "REFORMATTED"]
        ds.ImageOrientationPatient = [0, 1, 0, 0, 0, -1]
        ds.ImagePositionPatient = [f"{xs[i]:.3f}", f"{ys[0]:.3f}", f"{zs[-1]:.3f}"]
        ds.PixelSpacing = [f"{Z_STEP}", f"{PS}"]
        ds.SliceThickness = f"{4 * PS:.1f}"
        img = vol[:, i, ::-1].T  # (z from top, y)
        files.append(write(ds, img, f"sagittal_{k + 1:03d}.dcm"))

    # coronal reformat: rows = z (top = superior), cols = x
    s_uid = uid("coronal")
    yi = list(range(24, N - 24, 4))
    for k, j in enumerate(yi):
        ds = base_dataset(4, "Coronal reformat 3.6 mm", uid("cor", k), s_uid, k + 1)
        ds.ImageType = ["DERIVED", "SECONDARY", "REFORMATTED"]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]
        ds.ImagePositionPatient = [f"{xs[0]:.3f}", f"{ys[j]:.3f}", f"{zs[-1]:.3f}"]
        ds.PixelSpacing = [f"{Z_STEP}", f"{PS}"]
        ds.SliceThickness = f"{4 * PS:.1f}"
        img = vol[j, :, ::-1].T  # (z from top, x)
        files.append(write(ds, img, f"coronal_{k + 1:03d}.dcm"))

    # lateral scout: projection along x, shown like a lateral radiograph
    mu = np.clip((vol + 1000) / 1000, 0, None) * 0.02 * PS  # attenuation per voxel
    proj = mu.sum(axis=1)[:, ::-1].T  # (z from top, y)
    scout = (proj / proj.max()) * 2200 - 1000 + RNG.normal(0, 6, proj.shape)
    ds = base_dataset(1, "Scout lateral", uid("scout", 0), uid("scout"), 1)
    ds.ImageType = ["ORIGINAL", "PRIMARY", "LOCALIZER"]
    ds.ImageOrientationPatient = [0, 1, 0, 0, 0, -1]
    ds.ImagePositionPatient = ["0", f"{ys[0]:.3f}", f"{zs[-1]:.3f}"]
    ds.PixelSpacing = [f"{Z_STEP}", f"{PS}"]
    ds.WindowCenter = ["300"]
    ds.WindowWidth = ["2400"]
    ds.WindowCenterWidthExplanation = ["SCOUT"]
    files.append(write(ds, scout, "scout_001.dcm"))

    (OUT / "manifest.json").write_text(json.dumps({
        "description": "Synthetic head CT phantom (no real patient data)",
        "files": files,
    }, indent=1))
    size = sum((OUT / f).stat().st_size for f in files)
    print(f"{len(files)} files, {size / 1e6:.1f} MB in {OUT}")


if __name__ == "__main__":
    main()
