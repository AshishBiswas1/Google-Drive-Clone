const express = require('express');
const hpp = require('hpp');
const morgan = require('morgan');
const helmet = require('helmet');
const xss = require('xss-clean');
const cookieParser = require('cookie-parser');

const userRouter = require('./Router/userRouter');
const userDocumentRouter = require('./Router/UserDocumentRouter');
const globalErrorHandler = require('./controller/errorController');
const AppError = require('./util/appError');

const app = express();

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
