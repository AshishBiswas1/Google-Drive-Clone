const express = require('express');
const authController = require('./../controller/authController');
const userDocController = require('./../controller/userDocController');

const router = express.Router();

router.use(authController.protect);

router
  .route('/upload')
  .post(
    userDocController.uploadDocumentMiddleware,
    userDocController.uploadUserDocs
  );

router.route('/openDoc/:docId').get(userDocController.openUserDocument);
router.route('/download/:docId').get(userDocController.downloadUserDoc);

router.route('/getDocs').get(userDocController.getUserDocs);

module.exports = router;
