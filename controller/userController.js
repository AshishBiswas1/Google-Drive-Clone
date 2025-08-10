const supabase = require('../util/supabaseClient');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');

exports.getAllUsers = catchAsync(async (req, res, next) => {
  const { data: users, error } = await supabase
    .from('User')
    .select('*')
    .order('created_at');

  if (error) return next(new AppError(error.message, 400));

  res.status(200).json({
    status: 'success',
    data: { users }
  });
});

exports.getUser = catchAsync(async (req, res, next) => {
  const email = req.params.email?.trim().toLowerCase();

  const { data, error } = await supabase
    .from('User')
    .select('*')
    .eq('email', email); // Adjust casing as per your DB

  if (error) return next(new AppError('Error fetching user', 500));
  if (!data || data.length === 0)
    return next(new AppError('No user found', 404));

  res.status(200).json({
    status: 'success',
    data: { user: data[0] }
  });
});

exports.createUser = catchAsync(async (req, res, next) => {
  const Name = req.body.name?.trim();
  const email = req.body.email?.trim();
  const password = req.body.password;
  const confirmPassword = req.body.confirmPassword;

  console.log('Email going to Supabase:', JSON.stringify(email));
  console.log('Password going to Supabase:', password);

  if (password !== confirmPassword)
    return next(new AppError('Passwords do not match', 400));

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { Name } }
  });

  if (authError) return next(new AppError(authError.message, 400));

  const { data, error } = await supabase
    .from('User')
    .insert([{ id: authData.user.id, Name, email }], {
      returning: 'representation'
    });

  if (error) return next(new AppError(error.message, 500));

  res.status(201).json({
    status: 'success',
    data
  });
});
