const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, getOne, query, execute } = require('../config/database');
const { compressImageBuffer, isImageFile } = require('./imageCompressionService');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const DOCUMENTS_BASE_DIR = path.join(UPLOADS_DIR, '201_files');

// Ensure base upload directory exists
if (!fs.existsSync(DOCUMENTS_BASE_DIR)) {
  fs.mkdirSync(DOCUMENTS_BASE_DIR, { recursive: true });
}

// Configurable maximum file size (default 10MB)
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_DOCUMENT_SIZE_MB || '10', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * 201-FILE Document Category Definitions
 */
const DOCUMENT_CATEGORIES = {
  curriculum: {
    key: 'curriculum',
    name: 'Curriculum',
    description: 'Official College of Computer Studies Curriculum checklist / program guide.',
    isMultiFile: false,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: false
  },
  data_privacy: {
    key: 'data_privacy',
    name: 'Data Privacy Consent',
    description: 'Signed Data Privacy Act (DPA 2012) consent and acknowledgement form.',
    isMultiFile: false,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: false
  },
  com: {
    key: 'com',
    name: 'Certificate of Matriculation (COM)',
    description: 'Official Certificate of Matriculation / Registration for current and past semesters.',
    isMultiFile: true,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: false
  },
  grades: {
    key: 'grades',
    name: 'Grades',
    description: 'Copy of Grades / Evaluation sheets for completed academic terms.',
    isMultiFile: true,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: false
  },
  return_slips: {
    key: 'return_slips',
    name: 'Return Slips',
    description: 'Acknowledged Return Slips from faculty or college administration.',
    isMultiFile: true,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: false
  },
  seminar_certificates: {
    key: 'seminar_certificates',
    name: 'Certificates of Seminars',
    description: 'Certificates of attendance for collegiate IT webinars, workshops, and technical seminars.',
    isMultiFile: true,
    allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png'],
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    seminarOnly: true // 3rd & 4th year students only
  }
};

/**
 * Determine if a student is eligible for seminar certificates based on database year level & section
 */
function isEligibleForSeminars(yearLevel, sectionName) {
  const cleanYl = (yearLevel || '').toLowerCase();
  const cleanSec = (sectionName || '').trim();

  // Check year level string
  if (cleanYl.includes('3rd') || cleanYl.includes('4th') || cleanYl.includes('3') || cleanYl.includes('4')) {
    return true;
  }

  // Check section name prefix (e.g., '3A', '3B', '4A', '4B')
  if (/^[34]/i.test(cleanSec)) {
    return true;
  }

  return false;
}

/**
 * Validate actual binary file content using magic byte signatures
 */
function validateFileSignature(buffer, declaredMimeType, extension) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'File is empty (0 bytes).' };
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `File exceeds maximum allowed size of ${MAX_FILE_SIZE_MB}MB.` };
  }

  const ext = extension.toLowerCase();

  // 1. PDF Check (%PDF signature: 25 50 44 46)
  if (ext === '.pdf' || declaredMimeType === 'application/pdf') {
    const isPdfMagic = buffer.length >= 4 &&
      buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
    if (!isPdfMagic) {
      return { valid: false, error: 'Corrupted or invalid PDF file format.' };
    }
    return { valid: true, mimeType: 'application/pdf', ext: '.pdf' };
  }

  // 2. PNG Check (89 50 4E 47 0D 0A 1A 0A)
  if (ext === '.png' || declaredMimeType === 'image/png') {
    const isPngMagic = buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;
    if (!isPngMagic) {
      return { valid: false, error: 'Corrupted or invalid PNG image format.' };
    }
    return { valid: true, mimeType: 'image/png', ext: '.png' };
  }

  // 3. JPEG Check (FF D8 FF)
  if (['.jpg', '.jpeg'].includes(ext) || ['image/jpeg', 'image/jpg'].includes(declaredMimeType)) {
    const isJpgMagic = buffer.length >= 3 &&
      buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    if (!isJpgMagic) {
      return { valid: false, error: 'Corrupted or invalid JPEG image format.' };
    }
    return { valid: true, mimeType: 'image/jpeg', ext: ext === '.jpeg' ? '.jpeg' : '.jpg' };
  }

  return { valid: false, error: 'Unsupported file type. Only PDF, JPG, and PNG files are accepted.' };
}

