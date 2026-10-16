"""Build a local library of real, de-identified studies for end-to-end tests.

Source: the public DICOMweb server of the OHIF viewer demo
(https://viewer.ohif.org), which serves de-identified studies, mostly from The
Cancer Imaging Archive (TCIA, CC BY licences). The server provides metadata
and pixel frames (not whole files), so each instance is rebuilt as a DICOM
Part 10 file: header from the metadata, pixel data from the frames in the
transfer syntax the server returns.

Data are only used locally for tests: never committed or bundled.

    python -I test/tools/fetch_library.py [target folder]

Writes <target>/<name>/<n>.dcm, a few series also as <name>.zip (the ZIP
import path), and manifest.json.
"""
import gzip
import json
import re
import sys
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pydicom
from pydicom.datadict import dictionary_VR
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.filewriter import correct_ambiguous_vr
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian, UID

BASE = "https://d14fa38qiwhyfd.cloudfront.net/dicomweb"

# (name, study description pattern, modality, max instances, zip?)
WANTED = [
    ("ct_chest", r"CT CHEST W/ CONT", "CT", 400, True),
    ("ct_thorax", r"^CT Thorax$", "CT", 300, False),
    ("pt_wholebody", r"WB PET/CT", "PT", 400, False),
    ("ct_petct", r"WB PET/CT", "CT", 400, False),
    ("mr_head_tumor", r"MR HEAD W AND WO IV CONTRAST", "MR", 220, True),
    ("mr_prostate", r"MRI Prostate ERC", "MR", 120, False),
    ("mg_mammo", r"Digital Diagnostic Mammogram Bilateral", "MG", 6, False),
    ("cr_chest", r"CHEST AP VIEWONLY", "CR", 2, False),
    ("dx_thorax", r"Thorax \(kl\.\)", "DX", 2, False),
    ("dx_abdomen", r"XR_RF AbdPelvis", "DX", 15, False),
    ("xa_biopsy", r"XR_Biopsy_BoneMarrow", "XA", 4, False),
    ("nm_datscan", r"DATSCAN", "NM", 6, False),
    ("us_pelvis", r"US PELVIS", "US", 60, True),
    ("us_misc", r"^$", "US", 20, False),
    ("mr_liver", r"abdomen\^liver", "MR", 4, False),
    ("rtdose", r"NECK/AXA", "RTDOSE", 2, False),
    ("ot_testpattern", r"Luminance 1K", "OT", 25, False),
    ("op_ophthalmic", r"^$", "OP", 17, False),
]


