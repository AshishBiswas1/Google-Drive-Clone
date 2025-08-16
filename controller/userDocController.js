const supabase = require('./../util/supabaseClient');
const multer = require('multer');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const path = require('path');

async function getSignedUrlForDoc(userId, docId, expirySeconds = 60 * 10) {
  const { data: doc, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('id', docId)
    .eq('uid', userId)
    .single();

  if (fetchError || !doc) {
    return { error: 'Not_found' };
  }

  const { data: signedUrl, error: signedError } = await supabase.storage
    .from('User-Documents')
    .createSignedUrl(doc.path_of_file, expirySeconds);

  if (signedError || !signedUrl?.signedUrl) return { error: 'url_error' };

  return { doc, signedUrl: signedUrl.signedUrl };
}

const upload = multer({ storage: multer.memoryStorage() });

// For document upload
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

exports.openUserDocument = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;

  console.log(req.params.docId);

  if (!docId) {
    return next(new AppError('Document Id is required', 400));
  }

  const result = await getSignedUrlForDoc(userId, docId, 60 * 10);

  if (result.error === 'Not_found') {
    return next(new AppError('Document not found', 400));
  }
  if (result.error === 'url_error') {
    return next(new AppError('Unable to generate file access URL.', 400));
  }

  // Detect file extention and build url for editing/viewing if needed
  const ext = path.extname(result.doc.fileName).toLowerCase();
  const googleDocViewer = {
    // Docs & Sheets & Slides
    '.pdf': (url) => url,
    '.doc': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    '.docx': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    '.xls': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    '.xlsx': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    '.ppt': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    '.pptx': (url) =>
      `https://docs.google.com/gview?url=${encodeURIComponent(
        url
      )}&embedded=true`,
    // Images
    '.jpg': (url) => url,
    '.jpeg': (url) => url,
    '.png': (url) => url,
    '.gif': (url) => url,
    '.bmp': (url) => url,
    '.heic': (url) => url,
    '.svg': (url) => url,
    '.webp': (url) => url,
    // Videos (embed in HTML5 video player)
    '.mp4': (url) => url,
    '.webm': (url) => url,
    '.mov': (url) => url,
    '.avi': (url) => url,
    '.mkv': (url) => url
    // Add other video/image formats as needed
  };

  const openUrl = googleDocViewer[ext]
    ? googleDocViewer[ext](result.signedUrl)
    : result.signedUrl;

  res.status(200).json({
    status: 'success',
    openUrl
  });
});

exports.downloadUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;

  if (!docId) {
    return next(new AppError('Document Id is required', 400));
  }

  const result = await getSignedUrlForDoc(userId, docId, 60 * 10);

  if (result.error === 'not_found')
    return next(new AppError('Document not found or unauthorized', 400));
  if (result.error === 'url_error')
    return next(new AppError('Unable to generate file access URL.', 400));

  const { doc, signedUrl } = result;

  res.redirect(signedUrl);
});
