'use strict';
const handler = require('../../api/index.js');

// Stormkit Serverless (AWS Lambda / SSR) 핸들러 export
exports.handler = handler.handler || handler;
