import React, { useEffect, useState } from 'react';
import { fetchProfile, saveProfile, type ProfileRole } from '../services/auth';

/** Minimal driver/host profile for the signed-in wallet. */
export const ProfileEditor: React.FC<{ address: string }> = ({ address }) => {
  const [role, setRole] = useState<ProfileRole>('driver');
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'loading' | 'new' | 'saved' | 'saving' | 'edited'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    fetchProfile().then((profile) => {
      if (!live) return;
      if (profile) {
        setRole(profile.role);
        setDisplayName(profile.displayName);
      }
      setStatus(profile ? 'saved' : 'new');
    }, (err: unknown) => {
      if (!live) return;
      setError(`Profile unavailable: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('new');
    });
    return () => { live = false; };
  }, [address]);

  const save = async () => {
    setStatus('saving');
    setError(null);
    try {
      await saveProfile({ role, displayName });
      setStatus('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('edited');
    }
  };
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setStatus('edited'); };

  return (
    <form className="profile-editor" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-busy={status === 'loading'}>
      <label>
        I mainly use BidPark as a
        <select value={role} onChange={(e) => edit(setRole)(e.target.value as ProfileRole)} disabled={status === 'loading'}>
          <option value="driver">Driver (bidding for parking)</option>
          <option value="host">Host (listing a space)</option>
          <option value="both">Both</option>
        </select>
      </label>
      <label>
        Display name (optional)
        <input value={displayName} maxLength={40} onChange={(e) => edit(setDisplayName)(e.target.value)} disabled={status === 'loading'} />
      </label>
      <p className="section-note">
        Your profile is not shown to other users and does not verify your identity or any parking space.
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="read-status-retry" disabled={status === 'loading' || status === 'saving'}>
        {status === 'saving' ? 'Saving…' : 'Save profile'}
      </button>
      {status === 'saved' && <span role="status"> Profile saved</span>}
    </form>
  );
};
