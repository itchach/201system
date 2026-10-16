const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { getPool, getOne, query, execute } = require('./config/database');
const { saveUploadedDocument, ensureDocumentOnDisk, deleteDocument } = require('./services/documentStorageService');
const { compressBase64Image } = require('./services/imageCompressionService');

async function runImageCompressionTests() {
  console.log('====================================================');
  console.log('STARTING AUTOMATIC IMAGE COMPRESSION VERIFICATION');
  console.log('====================================================\n');

  // 1. Get or create a test student in the database
  let student = await getOne("SELECT * FROM students LIMIT 1");
  if (!student) {
    console.log('Creating a temporary student for test...');
    const res = await execute(
      "INSERT INTO students (student_id, first_name, last_name, email, year_level) VALUES ('TEST-COMPRESS-01', 'Test', 'Compression', 'test.compress@school.edu.ph', '1st Year')"
    );
    student = await getOne("SELECT * FROM students WHERE id = ?", [res.insertId]);
  }
  console.log(`Using Student ID: ${student.id} (${student.student_id || student.email})\n`);

  const createdDocIds = [];

  try {
    // ----------------------------------------------------
    // TEST 1: JPEG Image Automatic Compression
    // ----------------------------------------------------
    console.log('--- TEST 1: JPEG Image Upload & Automatic Compression ---');
    // Generate a high-resolution, uncompressed test JPEG (1600x1200)
    const rawJpgBuffer = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 180, g: 60, b: 30 }
      }
    })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer();

    console.log(`Original JPEG file size: ${rawJpgBuffer.length} bytes (${(rawJpgBuffer.length / 1024).toFixed(1)} KB)`);

    const jpgUploadResult = await saveUploadedDocument({
      studentId: student.id,
      documentType: 'curriculum',
      originalFilename: 'test_curriculum_scan.jpg',
      buffer: rawJpgBuffer,
      declaredMimeType: 'image/jpeg',
      uploadedBy: 'compression_tester'
    });

    createdDocIds.push(jpgUploadResult.id);

    console.log(`Saved Document ID: ${jpgUploadResult.id}`);
    console.log(`Compressed JPEG file size: ${jpgUploadResult.fileSize} bytes (${(jpgUploadResult.fileSize / 1024).toFixed(1)} KB)`);
    console.log(`Compression savings: ${jpgUploadResult.compressionInfo ? jpgUploadResult.compressionInfo.savingsPercent : 0}% reduction`);

    if (jpgUploadResult.fileSize >= rawJpgBuffer.length) {
      throw new Error(`TEST 1 FAILED: Expected compressed size (${jpgUploadResult.fileSize}) to be smaller than original (${rawJpgBuffer.length})`);
    }

    // Verify metadata saved in student_documents table
    const docRow = await getOne("SELECT * FROM student_documents WHERE id = ?", [jpgUploadResult.id]);
    if (!docRow || docRow.file_size !== jpgUploadResult.fileSize) {
      throw new Error(`TEST 1 FAILED: student_documents table file_size (${docRow ? docRow.file_size : 'null'}) does not match compressed size (${jpgUploadResult.fileSize})`);
    }
    console.log('✓ Database metadata table (student_documents) correctly stores compressed file size');

    // Verify binary BLOB saved in student_document_files table
    const blobRow = await getOne("SELECT file_data FROM student_document_files WHERE document_id = ?", [jpgUploadResult.id]);
    if (!blobRow || !blobRow.file_data || blobRow.file_data.length !== jpgUploadResult.fileSize) {
      throw new Error(`TEST 1 FAILED: student_document_files table BLOB size (${blobRow && blobRow.file_data ? blobRow.file_data.length : 'null'}) does not match compressed size`);
    }
    console.log('✓ Database binary table (student_document_files) stores exact compressed buffer');

    // Verify disk file
    const diskPath = path.join(__dirname, 'uploads', '201_files', jpgUploadResult.storageKey);
    if (!fs.existsSync(diskPath)) {
      throw new Error(`TEST 1 FAILED: Disk file missing at ${diskPath}`);
    }
    const diskStat = fs.statSync(diskPath);
    if (diskStat.size !== jpgUploadResult.fileSize) {
      throw new Error(`TEST 1 FAILED: Disk file size (${diskStat.size}) does not match compressed size (${jpgUploadResult.fileSize})`);
    }
    console.log('✓ Disk cache stores exact compressed image');

    // Verify the saved image is readable and preserves aspect ratio
    const verifiedJpg = await sharp(diskPath).metadata();
    console.log(`✓ Saved JPEG image verified: ${verifiedJpg.width}x${verifiedJpg.height}, format: ${verifiedJpg.format}`);
    if (Math.round(verifiedJpg.width / verifiedJpg.height * 100) !== Math.round(1600 / 1200 * 100)) {
      throw new Error('TEST 1 FAILED: Aspect ratio was not preserved');
    }
    console.log('✓ Aspect ratio successfully preserved');
    console.log('>> TEST 1 PASSED ✓\n');

    // ----------------------------------------------------
    // TEST 2: PNG Image with Transparency
    // ----------------------------------------------------
    console.log('--- TEST 2: PNG Image Upload & Transparency Preservation ---');
    // Generate a transparent PNG
    const rawPngBuffer = await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 4,
        background: { r: 0, g: 120, b: 240, alpha: 0.4 }
      }
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    console.log(`Original PNG file size: ${rawPngBuffer.length} bytes (${(rawPngBuffer.length / 1024).toFixed(1)} KB)`);

    const pngUploadResult = await saveUploadedDocument({
      studentId: student.id,
      documentType: 'data_privacy',
      originalFilename: 'signed_privacy_form.png',
      buffer: rawPngBuffer,
      declaredMimeType: 'image/png',
      uploadedBy: 'compression_tester'
    });

    createdDocIds.push(pngUploadResult.id);

    console.log(`Saved Document ID: ${pngUploadResult.id}`);
    console.log(`Compressed PNG file size: ${pngUploadResult.fileSize} bytes (${(pngUploadResult.fileSize / 1024).toFixed(1)} KB)`);
    console.log(`Compression savings: ${pngUploadResult.compressionInfo ? pngUploadResult.compressionInfo.savingsPercent : 0}% reduction`);

    if (pngUploadResult.fileSize >= rawPngBuffer.length) {
      throw new Error(`TEST 2 FAILED: Expected compressed PNG size to be smaller than original`);
    }

    // Verify transparency retention in compressed PNG
    const pngDiskPath = path.join(__dirname, 'uploads', '201_files', pngUploadResult.storageKey);
    const pngMeta = await sharp(pngDiskPath).metadata();
    console.log(`✓ Saved PNG format: ${pngMeta.format}, channels: ${pngMeta.channels}, hasAlpha: ${pngMeta.hasAlpha}`);
    if (!pngMeta.hasAlpha || pngMeta.channels !== 4) {
      throw new Error('TEST 2 FAILED: PNG transparency was lost during compression');
    }
    console.log('✓ PNG transparency preserved perfectly');
    console.log('>> TEST 2 PASSED ✓\n');

    // ----------------------------------------------------
    // TEST 3: Non-Image File (PDF) Bypasses Compression
    // ----------------------------------------------------
    console.log('--- TEST 3: Non-Image File (PDF) Safe Bypass ---');
    // Generate minimal valid PDF
    const dummyPdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n160\n%%EOF';
    const pdfBuffer = Buffer.from(dummyPdfContent);

    const pdfUploadResult = await saveUploadedDocument({
      studentId: student.id,
      documentType: 'com',
      originalFilename: 'matriculation.pdf',
      buffer: pdfBuffer,
      declaredMimeType: 'application/pdf',
      uploadedBy: 'compression_tester'
    });

    createdDocIds.push(pdfUploadResult.id);

    console.log(`PDF Original size: ${pdfBuffer.length} bytes, Saved size: ${pdfUploadResult.fileSize} bytes`);
    if (pdfUploadResult.fileSize !== pdfBuffer.length) {
      throw new Error('TEST 3 FAILED: Non-image PDF was unexpectedly modified');
    }
    if (pdfUploadResult.compressionInfo) {
      throw new Error('TEST 3 FAILED: PDF should not have compressionInfo');
    }
    console.log('✓ PDF file safely saved byte-for-byte without altering format');
    console.log('>> TEST 3 PASSED ✓\n');

    // ----------------------------------------------------
    // TEST 4: Invalid/Corrupt Image Rejection
    // ----------------------------------------------------
    console.log('--- TEST 4: Invalid / Corrupt Image File Rejection ---');
    let rejected = false;
    try {
      await saveUploadedDocument({
        studentId: student.id,
        documentType: 'grades',
        originalFilename: 'fake_image.jpg',
        buffer: Buffer.from('NOT_AN_IMAGE_FAKE_BYTES'),
        declaredMimeType: 'image/jpeg',
        uploadedBy: 'compression_tester'
      });
    } catch (err) {
      rejected = true;
      console.log(`✓ Corrupt file properly rejected with error: "${err.message}"`);
    }

    if (!rejected) {
      throw new Error('TEST 4 FAILED: Corrupted image file was not rejected');
    }
    console.log('>> TEST 4 PASSED ✓\n');

    // ----------------------------------------------------
    // TEST 5: Student 1x1 Photo Base64 Auto-Compression
    // ----------------------------------------------------
    console.log('--- TEST 5: Student 1" x 1" Photo Base64 Compression ---');
    const photoBuffer = await sharp({
      create: {
        width: 1200,
        height: 1200,
        channels: 3,
        background: { r: 240, g: 200, b: 180 }
      }
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const photoBase64 = `data:image/jpeg;base64,${photoBuffer.toString('base64')}`;
    console.log(`Raw Photo Base64 length: ${photoBase64.length} characters`);

    const compressedPhoto = await compressBase64Image(photoBase64, { maxDimension: 600, quality: 85 });
    console.log(`Compressed Photo Base64 length: ${compressedPhoto.dataUrl.length} characters (${compressedPhoto.savingsPercent}% reduction)`);

    if (compressedPhoto.dataUrl.length >= photoBase64.length) {
      throw new Error('TEST 5 FAILED: Base64 photo compression did not reduce length');
    }
    console.log('✓ Student 1x1 photo base64 compression passed');
    console.log('>> TEST 5 PASSED ✓\n');

    // ----------------------------------------------------
    // TEST 6: Disk Cache Restoration from Database BLOB
    // ----------------------------------------------------
    console.log('--- TEST 6: Disk Cache Restoration from Database BLOB ---');
    // Remove the disk file created in Test 1 to simulate a server restart or deployment
    if (fs.existsSync(diskPath)) {
      fs.unlinkSync(diskPath);
      console.log('Deleted disk cache file to test restoration...');
    }

    const restoredPath = await ensureDocumentOnDisk(docRow);
    if (!fs.existsSync(restoredPath)) {
      throw new Error('TEST 6 FAILED: Failed to restore compressed document from DB BLOB');
    }
    const restoredSize = fs.statSync(restoredPath).size;
    if (restoredSize !== jpgUploadResult.fileSize) {
      throw new Error(`TEST 6 FAILED: Restored size (${restoredSize}) does not match saved size (${jpgUploadResult.fileSize})`);
    }
    console.log(`✓ Restored compressed document from MySQL BLOB: ${restoredSize} bytes`);
    console.log('>> TEST 6 PASSED ✓\n');

    console.log('====================================================');
    console.log('ALL 6 AUTOMATIC IMAGE COMPRESSION TESTS PASSED! ✓');
    console.log('====================================================');

  } finally {
    // Clean up all created test documents from DB and disk
    console.log('\nCleaning up test artifacts...');
    for (const docId of createdDocIds) {
      try {
        await execute("DELETE FROM student_document_files WHERE document_id = ?", [docId]);
        const doc = await getOne("SELECT storage_key FROM student_documents WHERE id = ?", [docId]);
        if (doc) {
          const fp = path.join(__dirname, 'uploads', '201_files', doc.storage_key);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        await execute("DELETE FROM student_documents WHERE id = ?", [docId]);
      } catch (cleanupErr) {
        console.warn('Cleanup error:', cleanupErr.message);
      }
    }
    console.log('Cleanup completed successfully.');
  }

  process.exit(0);
}

runImageCompressionTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED WITH ERROR:', err);
  process.exit(1);
});
