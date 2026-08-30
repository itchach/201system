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

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'olivarezcollege.edu.ph').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
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

  try {
    if (!GOOGLE_CLIENT_ID) {
      // GOOGLE_CLIENT_ID not yet configured — cannot verify token audience.
      // The system is not usable until a valid Client ID is set in .env.
      return res.status(503).json({
        error: 'Google Sign-In is not yet configured on this server. Please contact the system administrator to set up GOOGLE_CLIENT_ID.'
      });
    }

    // Cryptographically verify the Google ID token using the OAuth2 client.
    // This call contacts Google's public key endpoint to verify the JWT signature,
    // expiry, and audience. ONLY the verified payload is trusted.
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

    // Extract identity exclusively from the verified token payload — never from the request body
    googleUser = {
      googleId: payload.sub,                                       // immutable Google account ID
      email: payload.email.trim().toLowerCase(),                   // verified by Google
      name: payload.name || payload.email,
      hostedDomain: (payload.hd || '').toLowerCase()              // Google Workspace hosted domain
    };

    // 2. Strict Domain Verification: Only @olivarezcollege.edu.ph permitted
    const emailDomain = googleUser.email.split('@')[1] || '';
    if (emailDomain !== ALLOWED_DOMAIN && googleUser.hostedDomain !== ALLOWED_DOMAIN) {
      return res.status(403).json({
        error: 'Please sign in using your Olivarez College Google account.'
      });
    }

    // 3. Authorized User Checking: School account must be pre-registered and active.
    // The authorized-user record only GRANTS permission to the authenticated Google identity.
    // It does not create or impersonate that identity.
    let user = await getOne('SELECT * FROM users WHERE LOWER(email) = ?', [googleUser.email]);

    if (!user) {
      return res.status(403).json({
        error: 'Your account is not authorized to access this system. Please contact the administrator.'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        error: 'Your account is not authorized to access this system. Please contact the administrator.'
      });
    }

    // 4. Bind the verified Google ID (sub) to this user record on first sign-in
    if (googleUser.googleId && user.google_id !== googleUser.googleId) {
      // If a different google_id is already bound, reject (account takeover prevention)
      if (user.google_id && user.google_id !== googleUser.googleId) {
        console.warn(`[SECURITY] Google ID mismatch for user ${user.email}: stored=${user.google_id}, presented=${googleUser.googleId}`);
        return res.status(403).json({
          error: 'Google account identity mismatch. Please contact the administrator.'
        });
      }
      await execute('UPDATE users SET google_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [googleUser.googleId, user.id]);
      user.google_id = googleUser.googleId;
    }

    // 5. Create Secure Server Session
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2);
    req.session.sessionId = sessionId;
    req.session.user = {
      id: user.id,
      googleId: user.google_id,       // immutable sub from Google
      email: user.email,              // from our users table (matched against verified token email)
      name: user.name,
      role: user.role
    };
    req.session.lastActivity = Date.now();

    // Diagnostic log — helps trace the POST→GET session round-trip on Render
    console.log('[AUTH] Session created:', !!req.session, req.session?.user?.email, '| secure:', isProduction, '| proto:', req.protocol);

    res.json({
      message: 'Authentication successful',
      user: req.session.user
    });
  } catch (err) {
    console.error('Google token verification error:', err.message);
    // Return generic error — never expose internal verification details to client
    res.status(401).json({ error: 'Google authentication failed. Please try again.' });
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

    const totalSections = secRow ? secRow.count : 0;
    const totalStudents = stuRow ? stuRow.count : 0;
    const totalSifs = sifRow ? sifRow.count : 0;

    const sectionBreakdown = await query(`
      SELECT 
        sec.id,
        sec.name,
        sec.status,
        COUNT(DISTINCT s.id) as student_count,
        COUNT(DISTINCT gf.id) as sif_count
      FROM sections sec
      LEFT JOIN students s ON sec.id = s.section_id
      LEFT JOIN generated_files gf ON s.id = gf.student_id
      GROUP BY sec.id, sec.name, sec.status
      ORDER BY sec.name ASC
    `);

    res.json({
      totalSections,
      totalStudents,
      totalSifs,
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
// 5. ADMIN STUDENT MANAGEMENT & SEARCH
// ==========================================

// Admin: Search & Filter Students
app.get('/api/students', requireAuth, requireAdmin, async (req, res) => {
  const { query: searchQuery, sectionId } = req.query;

  let sql = `
    SELECT 
      s.id,
      s.student_id,
      s.first_name,
      s.middle_name,
      s.last_name,
      s.email,
      s.section_id,
      sec.name as section_name,
      gf.id as generated_file_id,
      gf.file_name,
      gf.file_size,
      gf.generated_at as sif_created_at
    FROM students s
    LEFT JOIN sections sec ON s.section_id = sec.id
    LEFT JOIN generated_files gf ON s.id = gf.student_id
    WHERE 1=1
  `;
  const params = [];

  if (searchQuery && searchQuery.trim()) {
    const q = `%${searchQuery.trim()}%`;
    sql += ` AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ? OR CONCAT(s.first_name, ' ', s.last_name) LIKE ?)`;
    params.push(q, q, q, q, q);
  }

  if (sectionId && sectionId !== 'all') {
    sql += ` AND s.section_id = ?`;
    params.push(sectionId);
  }

  sql += ` ORDER BY s.last_name ASC, s.first_name ASC`;

  try {
    const students = await query(sql, params);
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search student records.' });
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

// ==========================================
// 6. SECURE FILE ACCESS & DOWNLOADS (PROTECTED)
// ==========================================

// Download SIF PDF (Strict Ownership Check)
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

    const fullPath = path.isAbsolute(fileRecord.file_path)
      ? fileRecord.file_path
      : path.join(__dirname, fileRecord.file_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File does not exist on server.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.file_name}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to download file.' });
  }
});

// View SIF PDF inline in browser (Strict Ownership Check)
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

    // Critical Security Check: Student can ONLY view their own file
    if (req.session.user.role !== 'admin' && req.session.user.id !== fileRecord.user_id) {
      return res.status(403).json({ error: 'You do not have permission to access this student record.' });
    }

    const fullPath = path.isAbsolute(fileRecord.file_path)
      ? fileRecord.file_path
      : path.join(__dirname, fileRecord.file_path);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File does not exist on server.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileRecord.file_name}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
  } catch (err) {
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

// Add authorized school user (Must belong to @olivarezcollege.edu.ph)
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, name, role } = req.body;
  if (!email || !name) {
    return res.status(400).json({ error: 'Email and full name are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanRole = role === 'admin' ? 'admin' : 'student';

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
      message: 'Authorized user added successfully.',
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

// Update user role
app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['admin', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
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
