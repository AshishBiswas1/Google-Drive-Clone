const express = require('express');
const authController = require('./../controller/authController');
const userDocController = require('./../controller/userDocController');

const router = express.Router();

router.use(authController.protect);

// After authController.protect
router.get('/shared-to', userDocController.listSharedTo);
router.get('/shared-from', userDocController.listSharedFrom);

router.route('/openShared/:docId').get(userDocController.openViaStoredShare);

router.route('/removeShare/:docId').delete(userDocController.removeShare);

router.post(
  '/share',
  userDocController.shareUserDocument,
  userDocController.runPostShareHooks
);

router.route('/share/doc/:docId').post(
  userDocController.shareUserDocument, // sets res.locals.share + res.locals.docId; next()
  userDocController.sharedTo, // updates sharedTo; sets res.locals.sharedTo; next()
  userDocController.sharedFrom, // updates sharedFrom; sets res.locals.sharedFrom; next()
  userDocController.runPostShareHooks // sends final JSON with all details
);

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

router.route('/share/emails/:docId').post(userDocController.sharedTo);

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
