const http = require('http');
const crypto = require('crypto');

const targetUrl = new URL(
  process.env.YO_PROXY_URL || 'http://34.79.189.141:3000/yo'
);
const requestUrl = new URL(
  `${targetUrl.pathname.replace(/\/$/, '')}/ybs/task.php${targetUrl.search}`,
  targetUrl.origin
);
const apiUsername = process.env.YO_API_USERNAME || '<YO_API_USERNAME>';
const apiPassword = process.env.YO_API_PASSWORD || '<YO_API_KEY>';
const authorization = process.env.YO_AUTHORIZATION || apiPassword;
const missingCredentialsMessage =
  'YO_API_USERNAME and/or YO_API_PASSWORD are not set.';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildRequestXml(fields) {
  const body = Object.entries(fields)
    .filter(([, value]) => value != null && String(value).trim().length > 0)
    .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
}

const requestBody = buildRequestXml({
  APIUsername: apiUsername,
  APIPassword: apiPassword,
  Authorization: authorization,
  Method: 'acdepositfunds',
  Amount: '100',
  NonBlocking: 'TRUE',
  Account: '2567XXXXXXXX',
  AccountProviderCode: 'MTN_UGANDA',
  Narrative: 'TEST',
});

const options = {
  method: 'POST',
  hostname: requestUrl.hostname,
  port: Number(requestUrl.port || 80),
  path: `${requestUrl.pathname}${requestUrl.search}`,
  headers: {
    Accept: 'application/xml, text/xml, */*',
    'Content-Type': 'text/xml',
    'Content-transfer-encoding': 'text',
    'X-Trace-Id': crypto.randomUUID(),
    'Content-Length': Buffer.byteLength(requestBody),
  },
};

let proxyReachable = false;

const req = http.request(options, (res) => {
  const chunks = [];

  res.on('data', (chunk) => {
    chunks.push(chunk);
  });

  res.on('end', () => {
    const responseBody = Buffer.concat(chunks).toString('utf8');
    const credentialsSatisfied = !responseBody.includes(
      missingCredentialsMessage
    );

    console.log('HTTP Status Code:', res.statusCode ?? 'Unknown');
    console.log('Response Body:');
    console.log(responseBody || '(empty)');
    console.log('Proxy Reachable:', proxyReachable ? 'YES' : 'NO');
    console.log(
      'Credentials Requirement Satisfied:',
      credentialsSatisfied ? 'YES' : 'NO'
    );
    console.log('PROXY OK');
  });
});

req.on('socket', (socket) => {
  socket.on('connect', () => {
    proxyReachable = true;
  });
});

req.setTimeout(5000, () => {
  req.destroy(new Error('Request timed out after 5 seconds.'));
});

req.on('error', (error) => {
  console.error('HTTP Status Code: Not received');
  console.error('Response Body:');
  console.error(error.message);
  console.error('Proxy Reachable:', proxyReachable ? 'YES' : 'NO');
  console.error('Credentials Requirement Satisfied: UNKNOWN');
  console.error('PROXY FAIL');
  process.exitCode = 1;
});

req.write(requestBody);
req.end();
