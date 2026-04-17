/**
 * Generates a PDF matching the docx design using pdf-lib.
 *
 * Uses Bona Nova (title + times) and Narkiss Text (Hebrew labels), both
 * embedded from /d/. Color #232140 throughout.
 *
 * Hebrew RTL handling: pdf-lib doesn't do bidi; we reverse Hebrew strings
 * before drawing. Works for pure-Hebrew content.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const COLOR = rgb(0x23 / 255, 0x21 / 255, 0x40 / 255);
const COLOR_RULE_LAST = rgb(0xaa / 255, 0xaa / 255, 0xaa / 255);
const COLOR_DARK = rgb(0x33 / 255, 0x33 / 255, 0x33 / 255);

const HEBREW_LABELS = {
  'erev_shabbos.mincha': 'מנחה ערב שבת',
  'shabbos.shacharis': 'שחרית',
  'shabbos.mincha': 'מנחה שבת',
  'motzei_shabbos.maariv': 'מעריב מוצאי שבת',
  'erev_yom_tov.mincha': 'מנחה ערב יום טוב',
  'erev_yom_tov.maariv': 'מעריב ליל יום טוב',
  'yom_tov.shacharis': 'שחרית יום טוב',
  'yom_tov.mincha': 'מנחה יום טוב',
  'yom_tov_continues.maariv': 'מעריב ליל יום טוב שני',
  'motzei_yom_tov.maariv': 'מעריב מוצאי יום טוב',
  'chol_hamoed.mincha': 'מנחה חול המועד',
};

const TAG_PRIORITY = [
  'erev_yom_tov', 'motzei_yom_tov', 'yom_tov_continues', 'yom_tov',
  'erev_shabbos', 'motzei_shabbos', 'shabbos', 'chol_hamoed',
];

/**
 * @param {object} opts
 * @param {object} opts.schedule
 * @param {Array}  opts.announcements
 * @param {Uint8Array} opts.logoData        PNG bytes (optional)
 * @param {Uint8Array} opts.hebrewFontData  Narkiss Text TTF/OTF (required)
 * @param {Uint8Array} opts.latinFontData   Bona Nova TTF (required)
 */
export async function generatePDF({
  schedule,
  announcements,
  logoData,
  hebrewFontData,
  latinFontData,
}) {
  if (!hebrewFontData) throw new Error('pdf-template: hebrewFontData required');
  if (!latinFontData) throw new Error('pdf-template: latinFontData required');

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontHebrew = await pdf.embedFont(hebrewFontData, { subset: false });
  const fontLatin = await pdf.embedFont(latinFontData, { subset: false });

  // Letter: 8.5" x 11" = 612 x 792 pt.
  const pageWidth = 612;
  const pageHeight = 792;
  const page = pdf.addPage([pageWidth, pageHeight]);

  const marginX = 90; // 1.25"

  let cursorY = pageHeight;

  // --- Logo header (full-width, edge-to-edge) ---
  if (logoData) {
    const logoImg = await pdf.embedPng(logoData);
    // Span ~8" wide (extending into margins).
    const logoWidth = pageWidth * 0.95;
    const logoHeight = (logoImg.height / logoImg.width) * logoWidth;
    const logoX = (pageWidth - logoWidth) / 2;
    const logoY = pageHeight - 18 - logoHeight; // 18pt from top
    page.drawImage(logoImg, {
      x: logoX,
      y: logoY,
      width: logoWidth,
      height: logoHeight,
    });
    cursorY = logoY - 30;
  } else {
    cursorY -= 80;
  }

  // --- Parsha title — Bona Nova 60pt ---
  const titleHe = stripNikud(schedule.parsha?.he || schedule.label || '');
  if (titleHe) {
    const titleSize = 52;
    cursorY -= titleSize;
    const w = fontHebrew.widthOfTextAtSize(titleHe, titleSize);
    page.drawText(titleHe, {
      x: (pageWidth - w) / 2,
      y: cursorY,
      size: titleSize,
      font: fontHebrew,
      color: COLOR,
    });
    cursorY -= 40;
  }

  // --- Times rows ---
  const rows = [];
  for (const day of schedule.days) {
    for (const minyan of ['shacharis', 'mincha', 'maariv']) {
      const info = day.times[minyan];
      if (!info) continue;
      rows.push({
        time: to12hShort(info.time),
        label: getHebrewLabel(day, minyan),
      });
    }
  }

  const rowHeight = 74;       // ~0.9"
  const timeSize = 36;
  const labelSize = 32;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isLast = i === rows.length - 1;

    // Vertical center of the row.
    const baseY = cursorY - rowHeight / 2 - timeSize / 3;

    // Time (Bona Nova, LEFT).
    page.drawText(row.time, {
      x: marginX,
      y: baseY,
      size: timeSize,
      font: fontLatin,
      color: COLOR,
    });

    // Hebrew label (Narkiss, RIGHT-aligned — logical order; PDF viewer handles RTL).
    const labelW = fontHebrew.widthOfTextAtSize(row.label, labelSize);
    page.drawText(row.label, {
      x: pageWidth - marginX - labelW,
      y: baseY,
      size: labelSize,
      font: fontHebrew,
      color: COLOR,
    });

    cursorY -= rowHeight;
    // Bottom rule.
    const ruleColor = isLast ? COLOR_RULE_LAST : COLOR;
    const ruleThickness = isLast ? 0.6 : 0.8;
    page.drawLine({
      start: { x: marginX, y: cursorY + 4 },
      end: { x: pageWidth - marginX, y: cursorY + 4 },
      thickness: ruleThickness,
      color: ruleColor,
    });
  }

  // --- Announcements ---
  if (announcements && announcements.length > 0) {
    cursorY -= 30;
    const annSize = 14;
    const maxWidth = pageWidth - 2 * marginX;
    for (const a of announcements) {
      const paragraphs = String(a.text).split(/\r?\n/);
      for (const paragraph of paragraphs) {
        const wrapped = wrapText(paragraph, fontLatin, annSize, maxWidth);
        for (const line of wrapped) {
          const w = fontLatin.widthOfTextAtSize(line, annSize);
          cursorY -= annSize + 6;
          page.drawText(line, {
            x: (pageWidth - w) / 2,
            y: cursorY,
            size: annSize,
            font: fontLatin,
            color: COLOR_DARK,
          });
        }
      }
    }
  }

  return pdf.save();
}

function getHebrewLabel(day, minyan) {
  for (const tag of TAG_PRIORITY) {
    if (day.tags.includes(tag)) {
      const key = `${tag}.${minyan}`;
      if (HEBREW_LABELS[key]) return HEBREW_LABELS[key];
    }
  }
  return { shacharis: 'שחרית', mincha: 'מנחה', maariv: 'מעריב' }[minyan] || minyan;
}

function to12hShort(hm) {
  if (!hm || !/^\d\d:\d\d$/.test(hm)) return hm || '';
  const [h, m] = hm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}`;
}

function stripNikud(s) {
  return String(s).replace(/[\u0591-\u05C7]/g, '');
}

function wrapText(text, font, size, maxWidth) {
  if (!text) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
    } else {
      // Word itself exceeds maxWidth — break by character.
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) {
          chunk = next;
        } else {
          if (chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      current = chunk;
    }
  }
  if (current) lines.push(current);
  return lines;
}