/**
 * Generate safe disk storage path and ensure student folder hierarchy
 */
function getStoragePathForStudent(studentId, categoryKey, safeFilename) {
  const studentFolder = path.join(DOCUMENTS_BASE_DIR, `student_${studentId}`, categoryKey);
  if (!fs.existsSync(studentFolder)) {
    fs.mkdirSync(studentFolder, { recursive: true });
  }
  return {
    studentFolder,
    fullPath: path.join(studentFolder, safeFilename),
    storageKey: `student_${studentId}/${categoryKey}/${safeFilename}`
  };
}

/**
 * Save an uploaded document file:
 * - Writes to local disk cache under uploads/201_files/student_{id}/{category}/
 * - Persists binary data to MySQL student_document_files table (survives Render restarts)
 * - Inserts metadata into student_documents table
 */
async function saveUploadedDocument({
  studentId,
  documentType,
  originalFilename,
  buffer,
  declaredMimeType,
  uploadedBy
}) {
  const category = DOCUMENT_CATEGORIES[documentType];
  if (!category) {
    throw new Error(`Invalid document category: "${documentType}".`);
  }

  // 1. Verify student exists in DB
  const student = await getOne(
    `SELECT s.*, sec.name as section_name FROM students s LEFT JOIN sections sec ON s.section_id = sec.id WHERE s.id = ?`,
    [studentId]
  );
  if (!student) {
    throw new Error('Student record not found.');
  }

  // 2. Validate Year Level Eligibility for Seminar Certificates
  if (category.seminarOnly) {
    const eligible = isEligibleForSeminars(student.year_level, student.section_name);
    if (!eligible) {
      throw new Error('Certificates of Seminars are only applicable to verified 3rd-year and 4th-year students.');
    }
  }

  // 3. Validate File Signature & Content
  const rawExt = path.extname(originalFilename || '').toLowerCase();
  const validation = validateFileSignature(buffer, declaredMimeType, rawExt);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // 4. Handle Single-File Categories (replace policy)
  if (!category.isMultiFile) {
    const existing = await getOne(`
      SELECT id, upload_status, original_filename
      FROM student_documents
      WHERE student_id = ? AND document_type = ? AND is_deleted = 0
      ORDER BY id DESC LIMIT 1
    `, [studentId, documentType]);

    if (existing) {
      if (existing.upload_status === 'verified') {
        throw new Error('This document has already been verified and locked by administration. Replacement is not permitted without administrative authorization.');
      }
      // Soft-delete previous file record
      await execute(`
        UPDATE student_documents
        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
        WHERE id = ?
      `, [uploadedBy || 'system_replace', existing.id]);
    }
  }

  // 4b. Automatic Image Compression (JPEG / PNG)
  // Preserves aspect ratio, EXIF orientation, and PNG transparency
  let fileBufferToSave = buffer;
  let fileMimeToSave = validation.mimeType;
  let compressionInfo = null;

  if (isImageFile(validation.mimeType, originalFilename)) {
    try {
      const compressionResult = await compressImageBuffer(buffer, validation.mimeType, originalFilename);
      if (compressionResult && compressionResult.compressed && compressionResult.buffer) {
        fileBufferToSave = compressionResult.buffer;
        fileMimeToSave = compressionResult.mimeType || validation.mimeType;
        compressionInfo = {
          compressed: true,
          originalSize: compressionResult.originalSize,
          compressedSize: compressionResult.compressedSize,
          savingsPercent: compressionResult.savingsPercent
        };
      }
    } catch (compressErr) {
      console.warn(`[STORAGE] Automatic compression failed for "${originalFilename}": ${compressErr.message}. Safely using original buffer.`);
    }
  }

  // 5. Generate Safe Storage Filename
  const safeRandom = crypto.randomBytes(6).toString('hex');
  const safeFilename = `${documentType}_std${studentId}_${Date.now()}_${safeRandom}${validation.ext}`;
  const { fullPath, storageKey } = getStoragePathForStudent(studentId, documentType, safeFilename);

  // 6. Write file to disk cache (using compressed buffer if image was compressed)
  fs.writeFileSync(fullPath, fileBufferToSave);

  // 7. Store document metadata in MySQL (including original vs compressed size)
  const insertResult = await execute(`
    INSERT INTO student_documents (
      student_id, document_type, original_filename, storage_key,
      mime_type, file_size, original_file_size, upload_status, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', CURRENT_TIMESTAMP)
  `, [
    studentId,
    documentType,
    path.basename(originalFilename),
    storageKey,
    fileMimeToSave,
    fileBufferToSave.length,
    buffer.length
  ]);

  const documentId = insertResult.insertId;

  // 8. Persist binary file data in MySQL (guarantees survival on Render restarts/redeployments)
  await execute(`
    INSERT INTO student_document_files (document_id, file_data)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE file_data = VALUES(file_data)
  `, [documentId, fileBufferToSave]);

  // 9. Record in Audit Log
  try {
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
      VALUES (?, 'DOCUMENT_UPLOAD', 'student_documents', ?, ?)
    `, [
      student.user_id || null,
      documentId.toString(),
      JSON.stringify({
        studentId,
        documentType,
        originalFilename: path.basename(originalFilename),
        fileSize: fileBufferToSave.length,
        originalFileSize: buffer.length,
        compressed: !!(compressionInfo && compressionInfo.compressed),
        compressionSavings: compressionInfo ? `${compressionInfo.savingsPercent}%` : null,
        storageKey
      })
    ]);
  } catch (auditErr) {
    console.warn('[AUDIT] Failed to record upload audit:', auditErr.message);
  }

  return {
    id: documentId,
    studentId,
    documentType,
    originalFilename: path.basename(originalFilename),
    storageKey,
    mimeType: fileMimeToSave,
    fileSize: fileBufferToSave.length,
    originalFileSize: buffer.length,
    compressionInfo,
    uploadStatus: 'uploaded'
  };
}

/**
 * Ensure document exists on disk cache, restoring from database BLOB if missing (e.g. after Render restart)
 */
async function ensureDocumentOnDisk(docRecord) {
  if (!docRecord) return null;

  // Determine full disk path
  const fullPath = path.isAbsolute(docRecord.storage_key)
    ? docRecord.storage_key
    : path.join(DOCUMENTS_BASE_DIR, docRecord.storage_key);

  // If file already exists on disk cache, return immediately
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }

  console.log(`[STORAGE] Document missing on disk (${fullPath}). Restoring from persistent database backup...`);

  // Fetch binary blob from MySQL
  const fileBlobRecord = await getOne(
    `SELECT file_data FROM student_document_files WHERE document_id = ?`,
    [docRecord.id]
  );

  if (!fileBlobRecord || !fileBlobRecord.file_data) {
    console.error(`[STORAGE] Document BLOB missing in database for document ID ${docRecord.id}`);
    return null;
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(fullPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Write restored file to disk
  fs.writeFileSync(fullPath, fileBlobRecord.file_data);
  console.log(`✓ Document ID ${docRecord.id} successfully restored to disk: ${fullPath}`);

  return fullPath;
}

/**
 * Get comprehensive document checklist and files for a student
 */
async function getStudentDocumentOverview(studentId) {
  const student = await getOne(`
    SELECT s.*, sec.name as section_name, gf.id as generated_file_id, gf.file_name as pis_file_name, gf.generated_at as pis_generated_at
    FROM students s
    LEFT JOIN sections sec ON s.section_id = sec.id
    LEFT JOIN generated_files gf ON s.id = gf.student_id
    WHERE s.id = ?
  `, [studentId]);

  if (!student) return null;

  const eligibleForSeminars = isEligibleForSeminars(student.year_level, student.section_name);

  // Fetch all active (non-deleted) uploaded documents
  const documents = await query(`
    SELECT 
      id, student_id, document_type, original_filename, storage_key,
      mime_type, file_size, original_file_size, upload_status, uploaded_at, verified_by,
      verified_at, admin_remarks
    FROM student_documents
    WHERE student_id = ? AND is_deleted = 0
    ORDER BY uploaded_at DESC, id DESC
  `, [studentId]);

  // Group files by category
  const filesByCategory = {};
  Object.keys(DOCUMENT_CATEGORIES).forEach(k => {
    filesByCategory[k] = [];
  });

  documents.forEach(doc => {
    if (filesByCategory[doc.document_type]) {
      filesByCategory[doc.document_type].push(doc);
    }
  });

  // Calculate category status and checklist
  const categoriesList = [];

  // 1. Personal Information Sheet (PIS) - Existing Module Integration
  const pisStatus = student.generated_file_id ? 'verified' : 'missing';
  categoriesList.push({
    key: 'pis',
    name: 'Personal Information Sheet (PIS)',
    description: 'Official College of Computer Studies Student Personal Information Sheet PDF.',
    isMultiFile: false,
    status: pisStatus,
    statusLabel: pisStatus === 'verified' ? 'Generated' : 'Missing',
    filesCount: student.generated_file_id ? 1 : 0,
    files: student.generated_file_id ? [{
      id: student.generated_file_id,
      document_type: 'pis',
      original_filename: student.pis_file_name,
      file_size: null,
      upload_status: 'verified',
      uploaded_at: student.pis_generated_at,
      isPis: true
    }] : [],
    isEligible: true
  });

  // 2. Uploadable Document Categories
  for (const [key, cat] of Object.entries(DOCUMENT_CATEGORIES)) {
    const isEligible = cat.seminarOnly ? eligibleForSeminars : true;
    const catFiles = filesByCategory[key] || [];

    let status = 'missing';
    let statusLabel = 'Missing';

    if (catFiles.length > 0) {
      const hasRejected = catFiles.some(f => f.upload_status === 'rejected');
      const allVerified = catFiles.every(f => f.upload_status === 'verified');
      const hasUploaded = catFiles.some(f => f.upload_status === 'uploaded');

      if (hasRejected) {
        status = 'rejected';
        statusLabel = 'Requires Resubmission';
      } else if (allVerified) {
        status = 'verified';
        statusLabel = 'Verified';
      } else if (hasUploaded) {
        status = 'uploaded';
        statusLabel = 'Pending Review';
      }
    }

    categoriesList.push({
      key,
      name: cat.name,
      description: cat.description,
      isMultiFile: cat.isMultiFile,
      status,
      statusLabel,
      filesCount: catFiles.length,
      files: catFiles,
      isEligible,
      seminarOnly: cat.seminarOnly
    });
  }

  // Overall checklist metrics
  const applicableCategories = categoriesList.filter(c => c.isEligible);
  const completedCount = applicableCategories.filter(c => c.status === 'verified').length;
  const pendingCount = applicableCategories.filter(c => c.status === 'uploaded').length;
  const missingCount = applicableCategories.filter(c => c.status === 'missing').length;
  const rejectedCount = applicableCategories.filter(c => c.status === 'rejected').length;

  return {
    student: {
      id: student.id,
      student_id: student.student_id,
      name: `${student.first_name || ''} ${student.last_name || ''}`.trim(),
      firstName: student.first_name,
      lastName: student.last_name,
      email: student.email,
      sectionId: student.section_id,
      sectionName: student.section_name || 'Unassigned',
      yearLevel: student.year_level || '1st Year',
      eligibleForSeminars
    },
    checklist: {
      totalCategories: applicableCategories.length,
      completedCount,
      pendingCount,
      missingCount,
      rejectedCount,
      percentage: Math.round((completedCount / applicableCategories.length) * 100)
    },
    categories: categoriesList
  };
}

/**
 * Delete or soft-delete an uploaded document
 */
async function deleteDocument(documentId, studentId, userEmail, isAdmin = false) {
  const doc = await getOne(`SELECT * FROM student_documents WHERE id = ? AND is_deleted = 0`, [documentId]);
  if (!doc) {
    throw new Error('Document not found or already deleted.');
  }

  // Student ownership check
  if (!isAdmin && doc.student_id !== studentId) {
    throw new Error('Access denied. You can only delete your own documents.');
  }

  // Locked verification check
  if (!isAdmin && doc.upload_status === 'verified') {
    throw new Error('Cannot delete a document that has been officially verified by administration.');
  }

  // Soft delete record
  await execute(`
    UPDATE student_documents
    SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
    WHERE id = ?
  `, [userEmail, documentId]);

  // Optionally clean up disk file
  const fullPath = path.isAbsolute(doc.storage_key)
    ? doc.storage_key
    : path.join(DOCUMENTS_BASE_DIR, doc.storage_key);

  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch (e) {
      console.warn('Could not remove file from disk:', e.message);
    }
  }

  // Record Audit Log
  try {
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
      VALUES (NULL, 'DOCUMENT_DELETE', 'student_documents', ?, ?)
    `, [
      documentId.toString(),
      JSON.stringify({
        deletedBy: userEmail,
        isAdmin,
        originalFilename: doc.original_filename,
        documentType: doc.document_type
      })
    ]);
  } catch (err) {}

  return { success: true, message: `Document "${doc.original_filename}" removed successfully.` };
}

