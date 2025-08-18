const supabase = require('./../util/supabaseClient');
const multer = require('multer');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function generateShareLink(shareLink) {
  return `/api/drive/docs/share/${shareLink}`;
}

async function moveToTrash(supabase, userId, doc) {
  if (!doc || doc.uid !== userId) return { error: 'unauthorized' };

  const bucket = 'User-Documents';

  // Normalize and validate the source key
  const srcPathRaw = doc.path_of_file;
  const srcPath =
    typeof srcPathRaw === 'string' ? srcPathRaw.replace(/^\/+/, '').trim() : '';

  if (!srcPath) return { error: 'invalid_path', detail: 'Empty path_of_file' };

  // Destination: trash/<userId>/<original path>
  const distPath = `trash/${userId}/${srcPath}`;

  console.log('[moveToTrash] srcPath:', srcPath);
  console.log('[moveToTrash] distPath:', distPath);

  // Optional: probe existence to give clearer errors
  const probe = await supabase.storage
    .from(bucket)
    .createSignedUrl(srcPath, 30);

  if (probe.error || !probe.data?.signedUrl) {
    return { error: 'object_not_found', detail: `No object at ${srcPath}` };
  }

  // 1) Copy within same bucket
  const { error: copyError } = await supabase.storage
    .from(bucket)
    .copy(srcPath, distPath);

  if (copyError) {
    return {
      error: 'copy_failed',
      detail: `${copyError.message} (from: ${srcPath} to: ${distPath})`
    };
  }

  // 2) Remove original
  const { error: removeError } = await supabase.storage
    .from(bucket)
    .remove([srcPath]);

  if (removeError) {
    // Attempt rollback of the copy
    await supabase.storage
      .from(bucket)
      .remove([distPath])
      .catch(() => {});
    return { error: 'remove_failed', detail: removeError.message };
  }

  // 3) Update DB
  const { error: dbError } = await supabase
    .from('UserDocuments')
    .update({
      status: 'trashed',
      trash_path: distPath
    })
    .eq('id', doc.id)
    .eq('uid', userId);

  if (dbError) {
    return {
      ok: true,
      warning: 'db_update_failed',
      detail: dbError.message,
      fileName: path.basename(srcPath),
      trashPath: distPath
    };
  }

  return {
    ok: true,
    fileName: path.basename(srcPath),
    trashPath: distPath
  };
}

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

exports.shareUserDocument = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.body.docId;
  const shareType = req.body.shareType;

  if (!docId || !shareType) {
    return next(new AppError('Document Id and Share Type is required', 400));
  }

  if (!['restricted', 'Anyone with link'].includes(shareType)) {
    return next(
      new AppError('shareType must be "restricted" or "Anyone with link"', 400)
    );
  }

  const { data: doc, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('id', docId)
    .eq('uid', userId)
    .single();

  if (fetchError || !doc) {
    return next(new AppError('Document not found or unauthorized', 403));
  }

  const shareId = uuidv4();
  const { error: shareError } = await supabase.from('documentshares').insert([
    {
      id: shareId,
      doc_id: docId,
      uid: userId,
      share_type: shareType
    }
  ]);

  if (shareError) {
    return next(new AppError('Unable to create share link', 500));
  }

  const shareLink = generateShareLink(shareId);

  res.status(201).json({
    status: 'success',
    shareLink,
    shareType,
    info:
      shareType === 'restricted'
        ? 'Recipients must request access'
        : 'Anyone with link can view/read/download'
  });
});

