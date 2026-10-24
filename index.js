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

const createSharedModule = require('./lib/shared')
const createProfileModule = require('./lib/profile')
const createPairingModule = require('./lib/pairing')
const createLanguageModule = require('./lib/language')
const createLanguageAdminModule = require('./lib/language-admin')
const createPollsModule = require('./lib/polls')
const createTranslationsModule = require('./lib/translations')

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
const maxUserAvatarBytes = 2 * 1024 * 1024
const maxLanguageAvatarBytes = 80 * 1024
const supportedAvatarTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const runtime = {
  PearRuntime,
  Hyperswarm,
  Corestore,
  goodbye,
  FramedStream,
  path,
  fs,
  dir,
  Autobase,
  Hyperbee,
  crypto,
  b4a,
  maxMediaBytes,
  updaterConfig,
  pipe,
  updater_store,
  updater_swarm,
  swarm,
  pear,
  peers,
  connections,
  pairingSessions,
  languages,
  languageDirectory,
  userBaseDirectory,
  registryStore,
  localStateView,
  userStoragePath,
  profileKey,
  pairingCodeVersion,
  pairingCodeApp,
  pairingCodeTtl,
  maxUserAvatarBytes,
  maxLanguageAvatarBytes,
  supportedAvatarTypes
}
Object.defineProperties(runtime, {
  activeLanguageId: {
    enumerable: true,
    get: () => activeLanguageId,
    set: (value) => {
      activeLanguageId = value
    }
  },
  userStore: {
    enumerable: true,
    get: () => userStore,
    set: (value) => {
      userStore = value
    }
  },
  userBaseStore: {
    enumerable: true,
    get: () => userBaseStore,
    set: (value) => {
      userBaseStore = value
    }
  },
  userBase: {
    enumerable: true,
    get: () => userBase,
    set: (value) => {
      userBase = value
    }
  },
  userBaseReady: {
    enumerable: true,
    get: () => userBaseReady,
    set: (value) => {
      userBaseReady = value
    }
  },
  userOperationQueue: {
    enumerable: true,
    get: () => userOperationQueue,
    set: (value) => {
      userOperationQueue = value
    }
  },
  userSyncQueue: {
    enumerable: true,
    get: () => userSyncQueue,
    set: (value) => {
      userSyncQueue = value
    }
  }
})
Object.assign(runtime, createSharedModule(runtime))
Object.assign(runtime, createProfileModule(runtime))
Object.assign(runtime, createPairingModule(runtime))
Object.assign(runtime, createLanguageModule(runtime))
Object.assign(runtime, createLanguageAdminModule(runtime))
Object.assign(runtime, createPollsModule(runtime))
Object.assign(runtime, createTranslationsModule(runtime))
const {
  enqueueLanguage,
  sendError,
  stopPairingSession,
  resumePairingSessions,
  loadLanguages,
  handleProfile,
  handlePairing,
  handleLanguage,
  handlePoll,
  handleComment,
  handleTranslation,
  handleSearch
} = runtime

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

console.log('worker: after all')
