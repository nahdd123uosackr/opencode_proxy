'use strict';
const serverless = require('@stormkit/serverless');
const handle = require('../../api/index.js');

exports.handler = serverless((req, res) => {
  return handle(req, res);
});
