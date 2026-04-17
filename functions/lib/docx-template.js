/**
 * Generates a .docx Word document matching the Shaarei Avodah printed sheet.
 *
 * Layout modeled on test_sheet_v3.docx:
 *   - Floating full-width logo image at the top (spans edge-to-edge)
 *   - Parsha title in Bona Nova 60pt (not bold), centered
 *   - Two-column table: time (Bona Nova 40pt, left) | label (Narkiss 40pt, RTL right)
 *   - Horizontal rule borders between rows, matching text color
 *   - Letter page, 0.75"/1.25" margins
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  VerticalAlign,
  HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom,
  convertInchesToTwip,
} from 'docx';

const FONT_TITLE = 'Bona Nova';
const FONT_LATIN = 'Bona Nova';  // used for times (digits)
const FONT_HEBREW = 'Narkiss Text';
const COLOR = '232140';
const COLOR_RULE_LAST = 'AAAAAA';

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

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: '000000' };
const RULE_BORDER = { style: BorderStyle.SINGLE, size: 8, color: COLOR };
const RULE_BORDER_LAST = { style: BorderStyle.SINGLE, size: 6, color: COLOR_RULE_LAST };

export async function generateDocx({ schedule, announcements, logoData }) {
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

  const titleHe = stripNikud(schedule.parsha?.he || schedule.label || '');

  const children = [];

  // Logo header — floating image, extends edge-to-edge.
  if (logoData) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new ImageRun({
            data: logoData,
            transformation: { width: 760, height: 152 }, // ~8" x 1.6"
            floating: {
              horizontalPosition: {
                offset: -910000, // EMU: extend ~1" left into the margin
                relative: HorizontalPositionRelativeFrom.COLUMN,
              },
              verticalPosition: {
                offset: -720000, // EMU: pull up ~0.75" into the top margin
                relative: VerticalPositionRelativeFrom.PARAGRAPH,
              },
              margins: { top: 0, bottom: 0, left: 0, right: 0 },
              behindDocument: false,
              allowOverlap: true,
            },
          }),
        ],
      })
    );
  }

  // Spacer rows to push the parsha title below the logo — exactly 20pt tall each.
  children.push(
    new Paragraph({ spacing: { line: 400, lineRule: 'exact', after: 0 }, children: [] }),
    new Paragraph({ spacing: { line: 400, lineRule: 'exact', after: 0 }, children: [] })
  );

  // Parsha title — Bona Nova 60pt, NOT bold.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 500 },
      bidirectional: true,
      children: [
        new TextRun({
          text: titleHe,
          size: 120, // half-points → 60pt
          font: FONT_TITLE,
          color: COLOR,
          rightToLeft: true,
        }),
      ],
    })
  );

  // One extra spacer line.
  children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));

  // Times rows.
  const tableRows = rows.map((row, idx) => {
    const isLast = idx === rows.length - 1;
    const isFirst = idx === 0;
    const bottomBorder = isLast ? RULE_BORDER_LAST : RULE_BORDER;
    const topBorder = isFirst ? NO_BORDER : RULE_BORDER;

    return new TableRow({
      height: { value: 1296, rule: 'atLeast' },
      children: [
        // Time cell — Bona Nova, left-aligned.
        new TableCell({
          borders: { top: topBorder, left: NO_BORDER, right: NO_BORDER, bottom: bottomBorder },
          width: { size: 22, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [
                new TextRun({
                  text: row.time,
                  size: 80, // 40pt
                  font: FONT_LATIN,
                  color: COLOR,
                }),
              ],
            }),
          ],
        }),
        // Label cell — Narkiss Text, RTL, visually right-aligned.
        new TableCell({
          borders: { top: topBorder, left: NO_BORDER, right: NO_BORDER, bottom: bottomBorder },
          width: { size: 78, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT, // with bidi=true, this becomes visually right
              bidirectional: true,
              children: [
                new TextRun({
                  text: row.label,
                  size: 80,
                  font: FONT_HEBREW,
                  color: COLOR,
                  rightToLeft: true,
                }),
              ],
            }),
          ],
        }),
      ],
    });
  });

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: tableRows,
      borders: {
        top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
      },
    })
  );

  // Announcements.
  if (announcements && announcements.length > 0) {
    children.push(new Paragraph({ spacing: { before: 480 }, children: [] }));
    for (const a of announcements) {
      const lines = String(a.text).split(/\r?\n/);
      const runs = [];
      lines.forEach((line, i) => {
        if (i > 0) runs.push(new TextRun({ break: 1 }));
        runs.push(new TextRun({ text: line, size: 40, font: FONT_LATIN, color: COLOR }));
      });
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 60, after: 60 },
          children: runs,
        })
      );
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.5),
              height: convertInchesToTwip(11),
            },
            margin: {
              top: convertInchesToTwip(0.75),
              bottom: convertInchesToTwip(0.75),
              left: convertInchesToTwip(1.25),
              right: convertInchesToTwip(1.25),
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
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
