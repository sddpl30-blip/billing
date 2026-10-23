#!/usr/bin/env node
/**
 * The SMTP conversation, spoken to a real server.
 *
 * `documents.test.mjs` covers what the message looks like — headers, encoding,
 * dot-stuffing — and the settings read out of the environment. None of that
 * proves the client can hold an SMTP dialogue: the greeting, EHLO and its
 * multi-line extension list, STARTTLS and the second EHLO, AUTH, the envelope,
 * DATA and the terminating dot. Those are the parts that fail against a real
 * provider, and they were never exercised.
 *
 * So this runs a small SMTP server on a loopback port and sends through it.
 * It is not a mock of the client: the client opens a socket, and every byte in
 * both directions is the real protocol. The server is deliberately strict —
 * out-of-order commands are refused — so a client that sends DATA before RCPT
 * fails here rather than at a provider.
 *
 * The encrypted case needs the server's certificate to be trusted, and
 * NODE_EXTRA_CA_CERTS is only read at startup. The file therefore generates a
 * certificate and re-runs itself once with that variable set; the second run
 * does the work. Without openssl the encrypted cases are skipped and say so.
 *
 *   node server/smtp.test.mjs
 */

import { createServer } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = '../.server-build/server/src';
const { smtpProvider, SmtpError } = await import(`${build}/providers/smtp.js`);

// --- certificate, and the one re-exec ---------------------------------------

const certDir = process.env.SB_SMTP_TEST_CERTS;
let certs = null;
let certNote = '';

if (certDir !== undefined) {
  certs = {
    cert: readFileSync(join(certDir, 'cert.pem'), 'utf8'),
    key: readFileSync(join(certDir, 'key.pem'), 'utf8'),
  };
} else {
  const dir = mkdtempSync(join(tmpdir(), 'sb-smtp-'));
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { encoding: 'utf8', shell: false });

  if ((made.status ?? 1) === 0 && existsSync(join(dir, 'cert.pem'))) {
    const self = fileURLToPath(import.meta.url);
    const again = spawnSync(process.execPath, [self], {
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        SB_SMTP_TEST_CERTS: dir,
        NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem'),
      },
    });
    rmSync(dir, { recursive: true, force: true });
    process.exit(again.status ?? 1);
  }
  rmSync(dir, { recursive: true, force: true });
  certNote = 'openssl is not available, so the encrypted cases were skipped.';
}

// --- the test harness -------------------------------------------------------

let passed = 0;
let skipped = 0;
const failures = [];
let suiteName = '';
const suite = (n) => { suiteName = n; console.log(`\n${n}`); };

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${suiteName} / ${name}\n       ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
const skip = (name, why) => { skipped++; console.log(`  skip ${name} — ${why}`); };