/**
 * Administrator review action: Verify or Reject document
 */
async function updateDocumentStatus({
  documentId,
  status,
  remarks,
  adminUser
}) {
  if (!['uploaded', 'verified', 'rejected'].includes(status)) {
    throw new Error('Invalid status. Allowed: uploaded, verified, rejected.');
  }

  if (status === 'rejected' && (!remarks || !remarks.trim())) {
    throw new Error('Please provide specific remarks explaining why this document was rejected or what correction is required.');
  }

  const doc = await getOne(`SELECT * FROM student_documents WHERE id = ? AND is_deleted = 0`, [documentId]);
  if (!doc) {
    throw new Error('Document record not found.');
  }

  await execute(`
    UPDATE student_documents
    SET upload_status = ?,
        verified_by = ?,
        verified_at = CURRENT_TIMESTAMP,
        admin_remarks = ?
    WHERE id = ?
  `, [
    status,
    adminUser.email,
    remarks ? remarks.trim() : null,
    documentId
  ]);

  // Record Audit Log
  try {
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, 'student_documents', ?, ?)
    `, [
      adminUser.id,
      status === 'verified' ? 'DOCUMENT_VERIFY' : (status === 'rejected' ? 'DOCUMENT_REJECT' : 'DOCUMENT_STATUS_RESET'),
      documentId.toString(),
      JSON.stringify({
        adminEmail: adminUser.email,
        newStatus: status,
        remarks: remarks || '',
        previousStatus: doc.upload_status
      })
    ]);
  } catch (err) {}

  return {
    success: true,
    documentId,
    status,
    remarks: remarks || null,
    verifiedBy: adminUser.email
  };
}

module.exports = {
  DOCUMENT_CATEGORIES,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  isEligibleForSeminars,
  validateFileSignature,
  saveUploadedDocument,
  ensureDocumentOnDisk,
  getStudentDocumentOverview,
  deleteDocument,
  updateDocumentStatus
};
