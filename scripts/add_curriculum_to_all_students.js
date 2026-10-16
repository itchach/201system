const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, PDFRef, PDFName, PDFNumber } = require('pdf-lib');
const { query } = require('../config/database');
const { saveUploadedDocument } = require('../services/documentStorageService');

async function main() {
  // Use user-uploaded original PDF or Downloads path
  const userUploadPath = 'C:\\Users\\Jhaydee\\.gemini\\antigravity-ide\\brain\\7609e1c2-9f37-4f49-ae70-3f33372c07bd\\.user_uploaded\\media_1792110574465.pdf';
  const downloadsPath = 'C:\\Users\\Jhaydee\\Downloads\\OCP-BSIT-CURRICULUM.pdf';
  
  const sourcePdfPath = fs.existsSync(userUploadPath) ? userUploadPath : downloadsPath;
  if (!fs.existsSync(sourcePdfPath)) {
    throw new Error(`Source PDF not found at ${sourcePdfPath}`);
  }

  const rawBytes = fs.readFileSync(sourcePdfPath);
  console.log(`Original PDF file size: ${rawBytes.length} bytes (${(rawBytes.length / 1024).toFixed(1)} KB)`);

  // 1. Compress PDF:
  // - Extract and compress background watermark/header JPEG with sharp (mozjpeg, quality 75)
  // - Copy pages to fresh document to eliminate orphaned objects / metadata bloat
  // - Re-save with object streams enabled
  const origDoc = await PDFDocument.load(rawBytes);
  const imgStream = origDoc.context.lookup(PDFRef.of(8, 0));
  if (imgStream && imgStream.contents) {
    const origImgLen = imgStream.contents.length;
    const compImg = await sharp(imgStream.contents).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
    imgStream.contents = compImg;
    imgStream.dict.set(PDFName.of('Length'), PDFNumber.of(compImg.length));
    console.log(`Optimized background image: ${origImgLen} bytes -> ${compImg.length} bytes`);
  }

  const newDoc = await PDFDocument.create();
  const pageCount = origDoc.getPageCount();
  const copiedPages = await newDoc.copyPages(origDoc, Array.from({ length: pageCount }, (_, i) => i));
  copiedPages.forEach(p => newDoc.addPage(p));

  const compressedPdfBytes = await newDoc.save({ useObjectStreams: true });
  const compressedBuffer = Buffer.from(compressedPdfBytes);
  console.log(`Compressed PDF size: ${compressedBuffer.length} bytes (${(compressedBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`Compression savings: ${((1 - compressedBuffer.length / rawBytes.length) * 100).toFixed(1)}%`);

  // Save compressed version to Downloads
  const compressedOutputPath = 'C:\\Users\\Jhaydee\\Downloads\\OCP-BSIT-CURRICULUM-compressed.pdf';
  fs.writeFileSync(compressedOutputPath, compressedBuffer);
  console.log(`✓ Saved compressed PDF to: ${compressedOutputPath}`);

  // Also update OCP-BSIT-CURRICULUM.pdf in Downloads so the original file itself is compressed as requested
  fs.writeFileSync(downloadsPath, compressedBuffer);
  console.log(`✓ Updated Downloads PDF with compressed version: ${downloadsPath}`);

  // 2. Fetch all existing students in the system
  const students = await query('SELECT id, student_id, first_name, last_name, year_level, section_id FROM students ORDER BY id ASC');
  console.log(`Found ${students.length} existing students in the database.`);

  let successCount = 0;
  let errorCount = 0;

  for (const student of students) {
    try {
      const res = await saveUploadedDocument({
        studentId: student.id,
        documentType: 'curriculum',
        originalFilename: 'OCP-BSIT-CURRICULUM.pdf',
        buffer: compressedBuffer,
        declaredMimeType: 'application/pdf',
        uploadedBy: 'system_curriculum_sync'
      });
      successCount++;
      console.log(`[${successCount}/${students.length}] Added curriculum for Student #${student.id} (${student.student_id} - ${student.first_name} ${student.last_name})`);
    } catch (err) {
      errorCount++;
      console.error(`Failed for Student #${student.id} (${student.student_id}):`, err.message);
    }
  }

  console.log('\n--- Final Summary ---');
  console.log(`Total students processed: ${students.length}`);
  console.log(`Successfully added: ${successCount}`);
  console.log(`Failed: ${errorCount}`);
  console.log(`Original PDF: ${(rawBytes.length / 1024).toFixed(1)} KB`);
  console.log(`Compressed PDF: ${(compressedBuffer.length / 1024).toFixed(1)} KB (-${((1 - compressedBuffer.length / rawBytes.length) * 100).toFixed(1)}%)`);
}

main().then(() => {
  console.log('Finished successfully.');
  process.exit(0);
}).catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
