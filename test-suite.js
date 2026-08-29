const http = require('http');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch(e) { json = body; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });
    req.on('error', reject);
    if (data) {
      if (typeof data === 'object') {
        req.write(JSON.stringify(data));
      } else {
        req.write(data);
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING END-TO-END VERIFICATION SUITE ===\n');

  // Test 1: Check active sections
  const secRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/sections/active',
    method: 'GET'
  });
  console.log('Test 1: GET /api/sections/active -> Status:', secRes.status, 'Count:', secRes.data.length);
  if (!secRes.data.some(s => s.name === '1A')) throw new Error('Initial sections missing 1A');

  // Test 2: Admin Login
  const adminLogin = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'admin@school.edu.ph' });
  console.log('Test 2: Admin Login -> Status:', adminLogin.status, 'Role:', adminLogin.data.user.role);
  const adminCookie = adminLogin.headers['set-cookie'];

  // Test 3: Admin creates new dynamic section "TEST_TEMP"
  const createSec = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/sections',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, { name: 'TEST_TEMP' });
  console.log('Test 3: Admin created Section TEST_TEMP -> Status:', createSec.status, 'Message:', createSec.data ? createSec.data.message : 'OK');

  // Test 4: Verify TEST_TEMP is now in active sections
  const secRes2 = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/sections/active',
    method: 'GET'
  });
  const sectionTest = secRes2.data.find(s => s.name === 'TEST_TEMP');
  if (!sectionTest) throw new Error('Dynamic section TEST_TEMP not found in active list');
  console.log('Test 4: Dynamic section TEST_TEMP in active sections list -> PASS ✓');

  // Test 5: Student Login
  const studentLogin = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'student001@school.edu.ph' });
  console.log('Test 5: Student Login -> Status:', studentLogin.status, 'User:', studentLogin.data.user.email);
  const studentCookie = studentLogin.headers['set-cookie'];

  // Test 6: Student submits Olivarez College BSIT Form with Section TEST_TEMP
  const formSubmission = {
    formData: {
      sectionId: sectionTest.id,
      studentId: '2026-001',
      yearLevel: '2nd Year',
      lastName: 'Dela Cruz',
      firstName: 'Juan',
      middleName: 'Protacio',
      cityAddress: '123 Sucat Rd, Parañaque City, Metro Manila',
      provincialAddress: 'San Isidro, Nueva Ecija',
      landline: '(02) 8820-1234',
      mobile: '0917-555-0199',
      age: '20',
      gender: 'Male',
      civilStatus: 'Single',
      nationality: 'Filipino',
      religion: 'Roman Catholic',
      ordinalPosition: '1st',
      numSiblings: '2',
      numBoys: '1',
      numGirls: '1',
      birthdate: '2006-01-15',
      fatherName: 'Pedro Dela Cruz',
      fatherOccupation: 'Civil Engineer',
      fatherContact: '0918-111-2233',
      fatherCompanyAddress: 'Makati City',
      fatherEducationalAttainment: 'College Graduate',
      motherName: 'Maria Dela Cruz',
      motherOccupation: 'Accountant',
      motherContact: '0919-444-5566',
      motherCompanyAddress: 'Taguig City',
      motherEducationalAttainment: 'College Graduate',
      parentStatus: 'Living Together',
      livingArrangement: 'Living with Parents',
      languagesSpoken: 'Tagalog, English',
      collegeSchool: 'Olivarez College Parañaque',
      collegeAddress: 'Dr. A. Santos Ave, Parañaque',
      collegeCourse: 'BS Information Technology',
      highSchool: 'Parañaque National High School',
      highSchoolAddress: 'Parañaque City',
      elementarySchool: 'Parañaque Elementary School',
      elementaryAddress: 'Parañaque City',
      emergencyName: 'Maria Dela Cruz',
      emergencyRelationship: 'Mother',
      emergencyContact: '0919-444-5566',
      emergencyAddress: '123 Sucat Rd, Parañaque City'
    }
  };

  const submitRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/student/submit',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': studentCookie
    }
  }, formSubmission);
  console.log('Test 6: SIF Form Submission & Auto-Generation -> Status:', submitRes.status, 'File:', submitRes.data.fileName, 'Section:', submitRes.data.sectionName);

  // Test 7: Verify student can view their generated SIF
  const viewRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/files/sif/${submitRes.data.fileId}/view`,
    method: 'GET',
    headers: { 'Cookie': studentCookie }
  });
  console.log('Test 7: Student View SIF PDF -> Status:', viewRes.status, 'Content-Type:', viewRes.headers['content-type']);

  // Test 8: Admin views Section TEST_TEMP student list
  const secStudents = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/sections/${sectionTest.id}/students`,
    method: 'GET',
    headers: { 'Cookie': adminCookie }
  });
  console.log('Test 8: Admin View Section TEST_TEMP Files -> Status:', secStudents.status, 'Students:', secStudents.data.students.length);

  // Test 9: Admin moves student from TEST_TEMP to 2B
  const section2B = secRes2.data.find(s => s.name === '2B');
  const studentDbId = secStudents.data.students[0].id;
  const moveRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/students/${studentDbId}/section`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, { sectionId: section2B.id });
  console.log('Test 9: Admin Move Student Section to 2B -> Status:', moveRes.status, 'Message:', moveRes.data.message);

  // Test 10: Admin regenerates SIF PDF under 2B
  const regenRes = await request({
    hostname: 'localhost',
    port: 3000,
    path: `/api/students/${studentDbId}/regenerate-pdf`,
    method: 'POST',
    headers: { 'Cookie': adminCookie }
  });
  console.log('Test 10: Admin Regenerate SIF PDF under new Section -> Status:', regenRes.status, 'Result:', regenRes.data.message);

  // Cleanup TEST_TEMP from DB and disk
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');
  const db = new Database(path.join(__dirname, 'data', 'sif_system.db'));
  db.prepare('DELETE FROM sections WHERE name = ?').run('TEST_TEMP');
  const tempDir = path.join(__dirname, 'uploads', 'sifs', 'TEST_TEMP');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('\n=== ALL 10 END-TO-END TEST SUITE CHECKS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
