const supabase = require('./../util/supabaseClient');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const { createClient } = require('@supabase/supabase-js');

const isProd = process.env.NODE_ENV === 'production';

// Centralized cookie options for setting auth cookie
function getAuthCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: isProd ? true : false, // true in prod (HTTPS)
    sameSite: isProd ? 'none' : 'lax', // cross-site requires "none"
    path: '/',
    maxAge: maxAgeMs,
    expires: new Date(Date.now() + maxAgeMs)
  };
}

// Centralized cookie options for clearing auth cookie (MUST MATCH)
function getClearCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd ? true : false,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0)
  };
}

const createSendToken = (user, access_token, statusCode, res) => {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Use cross-site-safe options
  const cookieOptions = getAuthCookieOptions(maxAge);

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
      data: { display_name: name }
    }
  });

  if (authError) return next(new AppError(authError.message, 400));

  const user = authuser.user;
  const filteredUser = {
    id: user.id,
    email: user.email,
    name: user.user_metadata.display_name || null
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

  if (loginError) return next(new AppError(loginError.message, 400));

  const user = loginData.user;
  if (!user) return next(new AppError('User not found', 400));

  const filteredUser = {
    id: user.id,
    email: user.email,
    name: user.user_metadata.display_name || null
  };

  const accessToken = loginData.session?.access_token || null;

  createSendToken(filteredUser, accessToken, 200, res);
});

// Protect middleware
exports.protect = catchAsync(async (req, res, next) => {
  const token = req.cookies?.jwt;

  if (!token) {
    return next(
      new AppError('You not logged in! Please login to get access', 401)
    );
  }

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

  req.user = userData;
  next();
});

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
  if (!email) return next(new AppError('Please provide email', 400));

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // In production, set this to a deployed frontend URL
    redirectTo:
      process.env.RESET_REDIRECT_URL ||
      'http://localhost:8000/api/drive/user/resetPassword'
  });

  if (error) return next(new AppError(error.message, 400));

  res.status(200).json({
    status: 'success',
    data: { message: 'Please check your email to reset your password' }
  });
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token, password, confirmPassword, refresh_token } = req.body;

  if (!token || !password || !confirmPassword) {
    return next(
      new AppError('Please provide token, password and confirmPassword', 400)
    );
  }

  if (password !== confirmPassword) {
    return next(new AppError('Passwords do not match', 400));
  }

  const tempSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      auth: { persistSession: false }
    }
  );

  const { data: sessionData, error: signInError } =
    await tempSupabase.auth.setSession({
      access_token: token,
      refresh_token
    });

  if (signInError || !sessionData) {
    return next(new AppError('Invalid or expired token.', 400));
  }

  const { error: updateError } = await tempSupabase.auth.updateUser({
    password
  });
  if (updateError)
    return next(
      new AppError('Failed to update password: ' + updateError.message, 400)
    );

  await tempSupabase.auth.signOut();

  res
    .status(200)
    .json({ status: 'success', message: 'Password reset successfully' });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return next(new AppError('Please provide all required fields', 400));
  }

  if (newPassword !== confirmPassword) {
    return next(
      new AppError('NewPassword and confirmPassword do not match', 400)
    );
  }

  const tempSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
      auth: { persistSession: false }
    }
  );

  const { error: verifyError } = await tempSupabase.auth.signInWithPassword({
    email: req.user.email,
    password: currentPassword
  });

  if (verifyError)
    return next(new AppError('Current password is incorrect', 400));

  const { error: updateError } = await tempSupabase.auth.updateUser({
    password: newPassword
  });

  if (updateError) return next(new AppError(updateError.message, 400));

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

  const accessToken = newSessionData.session?.access_token || null;
  const user = newSessionData.user;

  createSendToken(user, accessToken, 200, res);
});

exports.logout = catchAsync(async (req, res, next) => {
  // Clear using identical attributes as set
  res.cookie('jwt', '', getClearCookieOptions());
  return res.status(200).json({ status: 'success', message: 'Logged out' });
});
