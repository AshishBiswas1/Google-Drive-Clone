const supabase = require('./../util/supabaseClient');
const multer = require('multer');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const path = require('path');

const upload = multer({ storage: multer.memoryStorage() });

exports.uploadDocumentMiddleware = upload.array('document', 2);

exports.uploadUserDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const files = req.files;
  if (!files || files.length === 0) {
    return next(new AppError('No documents uploaded', 400));
  }

  if (files.length > 2) {
    return next(new AppError('You can only upload 2 documents at a time', 400));
  }

  const uploadResult = await Promise.all(
    files.map(async (file) => {
      const safeFileName = file.originalname.replace(/\s+/g, '_');

      const storagePath = `documents/${userId}/${safeFileName}`;

      const { error: uploadError } = await supabase.storage
        .from('User-Documents')
        .upload(storagePath, file.buffer, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.mimetype
        });

      if (uploadError) {
        throw new AppError(
          `Upload failed for ${file.originalname}: ${uploadError.message}`,
          400
        );
      }

      const { error: insertError } = await supabase
        .from('UserDocuments')
        .insert([
          {
            uid: userId,
            fileName: safeFileName,
            path_of_file: storagePath,
            mimetype: file.mimetype,
            filesize: file.size,
            uploaded_at: new Date()
          }
        ]);

      if (insertError) {
        return next(
          new AppError(
            `Insert failed for ${file.originalname}: ${insertError.message}`,
            400
          )
        );
      }
      return {
        original_filename: safeFileName,
        path: storagePath,
        mimetype: file.mimetype,
        size: file.size
      };
    })
  );

  res.status(201).json({
    status: 'success',
    message: 'Documents uploaded successfully',
    data: { uploadedFiles: uploadResult }
  });
});

exports.getUserDocs = catchAsync(async (req, res, next) => {
  const { data: userDocs, error: userDocsError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('uid', req.user.id)
    .order('uploaded_at', { ascending: false });

  if (userDocsError) {
    return next(new AppError(userDocsError.message, 400));
  }

  res.status(200).json({
    status: 'success',
    data: { userDocs }
  });
});
