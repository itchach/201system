const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { getOne, query } = require('../config/database');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const SIFS_DIR = path.join(UPLOADS_DIR, 'sifs');

// Ensure base directories exist
[TEMPLATES_DIR, UPLOADS_DIR, SIFS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const DEFAULT_TEMPLATE_PATH = path.join(TEMPLATES_DIR, 'Student_Personal_Information_Sheet.pdf');

/**
 * Creates the official 1-Page Olivarez College BSIT template with all sections
 * perfectly proportioned and distributed to maximize full page usage.
 */
async function ensureDefaultTemplate() {
  if (fs.existsSync(DEFAULT_TEMPLATE_PATH)) {
    return DEFAULT_TEMPLATE_PATH;
  }

  const pdfDoc = await PDFDocument.create();
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const greenPrimary = rgb(0.33, 0.61, 0.17); // #559c2b
  const greenLight = rgb(0.84, 0.92, 0.72);   // #d7ebb8
  const black = rgb(0, 0, 0);
  const grayText = rgb(0.35, 0.35, 0.35);

  // Letter size: 612 x 792 pt
  const page = pdfDoc.addPage([612, 792]);
  const leftX = 38;
  const rightX = 574;
  const contentW = rightX - leftX; // 536 pt

  // ==============================
  // HEADER
  // ==============================
  page.drawText('OLIVAREZ COLLEGE', { x: 216, y: 766, size: 13.5, font: fontBold, color: black });
  page.drawText('Dr. A. Santos Avenue, Sucat Road, Parañaque City', { x: 185, y: 753, size: 8, font: fontRegular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('PAASCU/PACUCOA Accredited', { x: 234, y: 742, size: 7.5, font: fontRegular, color: rgb(0.3, 0.3, 0.3) });
  page.drawText('College of Computer Studies', { x: 210, y: 728, size: 10.5, font: fontBold, color: black });
  page.drawText("Student's Personal Information Sheet (BSIT)", { x: 182, y: 715, size: 10, font: fontBold, color: black });

  // 2" x 2" Photo Box
  const photoW = 82;
  const photoH = 88;
  const photoX = rightX - photoW;
  const photoY = 692;
  page.drawRectangle({
    x: photoX,
    y: photoY,
    width: photoW,
    height: photoH,
    borderWidth: 0.8,
    borderColor: grayText,
    borderDashArray: [3, 3]
  });
  page.drawText('2" x 2"', { x: photoX + 28, y: photoY + 48, size: 8, font: fontRegular, color: grayText });
  page.drawText('PHOTO', { x: photoX + 24, y: photoY + 36, size: 8, font: fontRegular, color: grayText });

  let curY = 690;

  // Helper Banner Drawer
  const drawBanner = (title, y) => {
    page.drawRectangle({ x: leftX, y: y - 12, width: contentW, height: 14, color: greenPrimary });
    page.drawText(title, { x: leftX + 6, y: y - 8.5, size: 8.5, font: fontBold, color: rgb(1, 1, 1) });
  };

  // Helper Checkbox Drawer
  const drawCheckbox = (x, y, label) => {
    page.drawRectangle({ x, y: y - 1, width: 8, height: 8, borderWidth: 0.8, borderColor: black });
    page.drawText(label, { x: x + 12, y, size: 7.8, font: fontRegular, color: black });
  };

  // ==============================
  // SECTION I: PERSONAL INFORMATION
  // ==============================
  drawBanner('I. Personal Information', curY);
  curY -= 22;

  // 1. NAME Row
  page.drawText('NAME:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  // 3 equal lines across the rest of the row
  page.drawLine({ start: { x: leftX + 36, y: curY - 1 }, end: { x: leftX + 198, y: curY - 1 }, thickness: 0.8, color: black });
  page.drawText('(Last Name)', { x: leftX + 96, y: curY - 10, size: 7, font: fontRegular, color: grayText });

  page.drawLine({ start: { x: leftX + 208, y: curY - 1 }, end: { x: leftX + 372, y: curY - 1 }, thickness: 0.8, color: black });
  page.drawText('(First Name)', { x: leftX + 268, y: curY - 10, size: 7, font: fontRegular, color: grayText });

  page.drawLine({ start: { x: leftX + 382, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });
  page.drawText('(Middle Name)', { x: leftX + 440, y: curY - 10, size: 7, font: fontRegular, color: grayText });

  curY -= 19;

  // 2. CITY ADDRESS
  page.drawText('CITY ADDRESS:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 72, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 16;

  // 3. PROVINCIAL ADDRESS
  page.drawText('PROVINCIAL ADDRESS:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 108, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 16;

  // 4. LANDLINE & MOBILE
  page.drawText('LANDLINE #:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 64, y: curY - 1 }, end: { x: leftX + 265, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('MOBILE #:', { x: leftX + 285, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 338, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 16;

  // 5. AGE, GENDER, CIVIL STATUS, NATIONALITY, RELIGION
  // AGE | GENDER | CIVIL STATUS | NATIONALITY | RELIGION — evenly distributed to fit within margin
  page.drawText('AGE:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 22, y: curY - 1 }, end: { x: leftX + 58, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('GENDER:', { x: leftX + 64, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 106, y: curY - 1 }, end: { x: leftX + 148, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('CIVIL STATUS:', { x: leftX + 154, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 218, y: curY - 1 }, end: { x: leftX + 268, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('NATIONALITY:', { x: leftX + 274, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 336, y: curY - 1 }, end: { x: leftX + 390, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('RELIGION:', { x: leftX + 396, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 445, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 16;

  // 6. ORDINAL POSITION
  page.drawText('ORDINAL POSITION:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  drawCheckbox(leftX + 96, curY, '1st CHILD');
  drawCheckbox(leftX + 158, curY, '2nd CHILD');
  drawCheckbox(leftX + 224, curY, '3rd CHILD');
  drawCheckbox(leftX + 288, curY, '4th CHILD');

  page.drawLine({ start: { x: leftX + 352, y: curY - 1 }, end: { x: leftX + 406, y: curY - 1 }, thickness: 0.8, color: black });
  page.drawText('CHILD', { x: leftX + 412, y: curY, size: 7.8, font: fontRegular, color: black });

  curY -= 16;

  // 7. SIBLINGS, BOY/S, GIRL/S, BIRTHDATE, YEAR LEVEL — compressed to fit within margin
  page.drawText('NUMBER OF SIBLINGS:', { x: leftX, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 100, y: curY - 1 }, end: { x: leftX + 130, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('BOY/S:', { x: leftX + 136, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 166, y: curY - 1 }, end: { x: leftX + 196, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('GIRL/S:', { x: leftX + 202, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 234, y: curY - 1 }, end: { x: leftX + 264, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('BIRTHDATE:', { x: leftX + 270, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 324, y: curY - 1 }, end: { x: leftX + 400, y: curY - 1 }, thickness: 0.8, color: black });

  page.drawText('YEAR LEVEL:', { x: leftX + 406, y: curY, size: 8, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 458, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 20;

  // ==============================
  // SECTION II: PARENT'S INFORMATION
  // ==============================
  drawBanner("II. Parent's Information", curY);
  curY -= 14;

  const parentRows = [
    "FATHER'S INFORMATION",
    'OCCUPATION',
    'COMPANY ADDRESS',
    'EDUCATIONAL ATTAINMENT',
    'CONTACT NUMBER',
    "MOTHER'S INFORMATION",
    'OCCUPATION',
    'COMPANY ADDRESS',
    'EDUCATIONAL ATTAINMENT',
    'CONTACT NUMBER'
  ];

  const pRowH = 16;
  const pCol1W = 150;
  const pTableTop = curY;
  const pTableH = parentRows.length * pRowH;

  page.drawRectangle({
    x: leftX,
    y: pTableTop - pTableH,
    width: contentW,
    height: pTableH,
    borderWidth: 0.8,
    borderColor: black
  });
  page.drawLine({
    start: { x: leftX + pCol1W, y: pTableTop },
    end: { x: leftX + pCol1W, y: pTableTop - pTableH },
    thickness: 0.8,
    color: black
  });

  parentRows.forEach((label, idx) => {
    const rowY = pTableTop - (idx + 1) * pRowH;
    if (idx > 0) {
      page.drawLine({
        start: { x: leftX, y: pTableTop - idx * pRowH },
        end: { x: rightX, y: pTableTop - idx * pRowH },
        thickness: 0.8,
        color: black
      });
    }
    const isHeader = label.includes('INFORMATION');
    page.drawText(label, {
      x: leftX + 5,
      y: rowY + 3.8,
      size: 7.5,
      font: isHeader ? fontBold : fontRegular,
      color: black
    });
  });

  curY = pTableTop - pTableH - 12;

  // Parent Status & Living Checkboxes
  page.drawText("PARENT'S STATUS:", { x: leftX, y: curY, size: 7.5, font: fontBold, color: black });
  drawCheckbox(leftX + 115, curY, 'LIVING TOGETHER');
  drawCheckbox(leftX + 225, curY, 'SEPARATED');
  drawCheckbox(leftX + 305, curY, 'RE-MARRIED');
  drawCheckbox(leftX + 385, curY, 'WIDOW');

  curY -= 12;
  page.drawText('LIVING APARTMENT:', { x: leftX, y: curY, size: 7.5, font: fontBold, color: black });
  drawCheckbox(leftX + 115, curY, 'LIVING WITH PARENTS');
  drawCheckbox(leftX + 250, curY, 'LIVING WITH RELATIVES');

  curY -= 12;
  drawCheckbox(leftX + 115, curY, 'LIVING IN DORMITORY');
  drawCheckbox(leftX + 250, curY, 'OTHER ARRANGEMENT');

  curY -= 12;
  page.drawText('LANGUAGE/S OR DIALECT/S SPOKEN AT HOME:', { x: leftX, y: curY, size: 7.5, font: fontBold, color: black });
  page.drawLine({ start: { x: leftX + 182, y: curY - 1 }, end: { x: rightX, y: curY - 1 }, thickness: 0.8, color: black });

  curY -= 18;

  // ==============================
  // SECTION III: EDUCATIONAL BACKGROUND
  // ==============================
  drawBanner('III. Educational Background', curY);
  curY -= 14;

  const eduRowsConfig = [
    { type: 'header', text: 'COLLEGE (IF TRANSFEREE FROM OTHER SCHOOL)' },
    { type: 'data', label: 'Name of School Last Attended' },
    { type: 'data', label: 'Address of School Last Attended' },
    { type: 'data', label: 'Course Last Taken' },
    { type: 'header', text: 'HIGH SCHOOL' },
    { type: 'data', label: 'Name of School Last Attended' },
    { type: 'data', label: 'Address of School Last Attended' },
    { type: 'header', text: 'ELEMENTARY' },
    { type: 'data', label: 'Name of School Last Attended' },
    { type: 'data', label: 'Address of School Last Attended' }
  ];

  const eduRowH = 15.5;
  const eduCol1W = 160;
  const eduTableTop = curY;
  const eduTableH = eduRowsConfig.length * eduRowH;

  page.drawRectangle({
    x: leftX,
    y: eduTableTop - eduTableH,
    width: contentW,
    height: eduTableH,
    borderWidth: 0.8,
    borderColor: black
  });
  page.drawLine({
    start: { x: leftX + eduCol1W, y: eduTableTop },
    end: { x: leftX + eduCol1W, y: eduTableTop - eduTableH },
    thickness: 0.8,
    color: black
  });

  eduRowsConfig.forEach((row, idx) => {
    const rowY = eduTableTop - (idx + 1) * eduRowH;
    if (idx > 0) {
      page.drawLine({
        start: { x: leftX, y: eduTableTop - idx * eduRowH },
        end: { x: rightX, y: eduTableTop - idx * eduRowH },
        thickness: 0.8,
        color: black
      });
    }

    if (row.type === 'header') {
      page.drawRectangle({
        x: leftX + 0.4,
        y: rowY + 0.4,
        width: contentW - 0.8,
        height: eduRowH - 0.8,
        color: greenLight
      });
      page.drawText(row.text, {
        x: leftX + (contentW / 2) - 100,
        y: rowY + 3.8,
        size: 7.2,
        font: fontBold,
        color: black
      });
    } else {
      page.drawText(row.label, {
        x: leftX + 5,
        y: rowY + 3.8,
        size: 7.2,
        font: fontRegular,
        color: black
      });
    }
  });

  curY = eduTableTop - eduTableH - 22;

  // ==============================
  // SECTION IV: EMERGENCY CONTACT
  // ==============================
  drawBanner('PERSON TO BE NOTIFIED IN CASE OF EMERGENCY', curY);
  curY -= 14;

  const emergRows = [
    'NAME & RELATIONSHIP',
    'COMPLETE ADDRESS',
    'CONTACT NUMBER/S'
  ];
  const emergRowH = 22;
  const emergCol1W = 160;
  const emergTableTop = curY;
  const emergTableH = emergRows.length * emergRowH;

  page.drawRectangle({
    x: leftX,
    y: emergTableTop - emergTableH,
    width: contentW,
    height: emergTableH,
    borderWidth: 0.8,
    borderColor: black
  });
  page.drawLine({
    start: { x: leftX + emergCol1W, y: emergTableTop },
    end: { x: leftX + emergCol1W, y: emergTableTop - emergTableH },
    thickness: 0.8,
    color: black
  });

  emergRows.forEach((label, idx) => {
    const rowY = emergTableTop - (idx + 1) * emergRowH;
    if (idx > 0) {
      page.drawLine({
        start: { x: leftX, y: emergTableTop - idx * emergRowH },
        end: { x: rightX, y: emergTableTop - idx * emergRowH },
        thickness: 0.8,
        color: black
      });
    }
    page.drawText(label, {
      x: leftX + 5,
      y: rowY + 4,
      size: 7.5,
      font: fontBold,
      color: black
    });
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(DEFAULT_TEMPLATE_PATH, pdfBytes);
  return DEFAULT_TEMPLATE_PATH;
}

/**
 * Generate completed SIF PDF for a student (Maximized 1 Page format)
 * @param {Object} studentRecord - student data from DB
 * @param {Object} formData - submitted form details
 * @param {string} sectionName - name of the section for organization
 */
async function generateStudentSIF(studentRecord, formData, sectionName) {
  await ensureDefaultTemplate();

  const existingPdfBytes = fs.readFileSync(DEFAULT_TEMPLATE_PATH);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const page = pdfDoc.getPage(0);
  const leftX = 38;
  const rightX = 574;

  const fillText = (text, x, y, size = 8, isBold = false, maxWidth = 340, align = 'left', boxWidth = null) => {
    if (!text && text !== 0) return;
    const str = String(text);
    const font = isBold ? fontBold : fontRegular;
    let actualSize = size;
    let textWidth = font.widthOfTextAtSize(str, actualSize);
    if (maxWidth && textWidth > maxWidth) {
      actualSize = Math.max(6.2, (maxWidth / textWidth) * actualSize);
      textWidth = font.widthOfTextAtSize(str, actualSize);
    }
    let drawX = x;
    if (align === 'center') {
      const span = boxWidth || maxWidth || textWidth;
      drawX = x + (span - textWidth) / 2;
    }
    page.drawText(str, {
      x: drawX,
      y,
      size: actualSize,
      font,
      color: rgb(0.05, 0.1, 0.3) // Clean dark navy slate
    });
  };

  const drawCheck = (x, y) => {
    page.drawText('X', {
      x: x + 1,
      y: y + 0.5,
      size: 7.5,
      font: fontBold,
      color: rgb(0, 0, 0.55)
    });
  };

  // --- EMBED 2" x 2" PHOTO ---
  if (formData.photoBase64 && formData.photoBase64.startsWith('data:image')) {
    try {
      const base64Data = formData.photoBase64.split(',')[1];
      const imageBytes = Buffer.from(base64Data, 'base64');
      let embeddedImage;
      if (formData.photoBase64.includes('image/png')) {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
      } else {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
      }

      if (embeddedImage) {
        page.drawImage(embeddedImage, {
          x: rightX - 81,
          y: 693,
          width: 80,
          height: 86
        });
      }
    } catch (photoErr) {
      console.warn('Could not embed student photo into PDF:', photoErr.message);
    }
  }

  // --- SECTION I: PERSONAL INFORMATION ---
  let curY = 690 - 22; // 668

  // Name (centered in the middle of each respective underline)
  fillText(formData.lastName || '', leftX + 36, curY + 1, 8.5, true, 154, 'center', 162);
  fillText(formData.firstName || '', leftX + 208, curY + 1, 8.5, true, 156, 'center', 164);
  fillText(formData.middleName || '', leftX + 382, curY + 1, 8.5, true, 146, 'center', 154);

  // Address
  curY -= 19;
  fillText(formData.cityAddress || '', leftX + 78, curY + 1, 8, false, 450);

  curY -= 16;
  fillText(formData.provincialAddress || '', leftX + 114, curY + 1, 8, false, 415);

  // Contacts
  curY -= 16;
  fillText(formData.landline || '', leftX + 70, curY + 1, 8, false, 190);
  fillText(formData.mobile || '', leftX + 344, curY + 1, 8, false, 185);

  // Age, Gender, Civil Status, Nationality, Religion
  curY -= 16;
  fillText(formData.age || '', leftX + 24, curY + 1, 8, false, 32);
  fillText(formData.gender || '', leftX + 108, curY + 1, 8, false, 38);
  fillText(formData.civilStatus || '', leftX + 220, curY + 1, 8, false, 46);
  fillText(formData.nationality || '', leftX + 338, curY + 1, 8, false, 50);
  fillText(formData.religion || '', leftX + 448, curY + 1, 8, false, 80);

  // Ordinal Position
  curY -= 16;
  if (formData.ordinalPosition === '1st') drawCheck(leftX + 96, curY);
  else if (formData.ordinalPosition === '2nd') drawCheck(leftX + 158, curY);
  else if (formData.ordinalPosition === '3rd') drawCheck(leftX + 224, curY);
  else if (formData.ordinalPosition === '4th') drawCheck(leftX + 288, curY);
  else if (formData.ordinalPositionOther) {
    fillText(formData.ordinalPositionOther, leftX + 356, curY + 1, 8, false, 48);
  }

  // Siblings, Birthdate, Year Level
  curY -= 16;
  fillText(formData.numSiblings || '', leftX + 102, curY + 1, 8, false, 26);
  fillText(formData.numBoys || '', leftX + 168, curY + 1, 8, false, 26);
  fillText(formData.numGirls || '', leftX + 236, curY + 1, 8, false, 26);
  fillText(formData.birthdate || '', leftX + 326, curY + 1, 8, false, 72);
  fillText(formData.yearLevel || '', leftX + 460, curY + 1, 8, false, 75);

  // --- SECTION II: PARENT'S INFORMATION ---
  const pRowH = 16;
  const pTableTop = curY - 20 - 14;
  const pValX = leftX + 155;

  fillText(formData.fatherName || '', pValX, pTableTop - (1 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.fatherOccupation || '', pValX, pTableTop - (2 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.fatherCompanyAddress || '', pValX, pTableTop - (3 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.fatherEducationalAttainment || '', pValX, pTableTop - (4 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.fatherContact || '', pValX, pTableTop - (5 * pRowH) + 3.8, 8, false, 375);

  fillText(formData.motherName || '', pValX, pTableTop - (6 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.motherOccupation || '', pValX, pTableTop - (7 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.motherCompanyAddress || '', pValX, pTableTop - (8 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.motherEducationalAttainment || '', pValX, pTableTop - (9 * pRowH) + 3.8, 8, false, 375);
  fillText(formData.motherContact || '', pValX, pTableTop - (10 * pRowH) + 3.8, 8, false, 375);

  // Parent's Status & Living Checkboxes
  const statusY = pTableTop - (10 * pRowH) - 12;
  if (formData.parentStatus === 'Living Together') drawCheck(leftX + 115, statusY);
  else if (formData.parentStatus === 'Separated') drawCheck(leftX + 225, statusY);
  else if (formData.parentStatus === 'Re-Married') drawCheck(leftX + 305, statusY);
  else if (formData.parentStatus === 'Widow') drawCheck(leftX + 385, statusY);

  const livingY1 = statusY - 12;
  const livingY2 = statusY - 24;
  if (formData.livingArrangement === 'Living with Parents') drawCheck(leftX + 115, livingY1);
  else if (formData.livingArrangement === 'Living with Relatives') drawCheck(leftX + 250, livingY1);
  else if (formData.livingArrangement === 'Living in Dormitory') drawCheck(leftX + 115, livingY2);
  else if (formData.livingArrangement === 'Other Arrangement') drawCheck(leftX + 250, livingY2);

  const dialectY = livingY2 - 12;
  fillText(formData.languagesSpoken || '', leftX + 184, dialectY + 1, 8, false, 350);

  // --- SECTION III: EDUCATIONAL BACKGROUND ---
  const eduRowH = 15.5;
  const eduTableTop = dialectY - 18 - 14;
  const eduValX = leftX + 165;

  // College
  fillText(formData.collegeSchool || '', eduValX, eduTableTop - (2 * eduRowH) + 3.8, 7.8, false, 365);
  fillText(formData.collegeAddress || '', eduValX, eduTableTop - (3 * eduRowH) + 3.8, 7.8, false, 365);
  fillText(formData.collegeCourse || '', eduValX, eduTableTop - (4 * eduRowH) + 3.8, 7.8, false, 365);

  // High School
  fillText(formData.highSchool || '', eduValX, eduTableTop - (6 * eduRowH) + 3.8, 7.8, false, 365);
  fillText(formData.highSchoolAddress || '', eduValX, eduTableTop - (7 * eduRowH) + 3.8, 7.8, false, 365);

  // Elementary
  fillText(formData.elementarySchool || '', eduValX, eduTableTop - (9 * eduRowH) + 3.8, 7.8, false, 365);
  fillText(formData.elementaryAddress || '', eduValX, eduTableTop - (10 * eduRowH) + 3.8, 7.8, false, 365);

  // --- SECTION IV: EMERGENCY CONTACT (ON SAME PAGE) ---
  const emergRowH = 22;
  const emergTableTop = eduTableTop - (10 * eduRowH) - 22 - 14;
  const emergValX = leftX + 165;

  fillText(`${formData.emergencyName || ''} ${formData.emergencyRelationship ? '(' + formData.emergencyRelationship + ')' : ''}`.trim(), emergValX, emergTableTop - (1 * emergRowH) + 4, 8, false, 365);
  fillText(formData.emergencyAddress || '', emergValX, emergTableTop - (2 * emergRowH) + 4, 8, false, 365);
  fillText(formData.emergencyContact || '', emergValX, emergTableTop - (3 * emergRowH) + 4, 8, false, 365);

  // Optional Custom Mapping for Section Stamping
  const activeTemplate = await getOne('SELECT * FROM pdf_templates WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
  const customMappings = await getOne('SELECT * FROM pdf_field_mappings WHERE template_id = ? AND form_field = ?', [activeTemplate ? activeTemplate.id : 1, 'section']);
  if (customMappings && customMappings.is_mapped) {
    fillText(sectionName, customMappings.x, customMappings.y, customMappings.font_size);
  }

  // --- FILE ORGANIZATION BY SECTION ---
  const safeSectionFolder = sectionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sectionDir = path.join(SIFS_DIR, safeSectionFolder);
  if (!fs.existsSync(sectionDir)) {
    fs.mkdirSync(sectionDir, { recursive: true });
  }

  const safeId = (studentRecord.student_id || 'ID').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeLast = (formData.lastName || 'Student').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFirst = (formData.firstName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `SIF_${safeId}_${safeLast}_${safeFirst}.pdf`.replace(/__+/g, '_');

  const filePath = path.join(sectionDir, fileName);
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);

  return {
    filePath: path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/'),
    fileName,
    fileSize: pdfBytes.length,
    templateId: activeTemplate ? activeTemplate.id : 1
  };
}

module.exports = {
  ensureDefaultTemplate,
  generateStudentSIF,
  DEFAULT_TEMPLATE_PATH,
  TEMPLATES_DIR,
  SIFS_DIR
};
