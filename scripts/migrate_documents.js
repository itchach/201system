require('dotenv').config();
const { getPool } = require('../config/database');

async function migrate() {
  console.log('[MIGRATION] Running document tables migration...');
  const p = getPool();

  // 1. Ensure year_level column in students table
  try {
    const [ylCheck] = await p.query("SHOW COLUMNS FROM students LIKE 'year_level'");
    if (ylCheck.length === 0) {
      await p.query("ALTER TABLE students ADD COLUMN year_level VARCHAR(50) NOT NULL DEFAULT '1st Year'");
      console.log('✓ Added year_level column to students table.');
    } else {
      console.log('✓ year_level column already exists on students table.');
    }
  } catch (err) {
    console.error('Error with year_level column:', err.message);
  }

  // 2. High-speed server-side sync of year_level from JSON without pulling giant photo blobs over network
  try {
    const [updateResult] = await p.query(`
      UPDATE students s
      JOIN student_information si ON s.id = si.student_id
      SET s.year_level = JSON_UNQUOTE(JSON_EXTRACT(si.form_data, '$.yearLevel'))
      WHERE JSON_EXTRACT(si.form_data, '$.yearLevel') IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(si.form_data, '$.yearLevel')) != ''
    `);
    console.log(`✓ Fast-synced year_level on database: ${updateResult.affectedRows} rows updated.`);
  } catch (err) {
    console.warn('Note on year_level fast sync:', err.message);
  }

  // 3. Create student_documents table
  await p.query(`
    CREATE TABLE IF NOT EXISTS student_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      document_type VARCHAR(50) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      storage_key VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      file_size INT NOT NULL,
      upload_status ENUM('uploaded', 'verified', 'rejected') NOT NULL DEFAULT 'uploaded',
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verified_by VARCHAR(255) NULL,
      verified_at DATETIME NULL,
      admin_remarks TEXT NULL,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      deleted_at DATETIME NULL,
      deleted_by VARCHAR(255) NULL,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      INDEX idx_student_id (student_id),
      INDEX idx_doc_type (document_type),
      INDEX idx_status (upload_status)
    ) ENGINE=InnoDB;
  `);
  console.log('✓ student_documents table ready.');

  // 4. Create student_document_files table
  await p.query(`
    CREATE TABLE IF NOT EXISTS student_document_files (
      document_id INT PRIMARY KEY,
      file_data LONGBLOB NOT NULL,
      FOREIGN KEY (document_id) REFERENCES student_documents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);
  console.log('✓ student_document_files table ready.');

  const [tables] = await p.query('SHOW TABLES');
  console.log('✓ Current tables:', tables.map(r => Object.values(r)[0]));
  console.log('[MIGRATION] Migration completed successfully.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('[MIGRATION ERROR]', err);
  process.exit(1);
});
