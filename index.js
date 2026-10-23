console.log('worker is starting')
const PearRuntime = require('pear-runtime') // pear-runtime on desktop; pear-mobile on mobile
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const fs = require('bare-fs')
const dir = require('bare-storage')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const crypto = require('hypercore-crypto')

const b4a = require('b4a')
const maxMediaBytes = 10 * 1024 * 1024

function encodePayload(data) {
  if (data === undefined || data === null) {
    throw new Error('Cannot encode null or undefined payload')
  }

  // Convert object to JSON string, then to binary buffer
  const jsonString = JSON.stringify(data)
  return b4a.from(jsonString, 'utf-8')
}

function decodePayload(buffer) {
  if (!buffer || buffer.byteLength === 0) return null

  try {
    const jsonString = b4a.toString(buffer, 'utf-8')
    return JSON.parse(jsonString)
  } catch (err) {
    console.error('Failed to decode block node:', err.message)
    return null // Return null to safely ignore malformed nodes without crashing Autobase
  }
}

function keyId(key) {
  return b4a.toString(key, 'hex')
}

function enqueueLanguage(context, operation) {
  const previous = context.operationQueue
  let release
  context.operationQueue = new Promise((resolve) => {
    release = resolve
  })
  return previous.then(operation).finally(release)
}

function sendError(error) {
  pipe.write(JSON.stringify({ type: 'error', data: error.message || String(error) }))
}

console.log('worker: after requires')
function parseArgs(argsArray) {
  const flags = { _: [] }
  // Slice off the entry script path (index 0)
  const args = argsArray.slice(1)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg.startsWith('--')) {
      // Handles --key=value or --flag
      const [key, val] = arg.slice(2).split('=')
      if (val !== undefined) {
        flags[key] = val
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[++i] // Handles --key value
      } else {
        flags[key] = true // Handles boolean flags like --dev
      }
    } else if (arg.startsWith('-')) {
      // Handles short flags like -v
      flags[arg.slice(1)] = true
    } else {
      // Positional arguments
      flags._.push(arg)
    }
  }

  return flags
}

const argsParsed = parseArgs(Bare.argv)
console.log(argsParsed)

const updaterConfig = {
  updates: argsParsed.updates !== 'false',
  version: argsParsed.version,
  upgrade: argsParsed.upgrade,
  name: argsParsed.productName,
  dir: argsParsed.dir || dir.persistent(),
  app: argsParsed.appPath
}

const pipe = new FramedStream(Bare.IPC)
const updater_store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'))
const updater_swarm = new Hyperswarm()
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm: updater_swarm, store: updater_store })
const peers = new Set()
const connections = new Set()
const pairingSessions = new Map()
const languages = new Map()
let activeLanguageId = null
const languageDirectory = path.join(updaterConfig.dir, 'app-storage', 'languages')
const userBaseDirectory = path.join(updaterConfig.dir, 'app-storage', 'user-bases')
const registryStore = new Corestore(path.join(updaterConfig.dir, 'app-storage', 'registry'))
const localStateView = new Hyperbee(registryStore.get({ name: 'local-state' }), {
  keyEncoding: 'utf-8',
  valueEncoding: 'json'
})
const userStoragePath = path.join(updaterConfig.dir, 'app-storage', 'user')
let userStore = new Corestore(userStoragePath)
let userBaseStore = userStore
let userBase = null
let userBaseReady = null
let userOperationQueue = Promise.resolve()
let userSyncQueue = Promise.resolve()
const profileKey = 'user/profile'
const pairingCodeVersion = 1
const pairingCodeApp = 'buryad-ugenuud'
const pairingCodeTtl = 24 * 60 * 60 * 1000
const maxAvatarBytes = 2 * 1024 * 1024
const supportedAvatarTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

console.log('worker: after consts')

pear.updater.on('error', console.error)
if (updaterConfig.updates !== false) {
  updater_swarm.on('connection', (connection) => updater_store.replicate(connection))
  updater_swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
}

console.log('Application storage:', pear.storage)

pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))
pear.on('minver-required', () => pipe.write('minver-required')) // for mobile store update notification

