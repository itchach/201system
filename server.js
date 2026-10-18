require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { initDatabase, query, getOne, execute } = require('./config/database');
const { ensureDefaultTemplate, generateStudentSIF, SIFS_DIR, TEMPLATES_DIR } = require('./services/pdfService');
const {
  DOCUMENT_CATEGORIES,
  isEligibleForSeminars,
  saveUploadedDocument,
  ensureDocumentOnDisk,
  getStudentDocumentOverview,
  deleteDocument,
  updateDocumentStatus
} = require('./services/documentStorageService');
const { compressBase64Image } = require('./services/imageCompressionService');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'olivarezcollege.edu.ph').toLowerCase();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').replace(/^["']|["']$/g, '').trim();
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30', 10);
const INACTIVITY_TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60 * 1000;

// Revoked Session Store (Tracks logged out sessions for instant invalidation)
const revokedSessions = new Set();

// Google OAuth Client
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);

// Initialize Database & Default Template
(async () => {
  try {
    await initDatabase();
    console.log('✓ XAMPP MySQL Database connected and initialized.');
    await ensureDefaultTemplate();
  } catch (err) {
    console.error('Database/Template initialization error:', err.message);
  }
})();

// Determine environment before any middleware that depends on it
const isProduction = process.env.NODE_ENV === 'production';

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ── CRITICAL: Trust Render's reverse proxy so Express sees HTTPS ──
// Without this, secure:true cookies are silently dropped because Express
// sees the connection as plain HTTP (the proxy terminates TLS before it
// reaches the Node process). MUST be set before cookieSession.
if (isProduction) {
  app.set('trust proxy', 1);
  console.log('[CONFIG] trust proxy = 1 (production)');
}

// Middleware
// Frontend and API share the same Render domain, so CORS is same-origin.
// We still mount cors() for any potential cross-origin preflight, but only
// allow the known production and development origins.
const allowedOrigins = [
  'https://two01system.onrender.com',
  'http://localhost:3000'
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Secure Cookie Session
app.use(
  cookieSession({
    name: 'oc_sif_session',
    // Use the Render environment variable; fall back to dev-only default.
    // Set SESSION_SECRET in Render dashboard for production!
    keys: [process.env.SESSION_SECRET || 'dev_only_fallback_change_in_production'],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours max cookie life
    httpOnly: true,              // Prevent client-side JS access
    sameSite: 'lax',             // CSRF protection (lax works with GIS redirect)
    secure: isProduction         // HTTPS only in production (requires trust proxy)
  })
);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Multer storage for PDF templates (Private Storage)
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMPLATES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});
const uploadTemplate = multer({
  storage: templateStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF template files (.pdf) are permitted.'));
    }
  }
});

// Multer memory storage for Student 201-File Documents (Validates buffer & signatures in service)
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// ==========================================
// AUTHENTICATION & INACTIVITY MIDDLEWARE
// ==========================================

// Authenticate session & enforce 30-minute inactivity timeout
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || (req.session.sessionId && revokedSessions.has(req.session.sessionId))) {
    req.session = null;
    return res.status(401).json({ error: 'Unauthorized. Please sign in using your Olivarez College Google account.' });
  }

  // Check 30-minute inactivity timeout for shared computer safety
  const now = Date.now();
  if (req.session.lastActivity && (now - req.session.lastActivity > INACTIVITY_TIMEOUT_MS)) {
    if (req.session.sessionId) revokedSessions.add(req.session.sessionId);
    req.session = null;
    return res.status(401).json({ error: 'Session expired due to 30 minutes of inactivity. Please sign in again.' });
  }
  req.session.lastActivity = now;

  // Anti-caching headers for shared school computers
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

// Require Administrator Role
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
}

// ==========================================
// 1. GOOGLE AUTHENTICATION ENDPOINTS
// ==========================================

// Public Configuration endpoint (provides Google Client ID to frontend)
app.get('/api/auth/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    allowedDomain: ALLOWED_DOMAIN,
    timeoutMinutes: SESSION_TIMEOUT_MINUTES
  });
});

// PRIMARY GOOGLE SIGN-IN — Accepts ONLY a cryptographically verified Google ID Token
// The email and google_id (sub) are extracted exclusively from the verified token payload.
// Client-supplied email addresses are NEVER trusted or used for authentication.
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;

  // Reject any request that does not include a Google ID token
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({
      error: 'A valid Google ID token is required. Please sign in using the Google Sign-In button.'
    });
  }

  let googleUser = null;

  // --- 1. Verify Google ID Token ---
  try {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({
        error: 'Google Sign-In is not yet configured on this server. Please contact the system administrator to set up GOOGLE_CLIENT_ID.'
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    if (!payload || !payload.sub || !payload.email) {
      return res.status(401).json({ error: 'Google token verification failed: missing identity claims.' });
    }

    if (!payload.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified.' });
    }

    googleUser = {
      googleId: payload.sub,
      email: payload.email.trim().toLowerCase(),
      name: payload.name || payload.email,
      hostedDomain: (payload.hd || '').toLowerCase()
    };
  } catch (err) {
    console.error('[AUTH] Google ID token cryptographic verification error:', err.message);
    return res.status(401).json({ error: 'Google authentication failed. Please try again.' });
  }

  // --- 2. Strict Domain Verification ---
  const emailDomain = googleUser.email.split('@')[1] || '';
  if (emailDomain !== ALLOWED_DOMAIN && googleUser.hostedDomain !== ALLOWED_DOMAIN) {
    return res.status(403).json({
      error: 'Please sign in using your Olivarez College Google account.'
    });
  }

  // --- 3. Database User Authorization & Session Creation ---
  try {
    let user = await getOne('SELECT * FROM users WHERE LOWER(email) = ?', [googleUser.email]);

    if (!user) {
      console.warn(`[AUTH] Unauthorized user attempted sign-in: ${googleUser.email}`);
      return res.status(403).json({
        error: 'Your account is not authorized to access this system. Please contact the administrator.'
      });
    }

    if (user.status !== 'active') {
      console.warn(`[AUTH] Inactive user attempted sign-in: ${googleUser.email}`);
      return res.status(403).json({
        error: 'Your account is not authorized to access this system. Please contact the administrator.'
      });
    }

    // Bind Google ID on first login
    if (googleUser.googleId && user.google_id !== googleUser.googleId) {
      if (user.google_id && user.google_id !== googleUser.googleId) {
        console.warn(`[SECURITY] Google ID mismatch for user ${user.email}: stored=${user.google_id}, presented=${googleUser.googleId}`);
        return res.status(403).json({
          error: 'Google account identity mismatch. Please contact the administrator.'
        });
      }
      await execute('UPDATE users SET google_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [googleUser.googleId, user.id]);
      user.google_id = googleUser.googleId;
    }

    // Create Secure Session
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2);
    req.session.sessionId = sessionId;
    req.session.user = {
      id: user.id,
      googleId: user.google_id,
      email: user.email,
      name: user.name,
      role: user.role
    };
    req.session.lastActivity = Date.now();

    console.log('[AUTH] Session created:', !!req.session, req.session?.user?.email, '| secure:', isProduction, '| proto:', req.protocol);

    res.json({
      message: 'Authentication successful',
      user: req.session.user
    });
  } catch (err) {
    console.error('[AUTH] Database error during user authorization lookup:', err.message, err.code || '');
    res.status(500).json({ error: 'Database service unavailable. Please contact the administrator.' });
  }
});

