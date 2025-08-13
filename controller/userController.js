const supabase = require('../util/supabaseClient');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const bcrypt = require('bcryptjs');

const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });

  return newObj;
};

exports.getAllUsers = catchAsync(async (req, res, next) => {
  const { data: users, error } = await supabase
    .from('User')
    .select('*')
    .eq('is_active', true)
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

exports.getMe = catchAsync(async (req, res, next) => {
  req.params.id = req.user.id;
  next();
});

exports.updateMe = catchAsync(async (req, res, next) => {
  // Filter fields for custom User table
  const tableFields = filterObj(req.body, 'name', 'email');

  // Filter fields for Supabase Auth user_metadata
  // (You may want to include only custom profile fields, e.g., display_name, provider_type)
  const metadataFields = filterObj(req.body, 'email');

  if (req.body.name !== undefined) metadataFields.display_name = req.body.name;

  // Optionally: handle photo uploads
  if (req.file) {
    tableFields.photo = req.file.filename;
    metadataFields.photo = req.file.filename;
  }

  // 1) Update Supabase Auth user (user_metadata & email/phone)
  let authUpdateObj = { data: metadataFields };
  // If you want to update top-level email
  if ('email' in tableFields) authUpdateObj.email = tableFields.email;

  const { data: authUser, error: authError } = await supabase.auth.updateUser(
    authUpdateObj
  );

  if (authError) return next(new AppError(authError.message, 400));

  const { data: userTableUser, error: tableError } = await supabase
    .from('User')
    .update(tableFields)
    .eq('id', req.user.id)
    .select()
    .single();

  if (tableError)
    return next(
      new AppError('User table update failed: ' + tableError.message, 400)
    );

  // 3) Return combined info
  res.status(200).json({
    status: 'success',
    data: {
      user: userTableUser // Updated custom User table row
    }
  });
});

exports.deleteMe = catchAsync(async (req, res, next) => {
  const { error: userError } = await supabase
    .from('User')
    .update({ is_active: false })
    .eq('id', req.user.id);

  if (userError) {
    return next(new AppError(userError.message, 400));
  }

  res.status(200).json({
    status: 'success'
  });
});