exports.accessSharedDoc = catchAsync(async (req, res, next) => {
  const shareId = req.params.shareId;

  const { data: share, error: shareError } = await supabase
    .from('documentshares')
    .select('*')
    .eq('id', shareId)
    .single();

  if (shareError || !share) {
    return next(new AppError('Invalid or expired share link', 404));
  }

  const { data: doc, error: docError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('id', share.doc_id)
    .single();

  if (docError || !doc) {
    return next(new AppError('Document not found', 404));
  }

  if (share.share_type === 'restricted') {
    return next(new AppError('Access Restricted, request required', 401));
  }

  const { data: signedUrl, error: urlError } = await supabase.storage
    .from('User-Documents')
    .createSignedUrl(doc.path_of_file, 60 * 3);

  if (urlError || !signedUrl?.signedUrl) {
    return next(new AppError('Unable to generate file access URL.', 400));
  }

  res.status(200).json({
    status: 'success',
    docId: doc.id,
    fileName: doc.fileName,
    viewUrl: signedUrl.signedUrl,
    info: 'Anyone with this link has read-only access'
  });
});

exports.deleteUserDocTemp = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const singleId = req.params.docId;
  const csvIds = req.params.docIds;

  if (!singleId && !csvIds) {
    return next(
      new AppError(
        'Provide a document id in params (/:docId) or a CSV list (/:ids)',
        400
      )
    );
  }

  if (singleId && csvIds) {
    return next(new AppError('Provide either /:docId or /:ids, not both', 400));
  }

  if (singleId) {
    const { data: doc, error: fetchError } = await supabase
      .from('UserDocuments')
      .select('*')
      .eq('id', singleId)
      .eq('uid', userId)
      .single();

    if (fetchError || !doc) {
      return next(new AppError('Document not found or unauthorized', 404));
    }

    if (doc.status === 'trashed') {
      return res.status(200).json({
        status: 'success',
        message: 'Document already trashed',
        fileName: doc.fileName,
        trashPath: doc.trash_path || null,
        skipped: true
      });
    }

    const result = await moveToTrash(supabase, userId, doc);

    if (result.error === 'unauthorized') {
      return next(new AppError('Unauthorized', 403));
    }

    if (result.error) {
      return next(
        new AppError(
          `Move to trash failed: ${result.error} ${result.detail || ''}`,
          500
        )
      );
    }

    return res.status(200).json({
      status: 'success',
      message: 'Document moved to Trash',
      fileName: result.fileName,
      trashPath: result.trashPath,
      warning: result.warning || null
    });
  }

  const ids = csvIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return next(new AppError('No valid IDs provided in params', 400));
  }

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError) {
    return next(new AppError('Error fetching documents', 500));
  }
  if (!docs || docs.length === 0) {
    return next(new AppError('No documents found or unauthorized', 404));
  }

  const foundIds = new Set(docs.map((d) => d.id));
  const missingIds = ids.filter((id) => !foundIds.has(id));

  const results = [];

  for (const doc of docs) {
    if (doc.status === 'trashed') {
      results.push({ id: doc.id, skipped: true, reason: 'already_trashed' });
      continue;
    }

    const r = await moveToTrash(supabase, userId, doc);
    results.push({ id: doc.id, ...r });
  }

  return res.status(200).json({
    status: 'success',
    missingIds,
    results
  });
});

exports.getdeletedDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('uid', userId)
    .eq('status', 'trashed')
    .eq('permanently_deleted', false);

  if (fetchError) {
    return next(new AppError('Error fetching deleted documents', 500));
  }

  res.status(200).json({
    status: 'success',
    data: { docs }
  });
});

exports.permanentlyDeleteDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const singleId = req.params.docId;
  const csvIds = req.params.docIds;

  if (!singleId && !csvIds) {
    return next(
      new AppError(
        'Provide a document id in params (/:docId) or a CSV list (/:docIds)',
        400
      )
    );
  }
  if (singleId && csvIds) {
    return next(
      new AppError('Provide either /:docId or /:docIds, not both', 400)
    );
  }

  const ids = singleId
    ? [singleId]
    : (csvIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  if (ids.length === 0) {
    return next(new AppError('No valid IDs provided in params', 400));
  }

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError) {
    return next(
      new AppError(`Error fetching documents: ${fetchError.message}`, 500)
    );
  }
  if (!docs || docs.length === 0) {
    return next(new AppError('No documents found or unauthorized', 404));
  }

  const bucket = 'User-Documents';
  const results = [];
  const foundSet = new Set(docs.map((d) => d.id));
  const missingIds = ids.filter((x) => !foundSet.has(x));

  for (const doc of docs) {
    try {
      // Must be in trashed state and have a trash_path
      if (doc.status !== 'trashed' || !doc.trash_path) {
        results.push({
          id: doc.id,
          skipped: true,
          reason:
            doc.status !== 'trashed' ? 'not_trashed' : 'missing_trash_path'
        });
        continue;
      }

      const storageKey = String(doc.trash_path).replace(/^\/+/, '').trim();
      if (!storageKey) {
        results.push({ id: doc.id, error: 'invalid_trash_path' });
        continue;
      }

      // Remove object from storage
      const { error: rmErr } = await supabase.storage
        .from(bucket)
        .remove([storageKey]);

      if (rmErr) {
        // If object is already gone, still mark DB as permanently deleted,
        // but record the storage error in results for visibility.
        results.push({
          id: doc.id,
          warning: 'storage_remove_failed',
          detail: rmErr.message,
          storageKey
        });
      } else {
        results.push({ id: doc.id, ok: true, removed: storageKey });
      }

      const { error: delErr } = await supabase
        .from('UserDocuments')
        .delete()
        .eq('id', doc.id)
        .eq('uid', userId);

      if (delErr) {
        results.push({
          id: doc.id,
          warning: 'db_row_delete_failed',
          detail: delErr.message
        });
      }
    } catch (e) {
      results.push({ id: doc.id, error: 'exception', detail: e?.message });
    }
  }

  return res.status(200).json({
    status: 'success',
    missingIds, // requested but not found/unauthorized
    results
  });
});

