import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import { toSendParams } from '../src/convert.js'

const raw = [
  'From: "App" <app@example.com>',
  'To: Ann <ann@example.org>, bob@example.org',
  'Cc: carl@example.org',
  'Reply-To: help@example.com',
  'Subject: Hello',
  'X-Groundmail-Tag: flow=signup',
  'List-Unsubscribe: <https://example.com/u>',
  'Content-Type: text/plain',
  '',
  'Hi there',
].join('\r\n')

test('maps headers and envelope, and finds Bcc recipients', async () => {
  const parsed = await simpleParser(raw)
  const params = toSendParams(parsed, {
    mailFrom: { address: 'app@example.com' },
    rcptTo: [{ address: 'ann@example.org' }, { address: 'bob@example.org' }, { address: 'carl@example.org' }, { address: 'dee@example.org' }],
  })
  assert.equal(params.from, 'App <app@example.com>')
  assert.deepEqual(params.to, ['Ann <ann@example.org>', 'bob@example.org'])
  assert.deepEqual(params.cc, ['carl@example.org'])
  assert.deepEqual(params.bcc, ['dee@example.org'])
  assert.equal(params.replyTo, 'help@example.com')
  assert.equal(params.subject, 'Hello')
  assert.equal(params.text.trim(), 'Hi there')
  assert.deepEqual(params.tags, [{ name: 'flow', value: 'signup' }])
  assert.equal(params.headers['List-Unsubscribe'], '<https://example.com/u>')
  assert.equal(params.headers['X-Groundmail-Tag'], undefined)
})

test('only sends to envelope recipients', async () => {
  const parsed = await simpleParser(raw)
  const params = toSendParams(parsed, { mailFrom: false, rcptTo: [{ address: 'BOB@example.org' }] })
  assert.equal(params.to, 'bob@example.org')
  assert.equal(params.cc, undefined)
  assert.equal(params.bcc, undefined)
})

let api, relay, received = []
const PORT = 25250 + Math.floor(Math.random() * 500)

before(async () => {
  api = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = JSON.parse(body)
      received.push({ auth: req.headers.authorization, path: req.url, json })
      if (json.subject === 'reject me') {
        res.writeHead(422, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'Domain is not verified', code: 'domain_not_verified' } }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_test123', status: 'queued' }))
    })
  })
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  relay = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, GROUNDMAIL_API_KEY: 'gm_test', GROUNDMAIL_API_URL: `http://127.0.0.1:${api.address().port}`, SMTP_PORT: String(PORT), SMTP_HOST: '127.0.0.1', SMTP_PASSWORD: 'secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve) => relay.stdout.on('data', (d) => String(d).includes('listening') && resolve()))
})

after(() => {
  relay?.kill()
  api?.close()
})

const transport = (pass = 'secret') =>
  nodemailer.createTransport({ host: '127.0.0.1', port: PORT, secure: false, ignoreTLS: true, auth: { user: 'groundmail', pass } })

test('relays an SMTP message to the API', async () => {
  const info = await transport().sendMail({
    from: 'App <app@example.com>',
    to: 'ann@example.org',
    bcc: 'audit@example.org',
    subject: 'Welcome',
    html: '<p>Hi <b>Ann</b></p>',
    text: 'Hi Ann',
    attachments: [{ filename: 'a.txt', content: 'hello' }],
  })
  assert.match(info.response, /Queued as msg_test123/)
  const req = received.at(-1)
  assert.equal(req.auth, 'Bearer gm_test')
  assert.equal(req.json.to, 'ann@example.org')
  assert.deepEqual(req.json.bcc, ['audit@example.org'])
  assert.equal(req.json.html, '<p>Hi <b>Ann</b></p>')
  assert.equal(req.json.attachments[0].name, 'a.txt')
  assert.equal(Buffer.from(req.json.attachments[0].data, 'base64').toString(), 'hello')
})

test('rejects a wrong password', async () => {
  await assert.rejects(transport('nope').sendMail({ from: 'a@example.com', to: 'b@example.org', text: 'x' }), /535/)
})

test('returns a permanent error when the API rejects the message', async () => {
  await assert.rejects(
    transport().sendMail({ from: 'a@example.com', to: 'b@example.org', subject: 'reject me', text: 'x' }),
    (err) => err.responseCode === 550 && /not verified/i.test(err.message),
  )
})
