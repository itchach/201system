# Student Information File (201-FILE) Management System

A web-based **Student Information File (201-FILE) Management System** for schools built with Node.js, Express, SQLite, and PDF-Lib.

## Overview
The system enables students to complete their official school information sheet via a web form, automatically transfers the mapped data into the fields of the school-provided PDF template (**Olivarez College - College of Computer Studies - Student's Personal Information Sheet (BSIT)**), and systematically organizes generated files by dynamic **Section** folders.

---

## Key Features

1. **Dynamic Section Management**
   - Sections (e.g. `1A`, `1B`, `2A`, `2B`, `3A`, `4D`, `5A`) are stored dynamically in SQLite.
   - Administrators can add, edit, archive, and reactivate sections without requiring code changes.
   - Sections automatically populate the Student Information Form dropdown.

2. **Section as File-Management Metadata**
   - The selected section organizes generated 201-FILE files into directory folders: `uploads/201-FILEs/{section}/201-FILE_{student_id}_{last_name}_{first_name}.pdf`.
   - Distinguishes between form data that goes into the PDF and system metadata (Section). Section is NOT stamped onto the PDF unless explicitly mapped by the admin.

3. **Olivarez College BSIT 2-Page Form & Automated PDF Generation**
   - Implements the complete 2-page Olivarez College BSIT Personal Information Sheet (Personal Details, Parent's Information & check-boxes, Educational Background, and Emergency Contact).
   - Instant automated generation upon form submission with `pdf-lib`.

4. **Section Changes & Historical PDFs (Requirement #7)**
   - Moving a student between sections updates the student record while preserving historical PDFs unless explicitly regenerated.

5. **Authentication & Role-Based Access Control**
   - School Google Workspace login with domain whitelist checking and authorized user verification.
   - Separate Admin and Student portals.
   - Student ownership check: students can only access and download their own 201-FILE document.

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Application Server
```bash
npm start
```
The application will be running locally at: `http://localhost:3000`

### 3. Quick-Access Demo Accounts
- **Admin**: `admin@school.edu.ph`
- **Student 1**: `student001@school.edu.ph` (Juan Dela Cruz)
- **Student 2**: `student002@school.edu.ph` (Maria Santos)
- **Student 3**: `pedro.reyes@school.edu.ph` (Pedro Reyes)

