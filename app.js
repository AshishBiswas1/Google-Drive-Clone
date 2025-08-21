const express = require('express');
const hpp = require('hpp');
const morgan = require('morgan');
const helmet = require('helmet');
const xss = require('xss-clean');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const userRouter = require('./Router/userRouter');
const userDocumentRouter = require('./Router/UserDocumentRouter');
const globalErrorHandler = require('./controller/errorController');
const AppError = require('./util/appError');

const app = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: 'https://google-drive-clone-frontend-smoky.vercel.app',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  return res.sendStatus(204);
});

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(hpp());
app.use(helmet());
app.use(xss());
app.use(cookieParser());

app.use(express.json());

app.use('/api/drive/user', userRouter);
app.use('/api/drive/docs', userDocumentRouter);

app.all('*', (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

app.use(globalErrorHandler);

module.exports = app;