// REMOVED: /api/auth/login endpoint has been permanently removed.
// Authentication via a client-supplied email address is a security violation
// and is not permitted under any circumstances.
// All authentication MUST go through POST /api/auth/google with a verified Google ID token.

// Get Current User Profile & Role (Protected)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  // Diagnostic log — confirms the session cookie was correctly sent back
  console.log('[AUTH/ME] Session:', !!req.session, req.session?.user?.email, '| proto:', req.protocol);
  try {
    const user = await getOne('SELECT id, google_id, email, name, role, status FROM users WHERE id = ?', [req.session.user.id]);
    if (!user || user.status !== 'active') {
      req.session = null;
      return res.json({ user: null });
    }

    let studentData = null;
    if (user.role === 'student') {
      const student = await getOne(`
        SELECT s.*, sec.name as section_name, gf.file_name, gf.id as generated_file_id
        FROM students s
        LEFT JOIN sections sec ON s.section_id = sec.id
        LEFT JOIN generated_files gf ON s.id = gf.student_id
        WHERE s.user_id = ? OR LOWER(s.email) = ?
        ORDER BY gf.id DESC LIMIT 1
      `, [user.id, user.email.toLowerCase()]);

      if (student && !student.user_id) {
        await execute('UPDATE students SET user_id = ? WHERE id = ?', [user.id, student.id]);
        student.user_id = user.id;
      }

      studentData = student;
    }

    res.json({
      user,
      student: studentData
    });
  } catch (err) {
    console.error('Error fetching current user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign Out & Invalidate Session
app.post('/api/auth/logout', (req, res) => {
  if (req.session && req.session.sessionId) {
    revokedSessions.add(req.session.sessionId);
  }
  req.session = null;
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');
  res.json({ message: 'Signed out successfully' });
});

// ==========================================
// 2. DASHBOARD & STATS (ADMIN ONLY)
// ==========================================

app.get('/api/dashboard/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const secRow = await getOne("SELECT COUNT(*) as count FROM sections WHERE status = 'active'");
    const stuRow = await getOne('SELECT COUNT(*) as count FROM students');
    const sifRow = await getOne('SELECT COUNT(*) as count FROM generated_files');
    const docRow = await getOne('SELECT COUNT(*) as count FROM student_documents WHERE is_deleted = 0');

    const totalSections = secRow ? secRow.count : 0;
    const totalStudents = stuRow ? stuRow.count : 0;
    const totalSifs = sifRow ? sifRow.count : 0;
    const totalDocuments = docRow ? docRow.count : 0;

    const sectionBreakdown = await query(`
      SELECT 
        sec.id,
        sec.name,
        sec.status,
        COUNT(DISTINCT s.id) as student_count,
        COUNT(DISTINCT gf.id) as sif_count,
        COUNT(DISTINCT sd.id) as doc_count
      FROM sections sec
      LEFT JOIN students s ON sec.id = s.section_id
      LEFT JOIN generated_files gf ON s.id = gf.student_id
      LEFT JOIN student_documents sd ON s.id = sd.student_id AND sd.is_deleted = 0
      GROUP BY sec.id, sec.name, sec.status
      ORDER BY sec.name ASC
    `);

    res.json({
      totalSections,
      totalStudents,
      totalSifs,
      totalDocuments,
      sections: sectionBreakdown
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

// ==========================================
// 3. SECTION MANAGEMENT (DYNAMIC)
// ==========================================

// Get All Sections (Admin Only)
app.get('/api/sections', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sections = await query(`
      SELECT 
        sec.id,
        sec.name,
        sec.status,
        sec.created_at,
        COUNT(DISTINCT s.id) as student_count,
        COUNT(DISTINCT gf.id) as sif_count
      FROM sections sec
      LEFT JOIN students s ON sec.id = s.section_id
      LEFT JOIN generated_files gf ON s.id = gf.student_id
      GROUP BY sec.id, sec.name, sec.status, sec.created_at
      ORDER BY sec.name ASC
    `);
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sections.' });
  }
});

// Get Only Active Sections (For Student Web Form Dynamic Dropdown)
app.get('/api/sections/active', requireAuth, async (req, res) => {
  try {
    const activeSections = await query(`
      SELECT id, name FROM sections 
      WHERE status = 'active' 
      ORDER BY name ASC
    `);
    res.json(activeSections);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load active sections.' });
  }
});

// Admin: Create Section
app.post('/api/sections', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Section name is required.' });
  }

  const cleanName = name.trim().toUpperCase();

  try {
    const existing = await getOne('SELECT id FROM sections WHERE UPPER(name) = ?', [cleanName]);
    if (existing) {
      return res.status(400).json({ error: `Section "${cleanName}" already exists.` });
    }

    const info = await execute('INSERT INTO sections (name, status) VALUES (?, ?)', [cleanName, 'active']);

    const sectionDir = path.join(SIFS_DIR, cleanName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!fs.existsSync(sectionDir)) {
      fs.mkdirSync(sectionDir, { recursive: true });
    }

    res.status(201).json({
      message: `Section ${cleanName} created successfully.`,
      section: { id: info.insertId, name: cleanName, status: 'active' }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create section.' });
  }
});

// Admin: Edit Section Name
app.put('/api/sections/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Section name is required.' });
  }
  const cleanName = name.trim().toUpperCase();

  try {
    const section = await getOne('SELECT * FROM sections WHERE id = ?', [id]);
    if (!section) {
      return res.status(404).json({ error: 'Section not found.' });
    }

    await execute('UPDATE sections SET name = ? WHERE id = ?', [cleanName, id]);
    res.json({ message: 'Section renamed successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename section.' });
  }
});

// Admin: Toggle Archive / Reactivate Section
app.patch('/api/sections/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  try {
    await execute('UPDATE sections SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `Section marked as ${status}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update section status.' });
  }
});

// Admin: View Students & SIF Files under a Section
app.get('/api/sections/:id/students', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const section = await getOne('SELECT * FROM sections WHERE id = ?', [id]);
    if (!section) {
      return res.status(404).json({ error: 'Section not found.' });
    }

    const students = await query(`
      SELECT 
        s.id,
        s.student_id,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.email,
        gf.id as generated_file_id,
        gf.file_name,
        gf.file_size,
        gf.generated_at as sif_created_at
      FROM students s
      LEFT JOIN generated_files gf ON s.id = gf.student_id
      WHERE s.section_id = ?
      ORDER BY s.last_name ASC, s.first_name ASC
    `, [id]);

    res.json({
      section,
      students
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load section students.' });
  }
});

// ==========================================
// 4. STUDENT INFORMATION & SIF GENERATION (WITH IDOR PROTECTION)
// ==========================================

// Student: Get Own Information Form Data (Strict Ownership Check)
app.get('/api/student/info', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  try {
    const student = await getOne(`
      SELECT s.*, sec.name as section_name, gf.id as generated_file_id, gf.file_name, gf.generated_at as sif_generated_at
      FROM students s
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN generated_files gf ON s.id = gf.student_id
      WHERE s.user_id = ? OR LOWER(s.email) = ?
      ORDER BY gf.id DESC LIMIT 1
    `, [userId, userEmail]);

    if (!student) {
      return res.json({ student: null, formData: null });
    }

    if (!student.user_id) {
      await execute('UPDATE students SET user_id = ? WHERE id = ?', [userId, student.id]);
      student.user_id = userId;
    }

    const infoRecord = await getOne('SELECT form_data FROM student_information WHERE student_id = ?', [student.id]);
    const formData = infoRecord ? JSON.parse(infoRecord.form_data) : null;

    res.json({
      student,
      formData
    });
  } catch (err) {
    console.error('Error fetching student info:', err);
    res.status(500).json({ error: 'Failed to load student information.' });
  }
});

