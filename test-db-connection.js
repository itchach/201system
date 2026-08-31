require('dotenv').config();
const mysql = require('mysql2/promise');
const dns = require('dns').promises;

(async () => {
  console.log('=== Aiven / MySQL Database Connection Test ===');

  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '3306', 10);
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'defaultdb';
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;

  console.log('Testing configuration:');
  console.log('  DB_HOST:', host);
  console.log('  DB_PORT:', port);
  console.log('  DB_USER:', user);
  console.log('  DB_NAME:', database);
  console.log('  DATABASE_URL provided:', !!dbUrl);

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    console.log(`\n1. Resolving DNS for ${host}...`);
    try {
      const lookup = await dns.lookup(host);
      console.log(`  ✓ DNS lookup successful: ${host} -> ${lookup.address}`);
    } catch (dnsErr) {
      console.error(`  ✗ DNS lookup FAILED for ${host}:`, dnsErr.message);
      console.error('    Please check the exact Hostname in your Aiven Console.');
      process.exit(1);
    }
  }

  console.log('\n2. Attempting MySQL connection...');
  try {
    const config = dbUrl ? dbUrl : {
      host,
      port,
      user,
      password,
      database,
      ssl: { rejectUnauthorized: false }
    };
    const connection = await mysql.createConnection(config);
    console.log('  ✓ Connected successfully to database!');

    const [rows] = await connection.query('SELECT 1 + 1 AS solution, DATABASE() as current_db, VERSION() as version');
    console.log('  ✓ Query test passed:', rows);

    const [tables] = await connection.query('SHOW TABLES');
    console.log(`  ✓ Found ${tables.length} tables in database:`, tables.map(t => Object.values(t)[0]));

    await connection.end();
    console.log('\n✓ Database connection test PASSED completely.');
  } catch (dbErr) {
    console.error('  ✗ Database connection FAILED:', dbErr.message);
    console.error('    Error Code:', dbErr.code);
    process.exit(1);
  }
})();
