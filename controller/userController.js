const supabase = require('../util/supabaseClient');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const bcrypt = require('bcryptjs');

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
  const id = req.params.id;

  const { data, error } = await supabase.from('User').select('*').eq('id', id); // Adjust casing as per your DB

  if (error) return next(new AppError('Error fetching user', 500));
  if (!data || data.length === 0)
    return next(new AppError('No user found', 404));

  res.status(200).json({
    status: 'success',
    data: { user: data[0] }
  });
});

exports.createUser = catchAsync(async (req, res, next) => {
  const name = req.body.name?.trim();
  const email = req.body.email?.trim();
  const password = req.body.password?.trim();
  const confirmPassword = req.body.confirmPassword?.trim();
  const id = req.body.id;

  if (password !== confirmPassword) {
    return next(new AppError('Passwords do not match', 400));
  }

  const hashedpassword = await bcrypt.hash(password, 12);

  const { data, error: userError } = await supabase
    .from('User')
    .insert([{ id, name, email, password: hashedpassword }]);

  if (userError) return next(new AppError(userError.message, 400));

  const { data: user, error } = await supabase
    .from('User')
    .select('*')
    .eq('email', email);

  res.status(201).json({
    status: 'success',
    data: { user }
  });
});

exports.updateUser = catchAsync(async (req, res, next) => {
  const id = req.params.id;
  const name = req.body.name;
  const email = req.body.email;

  const { data, error } = await supabase
    .from('User')
    .update({ name, email })
    .eq('id', id);

  if (error) return next(new AppError(error.message, 400));

  const { data: user, error: userError } = await supabase
    .from('User')
    .select('*')
    .eq('id', id);

  res.status(200).json({
    status: 'success',
    data: {
      user
    }
  });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  const id = req.params.id;

  const { data, error } = await supabase.from('User').delete().eq('id', id);

  if (error) return next(new AppError(error.message, 400));

  res.status(200).json({
    status: 'success'
  });
});