// Student: Submit / Update Information Form & Auto-Generate SIF
app.post('/api/student/submit', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const user = req.session.user;
  const { formData } = req.body;

  if (!formData) {
    return res.status(400).json({ error: 'Form data is required.' });
  }

  const {
    studentId,
    firstName,
    middleName,
    lastName,
    sectionId
  } = formData;

  if (!studentId || !firstName || !lastName || !sectionId) {
    return res.status(400).json({ error: 'Please provide Student ID, First Name, Last Name, and select a Section.' });
  }

  // Automatic compression for student 1" x 1" photo if attached as Base64 Data URL
  if (formData.photoBase64 && typeof formData.photoBase64 === 'string' && formData.photoBase64.startsWith('data:image')) {
    try {
      const photoCompression = await compressBase64Image(formData.photoBase64, {
        maxDimension: 600,
        quality: 85
      });
      if (photoCompression.compressed && photoCompression.dataUrl) {
        formData.photoBase64 = photoCompression.dataUrl;
        console.log(`[SUBMIT] Student 1x1 photo compressed (${photoCompression.savingsPercent}% reduction).`);
      }
    } catch (photoErr) {
      console.warn('[SUBMIT] Student photo compression error (safe bypass):', photoErr.message);
    }
  }

  try {
    // 1. Verify that Section exists and is ACTIVE
    const section = await getOne('SELECT * FROM sections WHERE id = ? AND status = ?', [sectionId, 'active']);
    if (!section) {
      return res.status(400).json({ error: 'Selected section is invalid or inactive.' });
    }

    // 2. Check or create/update student record
    let student = await getOne(
      'SELECT * FROM students WHERE user_id = ? OR LOWER(email) = ?',
      [userId, user.email.toLowerCase()]
    );

    if (student) {
      // Check if studentId is being changed to one that already exists on another student
      const conflict = await getOne('SELECT id FROM students WHERE student_id = ? AND id != ?', [studentId.trim(), student.id]);
      if (conflict) {
        return res.status(400).json({ error: `Student ID "${studentId.trim()}" is already assigned to another student.` });
      }

      await execute(`
        UPDATE students
        SET user_id = ?, student_id = ?, first_name = ?, middle_name = ?, last_name = ?, section_id = ?, email = ?
        WHERE id = ?
      `, [userId, studentId.trim(), firstName.trim(), (middleName || '').trim(), lastName.trim(), section.id, user.email, student.id]);
      student = await getOne('SELECT * FROM students WHERE id = ?', [student.id]);
    } else {
      // Check if an unlinked student record exists with this student_id
      const existingByStudentId = await getOne('SELECT * FROM students WHERE student_id = ?', [studentId.trim()]);
      if (existingByStudentId) {
        if (existingByStudentId.user_id && existingByStudentId.user_id !== userId) {
          return res.status(400).json({ error: `Student ID "${studentId.trim()}" is already registered to another account.` });
        }
        await execute(`
          UPDATE students
          SET user_id = ?, first_name = ?, middle_name = ?, last_name = ?, section_id = ?, email = ?
          WHERE id = ?
        `, [userId, firstName.trim(), (middleName || '').trim(), lastName.trim(), section.id, user.email, existingByStudentId.id]);
        student = await getOne('SELECT * FROM students WHERE id = ?', [existingByStudentId.id]);
      } else {
        const insert = await execute(`
          INSERT INTO students (user_id, student_id, first_name, middle_name, last_name, section_id, email)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [userId, studentId.trim(), firstName.trim(), (middleName || '').trim(), lastName.trim(), section.id, user.email]);
        student = await getOne('SELECT * FROM students WHERE id = ?', [insert.insertId]);
      }
    }

    // 3. Save student_information (JSON)
    const existingInfo = await getOne('SELECT id FROM student_information WHERE student_id = ?', [student.id]);
    if (existingInfo) {
      await execute('UPDATE student_information SET form_data = ? WHERE id = ?', [JSON.stringify(formData), existingInfo.id]);
    } else {
      await execute('INSERT INTO student_information (student_id, form_data) VALUES (?, ?)', [student.id, JSON.stringify(formData)]);
    }

    // 4. Generate completed SIF PDF mapped into official template
    const pdfResult = await generateStudentSIF(student, formData, section.name);

    // 5. Save/Update generated_files table
    const existingFile = await getOne('SELECT id FROM generated_files WHERE student_id = ?', [student.id]);
    let fileId;
    if (existingFile) {
      await execute(`
        UPDATE generated_files 
        SET template_id = ?, file_path = ?, file_name = ?, file_size = ?, generated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, existingFile.id]);
      fileId = existingFile.id;
    } else {
      const fileInsert = await execute(`
        INSERT INTO generated_files (student_id, template_id, file_path, file_name, file_size, generated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [student.id, pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, user.email]);
      fileId = fileInsert.insertId;
    }

    res.json({
      message: 'Student Information File saved and SIF PDF generated successfully.',
      fileId,
      fileName: pdfResult.fileName,
      sectionName: section.name
    });
  } catch (err) {
    console.error('Error submitting SIF form:', err);
    res.status(500).json({ error: err.message || 'Failed to process submission.' });
  }
});

// ==========================================
// 4B. STUDENT 201-FILE DOCUMENT MANAGEMENT (WITH IDOR PROTECTION)
// ==========================================

// Student: Get 201-File Document Checklist & Uploads (Strict Session Ownership)
app.get('/api/student/documents', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  try {
    const student = await getOne(
      `SELECT id, user_id, email, year_level FROM students WHERE user_id = ? OR LOWER(email) = ? LIMIT 1`,
      [userId, userEmail]
    );

    if (!student) {
      return res.json({
        student: null,
        checklist: null,
        categories: []
      });
    }

    const overview = await getStudentDocumentOverview(student.id);
    res.json(overview);
  } catch (err) {
    console.error('Error fetching student documents:', err);
    res.status(500).json({ error: 'Failed to load document records.' });
  }
});

// Student: Upload Required 201-File Document (Strict Validation & IDOR Protection)
app.post('/api/student/documents/upload', requireAuth, uploadDocument.single('documentFile'), async (req, res) => {
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  const { documentType } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'Please select a document file to upload.' });
  }

  if (!documentType || !DOCUMENT_CATEGORIES[documentType]) {
    return res.status(400).json({ error: 'Invalid document category specified.' });
  }

  try {
    const student = await getOne(
      `SELECT id, user_id, email, year_level FROM students WHERE user_id = ? OR LOWER(email) = ? LIMIT 1`,
      [userId, userEmail]
    );

    if (!student) {
      return res.status(404).json({ error: 'Student record not found. Please complete your registration first.' });
    }

    const savedDoc = await saveUploadedDocument({
      studentId: student.id,
      documentType,
      originalFilename: req.file.originalname,
      buffer: req.file.buffer,
      declaredMimeType: req.file.mimetype,
      uploadedBy: req.session.user.email
    });

    const isCompressed = savedDoc.compressionInfo && savedDoc.compressionInfo.compressed;
    const successMsg = isCompressed
      ? `File "${savedDoc.originalFilename}" compressed (${savedDoc.compressionInfo.savingsPercent}% reduction) and uploaded successfully.`
      : `File "${savedDoc.originalFilename}" uploaded successfully.`;

    res.status(201).json({
      message: successMsg,
      document: savedDoc
    });
  } catch (err) {
    console.error('Error uploading student document:', err);
    res.status(400).json({ error: err.message || 'Failed to process document upload.' });
  }
});

// Student & Admin: View Document Inline in Browser (Strict Ownership + Anti-Caching)
app.get('/api/student/documents/:id/view', requireAuth, async (req, res) => {
  const docId = req.params.id;
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  try {
    const doc = await getOne(
      `SELECT sd.*, s.user_id, s.email as student_email 
       FROM student_documents sd 
       JOIN students s ON sd.student_id = s.id 
       WHERE sd.id = ? AND sd.is_deleted = 0`,
      [docId]
    );

    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    // Critical Security Check: Student can ONLY view their own file; Admin can view all
    if (req.session.user.role !== 'admin' && req.session.user.id !== doc.user_id && userEmail !== (doc.student_email || '').toLowerCase()) {
      return res.status(403).json({ error: 'Access denied. You do not have permission to view this document.' });
    }

    const fullPath = await ensureDocumentOnDisk(doc);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Document file could not be retrieved from storage.' });
    }

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_filename)}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
    console.error('Error viewing document:', err);
    res.status(500).json({ error: 'Failed to display document.' });
  }
});

// Student & Admin: Download Document File (Strict Ownership)
app.get('/api/student/documents/:id/download', requireAuth, async (req, res) => {
  const docId = req.params.id;
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  try {
    const doc = await getOne(
      `SELECT sd.*, s.user_id, s.email as student_email 
       FROM student_documents sd 
       JOIN students s ON sd.student_id = s.id 
       WHERE sd.id = ? AND sd.is_deleted = 0`,
      [docId]
    );

    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    if (req.session.user.role !== 'admin' && req.session.user.id !== doc.user_id && userEmail !== (doc.student_email || '').toLowerCase()) {
      return res.status(403).json({ error: 'Access denied. You do not have permission to download this document.' });
    }

    const fullPath = await ensureDocumentOnDisk(doc);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Document file could not be retrieved from storage.' });
    }

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_filename)}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
    console.error('Error downloading document:', err);
    res.status(500).json({ error: 'Failed to download document.' });
  }
});

// Student: Delete Own Uploaded Document (Forbidden if Verified by Admin)
app.delete('/api/student/documents/:id', requireAuth, async (req, res) => {
  const docId = req.params.id;
  const userId = req.session.user.id;
  const userEmail = (req.session.user.email || '').toLowerCase();
  try {
    const student = await getOne(
      `SELECT id FROM students WHERE user_id = ? OR LOWER(email) = ? LIMIT 1`,
      [userId, userEmail]
    );

    if (!student) {
      return res.status(404).json({ error: 'Student record not found.' });
    }

    const result = await deleteDocument(docId, student.id, req.session.user.email, false);
    res.json(result);
  } catch (err) {
    console.error('Error deleting student document:', err);
    res.status(400).json({ error: err.message || 'Failed to remove document.' });
  }
});

// ==========================================
// 5. ADMIN STUDENT MANAGEMENT & SEARCH
// ==========================================

// Admin: Get all 201-Document Categories definitions
app.get('/api/admin/documents/categories', requireAuth, requireAdmin, (req, res) => {
  const allCats = [
    {
      key: 'pis',
      name: 'Personal Information Sheet (PIS)',
      description: 'Official College of Computer Studies Student Personal Information Sheet (BSIT).',
      isMultiFile: false,
      seminarOnly: false
    },
    ...Object.values(DOCUMENT_CATEGORIES)
  ];
  res.json(allCats);
});

// Admin: Get Document Compliance Summary across students
app.get('/api/admin/documents/compliance-summary', requireAuth, requireAdmin, async (req, res) => {
  const { documentType, sectionId, yearLevel, query: searchQuery } = req.query;

  if (!documentType || documentType === 'all') {
    return res.status(400).json({ error: 'Specific documentType is required for compliance summary.' });
  }

  const categoryDef = documentType === 'pis' ? {
    key: 'pis',
    name: 'Personal Information Sheet (PIS)',
    description: 'Official College of Computer Studies Student Personal Information Sheet (BSIT).',
    isMultiFile: false,
    seminarOnly: false
  } : DOCUMENT_CATEGORIES[documentType];

  if (!categoryDef) {
    return res.status(400).json({ error: `Invalid document category: "${documentType}".` });
  }

  try {
    let sql = `
      SELECT 
        s.id,
        s.year_level,
        sec.name as section_name,
        gf.id as generated_file_id
    `;

    const params = [];

    if (documentType === 'pis') {
      sql += `, (CASE WHEN gf.id IS NOT NULL THEN 1 ELSE 0 END) as spec_doc_count,
              (CASE WHEN gf.id IS NOT NULL THEN 1 ELSE 0 END) as spec_doc_verified_count,
              0 as spec_doc_pending_count,
              0 as spec_doc_rejected_count
             FROM students s
             LEFT JOIN sections sec ON s.section_id = sec.id
             LEFT JOIN generated_files gf ON s.id = gf.student_id
             WHERE 1=1`;
    } else {
      sql += `, COUNT(DISTINCT sd_spec.id) as spec_doc_count,
              SUM(CASE WHEN sd_spec.upload_status = 'verified' THEN 1 ELSE 0 END) as spec_doc_verified_count,
              SUM(CASE WHEN sd_spec.upload_status = 'uploaded' THEN 1 ELSE 0 END) as spec_doc_pending_count,
              SUM(CASE WHEN sd_spec.upload_status = 'rejected' THEN 1 ELSE 0 END) as spec_doc_rejected_count
             FROM students s
             LEFT JOIN sections sec ON s.section_id = sec.id
             LEFT JOIN generated_files gf ON s.id = gf.student_id
             LEFT JOIN student_documents sd_spec ON s.id = sd_spec.student_id AND sd_spec.document_type = ? AND sd_spec.is_deleted = 0
             WHERE 1=1`;
      params.push(documentType);
    }

    if (searchQuery && searchQuery.trim()) {
      const q = `%${searchQuery.trim()}%`;
      sql += ` AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ? OR CONCAT(s.first_name, ' ', s.last_name) LIKE ?)`;
      params.push(q, q, q, q, q);
    }

    if (sectionId && sectionId !== 'all') {
      sql += ` AND s.section_id = ?`;
      params.push(sectionId);
    }

    if (yearLevel && yearLevel !== 'all') {
      sql += ` AND s.year_level = ?`;
      params.push(yearLevel);
    }

    sql += ` GROUP BY s.id, s.year_level, sec.name, gf.id`;

    const rows = await query(sql, params);

    let totalStudents = rows.length;
    let passedCount = 0;
    let notPassedCount = 0;
    let verifiedCount = 0;
    let pendingCount = 0;
    let rejectedCount = 0;
    let missingCount = 0;
    let notApplicableCount = 0;

    for (const r of rows) {
      const isEligible = categoryDef.seminarOnly ? isEligibleForSeminars(r.year_level, r.section_name) : true;
      if (categoryDef.seminarOnly && !isEligible) {
        notApplicableCount++;
        continue;
      }

      if (documentType === 'pis') {
        if (r.generated_file_id) {
          passedCount++;
          verifiedCount++;
        } else {
          notPassedCount++;
          missingCount++;
        }
      } else {
        const vCnt = Number(r.spec_doc_verified_count || 0);
        const pCnt = Number(r.spec_doc_pending_count || 0);
        const rCnt = Number(r.spec_doc_rejected_count || 0);
        const totalCnt = Number(r.spec_doc_count || 0);

        if (totalCnt === 0) {
          notPassedCount++;
          missingCount++;
        } else if (rCnt > 0 && vCnt === 0 && pCnt === 0) {
          notPassedCount++;
          rejectedCount++;
        } else if (pCnt > 0) {
          passedCount++;
          pendingCount++;
        } else if (vCnt > 0) {
          passedCount++;
          verifiedCount++;
        } else {
          passedCount++;
          pendingCount++;
        }
      }
    }

    const applicableStudents = totalStudents - notApplicableCount;
    const passedPercentage = applicableStudents > 0 ? Math.round((passedCount / applicableStudents) * 100) : 0;
    const notPassedPercentage = applicableStudents > 0 ? Math.round((notPassedCount / applicableStudents) * 100) : 0;

    res.json({
      documentType,
      documentName: categoryDef.name,
      description: categoryDef.description,
      isMultiFile: categoryDef.isMultiFile,
      seminarOnly: categoryDef.seminarOnly,
      totalStudents,
      applicableStudents,
      passedCount,
      passedPercentage,
      notPassedCount,
      notPassedPercentage,
      verifiedCount,
      pendingCount,
      rejectedCount,
      missingCount,
      notApplicableCount
    });
  } catch (err) {
    console.error('Error calculating document compliance summary:', err);
    res.status(500).json({ error: 'Failed to generate document compliance summary.' });
  }
});

// Admin: Search & Filter Students with Document Progress & Specific Document Pass/Fail Status
app.get('/api/students', requireAuth, requireAdmin, async (req, res) => {
  const { query: searchQuery, sectionId, yearLevel, status: filterStatus, documentType, docStatus } = req.query;

  const isSpecificDoc = documentType && documentType !== 'all';
  const effectiveStatus = (docStatus && docStatus !== 'all') ? docStatus : (filterStatus && filterStatus !== 'all' ? filterStatus : 'all');

  let categoryDef = null;
  if (isSpecificDoc) {
    if (documentType === 'pis') {
      categoryDef = {
        key: 'pis',
        name: 'Personal Information Sheet (PIS)',
        isMultiFile: false,
        seminarOnly: false
      };
    } else if (DOCUMENT_CATEGORIES[documentType]) {
      categoryDef = DOCUMENT_CATEGORIES[documentType];
    }
  }

  let sql = `
    SELECT 
      s.id,
      s.student_id,
      s.first_name,
      s.middle_name,
      s.last_name,
      s.email,
      s.section_id,
      s.year_level,
      sec.name as section_name,
      gf.id as generated_file_id,
      gf.file_name,
      gf.file_size,
      gf.generated_at as sif_created_at,
      COUNT(DISTINCT sd.id) as total_documents,
      SUM(CASE WHEN sd.upload_status = 'verified' THEN 1 ELSE 0 END) as verified_documents,
      SUM(CASE WHEN sd.upload_status = 'uploaded' THEN 1 ELSE 0 END) as pending_documents,
      SUM(CASE WHEN sd.upload_status = 'rejected' THEN 1 ELSE 0 END) as rejected_documents
  `;

  const params = [];

  if (isSpecificDoc) {
    if (documentType === 'pis') {
      sql += `,
        (CASE WHEN gf.id IS NOT NULL THEN 1 ELSE 0 END) as spec_doc_count,
        (CASE WHEN gf.id IS NOT NULL THEN 1 ELSE 0 END) as spec_doc_verified_count,
        0 as spec_doc_pending_count,
        0 as spec_doc_rejected_count,
        gf.id as spec_doc_latest_id,
        gf.file_name as spec_doc_latest_filename,
        gf.generated_at as spec_doc_latest_date,
        'verified' as spec_doc_latest_status,
        '' as spec_doc_latest_remarks
      `;
    } else {
      sql += `,
        COUNT(DISTINCT sd_spec.id) as spec_doc_count,
        SUM(CASE WHEN sd_spec.upload_status = 'verified' THEN 1 ELSE 0 END) as spec_doc_verified_count,
        SUM(CASE WHEN sd_spec.upload_status = 'uploaded' THEN 1 ELSE 0 END) as spec_doc_pending_count,
        SUM(CASE WHEN sd_spec.upload_status = 'rejected' THEN 1 ELSE 0 END) as spec_doc_rejected_count,
        MAX(sd_spec.id) as spec_doc_latest_id,
        MAX(sd_spec.uploaded_at) as spec_doc_latest_date,
        SUBSTRING_INDEX(GROUP_CONCAT(sd_spec.original_filename ORDER BY sd_spec.id DESC SEPARATOR '|||'), '|||', 1) as spec_doc_latest_filename,
        SUBSTRING_INDEX(GROUP_CONCAT(sd_spec.upload_status ORDER BY sd_spec.id DESC SEPARATOR '|||'), '|||', 1) as spec_doc_latest_status,
        SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(sd_spec.admin_remarks, '') ORDER BY sd_spec.id DESC SEPARATOR '|||'), '|||', 1) as spec_doc_latest_remarks
      `;
    }
  }

  sql += `
    FROM students s
    LEFT JOIN sections sec ON s.section_id = sec.id
    LEFT JOIN generated_files gf ON s.id = gf.student_id
    LEFT JOIN student_documents sd ON s.id = sd.student_id AND sd.is_deleted = 0
  `;

  if (isSpecificDoc && documentType !== 'pis') {
    sql += ` LEFT JOIN student_documents sd_spec ON s.id = sd_spec.student_id AND sd_spec.document_type = ? AND sd_spec.is_deleted = 0`;
    params.push(documentType);
  }

  sql += ` WHERE 1=1`;

  if (searchQuery && searchQuery.trim()) {
    const q = `%${searchQuery.trim()}%`;
    sql += ` AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ? OR CONCAT(s.first_name, ' ', s.last_name) LIKE ?)`;
    params.push(q, q, q, q, q);
  }

  if (sectionId && sectionId !== 'all') {
    sql += ` AND s.section_id = ?`;
    params.push(sectionId);
  }

  if (yearLevel && yearLevel !== 'all') {
    sql += ` AND s.year_level = ?`;
    params.push(yearLevel);
  }

  sql += ` GROUP BY s.id, sec.name, gf.id, gf.file_name, gf.file_size, gf.generated_at`;

  // Status filtering in HAVING clause
  if (effectiveStatus && effectiveStatus !== 'all') {
    if (isSpecificDoc) {
      if (documentType === 'pis') {
        if (effectiveStatus === 'passed' || effectiveStatus === 'verified') {
          sql += ` HAVING gf.id IS NOT NULL`;
        } else if (effectiveStatus === 'not_passed' || effectiveStatus === 'missing') {
          sql += ` HAVING gf.id IS NULL`;
        } else if (effectiveStatus === 'pending' || effectiveStatus === 'rejected') {
          sql += ` HAVING 1 = 0`;
        }
      } else {
        if (effectiveStatus === 'passed') {
          sql += ` HAVING (spec_doc_verified_count > 0 OR spec_doc_pending_count > 0)`;
        } else if (effectiveStatus === 'not_passed' || effectiveStatus === 'missing') {
          sql += ` HAVING (spec_doc_count = 0 OR (spec_doc_verified_count = 0 AND spec_doc_pending_count = 0))`;
        } else if (effectiveStatus === 'verified') {
          sql += ` HAVING (spec_doc_verified_count > 0 AND spec_doc_pending_count = 0)`;
        } else if (effectiveStatus === 'pending') {
          sql += ` HAVING (spec_doc_pending_count > 0)`;
        } else if (effectiveStatus === 'rejected') {
          sql += ` HAVING (spec_doc_rejected_count > 0 AND spec_doc_verified_count = 0 AND spec_doc_pending_count = 0)`;
        }
      }
    } else {
      // General multi-document status filter
      if (effectiveStatus === 'pending') {
        sql += ` HAVING pending_documents > 0`;
      } else if (effectiveStatus === 'rejected') {
        sql += ` HAVING rejected_documents > 0`;
      } else if (effectiveStatus === 'verified') {
        sql += ` HAVING verified_documents > 0 AND pending_documents = 0 AND rejected_documents = 0`;
      } else if (effectiveStatus === 'missing') {
        sql += ` HAVING total_documents = 0 OR gf.id IS NULL`;
      }
    }
  }

  sql += ` ORDER BY s.last_name ASC, s.first_name ASC`;

  try {
    const students = await query(sql, params);

    // If specific document requested, enrich each row with formatted status and eligibility
    if (isSpecificDoc && categoryDef) {
      students.forEach(s => {
        const isEligible = categoryDef.seminarOnly ? isEligibleForSeminars(s.year_level, s.section_name) : true;
        let docStatus = 'missing';
        let docStatusLabel = 'Not Passed (Missing)';
        let isPassed = false;

        if (categoryDef.seminarOnly && !isEligible) {
          docStatus = 'not_applicable';
          docStatusLabel = 'Not Required (1st/2nd Yr)';
          isPassed = false;
        } else if (documentType === 'pis') {
          if (s.generated_file_id) {
            docStatus = 'verified';
            docStatusLabel = 'Passed (Generated)';
            isPassed = true;
          } else {
            docStatus = 'missing';
            docStatusLabel = 'Not Passed (Missing)';
            isPassed = false;
          }
        } else {
          const vCnt = Number(s.spec_doc_verified_count || 0);
          const pCnt = Number(s.spec_doc_pending_count || 0);
          const rCnt = Number(s.spec_doc_rejected_count || 0);
          const totalCnt = Number(s.spec_doc_count || 0);

          if (totalCnt === 0) {
            docStatus = 'missing';
            docStatusLabel = 'Not Passed (Missing)';
            isPassed = false;
          } else if (rCnt > 0 && vCnt === 0 && pCnt === 0) {
            docStatus = 'rejected';
            docStatusLabel = 'Requires Resubmission';
            isPassed = false;
          } else if (pCnt > 0) {
            docStatus = 'uploaded';
            docStatusLabel = 'Passed (Pending Review)';
            isPassed = true;
          } else if (vCnt > 0) {
            docStatus = 'verified';
            docStatusLabel = 'Passed (Verified)';
            isPassed = true;
          } else {
            docStatus = 'uploaded';
            docStatusLabel = 'Passed (Submitted)';
            isPassed = true;
          }
        }

        s.spec_doc_key = documentType;
        s.spec_doc_name = categoryDef.name;
        s.spec_doc_status = docStatus;
        s.spec_doc_status_label = docStatusLabel;
        s.spec_doc_is_passed = isPassed;
        s.spec_doc_is_eligible = isEligible;
      });
    }

    res.json(students);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ error: 'Failed to search student records.' });
  }
});

// ==========================================
// 5B. ADMIN 201-FILE DOCUMENT REVIEW & VERIFICATION
// ==========================================

// Admin: Get Detailed 201-File Overview for Individual Student
app.get('/api/admin/students/:id/documents', requireAuth, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  try {
    const overview = await getStudentDocumentOverview(studentId);
    if (!overview) {
      return res.status(404).json({ error: 'Student record not found.' });
    }
    res.json(overview);
  } catch (err) {
    console.error('Error fetching student documents for admin:', err);
    res.status(500).json({ error: 'Failed to load student documents.' });
  }
});

// Admin: Verify, Reject, or Reset a Document Status (Audit-Logged)
app.patch('/api/admin/documents/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const docId = req.params.id;
  const { status, remarks } = req.body;
  try {
    const result = await updateDocumentStatus({
      documentId: docId,
      status,
      remarks,
      adminUser: req.session.user
    });

    res.json({
      message: `Document status marked as ${status}.`,
      result
    });
  } catch (err) {
    console.error('Error updating document status:', err);
    res.status(400).json({ error: err.message || 'Failed to update document status.' });
  }
});

// Admin: Delete Document from Student Record (Audit-Logged)
app.delete('/api/admin/documents/:id', requireAuth, requireAdmin, async (req, res) => {
  const docId = req.params.id;
  try {
    const result = await deleteDocument(docId, null, req.session.user.email, true);
    res.json(result);
  } catch (err) {
    console.error('Error deleting document as admin:', err);
    res.status(400).json({ error: err.message || 'Failed to remove document.' });
  }
});

// Admin: Set / Verify Official Student Year Level
app.put('/api/admin/students/:id/year-level', requireAuth, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  const { yearLevel } = req.body;

  if (!yearLevel || !['1st Year', '2nd Year', '3rd Year', '4th Year'].includes(yearLevel)) {
    return res.status(400).json({ error: 'Invalid year level. Must be 1st Year, 2nd Year, 3rd Year, or 4th Year.' });
  }

  try {
    const student = await getOne('SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student record not found.' });
    }

    await execute('UPDATE students SET year_level = ? WHERE id = ?', [yearLevel, studentId]);

    // Record in Audit Log
    try {
      await execute(`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
        VALUES (?, 'STUDENT_YEAR_LEVEL_UPDATE', 'students', ?, ?)
      `, [
        req.session.user.id,
        studentId.toString(),
        JSON.stringify({
          studentName: `${student.first_name} ${student.last_name}`,
          oldYearLevel: student.year_level,
          newYearLevel: yearLevel
        })
      ]);
    } catch (e) {}

    res.json({
      message: `Student year level updated to ${yearLevel} successfully.`,
      yearLevel
    });
  } catch (err) {
    console.error('Error updating student year level:', err);
    res.status(500).json({ error: 'Failed to update year level.' });
  }
});

// Admin: Change Student Section
app.put('/api/students/:id/section', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { sectionId } = req.body;

  try {
    const targetSection = await getOne('SELECT * FROM sections WHERE id = ?', [sectionId]);
    if (!targetSection) {
      return res.status(400).json({ error: 'Selected section not found.' });
    }

    const student = await getOne('SELECT * FROM students WHERE id = ?', [id]);
    if (!student) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    await execute('UPDATE students SET section_id = ? WHERE id = ?', [sectionId, id]);

    res.json({
      message: `Student ${student.first_name} ${student.last_name} moved to section ${targetSection.name}.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update student section.' });
  }
});

