'use strict';
const handle = require('../index.js');
const wrapper = (req, res) => {
  req.url = '/v1/ip' + (req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  return handle(req, res);
};
module.exports = wrapper;
module.exports.default = wrapper;
