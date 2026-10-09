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
const languages = new Map()
let activeLanguageId = null
const languageDirectory = path.join(updaterConfig.dir, 'app-storage', 'languages')
const registryStore = new Corestore(path.join(updaterConfig.dir, 'app-storage', 'registry'))
const registryView = new Hyperbee(registryStore.get({ name: 'languages' }), {
  keyEncoding: 'utf-8',
  valueEncoding: 'json'
})

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

async function readLanguageRegistry() {
  await registryStore.ready()
  await registryView.ready()
  const entries = []
  for await (const { value } of registryView.createReadStream({
    gte: 'languages/',
    lte: 'languages/\xff'
  })) {
    entries.push(value)
  }
  return entries
}

async function writeLanguageRegistry() {
  await registryStore.ready()
  await registryView.ready()
  for (const language of languages.values()) {
    const op = { key: language.key }
    if (language.storageFolder && language.storageFolder !== language.key)
      op.storageFolder = language.storageFolder
    await registryView.put(`languages/${language.key}`, op)
    console.log('wrote language, key: ', language.key, ' storageFolder:', language.storageFolder)
  }
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
        await view.put(`votes/${op.pollId}/${author}`, JSON.stringify(op.data))
      } else if (op.type === 'close-poll') {
        const entry = await view.get(`polls/${op.pollId}`)
        if (entry && JSON.parse(entry.value).creator === author) {
          await view.put(`polls/${op.pollId}/closed`, 'true')
        }
      } else if (op.type === 'save-translation-api-details') {
        await view.put('language/translation_api_details', JSON.stringify(op.data))
      }
    }
  })()
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
    operationQueue: Promise.resolve()
  }
  await base.ready()

  context.key = b4a.toString(base.key, 'hex')
  context.id = context.key
  context.storageFolder = storageFolder
  const metaEntry = await metaOfLanguage(context)
  if (metaEntry) Object.assign(context, metaEntry)
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
    if (activeLanguageId === context.id) {
      enqueueLanguage(context, async () => {
        await refreshLanguageMetadata(context)
        await sendAllPollsUnlocked(context)
      }).catch(sendError)
    }
  })
  return context
}

async function metaOfLanguage(context) {
  const entry = await context.base.view.get('language/meta')
  if (!entry) return null
  return JSON.parse(entry.value)
}

async function refreshLanguageMetadata(context) {
  const meta = metaOfLanguage(context)
  if (meta) {
    Object.assign(context, meta)
  }
  sendLanguages()
}

async function loadLanguages() {
  for (const metadata of await readLanguageRegistry()) {
    if (!/^[0-9a-f]{64}$/i.test(metadata.key || '')) {
      console.log('skipping language: ', JSON.stringify(metadata))
      continue
    }
    const context = await openLanguage(metadata, b4a.from(metadata.key, 'hex'))
    if (!activeLanguageId) activeLanguageId = context.id
  }
  sendLanguages()
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
  await writeLanguageRegistry()
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
  await writeLanguageRegistry()
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
    const { yKey, yFolderID } = details
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
              yFolderID
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
  for (const context of languages.values()) {
    context.base.replicate(connection)
    enqueueLanguage(context, () => context.base.update()).catch(sendError)
  }
})

async function startReplication() {
  await loadLanguages()
  sendPeerCount()
}

function sendPeerCount() {
  pipe.write(JSON.stringify({ type: 'peers', data: peers.size }))
}

goodbye(async () => {
  await updater_swarm.destroy()
  await swarm.destroy()
  await pear.close()
  await registryView.close()
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
    } else if (msg.type === 'language') {
      await handleLanguage(msg.data)
    } else if (msg.type === 'poll') {
      await handlePoll(msg.data)
    } else if (msg.type === 'comment') {
      await handleComment(msg.data)
    }
  } catch (err) {
    console.log(err.message)
    console.log('while handling:')
    console.log(message)
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
      if (await getVoteUnlocked(context, poll.id, author)) {
        throw new Error('You have already voted in this poll')
      }
      await base.append(
        encodePayload({
          type: 'cast-vote',
          pollId: poll.id,
          author,
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

  const pollsStream = context.base.view.createReadStream({
    gte: 'polls/',
    lte: 'polls/\xff'
  })

  const results = {}
  for await (const { key, value } of pollsStream) {
    if (key.includes('/closed')) continue
    const poll = JSON.parse(value)
    poll.votes = await getPollResultsUnlocked(context, poll.id)
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

console.log('worker: after all')
