/**
 * Runs `work` in a `BEGIN IMMEDIATE` transaction on `db`: commits and returns its result, or rolls back
 * and rethrows the error.
 */
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
