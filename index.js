console.log('worker is starting')
const PearRuntime = require('pear-runtime') // pear-runtime on desktop; pear-mobile on mobile
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const b4a = require('b4a')

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
const store = new Corestore(path.join(updaterConfig.dir, 'app-storage', 'bee'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm: updater_swarm, store: updater_store })
const pollKey = argsParsed['poll-key'] || argsParsed.pollKey
if (!/^[0-9a-f]{64}$/i.test(pollKey || '')) {
  throw new Error('poll-key must be a 32-byte hexadecimal Autobase key')
}
const sharedBootstrapKey = b4a.from(pollKey, 'hex')
const peers = new Set()

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

const base = new Autobase(store, sharedBootstrapKey, {
  optimistic: true,
  apply: async (batch, view, host) => {
    for (const node of batch) {
      const op = decodePayload(node.value)
      if (!op) continue
      const author = keyId(node.from.key)

      await host.ackWriter(node.from.key)
      if (op.type === 'create-poll') {
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
      } else if (op.type === 'add-comment') {
        await view.put(
          `comments/${op.pollId}/${op.timestamp}-${op.author}`,
          JSON.stringify(op.data)
        )
      }
    }
  },
  open: (store) => {
    const core = store.get({ name: 'view' })
    return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'utf-8' })
  }
})

console.log('worker: after base')

async function startReplication() {
  await base.ready()

  console.log('Application base discovery key:', b4a.toString(base.discoveryKey, 'hex'))
  sendPeerCount()
  base.on('update', () => sendAllPolls().catch(sendError))
  swarm.on('connection', (connection) => {
    peers.add(connection)
    console.log('Application peer connected')
    sendPeerCount()
    connection.once('close', () => {
      peers.delete(connection)
      console.log('Application peer disconnected')
      sendPeerCount()
    })
    store.replicate(connection)
  })
  swarm.join(base.discoveryKey, {
    client: true,
    server: true
  })
}

function sendPeerCount() {
  pipe.write(JSON.stringify({ type: 'peers', data: peers.size }))
}

goodbye(async () => {
  await updater_swarm.destroy()
  await swarm.destroy()
  await pear.close()
  await updater_store.close()
  await store.close()
})

//base.ready()

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

async function handlePoll(pollOperation) {
  try {
    await base.ready()
    const author = keyId(base.local.key)

    if (pollOperation.cmd === 'create') {
      const question = String(pollOperation.poll?.question || '').trim()
      const options = Array.isArray(pollOperation.poll?.options)
        ? pollOperation.poll.options.map((option) => String(option).trim()).filter(Boolean)
        : []
      if (!question || options.length < 2) {
        throw new Error('A poll needs a question and at least two options')
      }

      const id = `${Date.now()}-${author.slice(0, 12)}`
      await base.append(
        encodePayload({
          type: 'create-poll',
          id,
          data: { id, question, options, creator: author, closed: false, createdAt: Date.now() }
        }),
        { optimistic: true }
      )
      await sendAllPolls()
    } else if (pollOperation.cmd === 'vote') {
      const poll = await getPoll(pollOperation.pollId)
      if (!poll) throw new Error('Poll not found')
      if (poll.closed) throw new Error('Voting is closed')
      if (
        !Number.isInteger(pollOperation.optionIndex) ||
        pollOperation.optionIndex < 0 ||
        pollOperation.optionIndex >= poll.options.length
      ) {
        throw new Error('Choose a valid option')
      }
      if (await getVote(poll.id, author)) throw new Error('You have already voted in this poll')
      await base.append(
        encodePayload({
          type: 'cast-vote',
          pollId: poll.id,
          author,
          data: { optionIndex: pollOperation.optionIndex, createdAt: Date.now() }
        }),
        { optimistic: true }
      )
      await sendAllPolls()
    } else if (pollOperation.cmd === 'close') {
      const poll = await getPoll(pollOperation.pollId)
      if (!poll) throw new Error('Poll not found')
      if (poll.creator !== author) throw new Error('Only the poll creator can close voting')
      if (!poll.closed) {
        await base.append(encodePayload({ type: 'close-poll', pollId: poll.id }), {
          optimistic: true
        })
      }
      await sendAllPolls()
    } else if (pollOperation.cmd === 'get-all') {
      await sendAllPolls()
    }
  } catch (error) {
    sendError(error)
  }
}

function handleComment(commentOperation) { }

async function sendAllPolls() {
  await base.ready()

  const pollsStream = base.view.createReadStream({
    gte: 'polls/',
    lte: 'polls/\xff'
  })

  const results = {}
  for await (const { key, value } of pollsStream) {
    if (key.includes('/closed')) continue
    const poll = JSON.parse(value)
    poll.votes = await getPollResults(poll.id)
    results[poll.id] = poll
  }

  pipe.write(JSON.stringify({ type: 'polls', data: results }))
}

async function getPoll(pollId) {
  await base.ready()
  const entry = await base.view.get(`polls/${pollId}`)
  if (!entry) return null
  const poll = JSON.parse(entry.value)
  poll.closed = (await base.view.get(`polls/${pollId}/closed`)) !== null
  poll.votes = await getPollResults(pollId)
  return poll
}

async function getVote(pollId, author) {
  return (await base.view.get(`votes/${pollId}/${author}`)) !== null
}

async function getPollResults(pollId) {
  const results = {}
  const stream = base.view.createReadStream({
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
