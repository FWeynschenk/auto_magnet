'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.AMAGNET_PORT || 62201;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/movies',   require('./api/movies'));
app.use('/api/shows',    require('./api/shows'));
app.use('/api/search',   require('./api/search'));
app.use('/api/settings', require('./api/settings'));

app.get('/api/status', async (_req, res) => {
  const { testConnection } = require('./transmission');
  res.json(await testConnection());
});

app.post('/api/scheduler/run', async (_req, res) => {
  res.json({ started: true });
  require('./scheduler').run(); // fire and forget
});

// Serve Vue SPA (production build)
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`auto_magnet v2 on port ${PORT}`);
  require('./scheduler').start();
});
