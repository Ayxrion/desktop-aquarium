'use strict';

// Dev launcher for the preview panel: starts the server with a default API key
// and feeds it mock telemetry so the dashboard has something to render.
// NOT used in production (the Docker image runs src/server.js directly, which
// still requires a real API_KEY).

process.env.API_KEY = process.env.API_KEY || 'dev-key';
process.env.PORT = process.env.PORT || '3000';

require('../src/server');

// Begin publishing fake snapshots once the server is listening.
setTimeout(() => require('./mock-publisher'), 800);
