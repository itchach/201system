const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');

async function main() {
  const students = await query('SELECT count(*) as count FROM students');
  const curriculums = await query("SELECT count(DISTINCT student_id) as count FROM student_documents WHERE document_type = 'curriculum' AND is_deleted = 0");
  const filesBlobs = await query("SELECT count(*) as count FROM student_document_files sdf JOIN student_documents sd ON sdf.document_id = sd.id WHERE sd.document_type = 'curriculum' AND sd.is_deleted = 0");
  
  const baseDir = path.join(__dirname, '..', 'uploads', '201_files');
  const folders = fs.readdirSync(baseDir).filter(f => f.startsWith('student_'));
  
  console.log('--- Verification Report ---');
  console.log('Total students in DB:', students[0].count);
  console.log('Distinct students with active curriculum in DB:', curriculums[0].count);
  console.log('Total curriculum binary BLOBs persisted in MySQL:', filesBlobs[0].count);
  console.log('Total student folders on disk under uploads/201_files:', folders.length);
  
  // Sample check on 3 students
  const sampleIds = [2, 103, 185];
  for (const id of sampleIds) {
    const sDir = path.join(baseDir, `student_${id}`, 'curriculum');
    const files = fs.existsSync(sDir) ? fs.readdirSync(sDir) : [];
    console.log(`Student #${id} curriculum folder: ${files.join(', ')}`);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