function equal(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function truthy(value, what) {
  if (!value) throw new Error(`${what}: expected something truthy, got ${JSON.stringify(value)}`);
}
function matches(value, pattern, what) {
  if (!pattern.test(value)) {
    throw new Error(`${what}: ${JSON.stringify(value)} does not match ${pattern}`);
  }
}

// --- the SMTP server -------------------------------------------------------

/**
 * A small, strict SMTP server.
 *
 * `options.extensions` is the EHLO list, `options.rcptReply` lets a case refuse
 * a recipient, and `options.greeting` lets one refuse the connection outright.
 * Everything it saw is recorded in `transcript`, which is what the assertions
 * read: that is how a case proves the client sent STARTTLS before AUTH, or
 * sent nothing at all.
 */
function smtpServer(options = {}) {
  const {
    extensions = ['PIPELINING'],
    rcptReply = '250 2.1.5 Ok',
    greeting = '220 fake.localhost ESMTP ready',
    startTls = false,
    queueId = 'FAKE-QUEUE-1',
  } = options;

  const transcript = [];
  const messages = [];
  let encrypted = false;

  const handle = (socket) => {
    let buffer = '';
    let inData = false;
    let body = '';
    let seen = { ehlo: false, mail: false, rcpt: false };
    let authState = null;

    const write = (text) => { socket.write(`${text}\r\n`); };

    const upgrade = () => {
      socket.removeAllListeners('data');
      const tls = new TLSSocket(socket, {
        isServer: true, cert: certs.cert, key: certs.key,
      });
      tls.on('secure', () => { encrypted = true; });
      tls.setEncoding('utf8');
      buffer = '';
      seen = { ehlo: false, mail: false, rcpt: false };
      socket = tls;
      tls.on('data', onData);
      tls.on('error', () => { /* a refused certificate closes the socket */ });
    };

    const onLine = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push(body);
          body = '';
          write(`250 2.0.0 Ok: queued as ${queueId}`);
        } else {
          body += `${line}\r\n`;
        }
        return;
      }

      transcript.push(line);
      const upper = line.toUpperCase();

      if (authState === 'username') { authState = 'password'; write('334 UGFzc3dvcmQ6'); return; }
      if (authState === 'password') { authState = null; write('235 2.7.0 Accepted'); return; }

      if (upper.startsWith('EHLO')) {
        seen.ehlo = true;
        const list = startTls && !encrypted ? ['STARTTLS', ...extensions] : extensions;
        for (const ext of list) write(`250-${ext}`);
        write('250 fake.localhost');
        return;
      }
      if (upper === 'STARTTLS') {
        if (!startTls) { write('502 5.5.1 Not implemented'); return; }
        write('220 2.0.0 Ready to start TLS');
        upgrade();
        return;
      }
      if (upper.startsWith('AUTH PLAIN')) {
        if (!seen.ehlo) { write('503 5.5.1 EHLO first'); return; }
        write('235 2.7.0 Accepted');
        return;
      }
      if (upper.startsWith('AUTH LOGIN')) {
        authState = 'username';
        write('334 VXNlcm5hbWU6');
        return;
      }
      if (upper.startsWith('MAIL FROM')) {
        if (!seen.ehlo) { write('503 5.5.1 EHLO first'); return; }
        seen.mail = true;
        write('250 2.1.0 Ok');
        return;
      }
      if (upper.startsWith('RCPT TO')) {
        if (!seen.mail) { write('503 5.5.1 MAIL first'); return; }
        seen.rcpt = true;
        write(rcptReply);
        return;
      }
      if (upper === 'DATA') {
        if (!seen.rcpt) { write('503 5.5.1 RCPT first'); return; }
        inData = true;
        write('354 End data with <CR><LF>.<CR><LF>');
        return;
      }
      if (upper === 'QUIT') { write('221 2.0.0 Bye'); socket.end(); return; }
      write('500 5.5.2 Unrecognised');
    };

    const onData = (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', () => { /* the client hanging up is a case, not a crash */ });
    write(greeting);
  };

  const server = options.implicitTls === true
    ? createTlsServer({ cert: certs.cert, key: certs.key }, (socket) => {
      encrypted = true;
      handle(socket);
    })
    : createServer(handle);

  return {
    transcript,
    messages,
    get encrypted() { return encrypted; },
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function settings(port, extra = {}) {
  return {
    host: 'localhost',
    port,
    implicitTls: false,
    from: 'books@society.localhost',
    fromName: 'Sunrise Residency',
    timeoutMs: 5000,
    requireTls: false,
    ...extra,
  };
}

const message = {
  to: 'owner@flat.localhost',
  subject: 'Maintenance invoice for July 2026',
  text: 'Your invoice for July 2026 is ₹4,500.',
};

/** Runs one case against a server, and always shuts the server down. */
async function against(options, fn) {
  const server = smtpServer(options);
  const port = await server.listen();
  try {
    return await fn(port, server);
  } finally {
    await server.close();
  }
}

// --- plaintext -------------------------------------------------------------

suite('an unencrypted conversation');

await check('a message is delivered, in the right order, and comes back with the queue id', async () => {
  await against({}, async (port, server) => {
    const provider = smtpProvider(settings(port), quiet);
    equal(provider.delivers, true, 'this provider does send');
    equal(provider.name, 'smtp:localhost', 'named after the host');

    const delivery = await provider.send(message);
    equal(delivery.provider, 'smtp:localhost', 'the provider that sent it');
    matches(delivery.providerMessageId, /FAKE-QUEUE-1/, 'the queue id the server gave back');

    const commands = server.transcript.map(l => l.split(':')[0].split(' ')[0].toUpperCase());
    equal(commands.join(' '), 'EHLO MAIL RCPT DATA QUIT', 'the command order');
    equal(server.messages.length, 1, 'one message arrived');
    matches(server.messages[0], /^From: Sunrise Residency <books@society\.localhost>/m, 'the From header');
    matches(server.messages[0], /^To: owner@flat\.localhost/m, 'the To header');
    matches(server.messages[0], /^Message-ID: </m, 'a Message-ID');
    matches(server.messages[0], /Maintenance invoice for July 2026/, 'the subject');
  });
});

await check('the envelope carries the configured sender and the message recipient', async () => {
  await against({}, async (port, server) => {
    await smtpProvider(settings(port), quiet).send(message);
    truthy(
      server.transcript.includes('MAIL FROM:<books@society.localhost>'),
      'MAIL FROM is the configured sender',
    );
    truthy(
      server.transcript.includes('RCPT TO:<owner@flat.localhost>'),
      'RCPT TO is the recipient of this message',
    );
  });
});

await check('a multi-line EHLO reply is read to its last line', async () => {
  // The extension list arrives as `250-` lines and one final `250 `. A client
  // that stops at the first line never sees STARTTLS or AUTH.
  await against({ extensions: ['SIZE 35882577', '8BITMIME', 'AUTH PLAIN LOGIN', 'PIPELINING'] },
    async (port, server) => {
      await smtpProvider(settings(port, { user: 'books', password: 'not-a-real-password' }), quiet)
        .send(message);
      truthy(
        server.transcript.some(l => l.toUpperCase().startsWith('AUTH')),
        'AUTH was offered on a later line and the client used it',
      );
      equal(server.messages.length, 1, 'and the message still went');
    });
});

await check('a dot on its own line in the body does not end the message early', async () => {
  await against({}, async (port, server) => {
    await smtpProvider(settings(port), quiet).send({
      to: 'owner@flat.localhost',
      subject: 'Notice',
      text: 'Line one\n.\nLine two',
    });
    equal(server.messages.length, 1, 'one message, not two');
    matches(server.messages[0], /Line two/, 'the text after the lone dot arrived');
  });
});

// --- authentication --------------------------------------------------------

suite('authentication');

await check('AUTH LOGIN sends the user and the password as the server asks for them', async () => {
  await against({ extensions: ['AUTH LOGIN'] }, async (port, server) => {
    await smtpProvider(
      settings(port, { user: 'books@society.localhost', password: 'a-test-password' }),
      quiet,
    ).send(message);

    const index = server.transcript.findIndex(l => l.toUpperCase().startsWith('AUTH LOGIN'));
    truthy(index >= 0, 'AUTH LOGIN was used, because that is what was offered');
    equal(
      Buffer.from(server.transcript[index + 1], 'base64').toString('utf8'),
      'books@society.localhost',
      'the username, base64-encoded',
    );
    equal(
      Buffer.from(server.transcript[index + 2], 'base64').toString('utf8'),
      'a-test-password',
      'then the password',
    );
    equal(server.messages.length, 1, 'and the message was accepted');
  });
});

await check('AUTH PLAIN is one line of NUL-separated credentials', async () => {
  await against({ extensions: ['AUTH PLAIN'] }, async (port, server) => {
    await smtpProvider(
      settings(port, { user: 'books', password: 'a-test-password' }),
      quiet,
    ).send(message);

    const line = server.transcript.find(l => l.toUpperCase().startsWith('AUTH PLAIN'));
    truthy(line !== undefined, 'AUTH PLAIN was used');
    const payload = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
    equal(payload, '\u0000books\u0000a-test-password', 'authzid, authcid and password');
  });
});

await check('nothing is sent when no credentials are configured', async () => {
  await against({ extensions: ['AUTH PLAIN LOGIN'] }, async (port, server) => {
    await smtpProvider(settings(port), quiet).send(message);
    equal(
      server.transcript.some(l => l.toUpperCase().startsWith('AUTH')),
      false,
      'a server offering AUTH is not reason enough to authenticate',
    );
    equal(server.messages.length, 1, 'and an open relay still accepts the message');
  });
});

// --- refusals --------------------------------------------------------------

suite('what the server refuses');

await check('a rejected recipient throws with the code, and nothing is queued', async () => {
  await against({ rcptReply: '550 5.1.1 No such user here' }, async (port, server) => {
    let caught = null;
    try {
      await smtpProvider(settings(port), quiet).send(message);
    } catch (err) {
      caught = err;
    }
    truthy(caught instanceof SmtpError, 'an SmtpError');
    matches(caught.message, /recipient was refused/, 'and it says which step failed');
    matches(caught.message, /550/, 'and carries the server\'s own words');
    equal(server.messages.length, 0, 'nothing was queued');
  });
});

await check('a server that refuses the connection is reported, not retried blindly', async () => {
  await against({ greeting: '421 4.3.2 Service not available' }, async (port) => {
    let caught = null;
    try {
      await smtpProvider(settings(port), quiet).send(message);
    } catch (err) {
      caught = err;
    }
    truthy(caught instanceof SmtpError, 'an SmtpError');
    matches(caught.message, /did not greet/, 'it says the greeting was wrong');
  });
});

await check('SMTP_REQUIRE_TLS refuses to send over a plaintext server', async () => {
  await against({ startTls: false }, async (port, server) => {
    let caught = null;
    try {
      await smtpProvider(settings(port, { requireTls: true }), quiet).send(message);
    } catch (err) {
      caught = err;
    }
    truthy(caught instanceof SmtpError, 'an SmtpError');
    matches(caught.message, /does not offer STARTTLS/, 'it says why');
    equal(server.messages.length, 0, 'and no addresses or dues left the process');
    equal(
      server.transcript.some(l => l.toUpperCase().startsWith('MAIL FROM')),
      false,
      'the envelope was never even started',
    );
  });
});

// --- encrypted -------------------------------------------------------------

suite('an encrypted conversation');

if (certs === null) {
  skip('STARTTLS is used when offered, and EHLO is repeated after it', certNote);
  skip('implicit TLS on connect works too', certNote);
  skip('a certificate that does not verify stops the send', certNote);
} else {
  await check('STARTTLS is used when offered, and EHLO is repeated after it', async () => {
    await against({ startTls: true, extensions: ['AUTH PLAIN'] }, async (port, server) => {
      const delivery = await smtpProvider(
        settings(port, { user: 'books', password: 'a-test-password', requireTls: true }),
        quiet,
      ).send(message);

      matches(delivery.providerMessageId, /FAKE-QUEUE-1/, 'the server accepted it');
      equal(server.encrypted, true, 'the connection became encrypted');

      const commands = server.transcript.map(l => l.split(' ')[0].split(':')[0].toUpperCase());
      equal(
        commands.slice(0, 4).join(' '),
        'EHLO STARTTLS EHLO AUTH',
        'EHLO, STARTTLS, EHLO again, and only then AUTH',
      );
      equal(server.messages.length, 1, 'and the message went over TLS');
    });
  });

  await check('implicit TLS on connect works too', async () => {
    await against({ implicitTls: true, extensions: ['AUTH PLAIN'] }, async (port, server) => {
      await smtpProvider(
        settings(port, { implicitTls: true, requireTls: true, user: 'books', password: 'pw' }),
        quiet,
      ).send(message);
      equal(server.encrypted, true, 'encrypted from the first byte');
      equal(
        server.transcript.some(l => l.toUpperCase() === 'STARTTLS'),
        false,
        'and STARTTLS is not sent on a connection that is already TLS',
      );
      equal(server.messages.length, 1, 'the message arrived');
    });
  });
}

await check('a certificate that does not verify stops the send', async () => {
  // The same server, reached by an address its certificate does not cover.
  // A client that passed `rejectUnauthorized: false` would sail through this.
  if (certs === null) throw new Error(certNote);
  await against({ startTls: true }, async (port, server) => {
    let caught = null;
    try {
      await smtpProvider(
        settings(port, { host: '127.0.0.1', requireTls: true }),
        quiet,
      ).send(message);
    } catch (err) {
      caught = err;
    }
    truthy(caught !== null, 'the send failed rather than continuing in the clear');
    equal(server.messages.length, 0, 'and nothing was queued');
  });
});

// --- result ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
if (certNote !== '') console.log(certNote);
if (failures.length > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
