#!/usr/bin/env python3
"""
App Store Connect API Client
Automates metadata update, screenshot uploads, build attachment, and App Store review submission.
"""

import os
import sys
import time
import json
import hashlib
from pathlib import Path
import jwt
import requests

BASE_URL = "https://api.appstoreconnect.apple.com/v1"

def get_token():
    key_id = os.environ.get("ASC_KEY_ID")
    issuer_id = os.environ.get("ASC_ISSUER_ID")
    private_key = os.environ.get("ASC_KEY_P8")

    if not key_id or not issuer_id or not private_key:
        print("ERROR: ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_P8 environment variables are required.")
        sys.exit(1)

    private_key = private_key.replace("\\n", "\n").strip()
    if not private_key.startswith("-----BEGIN"):
        private_key = f"-----BEGIN PRIVATE KEY-----\n{private_key}\n-----END PRIVATE KEY-----"

    now = int(time.time())
    headers = {"kid": key_id, "typ": "JWT", "alg": "ES256"}
    payload = {
        "iss": issuer_id,
        "iat": now,
        "exp": now + 1200,
        "aud": "appstoreconnect-v1"
    }
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)

class AppStoreClient:
    def __init__(self):
        self.token = get_token()
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        })

    def request(self, method, endpoint, data=None, params=None):
        url = f"{BASE_URL}/{endpoint}" if not endpoint.startswith("http") else endpoint
        res = self.session.request(method, url, json=data, params=params)
        if res.status_code >= 400:
            print(f"[{method}] {url} failed ({res.status_code}):")
            try:
                print(json.dumps(res.json(), indent=2))
            except Exception:
                print(res.text)
            res.raise_for_status()
        if res.status_code == 204 or not res.text:
            return None
        return res.json()

    def get_app(self, bundle_id="app.dicomreader.viewer"):
        data = self.request("GET", "apps", params={"filter[bundleId]": bundle_id})
        items = data.get("data", [])
        if not items:
            raise RuntimeError(f"App with bundleId '{bundle_id}' not found in App Store Connect.")
        app = items[0]
        print(f"Found app: {app['attributes']['name']} (ID: {app['id']})")
        return app

    def get_builds(self, app_id):
        data = self.request("GET", f"apps/{app_id}/builds", params={"limit": 10})
        builds = data.get("data", [])
        builds = sorted(builds, key=lambda b: b.get("attributes", {}).get("uploadedDate") or "", reverse=True)
        print(f"Found {len(builds)} builds for app.")
        for b in builds:
            attrs = b["attributes"]
            print(f" - Build ID: {b['id']}, Version: {attrs.get('version')}, State: {attrs.get('processingState')}, Uploaded: {attrs.get('uploadedDate')}")
        return builds

    def get_latest_valid_build(self, app_id, max_wait_seconds=900):
        start = time.time()
        while True:
            builds = self.get_builds(app_id)
            if not builds:
                print("No builds uploaded yet.")
                return None
            latest = builds[0]
            state = latest["attributes"].get("processingState")
            if state == "VALID":
                print(f"Latest build {latest['id']} (version {latest['attributes'].get('version')}) is VALID and ready.")
                return latest
            elif state == "PROCESSING":
                elapsed = int(time.time() - start)
                if elapsed >= max_wait_seconds:
                    print(f"Timed out after {elapsed}s waiting for build processing.")
                    return None
                print(f"Build {latest['id']} is still PROCESSING. Waiting 30s... ({elapsed}s elapsed)")
                time.sleep(30)
            else:
                print(f"Latest build has state: {state}")
                # check if any other recent build is valid
                for b in builds:
                    if b["attributes"].get("processingState") == "VALID":
                        print(f"Using earlier valid build {b['id']} (version {b['attributes'].get('version')})")
                        return b
                return None

    def get_or_create_version(self, app_id, version_string="1.0"):
        data = self.request("GET", f"apps/{app_id}/appStoreVersions", params={"filter[platform]": "IOS"})
        versions = data.get("data", [])
        for v in versions:
            attrs = v["attributes"]
            state = attrs.get("appStoreState")
            v_str = attrs.get("versionString")
            print(f"Existing version {v_str}: state={state} (ID: {v['id']})")
            if state in ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED"]:
                return v
            if state in ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_APPLE_RELEASE", "READY_FOR_SALE"]:
                print(f"Version {v_str} is already submitted (state: {state})!")
                return v

        print(f"Creating new App Store Version {version_string}...")
        payload = {
            "data": {
                "type": "appStoreVersions",
                "attributes": {
                    "platform": "IOS",
                    "versionString": version_string
                },
                "relationships": {
                    "app": {
                        "data": {
                            "type": "apps",
                            "id": app_id
                        }
                    }
                }
            }
        }
        res = self.request("POST", "appStoreVersions", data=payload)
        return res["data"]

    def update_localization(self, version_id, metadata, locale="en-US"):
        data = self.request("GET", f"appStoreVersions/{version_id}/appStoreVersionLocalizations")
        locs = data.get("data", [])
        loc = next((l for l in locs if l["attributes"]["locale"] == locale), None)

        payload_attrs = {
            "description": metadata["description"],
            "keywords": metadata["keywords"],
            "promotionalText": metadata.get("promotionalText", ""),
            "supportUrl": metadata["supportUrl"],
            "marketingUrl": metadata.get("marketingUrl", metadata["supportUrl"])
        }

        if loc:
            loc_id = loc["id"]
            print(f"Updating existing {locale} localization (ID: {loc_id})...")
            payload = {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": loc_id,
                    "attributes": payload_attrs
                }
            }
            res = self.request("PATCH", f"appStoreVersionLocalizations/{loc_id}", data=payload)
            return res["data"]
        else:
            print(f"Creating {locale} localization...")
            payload = {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "attributes": {
                        "locale": locale,
                        **payload_attrs
                    },
                    "relationships": {
                        "appStoreVersion": {
                            "data": {
                                "type": "appStoreVersions",
                                "id": version_id
                            }
                        }
                    }
                }
            }
            res = self.request("POST", "appStoreVersionLocalizations", data=payload)
            return res["data"]

    def update_review_detail(self, version_id, notes):
        data = self.request("GET", f"appStoreVersions/{version_id}/appStoreReviewDetail")
        detail = data.get("data")
        payload_attrs = {
            "notes": notes,
            "demoAccountRequired": False
        }
        fallback_contact = {
            "contactFirstName": os.environ.get("ASC_CONTACT_FIRST_NAME", "Noah"),
            "contactLastName": os.environ.get("ASC_CONTACT_LAST_NAME", "Lim"),
            "contactEmail": os.environ.get("ASC_CONTACT_EMAIL", "noahlimjj@gmail.com"),
            "contactPhone": os.environ.get("ASC_CONTACT_PHONE", "+65 9123 4567")
        }
        if detail:
            d_id = detail["id"]
            existing = detail.get("attributes", {})
            if not existing.get("contactEmail"):
                payload_attrs.update(fallback_contact)
            print(f"Updating App Review Detail (ID: {d_id})...")
            payload = {
                "data": {
                    "type": "appStoreReviewDetails",
                    "id": d_id,
                    "attributes": payload_attrs
                }
            }
            res = self.request("PATCH", f"appStoreReviewDetails/{d_id}", data=payload)
            return res["data"]
        else:
            print("Creating App Review Detail...")
            payload_attrs.update(fallback_contact)
            payload = {
                "data": {
                    "type": "appStoreReviewDetails",
                    "attributes": payload_attrs,
                    "relationships": {
                        "appStoreVersion": {
                            "data": {
                                "type": "appStoreVersions",
                                "id": version_id
                            }
                        }
                    }
                }
            }
            res = self.request("POST", "appStoreReviewDetails", data=payload)
            return res["data"]


    def attach_build(self, version_id, build_id):
        print(f"Attaching build {build_id} to version {version_id}...")
        payload = {
            "data": {
                "type": "appStoreVersions",
                "id": version_id,
                "relationships": {
                    "build": {
                        "data": {
                            "type": "builds",
                            "id": build_id
                        }
                    }
                }
            }
        }
        return self.request("PATCH", f"appStoreVersions/{version_id}", data=payload)

    def upload_screenshot_file(self, set_id, file_path):
        p = Path(file_path)
        file_bytes = p.read_bytes()
        file_size = len(file_bytes)
        file_name = p.name
        checksum = hashlib.md5(file_bytes).hexdigest()

        print(f"   Creating screenshot reservation for {file_name} ({file_size} bytes)...")
        payload = {
            "data": {
                "type": "appScreenshots",
                "attributes": {
                    "fileName": file_name,
                    "fileSize": file_size
                },
                "relationships": {
                    "appScreenshotSet": {
                        "data": {
                            "type": "appScreenshotSets",
                            "id": set_id
                        }
                    }
                }
            }
        }
        res = self.request("POST", "appScreenshots", data=payload)
        shot_id = res["data"]["id"]
        upload_ops = res["data"]["attributes"].get("uploadOperations", [])

        for op in upload_ops:
            url = op["url"]
            offset = op["offset"]
            length = op["length"]
            chunk = file_bytes[offset:offset+length]
            headers = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
            put_res = requests.put(url, data=chunk, headers=headers)
            if put_res.status_code not in [200, 204]:
                raise RuntimeError(f"Chunk upload failed ({put_res.status_code}): {put_res.text}")

        # Commit upload
        commit_payload = {
            "data": {
                "type": "appScreenshots",
                "id": shot_id,
                "attributes": {
                    "uploaded": True,
                    "sourceFileChecksum": checksum
                }
            }
        }
        self.request("PATCH", f"appScreenshots/{shot_id}", data=commit_payload)
        print(f"   ✓ Uploaded and committed {file_name}")

    def upload_screenshots_for_loc(self, loc_id, screenshots_dir):
        s_dir = Path(screenshots_dir)
        if not s_dir.exists():
            print(f"Screenshots dir {s_dir} not found. Skipping screenshot upload.")
            return

        display_mappings = {
            "APP_IPHONE_69": ["iphone-6.9-1-start.png", "iphone-6.9-2-measure.png", "iphone-6.9-3-two-views.png", "iphone-6.9-4-coronal.png", "iphone-6.9-5-series.png"],
            "APP_IPHONE_65": ["iphone-6.5-1-start.png", "iphone-6.5-2-measure.png", "iphone-6.5-3-two-views.png", "iphone-6.5-4-coronal.png", "iphone-6.5-5-series.png"],
            "APP_IPAD_PRO_3GEN_129": ["ipad-13-1-start.png", "ipad-13-2-measure.png", "ipad-13-3-two-views.png", "ipad-13-4-coronal.png", "ipad-13-5-series.png"]
        }

        # Fetch existing screenshot sets
        sets_data = self.request("GET", f"appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
        existing_sets = {s["attributes"]["screenshotDisplayType"]: s for s in sets_data.get("data", [])}

        for display_type, file_list in display_mappings.items():
            print(f"\nProcessing screenshot set for {display_type}...")
            if display_type in existing_sets:
                set_obj = existing_sets[display_type]
            else:
                print(f"Creating screenshot set for {display_type}...")
                create_payload = {
                    "data": {
                        "type": "appScreenshotSets",
                        "attributes": {
                            "screenshotDisplayType": display_type
                        },
                        "relationships": {
                            "appStoreVersionLocalization": {
                                "data": {
                                    "type": "appStoreVersionLocalizations",
                                    "id": loc_id
                                }
                            }
                        }
                    }
                }
                set_obj = self.request("POST", "appScreenshotSets", data=create_payload)["data"]

            set_id = set_obj["id"]

            # Check existing screenshots in set
            current_shots = self.request("GET", f"appScreenshotSets/{set_id}/appScreenshots").get("data", [])
            existing_names = {s["attributes"]["fileName"] for s in current_shots if "fileName" in s.get("attributes", {})}
            if len(existing_names) >= len(file_list):
                print(f"Set {display_type} already has {len(existing_names)} screenshots. Skipping re-upload.")
                continue

            for fname in file_list:
                if fname in existing_names:
                    print(f"   Screenshot {fname} already in {display_type}. Skipping.")
                    continue
                fpath = s_dir / fname
                if fpath.exists():
                    self.upload_screenshot_file(set_id, fpath)
                else:
                    print(f"Warning: {fpath} not found.")

    def submit_for_review(self, app_id, version_id):
        print("\nStarting App Review Submission...")
        subs_data = self.request("GET", f"apps/{app_id}/reviewSubmissions", params={"filter[platform]": "IOS"})
        active_sub = next((s for s in subs_data.get("data", []) if s["attributes"].get("state") in ["READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW"]), None)
        if active_sub:
            sub_id = active_sub["id"]
            state = active_sub["attributes"].get("state")
            print(f"Found active review submission container: {sub_id} (state: {state})")
            if state in ["WAITING_FOR_REVIEW", "IN_REVIEW"]:
                print(f"App version is already submitted to Apple! Current state: {state}")
                return active_sub
        else:
            payload = {
                "data": {
                    "type": "reviewSubmissions",
                    "attributes": {
                        "platform": "IOS"
                    },
                    "relationships": {
                        "app": {
                            "data": {
                                "type": "apps",
                                "id": app_id
                            }
                        }
                    }
                }
            }
            sub_res = self.request("POST", "reviewSubmissions", data=payload)
            sub_id = sub_res["data"]["id"]
            print(f"Created review submission container: {sub_id}")

        items_data = self.request("GET", f"reviewSubmissions/{sub_id}/items")
        has_version = any(
            item.get("relationships", {}).get("appStoreVersion", {}).get("data", {}).get("id") == version_id
            for item in items_data.get("data", [])
        )
        if not has_version:
            item_payload = {
                "data": {
                    "type": "reviewSubmissionItems",
                    "relationships": {
                        "reviewSubmission": {
                            "data": {
                                "type": "reviewSubmissions",
                                "id": sub_id
                            }
                        },
                        "appStoreVersion": {
                            "data": {
                                "type": "appStoreVersions",
                                "id": version_id
                            }
                        }
                    }
                }
            }
            self.request("POST", "reviewSubmissionItems", data=item_payload)
            print(f"Added App Store Version {version_id} to review submission.")

        submit_payload = {
            "data": {
                "type": "reviewSubmissions",
                "id": sub_id,
                "attributes": {
                    "submitted": True
                }
            }
        }
        final_res = self.request("PATCH", f"reviewSubmissions/{sub_id}", data=submit_payload)
        state = final_res["data"]["attributes"].get("state")
        print(f"🎉 Successfully submitted for App Review! Current state: {state}")
        return final_res["data"]

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    client = AppStoreClient()
    app = client.get_app()
    app_id = app["id"]

    if mode == "status":
        print("\n--- APP STATUS ---")
        client.get_builds(app_id)
        versions_data = client.request("GET", f"apps/{app_id}/appStoreVersions", params={"filter[platform]": "IOS"})
        for v in versions_data.get("data", []):
            print(f"Version: {v['attributes']['versionString']} | State: {v['attributes']['appStoreState']} | ID: {v['id']}")
        return

    # Metadata content
    metadata = {
        "promotionalText": "High-performance, offline DICOM viewer for personal medical imaging. Fast CT, MRI, and X-ray inspection with zero tracking.",
        "description": (
            "DICOM Mobile is a fast, secure, and private medical image viewer built specifically for your iPhone and iPad. "
            "Easily open, inspect, and analyze your own medical scans directly on your device without uploading anything to the cloud.\n\n"
            "KEY FEATURES:\n"
            "• High-Performance Volume Navigation: Smoothly scroll through hundreds of CT and MRI slices with instantaneous loading and fluid scrubber controls.\n"
            "• True Scout / Localizer Synchronization: Interactive reference lines show exact cross-sectional levels across axial, sagittal, and coronal planes. Tap or scrub the scout to jump across slices in real time.\n"
            "• Interactive Two-View Layout: Inspect companion views side by side (e.g., Scout next to Axial or Sagittal next to Coronal) with synchronized crosshair locators.\n"
            "• Precision Measurement Tools: Calibrated distance measurements, elliptical ROI statistics (area, mean, min/max HU, standard deviation), and Cobb angles.\n"
            "• Comprehensive DICOM Format Support: Uncompressed, RLE, JPEG Baseline/Lossless, JPEG 2000, and JPEG-LS. Supports multi-frame series and dynamic cine playback.\n"
            "• 100% Private & Offline: All image parsing and rendering happens locally on your device. No user accounts, no analytics, no third-party tracking, and zero cloud uploads.\n"
            "• Flexible Import: Open files directly from the Files app, iCloud Drive, Google Drive, AirDrop, or local ZIP archives.\n\n"
            "DISCLAIMER:\n"
            "DICOM Mobile is designed for personal reference, research, and educational purposes. It is not intended for primary diagnostic interpretation or clinical treatment planning."
        ),
        "keywords": "dicom,dicom viewer,ct scan,mri,xray,medical imaging,radiology,pacs,scout localizer,medical viewer",
        "supportUrl": "https://noahlimjj.github.io/dicomreader/",
        "marketingUrl": "https://noahlimjj.github.io/dicomreader/"
    }

    review_notes = (
        "DICOM Mobile is a personal medical image viewer designed exclusively for educational, reference, and informational viewing of personal DICOM files.\n\n"
        "1. All image decoding and measurements are performed strictly locally on the user's device (no servers, no cloud storage, no network transmission of patient files).\n"
        "2. The application does not provide automated diagnostic recommendations, automated pathology detection, or treatment algorithms.\n"
        "3. Prominent disclaimers are visible within the application confirming it is not intended for primary diagnostic use.\n"
        "4. Testing: A built-in synthetic phantom scan is accessible by tapping 'Open sample study' on the home screen."
    )

    # 1. Version
    version_obj = client.get_or_create_version(app_id, version_string="1.0")
    version_id = version_obj["id"]
    current_version_state = version_obj["attributes"].get("appStoreState")
    if current_version_state in ["WAITING_FOR_REVIEW", "IN_REVIEW"]:
        print(f"🎉 Version 1.0 is already in state '{current_version_state}'. No further submission action needed!")
        return

    # 2. Update localization metadata
    loc_obj = client.update_localization(version_id, metadata, locale="en-US")
    loc_id = loc_obj["id"]

    # 3. Update review detail notes
    client.update_review_detail(version_id, review_notes)

    # 4. Upload screenshots
    screenshots_path = Path("app/store/screenshots")
    if not screenshots_path.exists() and Path("store/screenshots").exists():
        screenshots_path = Path("store/screenshots")
    client.upload_screenshots_for_loc(loc_id, screenshots_path)

    # 5. Attach latest valid build
    build = client.get_latest_valid_build(app_id, max_wait_seconds=900)
    if build:
        client.attach_build(version_id, build["id"])
    else:
        # Check if version already has a build attached
        v_info = client.request("GET", f"appStoreVersions/{version_id}/build")
        if v_info and v_info.get("data"):
            build = v_info["data"]
            print(f"Version already has build {build['id']} attached.")
        else:
            print("WARNING: No valid build found to attach. You can attach it once processing completes.")

    # 6. Submit for review if requested
    if mode == "submit":
        if not build:
            print("ERROR: Cannot submit for review without an attached valid build.")
            sys.exit(1)
        client.submit_for_review(app_id, version_id)
    else:
        print("\nAll metadata, screenshots, and build have been configured in App Store Connect!")
        print("Ready for submission. Run with mode 'submit' to submit for Apple review.")

if __name__ == "__main__":
    main()
