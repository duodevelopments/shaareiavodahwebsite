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
 * @param {Uint8Array} opts.logoData        Wide banner PNG bytes (default layout, optional)
 * @param {Uint8Array} [opts.compactLogoData] Tall ark-icon PNG bytes (compact layout, optional)
 * @param {Uint8Array} opts.hebrewFontData  Narkiss Text TTF/OTF (required)
 * @param {Uint8Array} opts.latinFontData   Bona Nova TTF (required)
 * @param {object|null} [opts.layout]       Optional layout config; null/undefined → default layout.
 *        Compact: { mode: 'compact', title, sections: [{ title, subtitle, startDate, endDate }, ...] }
 */
export async function generatePDF({
  schedule,
  announcements,
  logoData,
  compactLogoData,
  hebrewFontData,
  latinFontData,
  layout,
}) {
  if (!hebrewFontData) throw new Error('pdf-template: hebrewFontData required');
  if (!latinFontData) throw new Error('pdf-template: latinFontData required');

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontHebrew = await pdf.embedFont(hebrewFontData, { subset: true });
  const fontLatin = await pdf.embedFont(latinFontData, { subset: true });
  const logoImg = logoData ? await pdf.embedPng(logoData) : null;
  const compactLogoImg = compactLogoData ? await pdf.embedPng(compactLogoData) : null;

  renderSchedulePage({
    pdf, fontHebrew, fontLatin, logoImg, compactLogoImg,
    schedule, announcements, layout,
  });

  return pdf.save();
}

/**
 * Render a single schedule page into an existing PDFDocument. Intended for
 * batch flows that embed fonts/logo once and add many pages.
 *
 * @param {object} opts
 * @param {import('pdf-lib').PDFDocument} opts.pdf
 * @param {*} opts.fontHebrew
 * @param {*} opts.fontLatin
 * @param {*} opts.logoImg     pdf-lib image handle, wide banner (default layout, optional)
 * @param {*} [opts.compactLogoImg] pdf-lib image handle, ark icon (compact layout, optional)
 * @param {object} opts.schedule
 * @param {Array}  opts.announcements
 * @param {object|null} [opts.layout]   Optional compact layout config; null → default
 */
