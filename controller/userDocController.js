const supabase = require('./../util/supabaseClient');
const multer = require('multer');
const catchAsync = require('./../util/catchAsync');
const AppError = require('./../util/appError');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ===================== Helpers =====================

function generateShareLink(shareLink) {
  return `/api/drive/docs/share/${shareLink}`;
}

async function getSignedUrlForDoc(userId, docId, ttlSeconds = 600) {
  // 1) Fetch doc row
  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, fileName, path_of_file, status')
    .eq('id', docId)
    .single();

  if (docErr || !doc) return { error: 'Not_found' };
  if (doc.uid !== userId) return { error: 'Not_found' }; // unauthorized behaves as not found
  if (doc.status === 'trashed') return { error: 'Not_found' };

  // 2) Validate storage key
  const key = String(doc.path_of_file || '')
    .replace(/^\/+/, '')
    .trim();
  if (!key) return { error: 'url_error' };

  // 3) Sign URL
  const { data: signed, error: sErr } = await supabase.storage
    .from('User-Documents')
    .createSignedUrl(key, ttlSeconds);

  if (sErr || !signed?.signedUrl) return { error: 'url_error' };

  // 4) Return consistent payload
  return {
    signedUrl: signed.signedUrl,
    doc: { id: doc.id, fileName: doc.fileName, path_of_file: doc.path_of_file }
  };
}

async function moveToTrash(supabase, userId, doc) {
  if (!doc || doc.uid !== userId) return { error: 'unauthorized' };

  const bucket = 'User-Documents';

  const srcPathRaw = doc.path_of_file;
  const srcPath =
    typeof srcPathRaw === 'string' ? srcPathRaw.replace(/^\/+/, '').trim() : '';
  if (!srcPath) return { error: 'invalid_path', detail: 'Empty path_of_file' };

  const distPath = `trash/${userId}/${srcPath}`;

  const probe = await supabase.storage
    .from(bucket)
    .createSignedUrl(srcPath, 30);
  if (probe.error || !probe.data?.signedUrl) {
    return { error: 'object_not_found', detail: `No object at ${srcPath}` };
  }

  const { error: copyError } = await supabase.storage
    .from(bucket)
    .copy(srcPath, distPath);
  if (copyError) {
    return {
      error: 'copy_failed',
      detail: `${copyError.message} (from: ${srcPath} to: ${distPath})`
    };
  }

  const { error: removeError } = await supabase.storage
    .from(bucket)
    .remove([srcPath]);
  if (removeError) {
    await supabase.storage
      .from(bucket)
      .remove([distPath])
      .catch(() => {});
    return { error: 'remove_failed', detail: removeError.message };
  }

  const { error: dbError } = await supabase
    .from('UserDocuments')
    .update({ status: 'trashed', trash_path: distPath })
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

  return { ok: true, fileName: path.basename(srcPath), trashPath: distPath };
}

const upload = multer({ storage: multer.memoryStorage() });

// ===================== Upload =====================

exports.uploadDocumentMiddleware = upload.array('document', 2);

exports.uploadUserDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const files = req.files;
  if (!files || files.length === 0)
    return next(new AppError('No documents uploaded', 400));
  if (files.length > 2)
    return next(new AppError('You can only upload 2 documents at a time', 400));

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
      if (uploadError)
        throw new AppError(
          `Upload failed for ${file.originalname}: ${uploadError.message}`,
          400
        );

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
      if (insertError)
        return next(
          new AppError(
            `Insert failed for ${file.originalname}: ${insertError.message}`,
            400
          )
        );

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

// ===================== List =====================

exports.getUserDocs = catchAsync(async (req, res, next) => {
  const { data: userDocs, error: userDocsError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('uid', req.user.id)
    .order('uploaded_at', { ascending: false });

  if (userDocsError) return next(new AppError(userDocsError.message, 400));

  res.status(200).json({ status: 'success', data: { userDocs } });
});

// ===================== Open/Download (Owner) =====================

exports.openUserDocument = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;
  if (!docId) return next(new AppError('Document Id is required', 400));

  const result = await getSignedUrlForDoc(userId, docId, 60 * 10);

  if (result?.error === 'Not_found' || result?.error === 'not_found') {
    return next(new AppError('Document not found or unauthorized', 404));
  }
  if (result?.error === 'url_error') {
    return next(new AppError('Unable to generate file access URL.', 500));
  }
  if (!result || !result.signedUrl) {
    console.warn('[openUserDocument] unexpected result:', result);
    return next(new AppError('Failed to open document (no signed URL)', 500));
  }

  const fileName = result?.doc?.fileName || result?.fileName || '';
  const ext = fileName ? path.extname(fileName).toLowerCase() : '';

  const googleDocViewer = {
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
    '.jpg': (url) => url,
    '.jpeg': (url) => url,
    '.png': (url) => url,
    '.gif': (url) => url,
    '.bmp': (url) => url,
    '.heic': (url) => url,
    '.svg': (url) => url,
    '.webp': (url) => url,
    '.mp4': (url) => url,
    '.webm': (url) => url,
    '.mov': (url) => url,
    '.avi': (url) => url,
    '.mkv': (url) => url
  };

  const openUrl = googleDocViewer[ext]
    ? googleDocViewer[ext](result.signedUrl)
    : result.signedUrl;
  return res
    .status(200)
    .json({ status: 'success', openUrl, fileName: fileName || null });
});