// Admin: Explicitly Regenerate SIF PDF for Student
app.post('/api/students/:id/regenerate-pdf', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const student = await getOne(`
      SELECT s.*, sec.name as section_name 
      FROM students s 
      LEFT JOIN sections sec ON s.section_id = sec.id 
      WHERE s.id = ?
    `, [id]);

    if (!student) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    const infoRecord = await getOne('SELECT form_data FROM student_information WHERE student_id = ?', [student.id]);
    if (!infoRecord) {
      return res.status(400).json({ error: 'Student has not submitted information form data yet.' });
    }

    const formData = JSON.parse(infoRecord.form_data);
    const sectionName = student.section_name || 'Unassigned';

    const pdfResult = await generateStudentSIF(student, formData, sectionName);

    const existingFile = await getOne('SELECT id FROM generated_files WHERE student_id = ?', [student.id]);
    if (existingFile) {
      await execute(`
        UPDATE generated_files
        SET template_id = ?, file_path = ?, file_name = ?, file_size = ?, generated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, existingFile.id]);
    } else {
      await execute(`
        INSERT INTO generated_files (student_id, template_id, file_path, file_name, file_size, generated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [student.id, pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, req.session.user.email]);
    }

    res.json({
      message: `SIF PDF regenerated and filed under section ${sectionName}.`,
      fileName: pdfResult.fileName
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate SIF PDF.' });
  }
});

// Admin: Regenerate ALL 201-FILE PDFs in a Section at once
app.post('/api/sections/:id/regenerate-all', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const section = await getOne('SELECT * FROM sections WHERE id = ?', [id]);
    if (!section) {
      return res.status(404).json({ error: 'Section not found.' });
    }

    const students = await query(`
      SELECT s.*, si.form_data
      FROM students s
      JOIN student_information si ON s.id = si.student_id
      WHERE s.section_id = ?
    `, [id]);

    if (!students || students.length === 0) {
      return res.status(400).json({ error: `No submitted student records found in Section ${section.name} to generate.` });
    }

    let successCount = 0;
    for (const student of students) {
      try {
        const formData = JSON.parse(student.form_data);
        const pdfResult = await generateStudentSIF(student, formData, section.name);

        const existingFile = await getOne('SELECT id FROM generated_files WHERE student_id = ?', [student.id]);
        if (existingFile) {
          await execute(`
            UPDATE generated_files
            SET template_id = ?, file_path = ?, file_name = ?, file_size = ?, generated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, existingFile.id]);
        } else {
          await execute(`
            INSERT INTO generated_files (student_id, template_id, file_path, file_name, file_size, generated_by)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [student.id, pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, req.session.user.email]);
        }
        successCount++;
      } catch (err) {
        console.error(`[SECTION REGEN] Error regenerating for student ${student.id}:`, err.message);
      }
    }

    res.json({
      message: `Successfully regenerated ${successCount} of ${students.length} 201-FILEs for Section ${section.name}.`,
      regeneratedCount: successCount,
      totalCount: students.length
    });
  } catch (err) {
    console.error('Error regenerating section PDFs:', err);
    res.status(500).json({ error: 'Failed to regenerate section PDFs.' });
  }
});

