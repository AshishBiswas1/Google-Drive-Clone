const supabase = require('./supabaseClient');

const BUCKET = 'User-Documents';

async function getSignedUrlForDoc(userId, docId, ttlSeconds = 300) {
  // Fetch the doc by id (do NOT filter by uid at this stage)
  const { data: doc, error: docErr } = await supabase
    .from('UserDocuments')
    .select('id, uid, path_of_file, fileName, status, sharedTo')
    .eq('id', docId)
    .single();

  if (docErr || !doc) return { error: 'not_found' };
  if (doc.status === 'trashed') return { error: 'not_found' };

  // Authorize: owner or recipient
  const isOwner = doc.uid === userId;
  const isRecipient =
    Array.isArray(doc.sharedTo) && doc.sharedTo.includes(userId);
  if (!isOwner && !isRecipient) return { error: 'not_found' };

  const storagePath = (doc.path_of_file || '').replace(/^\/+/, '');
  if (!storagePath) return { error: 'url_error' };

  const { data: signed, error: urlErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds, {
      download: doc.fileName || 'download'
    });

  if (urlErr || !signed?.signedUrl) return { error: 'url_error' };

  return { signedUrl: signed.signedUrl };
}

module.exports = { getSignedUrlForDoc };