exports.downloadUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;
  if (!docId) return next(new AppError('Document Id is required', 400));

  const result = await getSignedUrlForDoc(userId, docId, 60 * 10);
  if (result.error === 'Not_found' || result.error === 'not_found')
    return next(new AppError('Document not found or unauthorized', 404));
  if (result.error === 'url_error')
    return next(new AppError('Unable to generate file access URL.', 500));

  return res.redirect(302, result.signedUrl);
});

// ===================== Share Pipeline =====================

exports.shareUserDocument = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;
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

  // Create share row
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

  // Generate and store a signed URL for this share (longer TTL, e.g., 24h)
  const TTL_SECONDS = 60 * 60 * 24;
  const { data: signedUrlData, error: signedErr } = await supabase.storage
    .from('User-Documents')
    .createSignedUrl(doc.path_of_file, TTL_SECONDS);

  if (signedErr || !signedUrlData?.signedUrl) {
    return next(new AppError('Unable to generate share URL.', 500));
  }

  const expiresAtISO = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  const { error: shareUpdateErr } = await supabase
    .from('documentshares')
    .update({
      signed_url: signedUrlData.signedUrl,
      expires_at: expiresAtISO
    })
    .eq('id', shareId);

  if (shareUpdateErr) {
    return next(new AppError('Unable to store share URL.', 500));
  }

  const shareLink = generateShareLink(shareId);

  res.locals.share = {
    shareId,
    shareLink,
    shareType,
    signedUrl: signedUrlData.signedUrl,
    expiresAt: expiresAtISO
  };
  res.locals.docId = docId;
  res.locals.emails = req.body.emails;
  res.locals.access = req.body.access || 'viewer';
  return next();
});

