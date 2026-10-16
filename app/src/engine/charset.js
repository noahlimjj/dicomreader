// Text decoding for DICOM Specific Character Set (0008,0005).

const SINGLE_BYTE = {
  '': 'windows-1252',
  ISO_IR_6: 'windows-1252',
  ISO_IR_100: 'windows-1252',
  ISO_IR_101: 'iso-8859-2',
  ISO_IR_109: 'iso-8859-3',
  ISO_IR_110: 'iso-8859-4',
  ISO_IR_144: 'iso-8859-5',
  ISO_IR_127: 'iso-8859-6',
  ISO_IR_126: 'iso-8859-7',
  ISO_IR_138: 'iso-8859-8',
  ISO_IR_148: 'iso-8859-9',
  ISO_IR_203: 'iso-8859-15',
  ISO_IR_166: 'windows-874',
  ISO_IR_13: 'shift_jis',
  ISO_IR_192: 'utf-8',
  GB18030: 'gb18030',
  GBK: 'gbk',
};

const decoders = new Map();
function decoder(label) {
  if (!decoders.has(label)) {
    let d;
    try {
      d = new TextDecoder(label);
    } catch {
      d = new TextDecoder('windows-1252');
    }
    decoders.set(label, d);
  }
  return decoders.get(label);
}

function normalise(term) {
  return term.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

// Converted to EUC-JP and decoded in one go: browsers' iso-2022-jp decoders
// reject the 8-bit katakana that DICOM's ISO 2022 IR 13 uses.
export function decodeIso2022(bytes) {
  const euc = [];
  let mode = 'ascii';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b === 0x1b) {
      const s = String.fromCharCode(bytes[i + 1] || 0, bytes[i + 2] || 0);
      if (s === '$B' || s === '$@') mode = 'jis0208';
      else if (s === '(B' || s === '(J') mode = 'ascii';
      else if (s === '(I') mode = 'kana7';
      else if (s === '$(' && bytes[i + 3] === 0x44) {
        mode = 'jis0212';
        i += 4;
        continue;
      }
      // ESC ) I designates katakana to G1: handled by the high bytes below
      i += 3;
      continue;
    }
    if (b >= 0xa1 && b <= 0xdf) {
      euc.push(0x8e, b); // half-width katakana
      i += 1;
      continue;
    }
    if (mode === 'jis0208' && b >= 0x21 && b <= 0x7e && i + 1 < bytes.length) {
      euc.push(b | 0x80, bytes[i + 1] | 0x80);
      i += 2;
      continue;
    }
    if (mode === 'jis0212' && b >= 0x21 && b <= 0x7e && i + 1 < bytes.length) {
      euc.push(0x8f, b | 0x80, bytes[i + 1] | 0x80);
      i += 2;
      continue;
    }
    if (mode === 'kana7' && b >= 0x21 && b <= 0x5f) {
      euc.push(0x8e, b | 0x80);
      i += 1;
      continue;
    }
    // component delimiters reset to the default character set
    if (b === 0x5e || b === 0x3d || b === 0x5c || b === 0x0d || b === 0x0a) mode = 'ascii';
    euc.push(b);
    i += 1;
  }
  const text = decoder('euc-jp').decode(new Uint8Array(euc));
  // half-width katakana / full-width latin -> normal forms
  return text.normalize('NFKC');
}

// ISO 2022 with a single G1 set (Korean, simplified Chinese): drop the escape
// sequences, the remaining bytes are plain EUC.
function decodeIso2022Euc(bytes, label) {
  const out = [];
  for (let i = 0; i < bytes.length; ++i) {
    if (bytes[i] === 0x1b) {
      // ESC $ ) C / ESC $ ) A / ESC ( B ...
      i += bytes[i + 1] === 0x24 ? 3 : 2;
      continue;
    }
    out.push(bytes[i]);
  }
  return decoder(label).decode(new Uint8Array(out));
}

/**
 * A function that turns the raw bytes of a text element into a string for the
 * given Specific Character Set value (backslash separated terms).
 */
export function textDecoderFor(specificCharacterSet) {
  const terms = (specificCharacterSet || '').split('\\').map(normalise);
  const all = terms.join(' ');
  if (/ISO_2022_IR_(87|159|13)\b/.test(all) && terms.some((t) => t.startsWith('ISO_2022'))) {
    return decodeIso2022;
  }
  if (/ISO_2022_IR_149/.test(all)) return (b) => decodeIso2022Euc(b, 'euc-kr');
  if (/ISO_2022_IR_58/.test(all)) return (b) => decodeIso2022Euc(b, 'gbk');
  const first = (terms.find(Boolean) || '').replace(/^ISO_2022_/, 'ISO_');
  const label = SINGLE_BYTE[first] || 'windows-1252';
  const d = decoder(label);
  return (bytes) => d.decode(bytes);
}