// ==========================================
// Helper: Ensure SIF file exists on disk, auto-regenerating from DB if wiped (e.g. Render restart)
async function ensureSifFileOnDisk(fileRecord) {
  let fullPath = path.isAbsolute(fileRecord.file_path)
    ? fileRecord.file_path
    : path.join(__dirname, fileRecord.file_path);

  // Normalize path separators for current platform (Windows \ vs Linux /)
  fullPath = path.normalize(fullPath.replace(/\\/g, path.sep).replace(/\//g, path.sep));

  if (fs.existsSync(fullPath)) {
    return fullPath;
  }

  // If file doesn't exist on disk (e.g. after Render restart), auto-regenerate on the fly from database!
  console.log(`[FILE] File not found on disk (${fullPath}). Auto-regenerating from database for student_id: ${fileRecord.student_id}...`);
  try {
    const student = await getOne(`
      SELECT s.*, sec.name as section_name
      FROM students s
      LEFT JOIN sections sec ON s.section_id = sec.id
      WHERE s.id = ?
    `, [fileRecord.student_id]);

    if (!student) return null;

    const infoRecord = await getOne('SELECT form_data FROM student_information WHERE student_id = ?', [student.id]);
    if (!infoRecord || !infoRecord.form_data) return null;

    const formData = JSON.parse(infoRecord.form_data);
    const sectionName = student.section_name || 'Unassigned';
    const pdfResult = await generateStudentSIF(student, formData, sectionName);

    await execute(`
      UPDATE generated_files
      SET template_id = ?, file_path = ?, file_name = ?, file_size = ?, generated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [pdfResult.templateId, pdfResult.filePath, pdfResult.fileName, pdfResult.fileSize, fileRecord.id]);

    const newFullPath = path.isAbsolute(pdfResult.filePath)
      ? pdfResult.filePath
      : path.join(__dirname, pdfResult.filePath);

    return path.normalize(newFullPath);
  } catch (err) {
    console.error('[FILE] Auto-regeneration failed:', err.message);
    return null;
  }
}

// Download SIF PDF (Strict Ownership Check + Auto-Regeneration on Disk Miss)
app.get('/api/files/sif/:id/download', requireAuth, async (req, res) => {
  const fileId = req.params.id;
  try {
    const fileRecord = await getOne(`
      SELECT gf.*, s.user_id 
      FROM generated_files gf
      JOIN students s ON gf.student_id = s.id
      WHERE gf.id = ?
    `, [fileId]);

    if (!fileRecord) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Critical Security Check: Student can ONLY access their own file; Admin can access all
    if (req.session.user.role !== 'admin' && req.session.user.id !== fileRecord.user_id) {
      return res.status(403).json({ error: 'You do not have permission to access this student record.' });
    }

    const fullPath = await ensureSifFileOnDisk(fileRecord);

    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File could not be found or regenerated on the server.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.file_name}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download file.' });
  }
});

// View SIF PDF inline in browser (Strict Ownership Check + Auto-Regeneration on Disk Miss)
app.get('/api/files/sif/:id/view', requireAuth, async (req, res) => {
  const fileId = req.params.id;
  try {
    const fileRecord = await getOne(`
      SELECT gf.*, s.user_id 
      FROM generated_files gf
      JOIN students s ON gf.student_id = s.id
      WHERE gf.id = ?
    `, [fileId]);

    if (!fileRecord) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Critical Security Check: Student can ONLY view their own file; Admin can access all
    if (req.session.user.role !== 'admin' && req.session.user.id !== fileRecord.user_id) {
      return res.status(403).json({ error: 'You do not have permission to access this student record.' });
    }

    const fullPath = await ensureSifFileOnDisk(fileRecord);

    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File could not be found or regenerated on the server.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileRecord.file_name}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
    console.error('View file error:', err);
    res.status(500).json({ error: 'Failed to view file.' });
  }
});

// Admin: Delete/Remove a generated SIF file inside a section folder
app.delete('/api/files/sif/:id', requireAuth, requireAdmin, async (req, res) => {
  const fileId = req.params.id;
  try {
    const fileRecord = await getOne(`
      SELECT gf.*, s.first_name, s.last_name, sec.name as section_name
      FROM generated_files gf
      LEFT JOIN students s ON gf.student_id = s.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      WHERE gf.id = ?
    `, [fileId]);

    if (!fileRecord) {
      return res.status(404).json({ error: 'File record not found.' });
    }

    // 1. Remove physical file from disk inside the section folder if present
    const fullPath = path.isAbsolute(fileRecord.file_path)
      ? fileRecord.file_path
      : path.join(__dirname, fileRecord.file_path);

    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr) {
        console.warn('Could not delete physical file from disk:', unlinkErr.message);
      }
    }

    // 2. Remove file record from generated_files table
    await execute('DELETE FROM generated_files WHERE id = ?', [fileId]);

    res.json({
      message: `File "${fileRecord.file_name}" removed from section ${fileRecord.section_name || 'folder'} successfully.`,
      fileId,
      studentId: fileRecord.student_id
    });
  } catch (err) {
    console.error('Error deleting SIF file:', err);
    res.status(500).json({ error: 'Failed to remove file.' });
  }
});

// Admin: Delete student record & clean up associated file
app.delete('/api/students/:id', requireAuth, requireAdmin, async (req, res) => {
  const studentId = req.params.id;
  try {
    const student = await getOne('SELECT s.*, gf.file_path FROM students s LEFT JOIN generated_files gf ON s.id = gf.student_id WHERE s.id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student record not found.' });
    }

    // Delete generated file from disk if present
    if (student.file_path) {
      const fullPath = path.isAbsolute(student.file_path) ? student.file_path : path.join(__dirname, student.file_path);
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) {}
      }
    }

    // Delete records in cascade order
    await execute('DELETE FROM generated_files WHERE student_id = ?', [studentId]);
    await execute('DELETE FROM student_information WHERE student_id = ?', [studentId]);
    await execute('DELETE FROM students WHERE id = ?', [studentId]);

    res.json({ message: `Student ${student.first_name} ${student.last_name} and associated records removed successfully.` });
  } catch (err) {
    console.error('Error deleting student:', err);
    res.status(500).json({ error: 'Failed to remove student.' });
  }
});

// View active template PDF directly (Admin Only)
app.get('/api/files/template/:id/view', requireAuth, requireAdmin, async (req, res) => {
  try {
    const template = await getOne('SELECT * FROM pdf_templates WHERE id = ?', [req.params.id]);
    if (!template) {
      return res.status(404).json({ error: 'Template not found.' });
    }
    const fullPath = path.isAbsolute(template.file_path)
      ? template.file_path
      : path.join(__dirname, template.file_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Template file missing on disk.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(fullPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to view template.' });
  }
});

// ==========================================
// 7. SIF TEMPLATE & FIELD MAPPING (ADMIN ONLY)
// ==========================================

// List Templates
app.get('/api/templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    const templates = await query('SELECT * FROM pdf_templates ORDER BY id DESC');
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load templates.' });
  }
});

// Upload New SIF Template
app.post('/api/templates/upload', requireAuth, requireAdmin, uploadTemplate.single('templateFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please upload a valid PDF file.' });
  }

  const { name, version } = req.body;
  const templateName = name ? name.trim() : path.basename(req.file.originalname, '.pdf');
  const relativePath = path.relative(__dirname, req.file.path);

  try {
    const insert = await execute(`
      INSERT INTO pdf_templates (name, version, file_path, is_active, uploaded_by)
      VALUES (?, ?, ?, 1, ?)
    `, [templateName, version || '1.0', relativePath, req.session.user.email]);

    res.status(201).json({
      message: 'PDF Template uploaded successfully.',
      templateId: insert.insertId
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template.' });
  }
});

// Get Field Mappings for Template
app.get('/api/templates/:id/mappings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const mappings = await query('SELECT * FROM pdf_field_mappings WHERE template_id = ?', [req.params.id]);
    res.json(mappings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load mappings.' });
  }
});

// Update/Save Field Mappings
app.post('/api/templates/:id/mappings', requireAuth, requireAdmin, async (req, res) => {
  const { mappings } = req.body;
  const templateId = req.params.id;

  if (!Array.isArray(mappings)) {
    return res.status(400).json({ error: 'Mappings must be an array.' });
  }

  try {
    await execute('DELETE FROM pdf_field_mappings WHERE template_id = ?', [templateId]);
    for (const row of mappings) {
      await execute(`
        INSERT INTO pdf_field_mappings (template_id, form_field, page_number, x, y, font_size, is_mapped)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        templateId,
        row.form_field,
        row.page_number || 1,
        row.x || 0,
        row.y || 0,
        row.font_size || 8.5,
        row.is_mapped ? 1 : 0
      ]);
    }
    res.json({ message: 'Field mappings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update mappings.' });
  }
});