function normalizeEmails(input) {
  if (typeof input === 'string') {
    return input
      .split(/[,\s;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input
      .map((e) =>
        String(e || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);
  }
  return [];
}

exports.sharedTo = catchAsync(async (req, res, next) => {
  const docId = req.params.docId || res.locals.docId;
  let { emails, access = 'viewer' } = req.body || {};

  if (!docId) return next(new AppError('docId param is required', 400));

  const emailArr = normalizeEmails(emails);
  if (emailArr.length === 0) {
    res.locals.sharedTo = {
      docId,
      sharedTo: null,
      addedUserIds: [],
      unresolvedEmails: [],
      access
    };
    return next();
  }

  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, sharedTo')
    .eq('id', docId)
    .single();
  if (docErr) return next(new AppError(docErr.message, 400));
  if (!doc) return next(new AppError('Document not found', 404));
  if (doc.uid !== req.user.id)
    return next(new AppError('Not authorized to share this file', 403));

  const { data: matchedUsers, error: userErr } = await supabase
    .from('User')
    .select('id, email')
    .in('email', emailArr);
  if (userErr) return next(new AppError(userErr.message, 400));

  const foundIds = (matchedUsers || []).map((u) => u.id);
  const unresolvedEmails = emailArr.filter(
    (e) =>
      !(matchedUsers || []).some((u) => (u.email || '').toLowerCase() === e)
  );

  const current = Array.isArray(doc.sharedTo) ? doc.sharedTo : [];
  const updatedSharedTo = Array.from(new Set([...current, ...foundIds]));

  if (foundIds.length > 0) {
    const { error: updErr } = await supabase
      .from('UserDocuments')
      .update({ sharedTo: updatedSharedTo })
      .eq('id', docId);
    if (updErr) return next(new AppError(updErr.message, 400));
  }

  res.locals.sharedTo = {
    docId,
    sharedTo: updatedSharedTo,
    addedUserIds: foundIds,
    unresolvedEmails,
    access
  };
  return next();
});

exports.sharedFrom = catchAsync(async (req, res, next) => {
  const docId = req.params.docId || res.locals.docId;
  let { emails } = req.body || {};
  if (!docId) return next(new AppError('docId param is required', 400));

  const emailArr = normalizeEmails(emails);

  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, sharedFrom')
    .eq('id', docId)
    .single();
  if (docErr) return next(new AppError(docErr.message, 400));
  if (!doc) return next(new AppError('Document not found', 404));
  if (doc.uid !== req.user.id)
    return next(new AppError('Not authorized to share this file', 403));

  // resolve recipients (optional output)
  let recipientIds = [];
  if (emailArr.length > 0) {
    const { data: matchedUsers, error: userErr } = await supabase
      .from('User')
      .select('id, email')
      .in('email', emailArr);
    if (userErr) return next(new AppError(userErr.message, 400));
    recipientIds = (matchedUsers || []).map((u) => u.id);
  }

  const currentFrom = Array.isArray(doc.sharedFrom) ? doc.sharedFrom : [];
  const updatedSharedFrom = currentFrom.includes(req.user.id)
    ? currentFrom
    : [...currentFrom, req.user.id];

  if (updatedSharedFrom !== currentFrom) {
    const { error: updErr } = await supabase
      .from('UserDocuments')
      .update({ sharedFrom: updatedSharedFrom })
      .eq('id', docId);
    if (updErr) return next(new AppError(updErr.message, 400));
  }

  res.locals.sharedFrom = {
    docId,
    sharedFrom: updatedSharedFrom,
    recipients: recipientIds
  };
  return next();
});

exports.runPostShareHooks = catchAsync(async (req, res, next) => {
  return res.status(200).json({
    status: 'success',
    share: res.locals.share || null,
    hooks: {
      sharedTo: res.locals.sharedTo || null,
      sharedFrom: res.locals.sharedFrom || null
    }
  });
});

// ===================== Trash / Restore / Delete / Rename =====================

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

    if (fetchError || !doc)
      return next(new AppError('Document not found or unauthorized', 404));
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
    if (result.error === 'unauthorized')
      return next(new AppError('Unauthorized', 403));
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
  if (ids.length === 0)
    return next(new AppError('No valid IDs provided in params', 400));

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError) return next(new AppError('Error fetching documents', 500));
  if (!docs || docs.length === 0)
    return next(new AppError('No documents found or unauthorized', 404));

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

  return res.status(200).json({ status: 'success', missingIds, results });
});

exports.getdeletedDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('uid', userId)
    .eq('status', 'trashed')
    .eq('permanently_deleted', false);

  if (fetchError)
    return next(new AppError('Error fetching deleted documents', 500));

  res.status(200).json({ status: 'success', data: { docs } });
});

exports.permanentlyDeleteDocs = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const singleId = req.params.docId;
  const csvIds = req.params.docIds;

  if (!singleId && !csvIds)
    return next(
      new AppError(
        'Provide a document id in params (/:docId) or a CSV list (/:docIds)',
        400
      )
    );
  if (singleId && csvIds)
    return next(
      new AppError('Provide either /:docId or /:docIds, not both', 400)
    );

  const ids = singleId
    ? [singleId]
    : (csvIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  if (ids.length === 0)
    return next(new AppError('No valid IDs provided in params', 400));

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError)
    return next(
      new AppError(`Error fetching documents: ${fetchError.message}`, 500)
    );
  if (!docs || docs.length === 0)
    return next(new AppError('No documents found or unauthorized', 404));

  const bucket = 'User-Documents';
  const results = [];
  const foundSet = new Set(docs.map((d) => d.id));
  const missingIds = ids.filter((x) => !foundSet.has(x));

  for (const doc of docs) {
    try {
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

      const { error: rmErr } = await supabase.storage
        .from(bucket)
        .remove([storageKey]);
      if (rmErr) {
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
      if (delErr)
        results.push({
          id: doc.id,
          warning: 'db_row_delete_failed',
          detail: delErr.message
        });
    } catch (e) {
      results.push({ id: doc.id, error: 'exception', detail: e?.message });
    }
  }

  return res.status(200).json({ status: 'success', missingIds, results });
});

