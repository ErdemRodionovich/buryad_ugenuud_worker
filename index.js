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


console.log('worker: after requires')
// mobile doesn't have the executable path (argv[0])
// and the worker entry path (argv[1]) in the workers argv‘s
// ... to reuse the same worker in all platforms this logic is needed
const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]

const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4) || dir.persistent(), // argv[4] is undefined in mobile
  app: argv(5) // argv[5] is undefined in mobile
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
      const { op } = node

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

await base.ready()

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
  } catch {
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
  if (pollOperation.cmd === 'create') {
    base.append({ type: 'create-poll', id: 123, data: { ...pollOperation.data, id: 123 } })
  } else if (pollOperation.cmd === 'get-all') {
    sendAllPolls()
  }
}

async function handleComment(commentOperation) {

}

async function sendAllPolls() {

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
}

console.log('worker: after all')