def get(url, accept="application/dicom+json"):
    req = urllib.request.Request(url, headers={"Accept": accept, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
        ctype = r.headers.get("Content-Type", "")
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data, ctype


def multipart(data, ctype):
    """parts of a multipart/related body: [(headers, bytes)]"""
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    if m:
        boundary = b"--" + m.group(1).encode()
    elif data.startswith(b"--"):
        # boundary missing from the header: take it from the first line
        boundary = data.split(b"\r\n", 1)[0]
    else:
        return [({}, data)]
    parts = []
    for chunk in data.split(boundary)[1:]:
        if chunk.startswith(b"--"):
            break
        head, _, body = chunk.partition(b"\r\n\r\n")
        headers = {}
        for line in head.decode("latin-1").strip().splitlines():
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        if body.endswith(b"\r\n"):
            body = body[:-2]
        parts.append((headers, body))
    return parts


def transfer_syntax(headers):
    ct = headers.get("content-type", "")
    m = re.search(r"transfer-syntax=([0-9.]+)", ct)
    if m:
        return m.group(1)
    if "jls" in ct:
        return "1.2.840.10008.1.2.4.80"
    if "jp2" in ct or "jpx" in ct:
        return "1.2.840.10008.1.2.4.90"
    if "jphc" in ct:
        return "1.2.840.10008.1.2.4.201"
    if "jpeg" in ct:
        return "1.2.840.10008.1.2.4.50"
    return ExplicitVRLittleEndian


def fill_vr(obj):
    """static DICOMweb metadata sometimes omits "vr": take it from the dictionary"""
    for tag, el in obj.items():
        if not isinstance(el, dict):
            continue
        if "vr" not in el:
            try:
                el["vr"] = dictionary_VR(int(tag, 16)).split(" or ")[0]
            except KeyError:
                el["vr"] = "UN" if "BulkDataURI" in el or "InlineBinary" in el else "LO"
        if el["vr"] in ("UN", "OB", "OW") and isinstance(el.get("Value"), list):
            # text values labelled as binary (private tags): keep them as text
            el["vr"] = "LO" if all(isinstance(v, str) for v in el["Value"]) else "UN"
            if el["vr"] == "UN":
                del el["Value"]
        if el["vr"] == "SQ":
            for item in el.get("Value") or []:
                fill_vr(item)
    return obj


def rebuild(meta_json, study, series, out_path):
    def no_bulk(*_):
        return b""
    ds = Dataset.from_json(fill_vr(meta_json), bulk_data_uri_handler=no_bulk)
    def tidy(d):
        for tag in list(d.keys()):
            el = d[tag]
            if el.VR == "SQ":
                for item in el.value or []:
                    tidy(item)
            elif "|" in el.VR or " or " in el.VR:
                signed = int(ds.get("PixelRepresentation", 0) or 0) == 1
                el.VR = "SS" if "SS" in el.VR and signed else el.VR.replace(" or ", "|").split("|")[0]
                if isinstance(el.value, (bytes, bytearray)) and el.VR in ("US", "SS") and len(el.value) >= 2:
                    el.value = int.from_bytes(el.value[:2], "little", signed=el.VR == "SS")
            elif el.VR in ("OB", "OW", "UN") and tag != 0x7FE00010:
                if not el.value:
                    del d[tag]
                elif isinstance(el.value, str) or (isinstance(el.value, list) and el.value and isinstance(el.value[0], str)):
                    el.VR = "LO"  # text labelled as binary (private tags)
    tidy(ds)
    correct_ambiguous_vr(ds, True)
    sop = ds.SOPInstanceUID
    frames = int(ds.get("NumberOfFrames", 1) or 1)
    data, ctype = get(f"{BASE}/studies/{study}/series/{series}/instances/{sop}/frames/{','.join(str(i + 1) for i in range(frames))}",
                      'multipart/related; type="application/octet-stream"; transfer-syntax=*')
    parts = multipart(data, ctype)
    ts = transfer_syntax(parts[0][0])
    pixel_frames = [p[1] for p in parts]
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = ds.SOPClassUID
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = UID(ts)
    meta.ImplementationClassUID = UID("1.2.826.0.1.3680043.10.1491.1")
    ds.file_meta = meta
    if "PixelData" in ds:
        del ds["PixelData"]
    if UID(ts).is_compressed:
        ds.add_new(0x7FE00010, "OB", encapsulate(pixel_frames))
    else:
        raw = b"".join(pixel_frames)
        if len(raw) % 2:
            raw += b"\0"
        ds.add_new(0x7FE00010, "OW" if int(ds.get("BitsAllocated", 16)) > 8 else "OB", raw)
    if UID(ts) == ImplicitVRLittleEndian:
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
    try:
        ds.save_as(out_path, enforce_file_format=True)
    except Exception:
        # some private elements do not survive the JSON round trip: drop them
        Path(out_path).unlink(missing_ok=True)
        ds.remove_private_tags()
        def strip(d):
            for el in d:
                if el.VR == "SQ":
                    for item in el.value or []:
                        item.remove_private_tags()
                        strip(item)
        strip(ds)
        try:
            ds.save_as(out_path, enforce_file_format=True)
        except Exception:
            Path(out_path).unlink(missing_ok=True)
            raise
    return ts


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "library"
    target.mkdir(parents=True, exist_ok=True)
    studies = json.loads(get(f"{BASE}/studies")[0])
    manifest = []
    used = set()
    for name, pattern, modality, max_n, make_zip in WANTED:
        folder = target / name
        done = sorted(folder.glob("*.dcm")) if folder.exists() else []
        if done:
            print("have", name, len(done), flush=True)
            manifest.append({"name": name, "modality": modality, "files": len(done), "zip": make_zip})
            continue
        choice = None
        for st in studies:
            desc = (st.get("00081030", {}).get("Value") or [""])[0]
            mods = st.get("00080061", {}).get("Value") or []
            uid = st["0020000D"]["Value"][0]
            if modality not in mods or not re.search(pattern, desc) or (uid, modality) in used:
                continue
            series = json.loads(get(f"{BASE}/studies/{uid}/series")[0])
            for se in series:
                m = (se.get("00080060", {}).get("Value") or [""])[0]
                n = (se.get("00201209", {}).get("Value") or [0])[0]
                if m == modality and 0 < int(n) <= max_n and (not choice or int(n) > choice[2]):
                    choice = (uid, se["0020000E"]["Value"][0], int(n), desc)
            if choice:
                used.add((uid, modality))
                break
        if not choice:
            print("skip", name, "(not found)", flush=True)
            continue
        study, series, n, desc = choice
        print(f"fetching {name}: {n} instances of {modality} '{desc}'", flush=True)
        folder.mkdir(exist_ok=True)
        meta = json.loads(get(f"{BASE}/studies/{study}/series/{series}/metadata")[0])

        def one(args):
            i, item = args
            try:
                return rebuild(item, study, series, folder / f"{i + 1:04d}.dcm")
            except Exception as e:  # keep going, report
                return f"error: {e}"

        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(one, enumerate(meta)))
        errors = [r for r in results if r.startswith("error")]
        tss = sorted({r for r in results if not r.startswith("error")})
        print(f"  {len(results) - len(errors)} files, transfer syntaxes {tss}, {len(errors)} errors {errors[:2]}", flush=True)
        if make_zip:
            with zipfile.ZipFile(target / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(folder.glob("*.dcm")):
                    z.write(f, f"{name}/DICOM/{f.stem}")
        manifest.append({"name": name, "modality": modality, "description": desc, "files": len(results) - len(errors),
                         "transferSyntaxes": tss, "zip": make_zip})
    (target / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} series in {target}")


if __name__ == "__main__":
    main()
