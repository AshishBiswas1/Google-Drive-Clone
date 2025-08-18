const express = require('express');
const authController = require('./../controller/authController');
const userDocController = require('./../controller/userDocController');

const router = express.Router();

router.use(authController.protect);

router.route('/share').post(userDocController.shareUserDocument);

router.route('/share/:shareId').get(userDocController.accessSharedDoc);

// For single file deletion
router.route('/delete/:docId').delete(userDocController.deleteUserDocTemp);

// for multiple file deletion
router
  .route('/delete/batch/:docIds')
  .delete(userDocController.deleteUserDocTemp);

// For single file permanent deletion
router
  .route('/permdelete/:docId')
  .delete(userDocController.permanentlyDeleteDocs);

// for multiple file permanent deletion
router
  .route('/permdelete/batch/:docIds')
  .delete(userDocController.permanentlyDeleteDocs);

// restore single deleted file
router.route('/restore/:docId').post(userDocController.restoreUserDoc);

// restore multiple deleted files
router.route('/restore/batch/:docIds').post(userDocController.restoreUserDoc);

router.route('/rename/:docId').patch(userDocController.renameUserDoc);

router.route('/getDeleted').get(userDocController.getdeletedDocs);

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