exports.restoreUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const singleId = req.params.docId;
  const csvIds = req.params.docIds;

  if (!singleId && !csvIds)
    return next(
      new AppError(
        'Provide a document id in params (/:docId) or a CSV list (/:docIds)',
        400
      )
    );
  if (singleId && csvIds)
    return next(
      new AppError('Provide either /:docId or /:docIds, not both', 400)
    );

  const ids = singleId
    ? [singleId]
    : (csvIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  if (ids.length === 0)
    return next(new AppError('No valid IDs provided in params', 400));

  const { data: docs, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .in('id', ids)
    .eq('uid', userId);

  if (fetchError)
    return next(
      new AppError(`Error fetching documents: ${fetchError.message}`, 500)
    );
  if (!docs || docs.length === 0)
    return next(new AppError('No documents found or unauthorized', 404));

  const bucket = 'User-Documents';
  const results = [];
  const foundSet = new Set(docs.map((d) => d.id));
  const missingIds = ids.filter((x) => !foundSet.has(x));

  for (const doc of docs) {
    try {
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

      const srcTrashKey = String(doc.trash_path).replace(/^\/+/, '').trim();
      let dstOriginalKey = null;
      if (doc.path_of_file) {
        dstOriginalKey = String(doc.path_of_file).replace(/^\/+/, '').trim();
      } else {
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
          status: 'active',
          path_of_file: dstOriginalKey,
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

  return res.status(200).json({ status: 'success', missingIds, results });
});

exports.renameUserDoc = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const docId = req.params.docId;
  const newNameRaw = req.body?.newName;

  if (!docId)
    return next(new AppError('Document Id is required in params', 400));
  if (!newNameRaw || typeof newNameRaw !== 'string')
    return next(new AppError('newName (string) is required in body', 400));

  const newName = newNameRaw.replace(/[/\\]+/g, '_').trim();
  if (!newName)
    return next(
      new AppError('newName cannot be empty after sanitization', 400)
    );

  const { data: doc, error: fetchError } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('id', docId)
    .eq('uid', userId)
    .single();

  if (fetchError || !doc)
    return next(new AppError('Document not found or unauthorized', 404));
  if (doc.status === 'trashed')
    return next(
      new AppError('Cannot rename a trashed file. Restore it first.', 400)
    );

  const bucket = 'User-Documents';
  const oldKey = String(doc.path_of_file || '')
    .replace(/^\/+/, '')
    .trim();
  if (!oldKey)
    return next(
      new AppError('Invalid stored path_of_file for this document', 400)
    );

  const dir = path.posix.dirname(oldKey);
  const newKey = `${dir}/${newName}`;
  if (oldKey === newKey) {
    return res.status(200).json({
      status: 'success',
      message: 'Name unchanged',
      fileName: doc.fileName,
      path_of_file: doc.path_of_file
    });
  }

  const probe = await supabase.storage.from(bucket).createSignedUrl(oldKey, 30);
  if (probe.error || !probe.data?.signedUrl)
    return next(new AppError(`Source object not found at ${oldKey}`, 404));

  const { error: copyError } = await supabase.storage
    .from(bucket)
    .copy(oldKey, newKey);
  if (copyError)
    return next(
      new AppError(
        `Rename failed during copy: ${copyError.message} (from: ${oldKey} to: ${newKey})`,
        500
      )
    );

  const { error: removeError } = await supabase.storage
    .from(bucket)
    .remove([oldKey]);
  if (removeError) {
    await supabase.storage
      .from(bucket)
      .remove([newKey])
      .catch(() => {});
    return next(
      new AppError(`Rename failed during remove: ${removeError.message}`, 500)
    );
  }

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

// ===================== Shares (Access/List) =====================

exports.accessSharedDoc = catchAsync(async (req, res, next) => {
  const shareId = req.params.shareId;

  if (!shareId) return next(new AppError('shareId is required', 400));

  const { data: share, error: shareError } = await supabase
    .from('documentshares')
    .select('*')
    .eq('id', shareId)
    .single();

  if (shareError || !share)
    return next(new AppError('Invalid or expired share link', 404));

  const { data: doc, error: docError } = await supabase
    .from('UserDocuments')
    .select('id, fileName')
    .eq('id', share.doc_id)
    .single();

  if (docError || !doc) return next(new AppError('Document not found', 404));

  if (share.share_type === 'restricted') {
    return next(new AppError('Access Restricted, request required', 401));
  }

  const now = Date.now();
  if (
    !share.signed_url ||
    (share.expires_at && new Date(share.expires_at).getTime() <= now)
  ) {
    return next(new AppError('Share link expired. Ask owner to refresh.', 410));
  }

  return res.status(200).json({
    status: 'success',
    docId: doc.id,
    fileName: doc.fileName,
    viewUrl: share.signed_url,
    info: 'Read-only via pre-generated signed URL'
  });
});

exports.listSharedTo = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from('UserDocuments')
    .select('*')
    .eq('uid', userId)
    .neq('sharedTo', '{}')
    .order('updated_at', { ascending: false });

  if (error) return next(new AppError(error.message, 400));

  res.status(200).json({ status: 'success', data: { docs: data || [] } });
});

exports.listSharedFrom = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from('UserDocuments')
    .select('*')
    .contains('sharedTo', [userId])
    .order('updated_at', { ascending: false });

  if (error) return next(new AppError(error.message, 400));

  res.status(200).json({ status: 'success', data: { docs: data || [] } });
});