exports.restoreUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const singleId = req.params.docId;
  const csvIds = req.params.docIds;

  if (!singleId && !csvIds) {
    return next(
      new AppError(
        'Provide a document id in params (/:docId) or a CSV list (/:docIds)',
        400
      )
    );
  }
  if (singleId && csvIds) {
    return next(
      new AppError('Provide either /:docId or /:docIds, not both', 400)
    );
  }

  const ids = singleId
    ? [singleId]
    : (csvIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  if (ids.length === 0) {
    return next(new AppError('No valid IDs provided in params', 400));
  }

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError) {
    return next(
      new AppError(`Error fetching documents: ${fetchError.message}`, 500)
    );
  }
  if (!docs || docs.length === 0) {
    return next(new AppError('No documents found or unauthorized', 404));
  }

  const bucket = 'User-Documents';
  const results = [];
  const foundSet = new Set(docs.map((d) => d.id));
  const missingIds = ids.filter((x) => !foundSet.has(x));

  for (const doc of docs) {
    try {
      // Must be trashed and have trash_path
      if (doc.status !== 'trashed') {
        results.push({ id: doc.id, skipped: true, reason: 'not_trashed' });
        continue;
      }
      if (!doc.trash_path) {
        results.push({
          id: doc.id,
          skipped: true,
          reason: 'missing_trash_path'
        });
        continue;
      }

      // Determine source (in trash) and destination (original path)
      const srcTrashKey = String(doc.trash_path).replace(/^\/+/, '').trim(); // e.g., 'trash/<uid>/documents/<uid>/<file>'
      let dstOriginalKey = null;

      if (doc.path_of_file) {
        dstOriginalKey = String(doc.path_of_file).replace(/^\/+/, '').trim();
      } else {
        // If you cleared path_of_file during trash, reconstruct it:
        // If your trash path is 'trash/<uid>/documents/<uid>/<file>', stripping 'trash/<uid>/' yields the original.
        // Note: ensure your trash_path format strictly follows 'trash/<uid>/<original key>'.
        const prefix = `trash/${userId}/`;
        if (srcTrashKey.startsWith(prefix)) {
          dstOriginalKey = srcTrashKey.slice(prefix.length);
        } else {
          results.push({
            id: doc.id,
            error: 'cannot_reconstruct_original_path',
            trash_path: doc.trash_path
          });
          continue;
        }
      }

      if (!dstOriginalKey) {
        results.push({ id: doc.id, error: 'invalid_original_path' });
        continue;
      }

      // 1) Copy from trash back to original
      const { error: copyErr } = await supabase.storage
        .from(bucket)
        .copy(srcTrashKey, dstOriginalKey);

      if (copyErr) {
        results.push({
          id: doc.id,
          error: 'copy_failed',
          detail: `${copyErr.message} (from: ${srcTrashKey} to: ${dstOriginalKey})`
        });
        continue;
      }

      const { error: removeErr } = await supabase.storage
        .from(bucket)
        .remove([srcTrashKey]);

      if (removeErr) {
        // Not fatal to user experience, but report
        results.push({
          id: doc.id,
          warning: 'trash_remove_failed',
          detail: removeErr.message,
          keptAt: dstOriginalKey
        });
      }

      const { error: updErr } = await supabase
        .from('UserDocuments')
        .update({
          status: 'active', // or whatever your active status is
          path_of_file: dstOriginalKey, // ensure DB matches the restored location
          trash_path: null
        })
        .eq('id', doc.id)
        .eq('uid', userId);

      if (updErr) {
        results.push({
          id: doc.id,
          warning: 'db_update_failed',
          detail: updErr.message
        });
      } else {
        results.push({ id: doc.id, ok: true, restoredTo: dstOriginalKey });
      }
    } catch (e) {
      results.push({ id: doc.id, error: 'exception', detail: e?.message });
    }
  }

  return res.status(200).json({
    status: 'success',
    missingIds,
    results
  });
});

