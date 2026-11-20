import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { readSession } from './auth.mjs';
import { PHOTO_MAX_BYTES } from '../shared/validation.js';

/*
 * Listing photos uploaded from the host workspace. A signed-in wallet posts the raw bytes of one image.
 * The format comes from those bytes, never from the Content-Type, filename or query string, and the file
 * is stored under the SHA-256 of its contents, so no client-supplied name reaches the filesystem. Stored
 * photos are served publicly by that name; the returned path is the photo field's same-origin reference.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORMATS = {
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.length >= PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
  webp: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
const STORED_NAME = /^[0-9a-f]{64}\.(jpg|png|webp)$/;
const LIMIT_LABEL = `${PHOTO_MAX_BYTES / (1024 * 1024)} MB`;

/** Writes through a random temporary name, then renames into place, so an interrupted upload leaves no partial file. */
async function storePhoto(file, bytes) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Photo uploads, mounted before the JSON body parser so the body is always raw bytes, whatever its Content-Type.
 * POST /api/photos stores one image for a signed-in wallet and returns its path. GET /api/photos/:name serves a
 * stored photo; names are content hashes, so responses are cached for a year.
 */
export function mountPhotos(app, { db, photoDir }) {
  const dir = path.resolve(photoDir);
  const readBody = express.raw({ type: () => true, limit: PHOTO_MAX_BYTES });

  function requireSession(req, res, next) {
    if (readSession(db, req)) return next();
    return res.status(401).json({ error: 'Sign in with your wallet first' });
  }
  // body-parser's own 413 message is generic; this one names the limit the client shows.
  function readPhoto(req, res, next) {
    readBody(req, res, (err) => {
      if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Photo must be ${LIMIT_LABEL} or smaller` });
      return next(err);
    });
  }

  /** POST /api/photos: the image bytes. The declared Content-Type and any name in the URL are ignored. */
  app.post('/api/photos', requireSession, readPhoto, async (req, res) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return res.status(400).json({ error: 'Choose a photo to upload' });
    const ext = Object.keys(FORMATS).find((format) => FORMATS[format](bytes));
    if (!ext) return res.status(415).json({ error: 'Photo must be a JPEG, PNG or WebP image' });
    const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await storePhoto(path.join(dir, name), bytes);
    res.status(201).json({ path: `/api/photos/${name}` });
  });

  /** GET /api/photos/:name: only names this module produces are looked up, so no request path can reach another file. */
  app.get('/api/photos/:name', (req, res, next) => {
    const { name } = req.params;
    if (!STORED_NAME.test(name)) return res.status(404).json({ error: 'Photo not found' });
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(name, { root: dir }, (err) => {
      if (!err) return;
      if (res.headersSent) return res.destroy();
      res.set('Cache-Control', 'no-store');
      if (err.status === 404) return res.status(404).json({ error: 'Photo not found' });
      return next(err);
    });
  });
}
