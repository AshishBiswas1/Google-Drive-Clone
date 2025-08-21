const express = require('express');
const userController = require('./../controller/userController');
const authController = require('./../controller/authController');

const router = express.Router();

// For signup and login
router.route('/signup').post(authController.signup);
router.route('/login').post(authController.login);

// Route for user forget and reset Password if they have forgoten it
router.route('/forgetPassword').post(authController.forgetPassword);
router.route('/resetPassword').post(authController.resetPassword);

router.use(authController.protect);
router.route('/updatePassword').post(authController.updatePassword);
router.route('/me').get(userController.getMe, userController.getUser);

router.route('/updateMe').patch(userController.updateMe);
router.route('/deleteMe').delete(userController.deleteMe);

router.route('/logout').post(authController.logout);

router.use(authController.protect, authController.restrictTo('admin'));

router
  .route('/')
  .get(userController.getAllUsers)
  .post(userController.createUser);

router
  .route('/:id')
  .get(userController.getUser)
  .patch(userController.updateUser)
  .delete(userController.deleteUser);

module.exports = router;