exports.renameUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;
  const newNameRaw = req.body?.newName;

  if (!docId) {
    return next(new AppError('Document Id is required in params', 400));
  }
  if (!newNameRaw || typeof newNameRaw !== 'string') {
    return next(new AppError('newName (string) is required in body', 400));
  }

  // Clean/sanitize the new name: prevent leading slashes and whitespace
  const newName = newNameRaw.replace(/[/\\]+/g, '_').trim();
  if (!newName) {
    return next(
      new AppError('newName cannot be empty after sanitization', 400)
    );
  }

  // Fetch document and verify ownership
  const { data: doc, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('id', docId)
    .eq('uid', userId)
    .single();

  if (fetchError || !doc) {
    return next(new AppError('Document not found or unauthorized', 404));
  }

  // If the doc is trashed, you might block renaming or allow it in trash; choose policy
  if (doc.status === 'trashed') {
    return next(
      new AppError('Cannot rename a trashed file. Restore it first.', 400)
    );
  }

  // Old storage key and new storage key
  const bucket = 'User-Documents';
  const oldKey = String(doc.path_of_file || '')
    .replace(/^\/+/, '')
    .trim();

  if (!oldKey) {
    return next(
      new AppError('Invalid stored path_of_file for this document', 400)
    );
  }

  // Compute destination key: keep the same folder, change only the filename
  // Example: documents/<uid>/<oldName> -> documents/<uid>/<newName>
  const dir = path.posix.dirname(oldKey); // use posix for URL-like paths
  const newKey = `${dir}/${newName}`;

  // If no change, short-circuit
  if (oldKey === newKey) {
    return res.status(200).json({
      status: 'success',
      message: 'Name unchanged',
      fileName: doc.fileName,
      path_of_file: doc.path_of_file
    });
  }

  // 1) Optional: probe old object exists (for clearer error)
  const probe = await supabase.storage.from(bucket).createSignedUrl(oldKey, 30);
  if (probe.error || !probe.data?.signedUrl) {
    return next(new AppError(`Source object not found at ${oldKey}`, 404));
  }

  // 2) Copy old object to new key
  const { error: copyError } = await supabase.storage
    .from(bucket)
    .copy(oldKey, newKey);

  if (copyError) {
    return next(
      new AppError(
        `Rename failed during copy: ${copyError.message} (from: ${oldKey} to: ${newKey})`,
        500
      )
    );
  }

  // 3) Remove old object
  const { error: removeError } = await supabase.storage
    .from(bucket)
    .remove([oldKey]);

  if (removeError) {
    // Try to rollback by removing new copy to avoid duplicates
    await supabase.storage
      .from(bucket)
      .remove([newKey])
      .catch(() => {});
    return next(
      new AppError(`Rename failed during remove: ${removeError.message}`, 500)
    );
  }

  // 4) Update DB: fileName + path_of_file
  const { error: dbError } = await supabase
    .from('UserDocuments')
    .update({
      fileName: newName,
      path_of_file: newKey,
      updated_at: new Date().toISOString()
    })
    .eq('id', doc.id)
    .eq('uid', userId);

  if (dbError) {
    // Storage already moved; try to roll back storage to oldKey
    const rbCopy = await supabase.storage.from(bucket).copy(newKey, oldKey);
    if (!rbCopy.error) {
      await supabase.storage
        .from(bucket)
        .remove([newKey])
        .catch(() => {});
    }
    return next(
      new AppError(`Database update failed: ${dbError.message}`, 500)
    );
  }

  return res.status(200).json({
    status: 'success',
    message: 'File renamed successfully',
    old: { fileName: doc.fileName, path_of_file: oldKey },
    updated: { fileName: newName, path_of_file: newKey }
  });
});
