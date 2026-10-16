"""Download pydicom's public test files and write reference pixel data.

The app's decoders (src/engine) are checked against pydicom's output in
test/decode.test.js. Run once (and in CI) before `npm test`:

    python -m pip install pydicom numpy pylibjpeg pylibjpeg-libjpeg \
        pylibjpeg-openjpeg pylibjpeg-rle pyjpegls
    python -I test/tools/make_golden.py

Writes test/data/<name>.dcm and test/golden/<name>.json + .<frame>.bin
(both folders are git-ignored).
"""
import json
import shutil
import sys
import warnings
from pathlib import Path

import numpy as np
import pydicom
from pydicom.data import get_charset_files, get_testdata_file
from pydicom.pixels import apply_color_lut, pixel_array

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GOLDEN = ROOT / "golden"

FILES = [
    "CT_small.dcm", "MR_small.dcm", "MR_small_bigendian.dcm", "MR_small_RLE.dcm",
    "MR_small_jpeg_ls_lossless.dcm", "emri_small.dcm", "emri_small_RLE.dcm",
    "emri_small_jpeg_2k_lossless.dcm", "emri_small_jpeg_ls_lossless.dcm",
    "emri_small_big_endian.dcm", "JPEG-lossy.dcm", "JPEG-LL.dcm", "JPEG2000.dcm",
    "US1_J2KR.dcm", "US1_UNCR.dcm", "US1_J2KI.dcm", "SC_rgb.dcm", "SC_rgb_rle.dcm",
    "SC_rgb_jpeg_dcmtk.dcm", "SC_rgb_jpeg_gdcm.dcm", "SC_ybr_full_uncompressed.dcm",
    "SC_jpeg_no_color_transform.dcm", "SC_jpeg_no_color_transform_2.dcm",
    "SC_rgb_small_odd.dcm", "SC_rgb_small_odd_jpeg.dcm", "OBXXXX1A.dcm",
    "OBXXXX1A_rle.dcm", "OBXXXX1A_2frame.dcm", "rtdose.dcm", "image_dfl.dcm",
    "693_J2KR.dcm", "693_UNCR.dcm", "693_UNCI.dcm", "liver.dcm", "liver_1frame.dcm",
    "color3d_jpeg_baseline.dcm", "SC_rgb_2frame.dcm", "RG1_UNCI.dcm", "RG1_J2KR.dcm",
    "JLSL_08_07_0_1F.dcm", "JPGLosslessP14SV1_1s_1f_8b.dcm", "SC_rgb_32bit.dcm",
    "MR2_J2KR.dcm", "MR-SIEMENS-DICOM-WithOverlays.dcm", "GDCMJ2K_TextGBR.dcm",
    "HTJ2KLossless_08_RGB.dcm", "HTJ2K_08_RGB.dcm", "J2K_pixelrep_mismatch.dcm",
    "explicit_VR-UN.dcm", "ExplVR_BigEnd.dcm",
]

LOSSY = {
    "1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.91",
    "1.2.840.10008.1.2.4.81", "1.2.840.10008.1.2.4.203",
}


def frames_to_check(n):
    return sorted({0, n // 2, n - 1})


def main():
    DATA.mkdir(exist_ok=True)
    GOLDEN.mkdir(exist_ok=True)
    done = 0
    for name in FILES:
        try:
            src = get_testdata_file(name)
        except Exception as e:  # network trouble: skip, the test skips too
            print("skip (download)", name, e)
            continue
        if not src:
            print("skip (missing)", name)
            continue
        shutil.copy(src, DATA / name)
        ds = pydicom.dcmread(src)
        ts = str(ds.file_meta.TransferSyntaxUID)
        n = int(ds.get("NumberOfFrames", 1) or 1)
        photometric = str(ds.PhotometricInterpretation)
        frames = []
        for f in frames_to_check(n):
            try:
                arr = pixel_array(ds, index=f if n > 1 else None, as_rgb=True)
            except Exception as e:
                print("skip (pydicom cannot decode)", name, e)
                frames = None
                break
            if photometric == "PALETTE COLOR":
                arr = apply_color_lut(arr, ds)
                if arr.dtype != np.uint8:
                    arr = (arr >> 8).astype(np.uint8)
            if arr.ndim == 3 and arr.shape[-1] == 3:
                if arr.dtype != np.uint8:
                    bits = int(ds.BitsStored)
                    arr = (arr.astype(np.float64) * 255 / (2 ** bits - 1)).round().astype(np.uint8)
                kind = "rgb"
                out = np.ascontiguousarray(arr, dtype=np.uint8)
            else:
                kind = "mono"
                out = np.ascontiguousarray(arr, dtype=np.float64)
            (GOLDEN / f"{name}.{f}.bin").write_bytes(out.tobytes())
            frames.append({"index": f, "kind": kind, "shape": list(arr.shape)})
        if frames is None:
            continue
        def nums(kw):
            v = ds.get(kw)
            if v is None:
                return None
            return [float(x) for x in (v if isinstance(v, (list, pydicom.multival.MultiValue)) else [v])]

        def pn(v):
            groups = [" ".join(g.replace("^", " ").split()) for g in str(v or "").split("=")]
            out = []
            for g in groups:
                if g and g not in out:
                    out.append(g)
            return " / ".join(out)

        meta = {
            "name": name,
            "patientName": pn(ds.get("PatientName")),
            "modality": str(ds.get("Modality", "") or ""),
            "ipp": nums("ImagePositionPatient"),
            "iop": nums("ImageOrientationPatient"),
            "pixelSpacing": nums("PixelSpacing"),
            "slope": float(ds.get("RescaleSlope", 1) or 1),
            "intercept": float(ds.get("RescaleIntercept", 0) or 0),
            "windowCenter": nums("WindowCenter"),
            "transferSyntax": ts,
            "lossy": ts in LOSSY or str(ds.get("LossyImageCompression", "00")) == "01" and ts in LOSSY,
            "photometric": photometric,
            "rows": int(ds.Rows),
            "columns": int(ds.Columns),
            "frames": n,
            "checked": frames,
        }
        (GOLDEN / f"{name}.json").write_text(json.dumps(meta, indent=1))
        done += 1
    print(f"{done} reference files written to {GOLDEN}")
    return 0 if done else 1




CHARSET_FILES = [
    "chrArab.dcm", "chrFren.dcm", "chrFrenMulti.dcm", "chrGerm.dcm", "chrGreek.dcm", "chrH31.dcm",
    "chrH32.dcm", "chrHbrw.dcm", "chrI2.dcm", "chrJapMulti.dcm", "chrJapMultiExplicitIR6.dcm",
    "chrKoreanMulti.dcm", "chrRuss.dcm", "chrX1.dcm", "chrX2.dcm",
]


def charsets():
    """expected patient names for the character set test files"""
    out = {}
    for name in CHARSET_FILES:
        found = get_charset_files(name)
        if not found:
            continue
        src = found[0]
        shutil.copy(src, DATA / name)
        ds = pydicom.dcmread(src)
        groups = [" ".join(g.replace("^", " ").split()) for g in str(ds.get("PatientName", "")).split("=")]
        uniq = []
        for g in groups:
            if g and g not in uniq:
                uniq.append(g)
        out[name] = {"charset": list(ds.get("SpecificCharacterSet", []) if isinstance(ds.get("SpecificCharacterSet"), pydicom.multival.MultiValue) else [ds.get("SpecificCharacterSet", "")]),
                     "patientName": " / ".join(uniq)}
    (GOLDEN / "charsets.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} character set files")


if __name__ == "__main__":
    status = main()
    charsets()
    sys.exit(status)
