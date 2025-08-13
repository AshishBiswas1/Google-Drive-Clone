const supabase = require('./../util/supabaseClient');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const { createClient } = require('@supabase/supabase-js');

const createSendToken = (user, access_token, statusCode, res) => {
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true
  };

  if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;

  res.cookie('jwt', access_token, cookieOptions);

  res.status(statusCode).json({
    status: 'success',
    token: access_token,
    data: {
      user
    }
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  const name = req.body.name;
  const email = req.body.email;
  const password = req.body.password;
  const confirmPassword = req.body.confirmPassword;

  if (password !== confirmPassword) {
    return next(
      new AppError('Password and ConfirmPassword do not match.', 400)
    );
  }

  const { data: authuser, error: authError } = await supabase.auth.signUp({
    email: email,
    password: password,
    options: {
      data: {
        display_name: name
      }
    }
  });

  if (authError) {
    return next(new AppError(authError.message, 400));
  }

  const user = authuser.user;
  const filteredUser = {
    id: user.id,
    email: user.email,
    name: user.user_metadata.display_name || null // or display_name if you used that
  };
  const id = user.id;
  const accessToken = authuser.session?.access_token || null;

  const { error: userError } = await supabase
    .from('User')
    .insert([{ id, name, email }]);

  if (userError) return next(new AppError(userError.message, 400));

  createSendToken(filteredUser, accessToken, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
  const email = req.body.email;
  const password = req.body.password;

  if (!email || !password) {
    return next(new AppError('Please provide email and password', 400));
  }

  const { data: loginData, error: loginError } =
    await supabase.auth.signInWithPassword({
      email,
      password
    });

  if (loginError) {
    return next(new AppError(loginError.message, 400));
  }

  const user = loginData.user;

  if (!user) {
    return next(new AppError('User not found', 400));
  }

  const filteredUser = {
    id: user.id,
    email: user.email,
    name: user.user_metadata.display_name || null // or display_name if you used that
  };

  const accessToken = loginData.session?.access_token || null;

  createSendToken(filteredUser, accessToken, 200, res);
});

// This will allow to protect routes which require login
exports.protect = catchAsync(async (req, res, next) => {
  // 1) Get the accessToken from the cookies
  const token = req.cookies?.jwt;

  if (!token) {
    return next(
      new AppError('You not logged in! Please login to get access', 401)
    );
  }

  // 2) Verify the accessToken if the user still exits

  const { data: authData, error: authError } = await supabase.auth.getUser(
    token
  );

  if (authError || !authData?.user) {
    return next(new AppError('Invalid token or user no longer exists!', 401));
  }

  const userId = authData.user.id;

  const { data: userData, error: userError } = await supabase
    .from('User')
    .select('*')
    .eq('id', userId)
    .single();

  if (userError) return next(new AppError(userError.message, 400));

  // 3)Attach the user to the request
  req.user = userData;

  next();
});

// This will help to allow only certain users to access specific routes
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.Role)) {
      return next(
        new AppError(
          'You do not have the permission to perform this action!',
          403
        )
      );
    }

    next();
  };
};

exports.forgetPassword = catchAsync(async (req, res, next) => {
  const email = req.body.email;

  if (!email) {
    return next(new AppError('Please provide email', 400));
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'http://localhost:8000/api/drive/user/resetPassword'
  });

  if (error) {
    return next(new AppError(error.message, 400));
  }

  res.status(200).json({
    status: 'success',
    data: {
      message: 'Please check your email to reset your password'
    }
  });
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token, password, confirmPassword } = req.body;

  if (!token || !password || !confirmPassword) {
    return next(
      new AppError('Please provide token, password and confirmPassword', 400)
    );
  }

  if (password !== confirmPassword) {
    return next(new AppError('Passwords do not match', 400));
  }

  // 1. Temporarily create a supabase client without session persistence
  const tempSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    { auth: { persistSession: false } }
  );

  // 2. Authenticate using the recovery token to establish a session
  const { data: sessionData, error: signInError } =
    await tempSupabase.auth.setSession({
      access_token: token, // from req.body.token
      refresh_token: req.body.refresh_token // new — from request body
    });

  if (signInError || !sessionData) {
    return next(new AppError('Invalid or expired token.', 400));
  }

  // 3. Use the temporary authenticated client to update the password
  const { error: updateError } = await tempSupabase.auth.updateUser({
    password
  });

  if (updateError) {
    return next(
      new AppError('Failed to update password: ' + updateError.message, 400)
    );
  }

  // 4. Optionally sign out the temporary session for cleanup
  await tempSupabase.auth.signOut();

  res.status(200).json({
    status: 'success',
    message: 'Password reset successfully'
  });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return next(new AppError('Please provide all required fields', 400));
  }

  // If passwords do not match
  if (newPassword !== confirmPassword) {
    return next(
      new AppError('NewPassword and confirmPassword do not match', 400)
    );
  }

  // Create a temporary client session (no persisting)
  const tempSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    { auth: { persistSession: false } }
  );

  // 1. Verify current password by logging in with it
  const { data: loginData, error: verifyError } =
    await tempSupabase.auth.signInWithPassword({
      email: req.user.email,
      password: currentPassword
    });

  if (verifyError) {
    return next(new AppError('Current password is incorrect', 400));
  }

  // 2. Update the password using the session from tempSupabase
  const { error: updateError } = await tempSupabase.auth.updateUser({
    password: newPassword
  });

  if (updateError) {
    return next(new AppError(updateError.message, 400));
  }

  // 3. Sign in again with the new password to get a fresh token
  const { data: newSessionData, error: signInError } =
    await tempSupabase.auth.signInWithPassword({
      email: req.user.email,
      password: newPassword
    });

  if (signInError) {
    return next(
      new AppError('Password updated, but failed to sign in again', 400)
    );
  }

  // 4. Send fresh token & user
  const accessToken = newSessionData.session?.access_token || null;
  const user = newSessionData.user;

  createSendToken(user, accessToken, 200, res);
});
