require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

function getDatabaseConfig() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      const isSsl = parsed.searchParams.get('ssl-mode') || process.env.DB_SSL === 'true' || (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1');
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '3306', 10),
        user: decodeURIComponent(parsed.username || 'root'),
        password: decodeURIComponent(parsed.password || ''),
        database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : 'defaultdb',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ...(isSsl ? { ssl: { rejectUnauthorized: false } } : {})
      };
    } catch (e) {
      console.warn('[DB] Failed to parse DATABASE_URL, falling back to individual DB_* env vars:', e.message);
    }
  }

  const host = process.env.DB_HOST || 'localhost';
  const isSsl = process.env.DB_SSL === 'true' || (process.env.NODE_ENV === 'production' && host !== 'localhost' && host !== '127.0.0.1');
  return {
    host: host,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sif_201_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ...(isSsl ? { ssl: { rejectUnauthorized: false } } : {})
  };
}

const DB_CONFIG = getDatabaseConfig();

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(DB_CONFIG);
  }
  return pool;
}

/**
 * Initialize MySQL Database & Tables
 */
async function initDatabase() {
  console.log(`[DB] Connecting to MySQL at ${DB_CONFIG.host}:${DB_CONFIG.port}, database: ${DB_CONFIG.database}, ssl: ${!!DB_CONFIG.ssl}`);
  // 1. Try to ensure database exists if user has global permissions (skip gracefully if scoped user on cloud)
  try {
    const tempConnection = await mysql.createConnection({
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      ...(DB_CONFIG.ssl ? { ssl: DB_CONFIG.ssl } : {})
    });
    await tempConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await tempConnection.end();
  } catch (err) {
    // On cloud databases (Aiven, TiDB, Railway), database is pre-created by provider or user lacks CREATE DATABASE privilege
  }

  const p = getPool();

  // 2. Users Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      google_id VARCHAR(255) NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      role ENUM('admin', 'student') NOT NULL DEFAULT 'student',
      status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  // 3. Sections Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS sections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      status ENUM('active', 'archived') NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  // 4. Students Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS students (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNIQUE NULL,
      student_id VARCHAR(100) UNIQUE NULL,
      first_name VARCHAR(150) NULL,
      middle_name VARCHAR(150) NULL,
      last_name VARCHAR(150) NULL,
      section_id INT NULL,
      email VARCHAR(255) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // 5. Student Information Table (Form JSON)
  await p.query(`
    CREATE TABLE IF NOT EXISTS student_information (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      form_data LONGTEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  // 6. PDF Templates Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS pdf_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      version VARCHAR(50) NOT NULL DEFAULT '1.0',
      file_path VARCHAR(500) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      uploaded_by VARCHAR(255) NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  // 7. PDF Field Mappings Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS pdf_field_mappings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      template_id INT NOT NULL,
      form_field VARCHAR(100) NOT NULL,
      page_number INT NOT NULL DEFAULT 1,
      x FLOAT NOT NULL,
      y FLOAT NOT NULL,
      font_size FLOAT NOT NULL DEFAULT 10,
      is_mapped TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES pdf_templates(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  // 8. Generated Files Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS generated_files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      template_id INT NULL,
      file_path VARCHAR(500) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_size INT NOT NULL,
      generated_by VARCHAR(255) NULL,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES pdf_templates(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // 9. Audit Logs Table
  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(100) NULL,
      details LONGTEXT NULL,
      ip_address VARCHAR(100) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB;
  `);

  // Seed Sections
  const [secRows] = await p.query('SELECT COUNT(*) as count FROM sections');
  if (secRows[0].count === 0) {
    const initialSections = [
      '1A', '1B', '1C', '1D',
      '2A', '2B', '2C', '2D',
      '3A', '3B', '3C', '3D',
      '4A', '4B', '4C', '4D'
    ];
    for (const sec of initialSections) {
      await p.query('INSERT IGNORE INTO sections (name, status) VALUES (?, ?)', [sec, 'active']);
    }
  }

  // Seed Initial Users
  const [uRows] = await p.query('SELECT COUNT(*) as count FROM users');
  const defaultUsers = [
    ['jhaydee.bunales@olivarezcollege.edu.ph', 'Jhaydee Bunales (Admin)', 'admin', 'active'],
    ['admin@olivarezcollege.edu.ph', 'College Administrator', 'admin', 'active']
  ];

  for (const u of defaultUsers) {
    await p.query(`
      INSERT INTO users (email, name, role, status)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), status = VALUES(status)
    `, u);
  }

  // Seed Default Template
  const [tplRows] = await p.query('SELECT COUNT(*) as count FROM pdf_templates');
  if (tplRows[0].count === 0) {
    await p.query(`
      INSERT INTO pdf_templates (name, version, file_path, is_active, uploaded_by)
      VALUES (?, ?, ?, 1, ?)
    `, [
      'Olivarez College BSIT Student Personal Information Sheet',
      '2026.1',
      'templates/Student_Personal_Information_Sheet.pdf',
      'admin@school.edu.ph'
    ]);
  }

  // Try migrating existing SQLite records if SQLite file exists and MySQL tables are fresh
  await migrateFromSqliteIfAvailable();
}

