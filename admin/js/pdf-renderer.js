/**
 * Browser-side PDF renderer — direct port of functions/lib/pdf-template.js,
 * using the UMD pdf-lib + fontkit globals loaded via <script> in the page.
 *
 * Why a copy instead of sharing code: pdf-template.js uses ESM imports of
 * pdf-lib that don't run in the browser without a bundler. This file is the
 * same logic with the imports swapped for window globals. Keep the two in
 * sync when changing the visual layout — and bump RENDERER_VERSION in
 * functions/lib/pdf-cache.js so cached pages get re-rendered.
 *
 * Usage:
 *   const bytes = await PdfRenderer.render({
 *     schedule, announcements, layout,
 *     hebrewFontData, latinFontData, logoData, compactLogoData,
 *   });
 */
(function (global) {
  const { PDFDocument, StandardFonts, rgb } = global.PDFLib;
  const fontkit = global.fontkit;

  const COLOR = rgb(0x23 / 255, 0x21 / 255, 0x40 / 255);
  // Slightly darker neutral for the announcements block — distinguishes it
  // visually from the times above without competing with them.
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

  async function render({
    schedule,
    announcements,
    layout,
    hebrewFontData,
    latinFontData,
    logoData,
    compactLogoData,
  }) {
    if (!hebrewFontData) throw new Error('PdfRenderer: hebrewFontData required');
    if (!latinFontData) throw new Error('PdfRenderer: latinFontData required');

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const fontHebrew = await pdf.embedFont(hebrewFontData, { subset: false });
    // Bona Nova for Latin text. The earlier copy of BonaNova-Regular.ttf
    // dropped digits + colon when fontkit parsed it in the browser; the
    // current file is the canonical Google Fonts build, which round-trips
    // through @pdf-lib/fontkit correctly. If you swap fonts again and digits
    // start dropping, fall back to StandardFonts.Helvetica as a safety net.
    const fontLatin = latinFontData
      ? await pdf.embedFont(latinFontData, { subset: false })
      : await pdf.embedFont(StandardFonts.Helvetica);
    const logoImg = logoData ? await pdf.embedPng(logoData) : null;
    const compactLogoImg = compactLogoData ? await pdf.embedPng(compactLogoData) : null;

    if (layout && layout.mode === 'compact') {
      renderCompactSchedulePage({
        pdf, fontHebrew, fontLatin, logoImg: compactLogoImg,
        schedule, announcements, layout,
      });
    } else {
      renderDefaultSchedulePage({
        pdf, fontHebrew, fontLatin, logoImg, compactLogoImg,
        schedule, announcements, layout,
      });
    }

    return pdf.save();
  }

  function renderDefaultSchedulePage({
    pdf, fontHebrew, fontLatin, logoImg, schedule, announcements,
  }) {
    // Letter: 8.5" x 11" = 612 x 792 pt.
    const pageWidth = 612;
    const pageHeight = 792;
    const page = pdf.addPage([pageWidth, pageHeight]);

    const marginX = 90;
    let cursorY = pageHeight;

    if (logoImg) {
      const logoWidth = pageWidth * 0.95;
      const logoHeight = (logoImg.height / logoImg.width) * logoWidth;
      const logoX = (pageWidth - logoWidth) / 2;
      const logoY = pageHeight - 18 - logoHeight;
      page.drawImage(logoImg, { x: logoX, y: logoY, width: logoWidth, height: logoHeight });
      cursorY = logoY - 30;
    } else {
      cursorY -= 80;
    }

    const titleHe = stripNikud(schedule.parsha?.he || schedule.label || '');
    if (titleHe) {
      const titleSize = 52;
      cursorY -= titleSize;
      const w = fontHebrew.widthOfTextAtSize(titleHe, titleSize);
      page.drawText(titleHe, {
        x: (pageWidth - w) / 2, y: cursorY, size: titleSize, font: fontHebrew, color: COLOR,
      });
      cursorY -= 40;
    }

    const rows = [];
    for (const day of schedule.days) {
      for (const minyan of ['shacharis', 'mincha', 'maariv']) {
        const info = day.times[minyan];
        if (!info) continue;
        rows.push({ time: to12hShort(info.time), label: getHebrewLabel(day, minyan) });
      }
    }

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

    const bottomMargin = 36;
    const availableForRows = cursorY - bottomMargin - annBlockHeight;
    const baseRowHeight = 74;
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
      const baseY = cursorY - rowHeight / 2 - timeSize / 3;

      page.drawText(row.time, { x: marginX, y: baseY, size: timeSize, font: fontLatin, color: COLOR });
      const labelW = fontHebrew.widthOfTextAtSize(row.label, labelSize);
      page.drawText(row.label, {
        x: pageWidth - marginX - labelW, y: baseY, size: labelSize, font: fontHebrew, color: COLOR,
      });

      cursorY -= rowHeight;
      if (!isLast) {
        page.drawLine({
          start: { x: marginX, y: cursorY + 4 },
          end: { x: pageWidth - marginX, y: cursorY + 4 },
          thickness: 0.8, color: COLOR,
        });
      }
    }

    if (annLines.length > 0) {
      cursorY -= annGap;
      for (const line of annLines) {
        const w = fontLatin.widthOfTextAtSize(line, annSize);
        cursorY -= annLineHeight;
        page.drawText(line, {
          x: (pageWidth - w) / 2, y: cursorY, size: annSize, font: fontLatin, color: COLOR_DARK,
        });
      }
    }
  }

  function renderCompactSchedulePage({
    pdf, fontHebrew, fontLatin, logoImg, schedule, announcements, layout,
  }) {
    const pageWidth = 612;
    const pageHeight = 792;
    const page = pdf.addPage([pageWidth, pageHeight]);

    const marginX = 54;
    const logoColumnWidth = 70;
    const contentLeft = marginX + logoColumnWidth + 14;
    const contentRight = pageWidth - marginX;
    let topY = pageHeight - 30;

    if (logoImg) {
      const logoW = logoColumnWidth;
      const logoH = (logoImg.height / logoImg.width) * logoW;
      const logoX = marginX;
      const logoTopY = topY;
      const logoBottomY = logoTopY - logoH;
      page.drawImage(logoImg, { x: logoX, y: logoBottomY, width: logoW, height: logoH });
      const barX = logoX + logoW / 2;
      const barTop = logoBottomY + 2;
      const barBottom = 48;
      page.drawLine({ start: { x: barX, y: barTop }, end: { x: barX, y: barBottom }, thickness: 0.7, color: COLOR });
      const capHalf = 5;
      page.drawLine({
        start: { x: barX - capHalf, y: barBottom }, end: { x: barX + capHalf, y: barBottom },
        thickness: 0.7, color: COLOR,
      });
    }

    const titleHe = stripNikud(layout.title || schedule.label || schedule.parsha?.he || '');
    const titleSize = 40;
    if (titleHe) {
      const w = fontHebrew.widthOfTextAtSize(titleHe, titleSize);
      page.drawText(titleHe, {
        x: contentRight - w, y: topY - titleSize, size: titleSize, font: fontHebrew, color: COLOR,
      });
    }
    let cursorY = topY - titleSize - 14;
    page.drawLine({ start: { x: contentLeft, y: cursorY }, end: { x: contentRight, y: cursorY }, thickness: 1, color: COLOR });
    cursorY -= 18;

    const allRows = [];
    for (const day of schedule.days) {
      for (const minyan of ['shacharis', 'mincha', 'maariv']) {
        const info = day.times[minyan];
        if (!info) continue;
        allRows.push({ date: day.date, time: to12hShort(info.time), label: getHebrewLabel(day, minyan) });
      }
    }
    const sections = (layout.sections || []).map((s) => ({
      title: stripNikud(s.title || ''),
      subtitle: stripNikud(s.subtitle || ''),
      rows: allRows.filter((r) => r.date >= s.startDate && r.date <= s.endDate),
    }));

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

    const baseSectionTitleSize = 24;
    const baseSubtitleSize = 14;
    const baseRowSize = 18;
    const baseRowHeight = 26;
    const baseSectionGap = 14;
    const baseSubtitleGap = 4;
    const baseHeaderToRowsGap = 10;

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

    for (const section of sections) {
      cursorY -= sectionGap;
      if (section.title) {
        const w = fontHebrew.widthOfTextAtSize(section.title, sectionTitleSize);
        cursorY -= sectionTitleSize;
        page.drawText(section.title, {
          x: contentRight - w, y: cursorY, size: sectionTitleSize, font: fontHebrew, color: COLOR,
        });
      }
      if (section.subtitle) {
        cursorY -= subtitleGap;
        const w = fontHebrew.widthOfTextAtSize(section.subtitle, subtitleSize);
        cursorY -= subtitleSize;
        page.drawText(section.subtitle, {
          x: contentRight - w, y: cursorY, size: subtitleSize, font: fontHebrew, color: COLOR_DARK,
        });
      }
      cursorY -= headerToRowsGap;

      const timeX = contentLeft + 12;
      const sepX = timeX + 56 * scale;
      const rowBaselineOffset = rowSize / 3;

      for (const row of section.rows) {
        const rowTop = cursorY;
        const rowBottom = cursorY - rowHeight;
        const baseY = rowTop - rowHeight / 2 - rowBaselineOffset;

        page.drawText(row.time, { x: timeX, y: baseY, size: rowSize, font: fontLatin, color: COLOR });
        page.drawLine({
          start: { x: sepX, y: rowTop - rowHeight * 0.15 },
          end: { x: sepX, y: rowBottom + rowHeight * 0.15 },
          thickness: 0.6, color: COLOR,
        });
        const labelW = fontHebrew.widthOfTextAtSize(row.label, rowSize);
        page.drawText(row.label, {
          x: contentRight - labelW, y: baseY, size: rowSize, font: fontHebrew, color: COLOR,
        });

        cursorY -= rowHeight;
      }
    }

    if (annLines.length > 0) {
      cursorY -= annGap;
      for (const line of annLines) {
        const w = fontLatin.widthOfTextAtSize(line, annSize);
        cursorY -= annLineHeight;
        page.drawText(line, {
          x: (pageWidth - w) / 2, y: cursorY, size: annSize, font: fontLatin, color: COLOR_DARK,
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
    return String(s).replace(/[֑-ׇ]/g, '');
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

  // Asset cache — keep fonts/logos in memory once loaded so successive renders
  // skip the network. Cleared if the page is reloaded.
  let assetCache = null;
  async function loadAssets() {
    if (assetCache) return assetCache;
    const [logoRes, compactLogoRes, hebrewFontRes, latinFontRes] = await Promise.all([
      fetch('/d/Logo Header.png'),
      fetch('/d/Logo Compact.png'),
      fetch('/d/51618.otf'),
      fetch('/d/BonaNova-Regular.ttf'),
    ]);
    if (!hebrewFontRes.ok) throw new Error('Hebrew font fetch failed');
    if (!latinFontRes.ok) throw new Error('Latin font fetch failed');
    assetCache = {
      logoData: logoRes.ok ? new Uint8Array(await logoRes.arrayBuffer()) : null,
      compactLogoData: compactLogoRes.ok ? new Uint8Array(await compactLogoRes.arrayBuffer()) : null,
      hebrewFontData: new Uint8Array(await hebrewFontRes.arrayBuffer()),
      latinFontData: new Uint8Array(await latinFontRes.arrayBuffer()),
    };
    return assetCache;
  }

  global.PdfRenderer = { render, loadAssets };
})(window);