// ==========================================
// 8. AUTHORIZED USERS MANAGEMENT (ADMIN ONLY)
// ==========================================

// List authorized school accounts
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await query(`
      SELECT id, google_id, email, name, role, status, created_at, updated_at
      FROM users
      ORDER BY role ASC, name ASC
    `);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// Helper to get active Admin Security Passcode (configured directly via .env)
async function getAdminSecurityPasscode() {
  return process.env.ADMIN_SECURITY_PASSCODE || 'JidiBonez2026!';
}

// Add authorized school user (Must belong to @olivarezcollege.edu.ph)
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, name, role, adminPasscode } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Email and full name are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanRole = role === 'admin' ? 'admin' : 'student';

  // If granting admin permissions, verify Admin Security Passcode
  if (cleanRole === 'admin') {
    const validPasscode = await getAdminSecurityPasscode();
    if (!adminPasscode || adminPasscode !== validPasscode) {
      return res.status(403).json({
        error: 'Invalid Admin Security Passcode. Administrator permissions were not granted.'
      });
    }
  }

  // Enforce school domain
  if (!cleanEmail.endsWith(`@${ALLOWED_DOMAIN}`)) {
    return res.status(400).json({
      error: `Authorized accounts must belong to @${ALLOWED_DOMAIN}. Personal accounts (@gmail.com) are not permitted.`
    });
  }

  try {
    const existing = await getOne('SELECT id FROM users WHERE LOWER(email) = ?', [cleanEmail]);
    if (existing) {
      return res.status(400).json({ error: 'A user with this school email already exists.' });
    }

    const insert = await execute(`
      INSERT INTO users (email, name, role, status)
      VALUES (?, ?, ?, 'active')
    `, [cleanEmail, name.trim(), cleanRole]);

    res.status(201).json({
      message: `Authorized ${cleanRole === 'admin' ? 'administrator' : 'user'} added successfully.`,
      userId: insert.insertId
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add user.' });
  }
});

