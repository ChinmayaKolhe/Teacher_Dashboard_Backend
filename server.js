require('dotenv').config();
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas
const studentSchema = new mongoose.Schema({
  studentId: String,
  name: String,
  department: String,
  year: String,
  division: String
});

const marksSchema = new mongoose.Schema({
  studentId: String,
  studentName: String,
  subject: String,
  division: String,
  department: String,
  year: String,
  paper: String,
  marks: Number,
  uploadedAt: { type: Date, default: Date.now }
});

const querySchema = new mongoose.Schema({
  studentId: String,
  studentName: String,
  subject: String,
  division: String,
  department: String,
  year: String,
  message: String,
  response: String,
  status: { type: String, enum: ['pending', 'resolved'], default: 'pending' },
  timestamp: { type: Date, default: Date.now }
});

const notificationSchema = new mongoose.Schema({
  type: String,
  message: String,
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  timestamp: { type: Date, default: Date.now }
});

const faSettingSchema = new mongoose.Schema({
  subject: String,
  division: String,
  department: String,
  year: String,
  mode: String,
  createdAt: { type: Date, default: Date.now }
});

// MongoDB Models
const Student = mongoose.model('Student', studentSchema);
const Marks = mongoose.model('Marks', marksSchema);
const Query = mongoose.model('Query', querySchema);
const Notification = mongoose.model('Notification', notificationSchema);
const FASetting = mongoose.model('FASetting', faSettingSchema);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.csv', '.xlsx', '.xls'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

// Helper functions
const calculateClassStats = async (filter) => {
  const matchQuery = {};
  if (filter.subject) matchQuery.subject = filter.subject;
  if (filter.division) matchQuery.division = filter.division;
  if (filter.department) matchQuery.department = filter.department;
  if (filter.year) matchQuery.year = filter.year;

  const marks = await Marks.find(matchQuery);
  const totalStudents = await Student.countDocuments({
    department: filter.department,
    year: filter.year,
    division: filter.division
  });

  const totalMarks = marks.reduce((sum, mark) => sum + mark.marks, 0);
  const avgMarks = marks.length > 0 ? Math.round(totalMarks / marks.length) : 0;
  const pendingQueries = await Query.countDocuments({ 
    ...matchQuery, 
    status: 'pending' 
  });

  const faSetting = await FASetting.findOne(matchQuery);

  return {
    avgMarks,
    totalStudents,
    submissionsReceived: marks.length,
    pendingQueries,
    faModeSet: !!faSetting
  };
};

// API Endpoints

// 1. Get initial data (filters, etc)
app.get('/api/init', async (req, res) => {
  try {
    // Get distinct values from the database
    const subjects = await Marks.distinct('subject');
    const departments = await Student.distinct('department');
    const years = await Student.distinct('year');
    const divisions = await Student.distinct('division');
    const faModes = ['Online Quiz', 'Offline Test', 'Assignment', 'Presentation', 'Poster', 'Other'];

    res.json({
      success: true,
      data: {
        subjects,
        departments,
        years,
        divisions,
        faModes
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 2. Get class statistics
app.post('/api/class-stats', async (req, res) => {
  try {
    const { subject, division, department, year } = req.body;
    
    if (!subject || !division || !department || !year) {
      return res.status(400).json({
        success: false,
        message: 'All filter parameters are required'
      });
    }

    const stats = await calculateClassStats({ subject, division, department, year });
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 3. Upload marks
app.post('/api/upload-marks', upload.single('file'), async (req, res) => {
  try {
    const { subject, division, department, year, paper } = req.body;
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    if (!subject || !division || !department || !year || !paper) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let marksData = [];

    const processData = async () => {
      if (fileExt === '.csv') {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => marksData.push(row))
          .on('end', async () => {
            try {
              await saveMarksData(marksData);
              fs.unlinkSync(filePath);
              res.json({
                success: true,
                message: `Marks uploaded successfully for ${marksData.length} students`
              });
            } catch (error) {
              fs.unlinkSync(filePath);
              throw error;
            }
          })
          .on('error', (err) => {
            fs.unlinkSync(filePath);
            throw err;
          });
      } else if (fileExt === '.xlsx' || fileExt === '.xls') {
        try {
          const workbook = xlsx.readFile(filePath);
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          marksData = xlsx.utils.sheet_to_json(worksheet);
          await saveMarksData(marksData);
          fs.unlinkSync(filePath);
          res.json({
            success: true,
            message: `Marks uploaded successfully for ${marksData.length} students`
          });
        } catch (error) {
          fs.unlinkSync(filePath);
          throw error;
        }
      } else {
        fs.unlinkSync(filePath);
        throw new Error('Unsupported file type');
      }
    };

    const saveMarksData = async (data) => {
      const marksToInsert = data.map(row => {
        const studentId = row['Student ID'] || row['student_id'] || row['ID'];
        const studentName = row['Name'] || row['student_name'] || row['Student Name'];
        const marks = parseFloat(row['Marks'] || row['marks'] || row['Score'] || 0);

        if (!studentId || !studentName) {
          throw new Error('Student ID and Name are required in the file');
        }

        if (isNaN(marks)) {
          throw new Error('Invalid marks format');
        }

        return {
          studentId,
          studentName,
          subject,
          division,
          department,
          year,
          paper,
          marks
        };
      });

      await Marks.insertMany(marksToInsert);
    };

    await processData();
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// 4. Get queries
app.get('/api/queries', async (req, res) => {
  try {
    const queries = await Query.find().sort({ timestamp: -1 });
    const notifications = await Notification.find({ status: 'active' }).sort({ timestamp: -1 });
    
    res.json({
      success: true,
      data: {
        queries,
        notifications
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 5. Respond to query
app.post('/api/queries/respond', async (req, res) => {
  try {
    const { queryId, response } = req.body;
    
    if (!queryId || !response) {
      return res.status(400).json({
        success: false,
        message: 'Query ID and response are required'
      });
    }

    const updatedQuery = await Query.findByIdAndUpdate(
      queryId,
      { response, status: 'resolved' },
      { new: true }
    );

    if (!updatedQuery) {
      return res.status(404).json({
        success: false,
        message: 'Query not found'
      });
    }

    res.json({
      success: true,
      data: updatedQuery,
      message: 'Response submitted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 6. Set FA Mode
app.post('/api/fa-mode', async (req, res) => {
  try {
    const { subject, division, department, year, mode } = req.body;
    
    if (!subject || !division || !department || !year || !mode) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Remove any existing setting for this class
    await FASetting.deleteMany({ subject, division, department, year });

    // Create new setting
    const faSetting = new FASetting({
      subject,
      division,
      department,
      year,
      mode
    });

    await faSetting.save();

    res.json({
      success: true,
      data: faSetting,
      message: 'FA Mode set successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 7. Get FA Mode status
app.get('/api/fa-mode', async (req, res) => {
  try {
    const { subject, division, department, year } = req.query;
    
    if (!subject || !division || !department || !year) {
      return res.status(400).json({
        success: false,
        message: 'All filter parameters are required'
      });
    }

    const faSetting = await FASetting.findOne({ subject, division, department, year });

    res.json({
      success: true,
      data: faSetting
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});