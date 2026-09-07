console.log('worker is starting')
const PearRuntime = require('pear-runtime') // pear-runtime on desktop; pear-mobile on mobile
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const dir = require('bare-storage')
const { isBareKit } = require('which-runtime')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const crypto = require('hypercore-crypto')

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

console.log('worker: after requires')
// mobile doesn't have the executable path (argv[0])
// and the worker entry path (argv[1]) in the workers argv‘s
// ... to reuse the same worker in all platforms this logic is needed
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

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
const topicForAll = crypto.data(Buffer.from('anyone'))

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

const base = new Autobase(store, null, {
  apply: async (batch, view, host) => {
    for (const node of batch) {
      const op = decodePayload(node.value)

      //verify block here

      await host.ackWriter(node.from.key)
      if (op.type === 'create-poll') {
        await view.put(`polls/${op.id}`, JSON.stringify(op.data))
      } else if (op.type === 'cast-vote') {
        await view.put(`votes/${op.pollId}/${op.author}`, JSON.stringify(op.data))
      } else if (op.type === 'add-comment') {
        await view.put(`comments/${op.pollId}/${op.timestamp}-${op.author}`, JSON.stringify(op.data))
      }
    }
  },
  open: (store) => {
    const core = store.get({ name: 'view' })
    return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'utf-8' })
  }
})

console.log('worker: after base')

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

swarm.on('connection', (connection) => store.replicate(connection))
swarm.join(topicForAll, {
  client: true,
  server: true
})

pipe.write('Hello from worker')

console.log('worker: after pipe hello')

async function handlePoll(pollOperation) {
  //try {
  if (pollOperation.cmd === 'create') {
    if (!base) {
      pipe.write(JSON.stringify({ type: 'error', data: "base is not set!" }))
      return
    }
    await base.append(encodePayload({ type: 'create-poll', id: 123, data: { ...pollOperation.poll, id: 123 } }))
  } else if (pollOperation.cmd === 'get-all') {
    sendAllPolls()
  }
  // } catch (err) {
  //   const errorMessage = error instanceof Error ? error.message : String(error)
  //   pipe.write(JSON.stringify({ type: 'error', data: errorMessage }))
  // }
}

async function handleComment(commentOperation) {

}

async function sendAllPolls() {
  //try {
  if (!base.view) {
    pipe.write(JSON.stringify({ type: 'error', data: "base.view is not set!" }))
    return
  }

  const pollsStream = base.view.createReadStream({
    gte: 'polls/',
    lte: 'polls/\xff'
  })

  const results = {}
  for await (const { key, value } of pollsStream) {
    const poll = JSON.parse(value)
    results[poll.id] = poll
  }

  pipe.write(JSON.stringify({ type: 'polls', data: results }))
  // } catch (err) {
  //   const errorMessage = error instanceof Error ? error.message : String(error)
  //   pipe.write(JSON.stringify({ type: 'error', data: errorMessage }))
  // }
}

console.log('worker: after all')