// Update user status (Active / Deactivated)
app.patch('/api/users/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  // Prevent self deactivation
  if (parseInt(id, 10) === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  }

  try {
    await execute('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `User status changed to ${status}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

// Update user role (Requires passcode when granting admin permission)
app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, adminPasscode } = req.body;

  if (!['admin', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  // If granting admin permissions, verify Admin Security Passcode
  if (role === 'admin') {
    const validPasscode = await getAdminSecurityPasscode();
    if (!adminPasscode || adminPasscode !== validPasscode) {
      return res.status(403).json({
        error: 'Invalid Admin Security Passcode. Administrator permissions were not granted.'
      });
    }
  }

  try {
    await execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    res.json({ message: `User role updated to ${role}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user role.' });
  }
});


// Delete user authorization
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (parseInt(id, 10) === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot remove your own administrator account.' });
  }

  try {
    await execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'User authorization removed successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove user.' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` 201-FILE Management System (Google Auth & Data Protection)`);
  console.log(` Running locally at http://localhost:${PORT}`);
  console.log(` Allowed Domain: @${ALLOWED_DOMAIN}`);
  console.log(` Inactivity Timeout: ${SESSION_TIMEOUT_MINUTES} minutes`);
  console.log(` Database: MySQL localhost:3306/sif_201_system`);
  console.log(`====================================================`);
});