export function renderSchedulePage({
  pdf,
  fontHebrew,
  fontLatin,
  logoImg,
  compactLogoImg,
  schedule,
  announcements,
  layout,
}) {
  if (layout && layout.mode === 'compact') {
    renderCompactSchedulePage({
      pdf, fontHebrew, fontLatin, logoImg: compactLogoImg,
      schedule, announcements, layout,
    });
    return;
  }
  // Letter: 8.5" x 11" = 612 x 792 pt.
  const pageWidth = 612;
  const pageHeight = 792;
  const page = pdf.addPage([pageWidth, pageHeight]);

  const marginX = 90; // 1.25"

  let cursorY = pageHeight;

  // --- Logo header (full-width, edge-to-edge) ---
  if (logoImg) {
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

  // Pre-wrap announcements so we know how much vertical space they need
  // before deciding whether to shrink the rows.
  const annSize = 14;
  const annLineHeight = annSize + 6;
  const annGap = 30;
  const annLines = [];
  if (announcements && announcements.length > 0) {
    const maxWidth = pageWidth - 2 * marginX;
    for (const a of announcements) {
      for (const paragraph of String(a.text).split(/\r?\n/)) {
        for (const line of wrapText(paragraph, fontLatin, annSize, maxWidth)) {
          annLines.push(line);
        }
      }
    }
  }
  const annBlockHeight = annLines.length > 0 ? annGap + annLines.length * annLineHeight : 0;

  // Auto-shrink rows to fit on a single page. Bottom margin keeps the last
  // rule off the page edge.
  const bottomMargin = 36;
  const availableForRows = cursorY - bottomMargin - annBlockHeight;

  const baseRowHeight = 74; // ~0.9"
  const baseTimeSize = 36;
  const baseLabelSize = 32;
  const requiredRowsHeight = rows.length * baseRowHeight;
  const scale = requiredRowsHeight > availableForRows && rows.length > 0
    ? Math.max(0.25, availableForRows / requiredRowsHeight)
    : 1;

  const rowHeight = baseRowHeight * scale;
  const timeSize = baseTimeSize * scale;
  const labelSize = baseLabelSize * scale;

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
    // Bottom rule (skip after the last row).
    if (!isLast) {
      page.drawLine({
        start: { x: marginX, y: cursorY + 4 },
        end: { x: pageWidth - marginX, y: cursorY + 4 },
        thickness: 0.8,
        color: COLOR,
      });
    }
  }

  // --- Announcements ---
  if (annLines.length > 0) {
    cursorY -= annGap;
    for (const line of annLines) {
      const w = fontLatin.widthOfTextAtSize(line, annSize);
      cursorY -= annLineHeight;
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

/**
 * Compact multi-section layout — small left logo, right-aligned title, sections
 * grouped by date range, no per-row rules. Used for long spans (Pesach, Sukkos)
 * where the default layout would overflow.
 *
 * Layout shape: { mode:'compact', title, sections:[{ title, subtitle, startDate, endDate }] }
 */
function renderCompactSchedulePage({
  pdf,
  fontHebrew,
  fontLatin,
  logoImg,
  schedule,
  announcements,
  layout,
}) {
  const pageWidth = 612;
  const pageHeight = 792;
  const page = pdf.addPage([pageWidth, pageHeight]);

  const marginX = 54; // 0.75"
  const logoColumnWidth = 70;
  const contentLeft = marginX + logoColumnWidth + 14;
  const contentRight = pageWidth - marginX;

  let topY = pageHeight - 30;

  // --- Logo (ark icon, top-left) + decorative vertical bar down the page ---
  if (logoImg) {
    const logoW = logoColumnWidth;
    const logoH = (logoImg.height / logoImg.width) * logoW;
    const logoX = marginX;
    const logoTopY = topY;
    const logoBottomY = logoTopY - logoH;
    page.drawImage(logoImg, {
      x: logoX,
      y: logoBottomY,
      width: logoW,
      height: logoH,
    });
    // Thin vertical line from the base of the icon down to near the bottom
    // margin, with a small horizontal cap at the bottom — mirrors the
    // decorative element from the original Pesach template.
    const barX = logoX + logoW / 2;
    const barTop = logoBottomY + 2;
    const barBottom = 48;
    page.drawLine({
      start: { x: barX, y: barTop },
      end: { x: barX, y: barBottom },
      thickness: 0.7,
      color: COLOR,
    });
    const capHalf = 5;
    page.drawLine({
      start: { x: barX - capHalf, y: barBottom },
      end: { x: barX + capHalf, y: barBottom },
      thickness: 0.7,
      color: COLOR,
    });
  }

  // --- Title (top-right, right-aligned) ---
  const titleHe = stripNikud(layout.title || schedule.label || schedule.parsha?.he || '');
  const titleSize = 40;
  if (titleHe) {
    const w = fontHebrew.widthOfTextAtSize(titleHe, titleSize);
    page.drawText(titleHe, {
      x: contentRight - w,
      y: topY - titleSize,
      size: titleSize,
      font: fontHebrew,
      color: COLOR,
    });
  }
  // Horizontal rule under the title.
  let cursorY = topY - titleSize - 14;
  page.drawLine({
    start: { x: contentLeft, y: cursorY },
    end: { x: contentRight, y: cursorY },
    thickness: 1,
    color: COLOR,
  });
  cursorY -= 18;

  // --- Group rows into sections by date ---
  const allRows = [];
  for (const day of schedule.days) {
    for (const minyan of ['shacharis', 'mincha', 'maariv']) {
      const info = day.times[minyan];
      if (!info) continue;
      allRows.push({
        date: day.date,
        time: to12hShort(info.time),
        label: getHebrewLabel(day, minyan),
      });
    }
  }
  const sections = (layout.sections || []).map((s) => ({
    title: stripNikud(s.title || ''),
    subtitle: stripNikud(s.subtitle || ''),
    rows: allRows.filter((r) => r.date >= s.startDate && r.date <= s.endDate),
  }));

  // Pre-wrap announcements (same as default layout).
  const annSize = 12;
  const annLineHeight = annSize + 5;
  const annGap = 18;
  const annLines = [];
  if (announcements && announcements.length > 0) {
    const maxWidth = contentRight - contentLeft;
    for (const a of announcements) {
      for (const paragraph of String(a.text).split(/\r?\n/)) {
        for (const line of wrapText(paragraph, fontLatin, annSize, maxWidth)) {
          annLines.push(line);
        }
      }
    }
  }
  const annBlockHeight = annLines.length > 0 ? annGap + annLines.length * annLineHeight : 0;

  // --- Auto-shrink: scale fonts/heights to fit ---
  const baseSectionTitleSize = 24;
  const baseSubtitleSize = 14;
  const baseRowSize = 18;
  const baseRowHeight = 26;
  const baseSectionGap = 14;       // gap above each section title
  const baseSubtitleGap = 4;       // gap between section title and subtitle
  const baseHeaderToRowsGap = 10;  // gap between section header(s) and first row

  const sectionsHeightAt = (s) => {
    let h = 0;
    for (const sec of sections) {
      h += baseSectionGap * s;
      h += baseSectionTitleSize * s;
      if (sec.subtitle) h += baseSubtitleGap * s + baseSubtitleSize * s;
      h += baseHeaderToRowsGap * s;
      h += sec.rows.length * baseRowHeight * s;
    }
    return h;
  };

  const bottomMargin = 36;
  const availableHeight = cursorY - bottomMargin - annBlockHeight;
  const requiredHeight = sectionsHeightAt(1);
  const scale = requiredHeight > availableHeight && requiredHeight > 0
    ? Math.max(0.5, availableHeight / requiredHeight)
    : 1;

  const sectionTitleSize = baseSectionTitleSize * scale;
  const subtitleSize = baseSubtitleSize * scale;
  const rowSize = baseRowSize * scale;
  const rowHeight = baseRowHeight * scale;
  const sectionGap = baseSectionGap * scale;
  const subtitleGap = baseSubtitleGap * scale;
  const headerToRowsGap = baseHeaderToRowsGap * scale;

  // --- Render sections ---
  for (const section of sections) {
    cursorY -= sectionGap;

    // Section title — right-aligned.
    if (section.title) {
      const w = fontHebrew.widthOfTextAtSize(section.title, sectionTitleSize);
      cursorY -= sectionTitleSize;
      page.drawText(section.title, {
        x: contentRight - w,
        y: cursorY,
        size: sectionTitleSize,
        font: fontHebrew,
        color: COLOR,
      });
    }
    if (section.subtitle) {
      cursorY -= subtitleGap;
      const w = fontHebrew.widthOfTextAtSize(section.subtitle, subtitleSize);
      cursorY -= subtitleSize;
      page.drawText(section.subtitle, {
        x: contentRight - w,
        y: cursorY,
        size: subtitleSize,
        font: fontHebrew,
        color: COLOR_DARK,
      });
    }
    cursorY -= headerToRowsGap;

    // Rows: time on the left of the content area, label right-aligned, with
    // a vertical separator between them.
    const timeX = contentLeft + 12;
    const sepX = timeX + 56 * scale;
    const rowBaselineOffset = rowSize / 3;

    for (const row of section.rows) {
      const rowTop = cursorY;
      const rowBottom = cursorY - rowHeight;
      const baseY = rowTop - rowHeight / 2 - rowBaselineOffset;

      page.drawText(row.time, {
        x: timeX,
        y: baseY,
        size: rowSize,
        font: fontLatin,
        color: COLOR,
      });

      // Vertical separator between time and label.
      page.drawLine({
        start: { x: sepX, y: rowTop - rowHeight * 0.15 },
        end: { x: sepX, y: rowBottom + rowHeight * 0.15 },
        thickness: 0.6,
        color: COLOR,
      });

      const labelW = fontHebrew.widthOfTextAtSize(row.label, rowSize);
      page.drawText(row.label, {
        x: contentRight - labelW,
        y: baseY,
        size: rowSize,
        font: fontHebrew,
        color: COLOR,
      });

      cursorY -= rowHeight;
    }
  }

  // --- Announcements ---
  if (annLines.length > 0) {
    cursorY -= annGap;
    for (const line of annLines) {
      const w = fontLatin.widthOfTextAtSize(line, annSize);
      cursorY -= annLineHeight;
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