/**
 * Migration helper from SQLite to MySQL
 */
async function migrateFromSqliteIfAvailable() {
  const sqliteDbPath = path.join(__dirname, '..', 'data', 'sif_system.db');
  if (!fs.existsSync(sqliteDbPath)) return;

  try {
    const Database = require('better-sqlite3');
    const sqliteDb = new Database(sqliteDbPath, { readonly: true });
    const p = getPool();

    // 1. Users
    const sqliteUsers = sqliteDb.prepare('SELECT * FROM users').all();
    for (const u of sqliteUsers) {
      await p.query(`
        INSERT INTO users (id, google_id, email, name, role, status)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status)
      `, [u.id, u.google_id || null, u.email, u.name, u.role, u.status]);
    }

    // Ensure Olivarez College Admin accounts have admin role
    await p.query(`
      UPDATE users SET role = 'admin', status = 'active'
      WHERE LOWER(email) IN ('jhaydee.bunales@olivarezcollege.edu.ph', 'admin@olivarezcollege.edu.ph')
    `);

    // 2. Sections
    const sqliteSections = sqliteDb.prepare('SELECT * FROM sections').all();
    for (const s of sqliteSections) {
      await p.query(`
        INSERT INTO sections (id, name, status)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE name = VALUES(name), status = VALUES(status)
      `, [s.id, s.name, s.status]);
    }

    // 3. Students
    const sqliteStudents = sqliteDb.prepare('SELECT * FROM students').all();
    for (const st of sqliteStudents) {
      await p.query(`
        INSERT INTO students (id, user_id, student_id, first_name, middle_name, last_name, section_id, email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          student_id = VALUES(student_id),
          first_name = VALUES(first_name),
          middle_name = VALUES(middle_name),
          last_name = VALUES(last_name),
          section_id = VALUES(section_id),
          email = VALUES(email)
      `, [st.id, st.user_id, st.student_id, st.first_name, st.middle_name, st.last_name, st.section_id, st.email]);
    }

    // 4. Student Information
    const sqliteInfo = sqliteDb.prepare('SELECT * FROM student_information').all();
    for (const info of sqliteInfo) {
      await p.query(`
        INSERT INTO student_information (id, student_id, form_data)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE form_data = VALUES(form_data)
      `, [info.id, info.student_id, info.form_data]);
    }

    // 5. Generated Files
    const sqliteFiles = sqliteDb.prepare('SELECT * FROM generated_files').all();
    for (const gf of sqliteFiles) {
      await p.query(`
        INSERT INTO generated_files (id, student_id, template_id, file_path, file_name, file_size, generated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), file_name = VALUES(file_name)
      `, [gf.id, gf.student_id, gf.template_id, gf.file_path, gf.file_name, gf.file_size, gf.generated_by || 'system']);
    }

    sqliteDb.close();
    console.log('✓ SQLite records migrated to MySQL successfully.');
  } catch (err) {
    console.warn('Note on SQLite migration:', err.message);
  }
}

/**
 * Helper: Run single query returning [rows, fields]
 */
async function query(sql, params = []) {
  const p = getPool();
  const [rows] = await p.query(sql, params);
  return rows;
}

/**
 * Helper: Run query returning first row or null
 */
async function getOne(sql, params = []) {
  const p = getPool();
  const [rows] = await p.query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Helper: Run INSERT/UPDATE/DELETE returning result object (insertId, affectedRows)
 */
async function execute(sql, params = []) {
  const p = getPool();
  const [result] = await p.query(sql, params);
  return result;
}

module.exports = {
  getPool,
  initDatabase,
  query,
  getOne,
  execute
};