function userOpen(store) {
  return new Hyperbee(store.get({ name: 'view' }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
}

async function userApply(batch, view, host) {
  for (const node of batch) {
    const op = decodePayload(node.value)
    if (!op) continue
    const author = keyId(node.from.key)
    const initialized = await view.get('user/initialized')

    if (op.type === 'user-init' && !initialized) {
      if (!/^[0-9a-f]{64}$/i.test(op.signerKey || '')) continue
      await view.put('user/initialized', 'true')
      await view.put('user/owner', author)
      await view.put(
        `devices/${author}`,
        JSON.stringify({ active: true, owner: true, signerKey: op.signerKey })
      )
      await view.put(profileKey, JSON.stringify({ nickname: '', avatar: null }))
      await host.ackWriter(node.from.key)
      continue
    }

    const device = await view.get(`devices/${author}`)
    if (!device || JSON.parse(device.value).active !== true) continue
    await host.ackWriter(node.from.key)

    if (op.type === 'user-profile') {
      await view.put(profileKey, JSON.stringify(op.profile))
    } else if (
      op.type === 'user-language-add' &&
      /^[0-9a-f]{64}$/i.test(op.language?.key || '')
    ) {
      await view.put(`languages/${op.language.key}`, JSON.stringify(op.language))
    } else if (op.type === 'user-language-remove' && op.key) {
      await view.del(`languages/${op.key}`)
    } else if (op.type === 'user-device-add') {
      const request = op.request
      if (
        !isValidPairingRequest(request) ||
        !verifyPairingRequest(request) ||
        !Number.isSafeInteger(op.approvedAt)
      ) {
        continue
      }
      if (request.deviceKey === author || (await view.get(`devices/${request.deviceKey}`))) continue
      await host.addWriter(b4a.from(request.deviceKey, 'hex'), {
        indexer: false,
        isIndexer: false
      })
      await view.put(
        `devices/${request.deviceKey}`,
        JSON.stringify({
          active: true,
          owner: false,
          signerKey: request.signerKey,
          pairedAt: op.approvedAt,
          requestId: request.requestId
        })
      )
    }
  }
}

function pairingRequestPayload(request) {
  return {
    app: request.app,
    version: request.version,
    type: request.type,
    deviceKey: request.deviceKey,
    signerKey: request.signerKey,
    pairingSecretHash: request.pairingSecretHash,
    requestId: request.requestId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt
  }
}

function pairingApprovalPayload(approval) {
  return {
    app: approval.app,
    version: approval.version,
    type: approval.type,
    userKey: approval.userKey,
    deviceKey: approval.deviceKey,
    requestId: approval.requestId,
    approvedBy: approval.approvedBy,
    signerKey: approval.signerKey,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt
  }
}

function isValidPairingRequest(request) {
  return Boolean(
    request &&
    request.app === pairingCodeApp &&
    request.version === pairingCodeVersion &&
    request.type === 'request' &&
    /^[0-9a-f]{64}$/i.test(request.deviceKey || '') &&
    /^[0-9a-f]{64}$/i.test(request.signerKey || '') &&
    /^[0-9a-f]{64}$/i.test(request.pairingSecretHash || '') &&
    (request.pairingSecret === undefined ||
      (/^[0-9a-f]{64}$/i.test(request.pairingSecret) &&
        keyId(crypto.hash(b4a.from(request.pairingSecret, 'hex'))) === request.pairingSecretHash)) &&
    /^[0-9a-f]{32}$/i.test(request.requestId || '') &&
    Number.isSafeInteger(request.createdAt) &&
    request.expiresAt === request.createdAt + pairingCodeTtl &&
    /^[0-9a-f]{128}$/i.test(request.signature || '')
  )
}

function verifyPairingRequest(request) {
  return crypto.verify(
    encodePayload(pairingRequestPayload(request)),
    b4a.from(request.signature, 'hex'),
    b4a.from(request.signerKey, 'hex')
  )
}

function isValidPairingApproval(approval) {
  return Boolean(
    approval &&
    approval.app === pairingCodeApp &&
    approval.version === pairingCodeVersion &&
    approval.type === 'approval' &&
    /^[0-9a-f]{64}$/i.test(approval.userKey || '') &&
    /^[0-9a-f]{64}$/i.test(approval.deviceKey || '') &&
    /^[0-9a-f]{32}$/i.test(approval.requestId || '') &&
    /^[0-9a-f]{64}$/i.test(approval.approvedBy || '') &&
    /^[0-9a-f]{64}$/i.test(approval.signerKey || '') &&
    Number.isSafeInteger(approval.issuedAt) &&
    approval.expiresAt === approval.issuedAt + pairingCodeTtl &&
    /^[0-9a-f]{128}$/i.test(approval.signature || '')
  )
}

function verifyPairingApproval(approval) {
  return crypto.verify(
    encodePayload(pairingApprovalPayload(approval)),
    b4a.from(approval.signature, 'hex'),
    b4a.from(approval.signerKey, 'hex')
  )
}

function parsePairingCode(raw, type) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Pairing code is invalid')
  let code
  try {
    code = JSON.parse(raw)
  } catch {
    throw new Error('Pairing code must be copied as JSON text')
  }
  const valid = type === 'request' ? isValidPairingRequest(code) : isValidPairingApproval(code)
  if (!valid) throw new Error(`Pairing ${type} code is invalid`)
  if (type === 'request' && !verifyPairingRequest(code)) {
    throw new Error('Pairing request signature is invalid')
  }
  if (type === 'approval' && !verifyPairingApproval(code)) {
    throw new Error('Pairing approval signature is invalid')
  }
  return code
}

function enqueueUser(operation) {
  const previous = userOperationQueue
  let release
  userOperationQueue = new Promise((resolve) => {
    release = resolve
  })
  return previous.then(operation).finally(release)
}

async function readUserLanguages() {
  const entries = []
  for await (const { value } of userBase.view.createReadStream({
    gte: 'languages/',
    lte: 'languages/\xff'
  })) {
    entries.push(JSON.parse(value))
  }
  return entries
}

async function sendProfile() {
  if (userBaseReady) await userBaseReady
  if (!userBase) throw new Error('User Autobase is not ready')
  const device = await userBase.view.get(`devices/${keyId(userBase.local.key)}`)
  if (!device || JSON.parse(device.value).active !== true) return
  const entry = await userBase.view.get(profileKey)
  const profile = entry ? JSON.parse(entry.value) : { nickname: '', avatar: null }
  pipe.write(JSON.stringify({ type: 'profile', data: profile }))
}

async function saveProfile(data) {
  const nickname = String(data.nickname || '').trim()
  if (!nickname) throw new Error('Nickname is required')
  if (nickname.length > 40) throw new Error('Nickname must be 40 characters or fewer')

  let avatar = null
  if (data.avatar) {
    const { data: encoded, mime } = data.avatar
    if (!supportedAvatarTypes.has(mime)) {
      throw new Error('Avatar must be a PNG, JPEG, WebP, or GIF image')
    }
    if (
      typeof encoded !== 'string' ||
      encoded.length === 0 ||
      encoded.length > Math.ceil((maxAvatarBytes * 4) / 3) + 4 ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      throw new Error('Avatar image data is invalid')
    }
    const bytes = b4a.from(encoded, 'base64')
    if (bytes.byteLength > maxAvatarBytes) throw new Error('Avatar must be 2 MB or smaller')
    avatar = { data: encoded, mime }
  }

  if (userBaseReady) await userBaseReady
  if (!userBase) throw new Error('User Autobase is not ready')
  return enqueueUser(async () => {
    await userBase.append(encodePayload({ type: 'user-profile', profile: { nickname, avatar } }), {
      optimistic: true
    })
    await userBase.update()
    await sendProfile()
  })
}

async function sendPairingStatus() {
  if (userBaseReady) await userBaseReady
  if (!userBase) return
  const deviceKey = keyId(userBase.local.key)
  const entry = await userBase.view.get(`devices/${deviceKey}`)
  const device = entry ? JSON.parse(entry.value) : null
  const pendingApproval = await localStateView.get('pairing/pending-approval')
  const devices = []
  for await (const { key, value } of userBase.view.createReadStream({
    gte: 'devices/',
    lte: 'devices/\xff'
  })) {
    devices.push({
      key: key.slice('devices/'.length),
      ...JSON.parse(value)
    })
  }
  pipe.write(
    JSON.stringify({
      type: 'pairing-status',
      data: {
        userKey: keyId(userBase.key),
        deviceKey,
        paired: device?.active === true,
        pending: Boolean(pendingApproval),
        devices
      }
    })
  )
}

async function createPairingRequest() {
  if (userBaseReady) await userBaseReady
  if (!userBase) throw new Error('User Autobase is not ready')
  const deviceKeyPair = await userStore.createKeyPair('user-device')
  const createdAt = Date.now()
  const request = {
    app: pairingCodeApp,
    version: pairingCodeVersion,
    type: 'request',
    deviceKey: keyId(userBase.local.key),
    signerKey: keyId(deviceKeyPair.publicKey),
    pairingSecret: crypto.randomBytes(32).toString('hex'),
    requestId: crypto.randomBytes(16).toString('hex'),
    createdAt,
    expiresAt: createdAt + pairingCodeTtl
  }
  request.pairingSecretHash = keyId(crypto.hash(b4a.from(request.pairingSecret, 'hex')))
  request.signature = b4a.toString(
    crypto.sign(encodePayload(pairingRequestPayload(request)), deviceKeyPair.secretKey),
    'hex'
  )
  await localStateView.put('pairing/request', request)
  pipe.write(JSON.stringify({ type: 'pairing-request', data: JSON.stringify(request) }))
  await startPairingSession('requester', request)
}

async function approvePairingRequest(data) {
  if (userBaseReady) await userBaseReady
  if (!userBase) throw new Error('User Autobase is not ready')
  const request = parsePairingCode(data.code, 'request')
  const now = Date.now()
  if (request.createdAt > now || request.expiresAt <= now) {
    throw new Error('Pairing request has expired or has an invalid date')
  }
  const currentDevice = await userBase.view.get(`devices/${keyId(userBase.local.key)}`)
  if (!currentDevice || JSON.parse(currentDevice.value).active !== true) {
    throw new Error('Only a paired device can approve a pairing request')
  }
  if (request.deviceKey === keyId(userBase.local.key)) {
    throw new Error('This device is already paired')
  }
  if (await userBase.view.get(`devices/${request.deviceKey}`)) {
    throw new Error('This device is already paired')
  }

  const approvedAt = Date.now()
  const approvedRequest = { ...request }
  delete approvedRequest.pairingSecret
  await enqueueUser(async () => {
    if (request.expiresAt <= Date.now()) throw new Error('Pairing request expired before approval')
    await userBase.append(encodePayload({ type: 'user-device-add', request: approvedRequest, approvedAt }), {
      optimistic: true
    })
    await userBase.update()
  })

  const deviceKeyPair = await userStore.createKeyPair('user-device')
  const approval = {
    app: pairingCodeApp,
    version: pairingCodeVersion,
    type: 'approval',
    userKey: keyId(userBase.key),
    deviceKey: request.deviceKey,
    requestId: request.requestId,
    approvedBy: keyId(userBase.local.key),
    signerKey: keyId(deviceKeyPair.publicKey),
    issuedAt: approvedAt,
    expiresAt: approvedAt + pairingCodeTtl
  }
  approval.signature = b4a.toString(
    crypto.sign(encodePayload(pairingApprovalPayload(approval)), deviceKeyPair.secretKey),
    'hex'
  )
  await localStateView.put(`pairing/approved/${request.requestId}`, { request, approval })
  pipe.write(JSON.stringify({ type: 'pairing-approval', data: JSON.stringify(approval) }))
  await startPairingSession('approver', request, approval)
  await sendPairingStatus()
}

function sendPairingConnectionStatus(requestId, status, role) {
  pipe.write(
    JSON.stringify({
      type: 'pairing-connection-status',
      data: { requestId, status, role }
    })
  )
}

function pairingTopic(request) {
  return crypto.hash(b4a.from(request.pairingSecret, 'hex'))
}

function pairingChallengePayload(requestId, challenge) {
  return {
    app: pairingCodeApp,
    type: 'pairing-challenge-response',
    requestId,
    challenge
  }
}

function writePairingMessage(session, message) {
  return new Promise((resolve, reject) => {
    session.stream.write(JSON.stringify(message), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function stopPairingSession(session, status = null) {
  if (pairingSessions.get(session.request.requestId) !== session) return
  pairingSessions.delete(session.request.requestId)
  clearTimeout(session.expirationTimer)
  if (status === 'expired') {
    if (session.role === 'requester') {
      await localStateView.del('pairing/request')
    } else {
      await localStateView.del(`pairing/approved/${session.request.requestId}`)
    }
  }
  if (status) sendPairingConnectionStatus(session.request.requestId, status, session.role)
  if (session.stream && !session.stream.destroyed) session.stream.destroy()
  await session.swarm.leave(session.topic)
  await session.swarm.destroy()
}

async function startPairingSession(role, request, approval = null) {
  const existing = pairingSessions.get(request.requestId)
  if (existing) await stopPairingSession(existing)
  const expiresAt = Math.min(request.expiresAt, approval?.expiresAt || request.expiresAt)
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) {
    sendPairingConnectionStatus(request.requestId, 'expired', role)
    return
  }

  const swarm = new Hyperswarm()
  const session = {
    role,
    request,
    approval,
    swarm,
    topic: pairingTopic(request),
    stream: null,
    challenge: null,
    completed: false,
    expirationTimer: null
  }
  pairingSessions.set(request.requestId, session)
  session.expirationTimer = setTimeout(() => {
    stopPairingSession(session, 'expired').catch(sendError)
  }, remaining)
  swarm.on('error', (error) => {
    sendPairingConnectionStatus(request.requestId, 'error', role)
    sendError(error)
  })
  swarm.on('connection', (socket) => {
    if (pairingSessions.get(request.requestId) !== session || session.completed) {
      socket.destroy()
      return
    }
    if (session.stream) {
      socket.destroy()
      return
    }
    session.stream = new FramedStream(socket, { bits: 16 })
    session.stream.on('error', (error) => {
      if (!session.completed) {
        session.stream = null
        sendPairingConnectionStatus(request.requestId, 'waiting', role)
        sendError(error)
      }
    })
    session.stream.on('close', () => {
      session.stream = null
      session.challenge = null
      if (!session.completed && pairingSessions.get(request.requestId) === session) {
        sendPairingConnectionStatus(request.requestId, 'waiting', role)
      }
    })
    session.stream.on('data', (data) => {
      handlePairingTransportMessage(session, data).catch((error) => {
        sendPairingConnectionStatus(request.requestId, 'error', role)
        sendError(error)
        if (session.stream && !session.stream.destroyed) session.stream.destroy()
      })
    })
    sendPairingConnectionStatus(request.requestId, 'connected', role)
    if (role === 'requester') {
      writePairingMessage(session, {
        type: 'request',
        data: { ...pairingRequestPayload(request), pairingSecret: request.pairingSecret },
        signature: request.signature
      }).catch(sendError)
    }
  })

  swarm.join(session.topic, { client: true, server: true })
  sendPairingConnectionStatus(request.requestId, 'waiting', role)
}

async function handlePairingTransportMessage(session, bytes) {
  if (bytes.byteLength > 8192) throw new Error('Pairing message is too large')
  let message
  try {
    message = JSON.parse(b4a.toString(bytes, 'utf-8'))
  } catch {
    throw new Error('Pairing peer sent invalid data')
  }

  if (session.role === 'approver' && message?.type === 'request') {
    const request = { ...message.data, type: 'request', signature: message.signature }
    if (
      !isValidPairingRequest(request) ||
      !verifyPairingRequest(request) ||
      request.requestId !== session.request.requestId ||
      request.deviceKey !== session.request.deviceKey ||
      request.signerKey !== session.request.signerKey ||
      request.pairingSecret !== session.request.pairingSecret ||
      request.pairingSecretHash !== session.request.pairingSecretHash ||
      request.signature !== session.request.signature
    ) {
      throw new Error('Direct pairing request did not match the approved request')
    }
    if (session.request.expiresAt <= Date.now()) throw new Error('Pairing request has expired')
    if (session.challenge) throw new Error('Pairing request challenge is already active')
    session.challenge = crypto.randomBytes(32).toString('hex')
    await writePairingMessage(session, {
      type: 'challenge',
      requestId: session.request.requestId,
      challenge: session.challenge
    })
    return
  }

  if (
    session.role === 'approver' &&
    message?.type === 'proof' &&
    message.requestId === session.request.requestId &&
    message.challenge === session.challenge &&
    message.signerKey === session.request.signerKey &&
    /^[0-9a-f]{128}$/i.test(message.signature || '') &&
    crypto.verify(
      encodePayload(pairingChallengePayload(message.requestId, message.challenge)),
      b4a.from(message.signature, 'hex'),
      b4a.from(message.signerKey, 'hex')
    )
  ) {
    if (session.request.expiresAt <= Date.now()) throw new Error('Pairing request has expired')
    session.challenge = null
    await writePairingMessage(session, { type: 'approval', approval: session.approval })
    sendPairingConnectionStatus(session.request.requestId, 'approval-sent', session.role)
    return
  }

  if (
    session.role === 'approver' &&
    message?.type === 'complete' &&
    message.requestId === session.request.requestId
  ) {
    session.completed = true
    await localStateView.del(`pairing/approved/${session.request.requestId}`)
    return stopPairingSession(session, 'complete')
  }

  if (
    session.role === 'requester' &&
    message?.type === 'challenge' &&
    message.requestId === session.request.requestId &&
    /^[0-9a-f]{64}$/i.test(message.challenge || '')
  ) {
    const deviceKeyPair = await userStore.createKeyPair('user-device')
    if (keyId(deviceKeyPair.publicKey) !== session.request.signerKey) {
      throw new Error('This device signing key no longer matches the pairing request')
    }
    const signature = b4a.toString(
      crypto.sign(
        encodePayload(pairingChallengePayload(message.requestId, message.challenge)),
        deviceKeyPair.secretKey
      ),
      'hex'
    )
    await writePairingMessage(session, {
      type: 'proof',
      requestId: message.requestId,
      challenge: message.challenge,
      signerKey: keyId(deviceKeyPair.publicKey),
      signature
    })
    return
  }

  if (session.role === 'requester' && message?.type === 'approval') {
    const approval = message.approval
    if (
      !isValidPairingApproval(approval) ||
      !verifyPairingApproval(approval) ||
      approval.deviceKey !== session.request.deviceKey ||
      approval.requestId !== session.request.requestId ||
      approval.issuedAt < session.request.createdAt ||
      approval.issuedAt > session.request.expiresAt ||
      approval.expiresAt <= Date.now()
    ) {
      throw new Error('Direct pairing approval is invalid or does not match this request')
    }
    sendPairingConnectionStatus(session.request.requestId, 'approval-received', session.role)
    await completePairing({ code: JSON.stringify(approval) })
    if (session.stream && !session.stream.destroyed) {
      await writePairingMessage(session, { type: 'complete', requestId: session.request.requestId })
    }
    return stopPairingSession(session, 'complete')
  }

  throw new Error('Unexpected message from pairing peer')
}

async function resumePairingSessions() {
  const requestEntry = await localStateView.get('pairing/request')
  const request = requestEntry?.value
  if (
    request &&
    isValidPairingRequest(request) &&
    verifyPairingRequest(request) &&
    request.expiresAt > Date.now()
  ) {
    pipe.write(JSON.stringify({ type: 'pairing-request', data: JSON.stringify(request) }))
    await startPairingSession('requester', request)
  } else if (request) {
    await localStateView.del('pairing/request')
  }

  for await (const { key, value } of localStateView.createReadStream({
    gte: 'pairing/approved/',
    lte: 'pairing/approved/\xff'
  })) {
    const { request: approvedRequest, approval } = value
    if (
      isValidPairingRequest(approvedRequest) &&
      verifyPairingRequest(approvedRequest) &&
      isValidPairingApproval(approval) &&
      verifyPairingApproval(approval) &&
      approval.expiresAt > Date.now()
    ) {
      pipe.write(JSON.stringify({ type: 'pairing-approval', data: JSON.stringify(approval) }))
      await startPairingSession('approver', approvedRequest, approval)
    } else {
      await localStateView.del(key)
    }
  }
}

async function completePairing(data) {
  if (userBaseReady) await userBaseReady
  const approval = parsePairingCode(data.code, 'approval')
  const now = Date.now()
  if (approval.issuedAt > now || approval.expiresAt <= now) {
    throw new Error('Pairing approval has expired or has an invalid date')
  }
  const requestEntry = await localStateView.get('pairing/request')
  const request = requestEntry?.value
  if (
    !request ||
    approval.issuedAt < request.createdAt ||
    approval.issuedAt > request.expiresAt ||
    request.deviceKey !== approval.deviceKey ||
    request.requestId !== approval.requestId
  ) {
    throw new Error("Pairing approval does not match this device's active request")
  }
  if (keyId(userBase.key) === approval.userKey) {
    throw new Error('This device is already using that user profile')
  }

  await localStateView.put('pairing/pending-approval', approval)
  await swarm.leave(userBase.discoveryKey)
  await localStateView.put('user/base-storage', approval.userKey)
  await localStateView.put('user/base', approval.userKey)
  await userBase.close()
  if (userBaseStore === userStore) {
    userStore = new Corestore(userStoragePath)
    await userStore.ready()
  }
  userBase = null
  userBaseStore = userStore
  userBaseReady = initializeUserBase()
  await userBaseReady
  await refreshUserState()
}

async function refreshUserState() {
  if (!userBase) return
  const deviceKey = keyId(userBase.local.key)
  const deviceEntry = await userBase.view.get(`devices/${deviceKey}`)
  const device = deviceEntry ? JSON.parse(deviceEntry.value) : null
  if (device?.active !== true) {
    await sendPairingStatus()
    return
  }

  const pendingEntry = await localStateView.get('pairing/pending-approval')
  if (pendingEntry) {
    const approval = pendingEntry.value
    const approver = await userBase.view.get(`devices/${approval.approvedBy}`)
    if (
      approval.deviceKey !== deviceKey ||
      !approver ||
      JSON.parse(approver.value).active !== true ||
      JSON.parse(approver.value).signerKey !== approval.signerKey ||
      !verifyPairingApproval(approval)
    ) {
      await sendPairingStatus()
      return
    }
    await localStateView.del('pairing/pending-approval')
    await localStateView.del('pairing/request')
  }

  await syncUserLanguages()
  await sendProfile()
  await sendPairingStatus()
}

function handlePairing(operation) {
  if (operation.cmd === 'status') return sendPairingStatus()
  if (operation.cmd === 'create-request') return createPairingRequest()
  if (operation.cmd === 'approve') return approvePairingRequest(operation)
  if (operation.cmd === 'complete') return completePairing(operation)
  throw new Error('Unknown pairing command')
}

async function addLanguageToUserRegistry(language) {
  if (userBaseReady) await userBaseReady
  if (!userBase) throw new Error('User Autobase is not ready')
  const metadata = { key: language.key }
  if (language.storageFolder && language.storageFolder !== language.key) {
    metadata.storageFolder = language.storageFolder
  }
  for (const field of ['name', 'description', 'creator']) {
    if (typeof language[field] === 'string') metadata[field] = language[field]
  }
  await enqueueUser(async () => {
    const entry = await userBase.view.get(`languages/${metadata.key}`)
    const current = entry ? JSON.parse(entry.value) : {}
    const next = { ...current, ...metadata }
    if (JSON.stringify(current) === JSON.stringify(next)) return
    await userBase.append(encodePayload({ type: 'user-language-add', language: next }), {
      optimistic: true
    })
    await userBase.update()
  })
}

async function initializeUserBase() {
  await registryStore.ready()
  await localStateView.ready()
  await userStore.ready()
  const keyEntry = await localStateView.get('user/base')
  const bootstrap = keyEntry?.value
  if (bootstrap && !/^[0-9a-f]{64}$/i.test(bootstrap)) {
    throw new Error('Stored user Autobase key is invalid')
  }
  const storageEntry = await localStateView.get('user/base-storage')
  if (storageEntry && storageEntry.value !== bootstrap) {
    throw new Error('Stored user Autobase storage key does not match its base key')
  }
  const pairedStorage = Boolean(storageEntry)
  if (userBaseStore !== userStore) await userBaseStore.close()
  userBaseStore = bootstrap && pairedStorage
    ? new Corestore(path.join(userBaseDirectory, bootstrap))
    : userStore
  await userBaseStore.ready()

  const deviceKeyPair = await userStore.createKeyPair('user-device')
  const openBase = (store) =>
    new Autobase(store, bootstrap ? b4a.from(bootstrap, 'hex') : null, {
      optimistic: true,
      apply: userApply,
      open: userOpen,
      keyPair: deviceKeyPair
    })
  userBase = openBase(userBaseStore)
  await userBase.ready()

  if (!bootstrap) await localStateView.put('user/base', keyId(userBase.key))

  if (!bootstrap && !(await userBase.view.get('user/initialized'))) {
    await userBase.append(
      encodePayload({ type: 'user-init', signerKey: keyId(deviceKeyPair.publicKey) }),
      { optimistic: true }
    )
    await userBase.update()
  }

  for (const connection of connections) userBase.replicate(connection)
  swarm.join(userBase.discoveryKey, { client: true, server: true })
  userBase.on('update', () => {
    refreshUserState().catch(sendError)
  })
}

function syncUserLanguages() {
  const next = userSyncQueue.then(syncUserLanguagesUnlocked)
  userSyncQueue = next.catch(sendError)
  return userSyncQueue
}

async function syncUserLanguagesUnlocked() {
  const ownDevice = await userBase.view.get(`devices/${keyId(userBase.local.key)}`)
  if (!ownDevice || JSON.parse(ownDevice.value).active !== true) return
  for (const metadata of await readUserLanguages()) {
    if (!/^[0-9a-f]{64}$/i.test(metadata.key || '')) {
      console.log('skipping language: ', JSON.stringify(metadata))
      continue
    }
    const existing = [...languages.values()].find((language) => language.key === metadata.key)
    if (existing) {
      for (const field of ['name', 'description', 'creator']) {
        if (typeof metadata[field] === 'string') existing[field] = metadata[field]
      }
      continue
    }
    const context = await openLanguage(metadata, b4a.from(metadata.key, 'hex'))
    if (!activeLanguageId) activeLanguageId = context.id
  }
  sendLanguages()
}

function handleProfile(operation) {
  if (operation.cmd === 'get') return sendProfile()
  if (operation.cmd === 'save') return saveProfile(operation)
  throw new Error('Unknown profile command')
}

function languageApply(batch, view, host) {
  return (async () => {
    for (const node of batch) {
      const op = decodePayload(node.value)
      if (!op) continue
      const author = keyId(node.from.key)

      if (op.type === 'language-join') {
        await host.addWriter(b4a.from(op.writer, 'hex'), { indexer: false, isIndexer: false })
        await host.ackWriter(node.from.key)
      } else {
        await host.ackWriter(node.from.key)
      }

      if (op.type === 'language-meta') {
        await view.put(
          'language/meta',
          JSON.stringify({ name: op.name, description: op.description, creator: op.creator })
        )
      } else if (op.type === 'create-poll') {
        await view.put(
          `polls/${op.id}`,
          JSON.stringify({ ...op.data, id: op.id, creator: author, closed: false })
        )
      } else if (op.type === 'cast-vote') {
        const voter = /^[0-9a-f]{64}$/i.test(op.voter || '')
          ? op.voter.toLowerCase()
          : author
        const voteKey = `votes/${op.pollId}/${voter}`
        if (!(await view.get(voteKey))) {
          await view.put(voteKey, JSON.stringify(op.data))
        }
      } else if (op.type === 'close-poll') {
        const entry = await view.get(`polls/${op.pollId}`)
        if (entry && JSON.parse(entry.value).creator === author) {
          await view.put(`polls/${op.pollId}/closed`, 'true')
        }
      } else if (op.type === 'save-translation-api-details') {
        await view.put('language/translation_api_details', JSON.stringify(op.data))
      } else if (op.type === 'save-translation') {
        await view.put(`translations/${op.data.translationID}`, JSON.stringify(op.data))
      } else if (op.type === 'remove-translation') {
        await view.del(`translations/${op.data.translationID}`)
      } else if (op.type === 'link-translation') {
        await linkTranslation(view, op.data)
      }
    }
  })()
}

async function linkTranslation(view, translation) {
  for (const word of translation.words) {
    const translationIDs = [translation.translationID]
    const entry = await view.get(`words/${word}/${translation.language}`)
    if (entry) {
      const oldIDs = JSON.parse(entry.value)
      for (const id of oldIDs) {
        if (id !== translation.translationID && !translationIDs.includes(id)) {
          translationIDs.push(id)
        }
      }
    }

    await view.put(`words/${word}/${translation.language}`, JSON.stringify(translationIDs))
  }

  const entry = await view.get(`translations-to-words/${translation.translationID}`)
  if (entry) {
    const oldWords = JSON.parse(entry.value)
    for (const old of oldWords) {
      if (!translation.words.includes(old)) {
        const entryOfOld = await view.get(`words/${old}/${translation.language}`)
        if (entryOfOld) {
          const ids = JSON.parse(entryOfOld.value)
          const without = ids.filter((i) => i !== translation.translationID)
          if (without.length > 0) {
            await view.put(`words/${old}/${translation.language}`, JSON.stringify(without))
          } else {
            await view.del(`words/${old}/${translation.language}`)
          }
        }
      }
    }
  }

  if (translation.words.length > 0) {
    await view.put(`translations-to-words/${translation.translationID}`, JSON.stringify(translation.words))
  } else {
    await view.del(`translations-to-words/${translation.translationID}`)
  }
}

function languageOpen(store) {
  return new Hyperbee(store.get({ name: 'view' }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
}

async function openLanguage(metadata, bootstrap, keyPair = null) {
  const languageKey = metadata.key || (keyPair && keyId(keyPair.publicKey))
  if (!languageKey) throw new Error('Language key is required')
  let storageFolder = languageKey
  if (metadata.storageFolder && fs.existsSync(path.join(languageDirectory, metadata.storageFolder)))
    storageFolder = metadata.storageFolder
  const languageStore = new Corestore(path.join(languageDirectory, storageFolder))
  const baseOptions = {
    optimistic: true,
    apply: languageApply,
    open: languageOpen
  }
  if (keyPair) baseOptions.keyPair = keyPair
  const base = new Autobase(languageStore, bootstrap, baseOptions)
  const context = {
    id: languageKey,
    key: languageKey,
    base,
    store: languageStore,
    operationQueue: Promise.resolve(),
    name: metadata.name,
    description: metadata.description,
    creator: metadata.creator
  }
  await base.ready()

  context.key = b4a.toString(base.key, 'hex')
  context.id = context.key
  context.storageFolder = storageFolder
  const metaEntry = await metaOfLanguage(context)
  if (metaEntry) {
    Object.assign(context, metaEntry)
    await addLanguageToUserRegistry(context)
  }
  languages.set(context.id, context)

  for (const connection of connections) context.base.replicate(connection)
  swarm.join(base.discoveryKey, { client: true, server: true })
  if (bootstrap && !(await base.local.getUserData('language/joined'))) {
    await base.append(encodePayload({ type: 'language-join', writer: keyId(base.local.key) }), {
      optimistic: true
    })
    await base.local.setUserData('language/joined', b4a.from('1'))
  }
  base.on('update', () => {
    enqueueLanguage(context, async () => {
      await refreshLanguageMetadata(context)
      if (activeLanguageId === context.id) await sendAllPollsUnlocked(context)
    }).catch(sendError)
  })
  return context
}

async function metaOfLanguage(context) {
  const entry = await context.base.view.get('language/meta')
  if (!entry) return null
  return JSON.parse(entry.value)
}

async function refreshLanguageMetadata(context) {
  const meta = await metaOfLanguage(context)
  if (meta) {
    Object.assign(context, meta)
    await addLanguageToUserRegistry(context)
  }
  sendLanguages()
}

async function loadLanguages() {
  userBaseReady = initializeUserBase()
  await userBaseReady
  await refreshUserState()
  if (activeLanguageId) await sendAllPolls(languages.get(activeLanguageId))
}

function sendLanguages() {
  pipe.write(
    JSON.stringify({
      type: 'languages',
      active: activeLanguageId,
      data: [...languages.values()].map(({ base, store, ...metadata }) => {
        const { id, key, storageFolder, name, description, creator } = metadata
        const isOwner = (creator === keyId(base.local.key))
        console.log('sent language ', name, ' isOwner: ', isOwner)
        return {
          id,
          key,
          storageFolder,
          name,
          description,
          creator,
          isOwner
        }
      })
    })
  )
}

async function createLanguage(data) {
  const name = String(data.name || '').trim()
  const description = String(data.description || '').trim()
  if (!name) throw new Error('Language name is required')
  const keyPair = crypto.keyPair()
  const context = await openLanguage({}, null, keyPair)
  await context.base.append(encodePayload({ type: 'language-meta', name, description, creator: keyId(context.base.local.key) }))
  await context.base.update()
  await context.base.flush()
  await context.base.local.setUserData('language/joined', b4a.from('1'))
  context.name = name
  context.description = description
  languages.set(context.id, context)
  activeLanguageId = context.id
  await addLanguageToUserRegistry(context)
  sendLanguages()
  pipe.write(
    JSON.stringify({ type: 'language-created', data: { id: context.id, key: context.key } })
  )
}

async function joinLanguage(data) {
  const key = String(data.key || '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Language key must be 64 hexadecimal characters')
  if ([...languages.values()].some((language) => language.key === key)) {
    throw new Error('This language is already joined')
  }
  const context = await openLanguage(
    {
      key
    },
    b4a.from(key, 'hex')
  )
  languages.set(context.id, context)
  activeLanguageId = context.id
  await addLanguageToUserRegistry(context)
  sendLanguages()
  await sendAllPolls(context)
}

function selectLanguage(id) {
  if (!languages.has(id)) throw new Error('Language not found')
  activeLanguageId = id
  sendLanguages()
  sendTranslationAPI_Details(languages.get(id))
  return sendAllPolls(languages.get(id))
}

function saveTranslationAPI_Details(details) {
  const context = languages.get(details.languageId || activeLanguageId)
  if (!context) return sendError(new Error('Select or join a language first'))
  return enqueueLanguage(context, () => saveTranslationAPI_DetailsUnlocked(details, context))
}

async function saveTranslationAPI_DetailsUnlocked(details, context) {
  try {
    const { base } = context
    const { yKey, yFolderID, gKey, gProjectID } = details
    await base.ready()
    // check for privileges
    const meta = await metaOfLanguage(context)
    if (meta && meta.creator === keyId(base.local.key)) {
      base.append(
        encodePayload(
          {
            type: 'save-translation-api-details',
            data: {
              yKey,
              yFolderID,
              gKey,
              gProjectID
            }
          }
        ),
        { optimistic: true }
      )
    } else if (!meta) {
      console.log('Cannot save Translation API details! NO meta!')
    } else {
      console.log('Cannot save Translation API details! not creator')
    }
  } catch (error) {
    sendError(error)
  }
}

async function sendTranslationAPI_Details(context) {
  return enqueueLanguage(context, () => sendTranslationAPI_DetailsUnlocked(context))
}

async function sendTranslationAPI_DetailsUnlocked(context) {
  await context.base.ready()
  const detailsEntry = await context.base.view.get('language/translation_api_details')
  if (detailsEntry) {
    const details = JSON.parse(detailsEntry.value)
    pipe.write(JSON.stringify(
      {
        type: 'translation-api-details',
        data: {
          ...details,
          languageId: context.id
        }
      }
    ))
  }
}

function handleLanguage(operation) {
  if (operation.cmd === 'create') return createLanguage(operation)
  if (operation.cmd === 'join') return joinLanguage(operation)
  if (operation.cmd === 'select') return selectLanguage(operation.id)
  if (operation.cmd === 'list') return sendLanguages()
  if (operation.cmd === 'saveAPI_Details') return saveTranslationAPI_Details(operation)
  throw new Error('Unknown language command')
}

swarm.on('connection', (connection) => {
  peers.add(connection)
  connections.add(connection)
  console.log('Application peer connected')
  sendPeerCount()
  connection.once('close', () => {
    peers.delete(connection)
    connections.delete(connection)
    console.log('Application peer disconnected')
    sendPeerCount()
  })
  if (userBase) {
    userBase.replicate(connection)
    userBase.update().catch(sendError)
  }
  for (const context of languages.values()) {
    context.base.replicate(connection)
    enqueueLanguage(context, () => context.base.update()).catch(sendError)
  }
})

async function startReplication() {
  await loadLanguages()
  await resumePairingSessions()
  sendPeerCount()
}

function sendPeerCount() {
  pipe.write(JSON.stringify({ type: 'peers', data: peers.size }))
}

goodbye(async () => {
  for (const session of pairingSessions.values()) await stopPairingSession(session)
  await updater_swarm.destroy()
  await swarm.destroy()
  await pear.close()
  if (userBase) await userBase.close()
  if (userBaseStore !== userStore) await userStore.close()
  await localStateView.close()
  await updater_store.close()
  await registryStore.close()
  for (const context of languages.values()) await context.store.close()
})

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message === 'pear:applyUpdate') {
    await pear.ready()
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
    return
  }

  try {
    const msg = JSON.parse(message)
    if (msg.type === 'ping') {
      pipe.write(JSON.stringify({ type: 'pong', time: new Date().toISOString() }))
    } else if (msg.type === 'profile') {
      await handleProfile(msg.data)
    } else if (msg.type === 'pairing') {
      await handlePairing(msg.data)
    } else if (msg.type === 'language') {
      await handleLanguage(msg.data)
    } else if (msg.type === 'poll') {
      await handlePoll(msg.data)
    } else if (msg.type === 'comment') {
      await handleComment(msg.data)
    } else if (msg.type === 'translation') {
      await handleTranslation(msg.data)
    } else if (msg.type === 'search') {
      await handleSearch(msg.data)
    }
  } catch (err) {
    console.log(err.message)
    console.log('while handling:')
    console.log(message)
    sendError(err)
  }
})

console.log('worker: after pipe on data subscription')

startReplication().catch(sendError)

pipe.write('Hello from worker')

console.log('worker: after pipe hello')

function normalizeMedia(media) {
  if (!media || media.type === 'none' || (!media.url && !media.data)) return null
  if (media.data) {
    const data = String(media.data)
    const bytes = b4a.from(data, 'base64')
    if (bytes.byteLength > maxMediaBytes) throw new Error('Media file must be 10 MB or smaller')
    const mime = String(media.mime || '')
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
      throw new Error('Media type does not match the selected file')
    }
    return {
      data,
      mime,
      name: String(media.name || '')
    }
  }
  if (media.type !== 'image' && media.type !== 'video') {
    throw new Error('Media must be an image or video')
  }
  const url = String(media.url).trim()
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('Media URL is invalid')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Media URL must use http or https')
  }
  return { type: media.type, url }
}

function normalizeMediaList(media) {
  const mediaItems = Array.isArray(media) ? media : media ? [media] : []
  return mediaItems.map(normalizeMedia).filter(Boolean)
}

function normalizeOption(option) {
  if (typeof option === 'string') return { text: option.trim(), media: [] }
  return {
    text: String(option?.text || '').trim(),
    media: normalizeMediaList(option?.media)
  }
}

async function handlePoll(pollOperation) {
  const context = languages.get(pollOperation.languageId || activeLanguageId)
  if (!context) return sendError(new Error('Select or join a language first'))
  return enqueueLanguage(context, () => handlePollUnlocked(pollOperation, context))
}

async function handlePollUnlocked(pollOperation, context) {
  try {
    const { base } = context
    await base.ready()
    const author = keyId(base.local.key)

    if (pollOperation.cmd === 'create') {
      const question = String(pollOperation.poll?.question || '').trim()
      const questionMedia = normalizeMediaList(pollOperation.poll?.questionMedia)
      const options = Array.isArray(pollOperation.poll?.options)
        ? pollOperation.poll.options.map(normalizeOption).filter((option) => option.text)
        : []
      if (!question || options.length < 2) {
        throw new Error('A poll needs a question and at least two options')
      }

      const id = `${Date.now()}-${author.slice(0, 12)}`
      await base.append(
        encodePayload({
          type: 'create-poll',
          id,
          data: {
            id,
            question,
            questionMedia,
            options,
            creator: author,
            closed: false,
            createdAt: Date.now()
          }
        }),
        { optimistic: true }
      )
      await sendAllPollsUnlocked(context)
    } else if (pollOperation.cmd === 'vote') {
      const poll = await getPollUnlocked(context, pollOperation.pollId)
      if (!poll) throw new Error('Poll not found')
      if (poll.closed) throw new Error('Voting is closed')
      if (
        !Number.isInteger(pollOperation.optionIndex) ||
        pollOperation.optionIndex < 0 ||
        pollOperation.optionIndex >= poll.options.length
      ) {
        throw new Error('Choose a valid option')
      }
      if (userBaseReady) await userBaseReady
      if (!userBase) throw new Error('User profile is not ready')
      const device = await userBase.view.get(`devices/${keyId(userBase.local.key)}`)
      if (!device || JSON.parse(device.value).active !== true) {
        throw new Error('This device is not paired to an active user')
      }
      const voter = keyId(userBase.key)
      if (await getVoteUnlocked(context, poll.id, voter)) {
        throw new Error('You have already voted in this poll')
      }
      await base.append(
        encodePayload({
          type: 'cast-vote',
          pollId: poll.id,
          voter,
          data: { optionIndex: pollOperation.optionIndex, createdAt: Date.now() }
        }),
        { optimistic: true }
      )
      await sendAllPollsUnlocked(context)
    } else if (pollOperation.cmd === 'close') {
      const poll = await getPollUnlocked(context, pollOperation.pollId)
      if (!poll) throw new Error('Poll not found')
      if (poll.creator !== author) throw new Error('Only the poll creator can close voting')
      if (!poll.closed) {
        await base.append(encodePayload({ type: 'close-poll', pollId: poll.id }), {
          optimistic: true
        })
      }
      await sendAllPollsUnlocked(context)
    } else if (pollOperation.cmd === 'get-all') {
      await sendAllPollsUnlocked(context)
    }
  } catch (error) {
    sendError(error)
  }
}

function handleComment(commentOperation) { }

async function sendAllPolls(context) {
  return enqueueLanguage(context, () => sendAllPollsUnlocked(context))
}

async function sendAllPollsUnlocked(context) {
  await context.base.ready()
  await context.base.update()
  if (userBaseReady) await userBaseReady
  const voter = userBase ? keyId(userBase.key) : null

  const pollsStream = context.base.view.createReadStream({
    gte: 'polls/',
    lte: 'polls/\xff'
  })

  const results = {}
  for await (const { key, value } of pollsStream) {
    if (key.includes('/closed')) continue
    const poll = JSON.parse(value)
    poll.votes = await getPollResultsUnlocked(context, poll.id)
    poll.hasVoted = voter ? await getVoteUnlocked(context, poll.id, voter) : false
    results[poll.id] = poll
  }

  pipe.write(JSON.stringify({ type: 'polls', languageId: context.id, data: results }))
}

async function getPoll(context, pollId) {
  return enqueueLanguage(context, () => getPollUnlocked(context, pollId))
}

async function getPollUnlocked(context, pollId) {
  await context.base.ready()
  const entry = await context.base.view.get(`polls/${pollId}`)
  if (!entry) return null
  const poll = JSON.parse(entry.value)
  poll.closed = (await context.base.view.get(`polls/${pollId}/closed`)) !== null
  poll.votes = await getPollResultsUnlocked(context, pollId)
  if (userBaseReady) await userBaseReady
  poll.hasVoted = userBase ? await getVoteUnlocked(context, pollId, keyId(userBase.key)) : false
  return poll
}

async function getVote(context, pollId, author) {
  return enqueueLanguage(context, () => getVoteUnlocked(context, pollId, author))
}

async function getVoteUnlocked(context, pollId, author) {
  return (await context.base.view.get(`votes/${pollId}/${author}`)) !== null
}

async function getPollResults(context, pollId) {
  return enqueueLanguage(context, () => getPollResultsUnlocked(context, pollId))
}

async function getPollResultsUnlocked(context, pollId) {
  const results = {}
  const stream = context.base.view.createReadStream({
    gte: `votes/${pollId}/`,
    lte: `votes/${pollId}/\xff`
  })
  for await (const { value } of stream) {
    const vote = JSON.parse(value)
    results[vote.optionIndex] = (results[vote.optionIndex] || 0) + 1
  }
  return results
}

async function handleTranslation(translation) {
  const context = languages.get(translation.languageId)
  if (!context) return sendError(new Error('Select or join a language first'))
  return enqueueLanguage(context, () => handleTranslationUnlocked(context, translation))
}

async function handleTranslationUnlocked(context, translation) {
  if (translation.cmd === 'save') {
    return await saveTranslationUnlocked(context, translation)
  } else if (translation.cmd === 'get-for-edit') {
    return await getTranslationForEditUnlocked(context, translation)
  } else if (translation.cmd === 'remove') {
    return await removeTranslationUnlocked(context, translation)
  }
}

async function saveTranslationUnlocked(context, translation) {
  console.log('saveTranslationUnlocked')
  const translations = translation.translations.map(({ translation, description, media }) => {
    return { translation, description, media: normalizeMediaList(media) };
  });

  if (translation.translationID == '' || !translation.translationID) {
    translation.translationID = guid();
  }

  try {
    const { base } = context
    await base.ready()
    const author = keyId(base.local.key)

    await base.append(encodePayload({
      type: 'save-translation',
      data: {
        translationID: translation.translationID,
        translations,
        author
      }
    }))

    await base.append(encodePayload({
      type: 'link-translation',
      data: {
        translationID: translation.translationID,
        words: translation.wordsForTranslation,
        language: translation.languageOfWordForTranslation
      }
    }))

    console.log('saved translation: ', JSON.stringify(translation))
  } catch (error) {
    sendError(error)
  }
}

function guid() {
  const bytes = crypto.randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function getTranslationForEditUnlocked(context, translation) {
  try {
    const { base } = context
    const entry = await base.view.get(`translations/${translation.translationID}`)
    if (entry) {
      const translationData = JSON.parse(entry.value)
      const wordsEntry = await base.view.get(`translations-to-words/${translation.translationID}`)
      if (wordsEntry) {
        const words = JSON.parse(wordsEntry.value)
        let language = null
        for (const word of words) {
          const idsReadStream = base.view.createReadStream({
            gte: `words/${word}`,
            lte: `words/${word}/\xff`
          })
          for await (const { key, value } of idsReadStream) {
            const ids = JSON.parse(value)
            if (ids.includes(translation.translationID)) {
              language = key.slice(key.lastIndexOf('/') + 1)
              break
            }
          }
          if (language) {
            break
          }
        }

        pipe.write(JSON.stringify({
          type: 'translation-for-edit',
          data: {
            translationID: translation.translationID,
            translations: translationData.translations,
            languageID: context.id,
            languageOfWordForTranslation: language,
            wordsForTranslation: words
          }
        }))
      }
    }
  } catch (error) {
    sendError(error)
  }
}

async function removeTranslationUnlocked(context, translation) {
  try {
    const { base } = context
    await base.append(encodePayload({
      type: 'link-translation',
      data: {
        translationID: translation.translationID,
        words: [],
        language: translation.languageOfWordForTranslation
      }
    }))
    await base.append(encodePayload({
      type: 'remove-translation',
      data: {
        translationID: translation.translationID
      }
    }))
  } catch (error) {
    sendError(error)
  }
}

async function handleSearch(search) {
  const context = languages.get(search.activeLanguageId)
  return enqueueLanguage(context, () => handleSearchUnlocked(context, search))
}

async function handleSearchUnlocked(context, search) {
  try {
    const wordsStream = context.base.view.createReadStream({
      gte: `words/${search.word}`,
      lte: `words/${search.word}/\xff`
    })

    const results = []
    for await (const { key, value } of wordsStream) {
      const ids = JSON.parse(value)
      const language = key.slice(key.lastIndexOf('/') + 1)
      for (const id of ids) {
        const entry = await context.base.view.get(`translations/${id}`)
        if (entry) {
          const translation = JSON.parse(entry.value)
          for (const trans of translation.translations) {
            results.push({
              translationID: translation.translationID,
              translation: trans.translation,
              description: trans.description,
              media: trans.media,
              language
            })
          }
        }
      }
    }

    pipe.write(JSON.stringify({ type: 'found-translations', languageId: context.id, data: results }))

    console.log('sent ', results.length, ' translations: ', JSON.stringify(results))
  } catch (error) {
    sendError(error)
  }
}

console.log('worker: after all')
