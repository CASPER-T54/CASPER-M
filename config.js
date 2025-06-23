const fs = require('fs');

if (fs.existsSync('config.env')) {
  require('dotenv').config({ path: './config.env' });
}

function convertToBool(text, fault = 'true') {
  return text === fault;
}

module.exports = {
  SESSION_ID: process.env.SESSION_ID || '',
  OWNER_NUMBER: process.env.OWNER_NUMBER || '',
  
};
