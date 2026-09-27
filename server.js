require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { attachOrg } = require('./middleware/orgMiddleware');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Electro Staff API running' });
});

// Every other /api route is scoped to an organization.
app.use('/api', attachOrg);

app.use('/api/org', require('./routes/orgRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/staff', require('./routes/staffRoutes'));
app.use('/api/sites', require('./routes/siteRoutes'));
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/advances', require('./routes/advanceRoutes'));
app.use('/api/payroll', require('./routes/payrollRoutes'));
app.use('/api/expenses', require('./routes/expenseRoutes'));
app.use('/api/receipts', require('./routes/receiptRoutes'));
app.use('/api/leaves', require('./routes/leaveRoutes'));
app.use('/api/performance', require('./routes/performanceRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));

app.use('/api', notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
};

if (require.main === module) start();

module.exports = app;
