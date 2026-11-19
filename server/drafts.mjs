import { readSession } from './auth.mjs';
import { isValidImageUrl } from '../shared/validation.js';

/**
 * Listing drafts and reusable space templates, saved per signed-in wallet. They are private: every
 * route needs a session and only ever touches that wallet's rows. A draft holds form text, a photo
 * reference (https URL or safe local path, never an upload) and explicit local date-times; nothing
 * in it is published until the host signs the auction.
 */
const MAX_PER_WALLET = 50;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const KINDS = new Set(['garage', 'driveway', 'covered']);
const text = (max) => (v) => typeof v === 'string' && v.length <= max;
const localTime = (v) => v === '' || (typeof v === 'string' && LOCAL_TIME.test(v));
const FIELDS = {
  title: text(120), address: text(200), neighborhood: text(100), description: text(2000),
  image: (v) => typeof v === 'string' && (v === '' || (v.length <= 1000 && isValidImageUrl(v))),
  spotKind: (v) => v === '' || KINDS.has(v),
  amenities: (v) => Array.isArray(v) && v.length <= 20 && v.every(text(40)),
  minBidEth: (v) => typeof v === 'string' && (v === '' || /^\d{1,6}(\.\d{1,18})?$/.test(v)),
  spaceId: (v) => typeof v === 'string' && (v === '' || /^[1-9]\d{0,77}$/.test(v)),
  latitude: (v) => Number.isFinite(v) && Math.abs(v) <= 90,
  longitude: (v) => Number.isFinite(v) && Math.abs(v) <= 180,
  replaces: (v) => v === '' || /^[1-9]\d{0,77}$/.test(v),
  cutoff: localTime, start: localTime, end: localTime,
};

/** The payload's known fields, or an error naming the first invalid one. Unknown fields are dropped. */
export function parseDraftPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Draft details are required' };
  const payload = {};
  for (const [field, valid] of Object.entries(FIELDS)) {
    if (raw[field] === undefined) continue;
    if (!valid(raw[field])) {
      return { error: field === 'image'
        ? 'Photo must be an https URL or a local path starting with /'
        : `Draft field "${field}" is invalid` };
    }
    payload[field] = raw[field];
  }
  return { payload };
}

export function mountDrafts(app, { db, contractAddress }) {
  function scope(req, res) {
    const session = readSession(db, req);
    if (!session) return void res.status(401).json({ error: 'Sign in with your wallet first' });
    const contract = contractAddress();
    if (!contract) return void res.status(503).json({ error: 'Smart contract not deployed' });
    return { session, contract };
  }
  const shape = (row) => ({ id: row.id, kind: row.kind, name: row.name, updatedAt: row.updated_at, ...JSON.parse(row.payload) });

  /** GET /api/drafts: the signed-in wallet's drafts and templates, newest first. */
  app.get('/api/drafts', (req, res) => {
    const s = scope(req, res);
    if (s) res.json({ drafts: db.listHostDrafts(s.contract, s.session.address).map(shape) });
  });

  /** POST /api/drafts { id?, kind, name, ...fields }: creates a draft, or replaces one this wallet owns. */
  app.post('/api/drafts', (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const { id, kind, name, ...rest } = req.body ?? {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!['draft', 'template'].includes(kind) || trimmed.length < 1 || trimmed.length > 80) {
      return res.status(400).json({ error: 'A draft needs a kind (draft or template) and a name of 1 to 80 characters' });
    }
    if (id != null && !Number.isSafeInteger(id)) return res.status(400).json({ error: 'Invalid draft id' });
    const parsed = parseDraftPayload(rest);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const payload = JSON.stringify(parsed.payload);
    if (payload.length > 8000) return res.status(400).json({ error: 'Draft is too large' });
    if (id == null && db.listHostDrafts(s.contract, s.session.address).length >= MAX_PER_WALLET) {
      return res.status(409).json({ error: `At most ${MAX_PER_WALLET} drafts and templates can be saved; delete one first` });
    }
    const saved = db.saveHostDraft(s.contract, s.session.address, { id: id ?? null, kind, name: trimmed, payload });
    if (saved === null) return res.status(404).json({ error: 'Draft not found' });
    res.status(id == null ? 201 : 200).json({ id: saved });
  });

  /** DELETE /api/drafts/:id: removes one of this wallet's drafts. */
  app.delete('/api/drafts/:id', (req, res) => {
    const s = scope(req, res);
    if (!s) return;
    const id = /^[1-9]\d{0,15}$/.test(req.params.id) ? Number(req.params.id) : null;
    if (id === null || !db.deleteHostDraft(s.contract, s.session.address, id)) return res.status(404).json({ error: 'Draft not found' });
    res.json({ deleted: true });
  });
}
