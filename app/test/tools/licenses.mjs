// Collects the licence texts of everything bundled into the app -> public/licenses.txt
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = ['DICOM Mobile uses the following open source software.\n'];
const seen = new Set();
function add(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const dir = join('node_modules', name);
  if (!existsSync(dir)) return;
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lic = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  out.push(`\n==== ${name} ${p.version} (${p.license || 'see below'}) ====\n${p.homepage || ''}\n`);
  if (lic) out.push(readFileSync(join(dir, lic), 'utf8'));
  for (const d of Object.keys(p.dependencies || {})) add(d);
}
for (const d of Object.keys(pkg.dependencies)) add(d);
out.push('\n==== pdf.js JPEG decoder (src/vendor/jpeg12.js) ====\nCopyright Mozilla Foundation. Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0\n');
out.push('\n==== Native codec libraries compiled to WebAssembly ====\nOpenJPEG (BSD 2-clause), CharLS (BSD 3-clause), libjpeg-turbo (IJG and BSD 3-clause licences; this software is based in part on the work of the Independent JPEG Group), OpenJPH (BSD 2-clause).\n');
out.push('\n==== DICOM data dictionary (public/dicom-dict.json) ====\nGenerated from pydicom (MIT licence, https://github.com/pydicom/pydicom), based on the DICOM Standard (NEMA).\n');
writeFileSync('public/licenses.txt', out.join(''));
console.log(`${seen.size} packages -> public/licenses.txt`);
