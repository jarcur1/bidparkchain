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
const MIB = 1024 * 1024;
const LIMIT_LABEL = `${PHOTO_MAX_BYTES / (1024 * 1024)} MB`;

/** Quotas and reclamation. Options win over BIDPARK_PHOTO_* variables, which win over the defaults. */
export function photoSettings(options = {}, env = process.env) {
  const positive = (name, value) => {
    if (!(Number(value) > 0)) throw new Error(`${name} must be a positive number`);
    return Number(value);
  };
  return {
    perWallet: Math.floor(positive('BIDPARK_PHOTO_MAX_PER_WALLET', options.perWallet ?? env.BIDPARK_PHOTO_MAX_PER_WALLET ?? 20)),
    storageBytes: Math.floor(positive('BIDPARK_PHOTO_STORAGE_MB', options.storageMb ?? env.BIDPARK_PHOTO_STORAGE_MB ?? 200) * MIB),
    graceMs: positive('BIDPARK_PHOTO_GRACE_HOURS', options.graceHours ?? env.BIDPARK_PHOTO_GRACE_HOURS ?? 24) * 3_600_000,
    sweepIntervalMs: positive('BIDPARK_PHOTO_SWEEP_MINUTES', options.sweepMinutes ?? env.BIDPARK_PHOTO_SWEEP_MINUTES ?? 60) * 60_000,
  };
}

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
export function mountPhotos(app, { db, photoDir, canUpload, settings = photoSettings() }) {
  const dir = path.resolve(photoDir);
  // Uploads and the sweep take turns, so a sweep can never delete a file an upload is just recording.
  let turn = Promise.resolve();
  const exclusive = (task) => {
    const run = turn.then(task);
    turn = run.catch(() => {});
    return run;
  };
  const readBody = express.raw({ type: () => true, limit: PHOTO_MAX_BYTES });

  function requireSession(req, res, next) {
    if (readSession(db, req)) return next();
    return res.status(401).json({ error: 'Sign in with your wallet first' });
  }
  /** Only hosts upload: a wallet with a space (owner or lister) or a saved draft. */
  async function requireHost(req, res, next) {
    try {
      const { address } = readSession(db, req);
      if (db.hasHostDrafts(address) || await canUpload(address)) return next();
      return res.status(403).json({ error: 'Photo uploads are for hosts. Save a draft first, then upload a photo.' });
    } catch {
      return res.status(503).json({ error: 'Could not check your spaces right now. Try again shortly.' });
    }
  }
  // body-parser's own 413 message is generic; this one names the limit the client shows.
  function readPhoto(req, res, next) {
    readBody(req, res, (err) => {
      if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Photo must be ${LIMIT_LABEL} or smaller` });
      return next(err);
    });
  }

  /** POST /api/photos: the image bytes. The declared Content-Type and any name in the URL are ignored. */
  app.post('/api/photos', requireSession, requireHost, readPhoto, async (req, res, next) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return res.status(400).json({ error: 'Choose a photo to upload' });
    const ext = Object.keys(FORMATS).find((format) => FORMATS[format](bytes));
    if (!ext) return res.status(415).json({ error: 'Photo must be a JPEG, PNG or WebP image' });
    const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const { address } = readSession(db, req);
    try {
      const failure = await exclusive(async () => {
        const mine = db.hasPhotoRow(name, address);
        if (!mine) {
          if (db.countWalletPhotos(address) >= settings.perWallet) {
            return { status: 429, error: `You can keep ${settings.perWallet} uploaded photos. Remove unused photos from your drafts and try again later.` };
          }
          if (!db.hasPhotoFile(name) && db.storedPhotoBytes() + bytes.length > settings.storageBytes) {
            return { status: 413, error: 'Photo storage is full right now. Use a photo link instead, or try again later.' };
          }
        }
        db.recordPhoto(name, address, bytes.length, Date.now());
        try {
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          await storePhoto(path.join(dir, name), bytes);
        } catch (err) {
          if (!mine) db.forgetPhoto(name, address);
          throw err;
        }
        return null;
      });
      if (failure) return res.status(failure.status).json({ error: failure.error });
      return res.status(201).json({ path: `/api/photos/${name}` });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Deletes photos no draft, template or listing has used since the grace period began, and stray files nothing
   * recorded. A referenced photo is never deleted; it only restarts its grace period. Returns the count removed.
   */
  function sweep(now = Date.now()) {
    return exclusive(async () => {
      const cutoff = now - settings.graceMs;
      let removed = 0;
      for (const name of db.listPhotoNames()) {
        if (db.isPhotoReferenced(name)) db.touchPhoto(name, now);
        else if (db.dropStalePhotoRows(name, cutoff)) {
          await fs.rm(path.join(dir, name), { force: true });
          removed++;
        }
      }
      for (const entry of await fs.readdir(dir).catch(() => [])) {
        const stray = entry.endsWith('.tmp') || (STORED_NAME.test(entry) && !db.hasPhotoFile(entry) && !db.isPhotoReferenced(entry));
        if (!stray) continue;
        const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.rm(path.join(dir, entry), { force: true });
          removed++;
        }
      }
      return removed;
    });
  }

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

  return { sweep, done: () => turn, sweepIntervalMs: settings.sweepIntervalMs };
}