exports.openViaStoredShare = catchAsync(async (req, res, next) => {
  const requesterId = req.user.id;
  const docId = req.params.docId;
  if (!docId) return next(new AppError('Document Id is required', 400));

  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, sharedTo, fileName, status')
    .eq('id', docId)
    .single();

  if (docErr || !doc) return next(new AppError('Document not found', 404));
  if (doc.status === 'trashed')
    return next(new AppError('File is in Trash', 403));

  const isOwner = doc.uid === requesterId;
  const isRecipient =
    Array.isArray(doc.sharedTo) && doc.sharedTo.includes(requesterId);
  if (!isOwner && !isRecipient)
    return next(new AppError('Not authorized to open this file', 403));

  const { data: shares, error: sErr } = await supabase
    .from('documentshares')
    .select('id, signed_url, expires_at, share_type, created_at')
    .eq('doc_id', docId)
    .neq('share_type', 'restricted')
    .order('created_at', { ascending: false })
    .limit(1);

  if (sErr || !shares || shares.length === 0) {
    return next(new AppError('No active share URL available', 404));
  }

  const share = shares[0];
  const now = Date.now();
  if (
    !share.signed_url ||
    (share.expires_at && new Date(share.expires_at).getTime() <= now)
  ) {
    return next(new AppError('Share link expired. Ask owner to refresh.', 410));
  }

  return res.status(200).json({ status: 'success', openUrl: share.signed_url });
});

// ===================== Remove Share =====================

exports.removeShare = catchAsync(async (req, res, next) => {
  const requesterId = req.user.id;
  const docId = req.params.docId;
  let { mode, recipients } = req.body || {};

  if (!docId) return next(new AppError('docId is required', 400));

  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, sharedTo')
    .eq('id', docId)
    .single();

  if (docErr) return next(new AppError(docErr.message, 400));
  if (!doc) return next(new AppError('Document not found', 404));

  const isOwner = doc.uid === requesterId;

  if (!mode) mode = isOwner ? 'owner' : 'recipient';

  if (mode === 'owner') {
    if (!isOwner)
      return next(
        new AppError('Only the owner can remove shares for others', 403)
      );

    const current = Array.isArray(doc.sharedTo) ? doc.sharedTo : [];
    let updatedSharedTo;

    if (Array.isArray(recipients) && recipients.length > 0) {
      const removeSet = new Set(recipients);
      updatedSharedTo = current.filter((id) => !removeSet.has(id));
    } else {
      updatedSharedTo = [];
    }

    const { error: updErr } = await supabase
      .from('UserDocuments')
      .update({ sharedTo: updatedSharedTo })
      .eq('id', docId);
    if (updErr) return next(new AppError(updErr.message, 400));

    const { error: delSharesErr } = await supabase
      .from('documentshares')
      .delete()
      .eq('doc_id', docId)
      .neq('share_type', 'restricted');

    return res.status(200).json({
      status: 'success',
      data: {
        docId,
        mode: 'owner',
        updatedSharedTo,
        clearedPublicShares: !delSharesErr
      }
    });
  }

  if (mode === 'recipient') {
    const current = Array.isArray(doc.sharedTo) ? doc.sharedTo : [];

    if (!current.includes(requesterId)) {
      return res.status(200).json({
        status: 'success',
        data: {
          docId,
          mode: 'recipient',
          alreadyRemoved: true,
          updatedSharedTo: current
        }
      });
    }

    const updatedSharedTo = current.filter((id) => id !== requesterId);
    const { error: updErr } = await supabase
      .from('UserDocuments')
      .update({ sharedTo: updatedSharedTo })
      .eq('id', docId);
    if (updErr) return next(new AppError(updErr.message, 400));

    return res.status(200).json({
      status: 'success',
      data: { docId, mode: 'recipient', removed: requesterId, updatedSharedTo }
    });
  }

  return next(new AppError('Invalid mode. Use "owner" or "recipient".', 400));
});
