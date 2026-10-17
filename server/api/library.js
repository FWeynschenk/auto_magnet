'use strict';

const express = require('express');
const router  = express.Router();
const { planFolderFixes, applyFolderFix } = require('../library');

// Show folders that don't match where new downloads go, and what moving each
// one would involve. Read-only.
router.get('/folders', async (_req, res) => {
  try {
    res.json(await planFolderFixes());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move one of them. The body only selects an entry from a freshly computed
// plan; it is never used as a path.
router.post('/folders/fix', async (req, res) => {
  const { from, target } = req.body || {};
  if (typeof from !== 'string' || !from) return res.status(400).json({ error: 'from required' });
  try {
    res.json(await applyFolderFix({ from, target }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

module.exports = router;
