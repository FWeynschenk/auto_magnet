'use strict';

const Transmission = require('transmission');
const { settings } = require('./db');

function getClient() {
  return new Transmission({
    host:     settings.get('transmission_host') || 'localhost',
    port:     parseInt(settings.get('transmission_port') || '9091'),
    username: settings.get('transmission_user'),
    password: settings.get('transmission_pw'),
  });
}

function addTorrent(magnet, downloadDir) {
  return new Promise((resolve, reject) => {
    getClient().addUrl(magnet, { 'download-dir': downloadDir }, (err, arg) => {
      if (err) reject(err);
      else resolve(arg);
    });
  });
}

function getTorrents() {
  return new Promise((resolve, reject) => {
    getClient().get((err, arg) => {
      if (err) reject(err);
      else resolve(arg.torrents || []);
    });
  });
}

function testConnection() {
  return new Promise((resolve) => {
    try {
      getClient().sessionStats((err, arg) => {
        if (err) resolve({ connected: false, error: err.message });
        else resolve({ connected: true, stats: arg });
      });
    } catch (err) {
      resolve({ connected: false, error: err.message });
    }
  });
}

module.exports = { addTorrent, getTorrents, testConnection };
