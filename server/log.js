'use strict';

// Activity log.
//
// Everything interesting the scheduler and the grab endpoint do used to go to
// stdout and nowhere else, which is fine until you want to answer "why didn't
// this download?" an hour later — by which point the container has been
// restarted and the answer is gone. This writes to both.
//
// Logging must never be the reason an operation fails, so every write is
// wrapped: a broken log is a lost line, not a lost download.

const { logs } = require('./db');

const RETENTION_DAYS = 30;

function emit(level, message) {
  const line = `[scheduler] ${message}`;
  if (level === 'error')      console.error(line);
  else if (level === 'warn')  console.warn(line);
  else                        console.log(line);
}

/**
 * @param {string} level     'info' | 'warn' | 'error'
 * @param {string} message
 * @param {Object} [entity]  { type: 'movie'|'show'|'episode', id }
 */
function record(level, message, entity = null) {
  emit(level, message);
  try {
    logs.add(level, entity?.type ?? null, entity?.id ?? null, message);
  } catch (err) {
    console.error('[log] could not persist entry:', err.message);
  }
}

const info  = (message, entity) => record('info',  message, entity);
const warn  = (message, entity) => record('warn',  message, entity);
const error = (message, entity) => record('error', message, entity);

/** Drop entries past the retention window. Called once per scheduler run. */
function prune() {
  try {
    const { changes } = logs.prune(RETENTION_DAYS);
    if (changes > 0) console.log(`[log] pruned ${changes} entr(ies) older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error('[log] prune failed:', err.message);
  }
}

module.exports = { info, warn, error, prune, RETENTION_DAYS };
