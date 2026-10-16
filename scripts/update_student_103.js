const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execute } = require('../config/database');

async function main() {
  const studentId = 103;
  const compressedPath = 'C:\\Users\\Jhaydee\\Downloads\\OCP-BSIT-CURRICULUM-compressed.pdf';
  const buffer = fs.readFileSync(compressedPath);

  // Soft delete old verified test document for student 103
  await execute(
    'UPDATE student_documents SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ? WHERE student_id = ? AND document_type = ? AND is_deleted = 0',
    ['admin_curriculum_sync', studentId, 'curriculum']
  );

  const safeRandom = crypto.randomBytes(6).toString('hex');
  const safeFilename = `curriculum_std${studentId}_${Date.now()}_${safeRandom}.pdf`;
  const studentFolder = path.join(__dirname, '..', 'uploads', '201_files', `student_${studentId}`, 'curriculum');
  if (!fs.existsSync(studentFolder)) {
    fs.mkdirSync(studentFolder, { recursive: true });
  }
  const fullPath = path.join(studentFolder, safeFilename);
  const storageKey = `student_${studentId}/curriculum/${safeFilename}`;

  fs.writeFileSync(fullPath, buffer);

  const insertResult = await execute(
    'INSERT INTO student_documents (student_id, document_type, original_filename, storage_key, mime_type, file_size, original_file_size, upload_status, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [studentId, 'curriculum', 'OCP-BSIT-CURRICULUM.pdf', storageKey, 'application/pdf', buffer.length, 995137, 'uploaded']
  );

  const docId = insertResult.insertId;
  await execute(
    'INSERT INTO student_document_files (document_id, file_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE file_data = VALUES(file_data)',
    [docId, buffer]
  );

  console.log(`✓ Successfully updated Student #103 with official compressed BSIT curriculum (Document ID: ${docId}, StorageKey: ${storageKey})`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
