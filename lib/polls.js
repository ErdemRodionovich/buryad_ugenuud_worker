module.exports = function createPollsModule(runtime) {
  function normalizeMedia(media) {
    if (!media || media.type === 'none' || (!media.url && !media.data)) return null
    if (media.data) {
      const data = String(media.data)
      const bytes = runtime.b4a.from(data, 'base64')
      if (bytes.byteLength > runtime.maxMediaBytes) {
        throw new Error('Media file must be 10 MB or smaller')
      }
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
    const context = runtime.languages.get(pollOperation.languageId || runtime.activeLanguageId)
    if (!context) return runtime.sendError(new Error('Select or join a language first'))
    return runtime.enqueueLanguage(context, () => handlePollUnlocked(pollOperation, context))
  }

  async function handlePollUnlocked(pollOperation, context) {
    try {
      const { base } = context
      await base.ready()
      const author = runtime.keyId(base.local.key)

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
        const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
        const creator = accountKeyPair.publicKey.toLowerCase()
        if (
          (await base.view.get(runtime.languageRoleKey(creator, 'banned-create-vote'))) &&
          !(await runtime.hasLanguageRole(context, creator, 'administrator'))
        ) {
          throw new Error('You are not allowed to create polls in this language')
        }
        const createdAt = Date.now()
        const data = {
          id,
          question,
          questionMedia,
          options,
          creator,
          createdAt
        }
        const creatorSignature = runtime.keyId(
          runtime.crypto.sign(
            runtime.encodePayload(runtime.pollCreationPayload(data)),
            runtime.b4a.from(accountKeyPair.secretKey, 'hex')
          )
        )
        if (
          !runtime.crypto.verify(
            runtime.encodePayload(runtime.pollCreationPayload(data)),
            runtime.b4a.from(creatorSignature, 'hex'),
            runtime.b4a.from(creator, 'hex')
          )
        ) {
          throw new Error('New poll account signature failed local verification')
        }
        await base.append(
          runtime.encodePayload({
            type: 'create-poll',
            id,
            creator,
            creatorSignature,
            data: { ...data, closed: false }
          }),
          { optimistic: true }
        )
        await base.update()
        if (!(await base.view.get(`polls/${id}`))) {
          throw new Error('Poll creation was rejected by the language database')
        }
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
        if (runtime.userBaseReady) await runtime.userBaseReady
        if (!runtime.userBase) throw new Error('User profile is not ready')
        const device = await runtime.userBase.view.get(
          `devices/${runtime.keyId(runtime.userBase.local.key)}`
        )
        if (!device || JSON.parse(device.value).active !== true) {
          throw new Error('This device is not paired to an active user')
        }
        const voter = runtime.keyId(runtime.userBase.key)
        if (await getVoteUnlocked(context, poll.id, voter)) {
          throw new Error('You have already voted in this poll')
        }
        await base.append(
          runtime.encodePayload({
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
        const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
        const actor = accountKeyPair.publicKey.toLowerCase()
        const canClose =
          poll.creator === actor ||
          (await runtime.hasLanguageRole(context, actor, 'administrator')) ||
          (await runtime.hasLanguageRole(context, actor, 'vote-closer'))
        if (!canClose) throw new Error('You are not allowed to close voting in this language')
        const closeOperation = {
          type: 'close-poll',
          pollId: poll.id,
          actor,
          signature: runtime.keyId(
            runtime.crypto.sign(
              runtime.encodePayload({ type: 'close-poll', pollId: poll.id, actor }),
              runtime.b4a.from(accountKeyPair.secretKey, 'hex')
            )
          )
        }
        if (!poll.closed) {
          await base.append(runtime.encodePayload(closeOperation), { optimistic: true })
          await base.update()
          if ((await base.view.get(`polls/${poll.id}/closed`)) === null) {
            throw new Error('Poll close was rejected by the language database')
          }
        }
        await sendAllPollsUnlocked(context)
      } else if (pollOperation.cmd === 'get-all') {
        await sendAllPollsUnlocked(context)
      }
    } catch (error) {
      runtime.sendError(error)
    }
  }

  function handleComment(commentOperation) {
    const context = runtime.languages.get(commentOperation.languageId || runtime.activeLanguageId)
    if (!context) throw new Error('Select or join a language first')
    return runtime.enqueueLanguage(context, async () => {
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const accountKey = accountKeyPair.publicKey.toLowerCase()
      if (
        (await runtime.hasLanguageRole(context, accountKey, 'banned-comment')) &&
        !(await runtime.hasLanguageRole(context, accountKey, 'administrator'))
      ) {
        throw new Error('You are not allowed to comment in this language')
      }
      throw new Error('Comments are not implemented yet')
    })
  }

  async function sendAllPolls(context) {
    return runtime.enqueueLanguage(context, () => sendAllPollsUnlocked(context))
  }

  async function sendAllPollsUnlocked(context) {
    await context.base.ready()
    await context.base.update()
    if (runtime.userBaseReady) await runtime.userBaseReady
    const voter = runtime.userBase ? runtime.keyId(runtime.userBase.key) : null
    const accountKeyPair = await runtime.getAccountSigningKeyPair()
    const accountCreator = accountKeyPair ? accountKeyPair.publicKey.toLowerCase() : null

    const pollsStream = context.base.view.createReadStream({
      gte: 'polls/',
      lte: 'polls/\xff'
    })

    const results = {}
    for await (const { key, value } of pollsStream) {
      if (key.includes('/closed')) continue
      const poll = JSON.parse(value)
      const creatorEntry = await context.base.view.get(`members/${poll.creator}`)
      poll.creatorProfile = creatorEntry ? JSON.parse(creatorEntry.value) : null
      poll.closed = (await context.base.view.get(`polls/${poll.id}/closed`)) !== null
      poll.votes = await getPollResultsUnlocked(context, poll.id)
      poll.hasVoted = voter ? await getVoteUnlocked(context, poll.id, voter) : false
      poll.canClose = Boolean(
        accountCreator &&
        (poll.creator === accountCreator ||
          (await runtime.hasLanguageRole(context, accountCreator, 'administrator')) ||
          (await runtime.hasLanguageRole(context, accountCreator, 'vote-closer')))
      )
      results[poll.id] = poll
    }

    runtime.pipe.write(JSON.stringify({ type: 'polls', languageId: context.id, data: results }))
  }

  async function getPoll(context, pollId) {
    return runtime.enqueueLanguage(context, () => getPollUnlocked(context, pollId))
  }

  async function getPollUnlocked(context, pollId) {
    await context.base.ready()
    const entry = await context.base.view.get(`polls/${pollId}`)
    if (!entry) return null
    const poll = JSON.parse(entry.value)
    poll.closed = (await context.base.view.get(`polls/${pollId}/closed`)) !== null
    poll.votes = await getPollResultsUnlocked(context, pollId)
    if (runtime.userBaseReady) await runtime.userBaseReady
    poll.hasVoted = runtime.userBase
      ? await getVoteUnlocked(context, pollId, runtime.keyId(runtime.userBase.key))
      : false
    const accountKeyPair = await runtime.getAccountSigningKeyPair()
    const accountKey = accountKeyPair?.publicKey.toLowerCase()
    poll.canClose = Boolean(
      accountKey &&
      (poll.creator === accountKey ||
        (await runtime.hasLanguageRole(context, accountKey, 'administrator')) ||
        (await runtime.hasLanguageRole(context, accountKey, 'vote-closer')))
    )
    return poll
  }

  async function getVote(context, pollId, author) {
    return runtime.enqueueLanguage(context, () => getVoteUnlocked(context, pollId, author))
  }

  async function getVoteUnlocked(context, pollId, author) {
    return (await context.base.view.get(`votes/${pollId}/${author}`)) !== null
  }

  async function getPollResults(context, pollId) {
    return runtime.enqueueLanguage(context, () => getPollResultsUnlocked(context, pollId))
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

  return {
    normalizeMedia,
    normalizeMediaList,
    normalizeOption,
    handlePoll,
    handlePollUnlocked,
    handleComment,
    sendAllPolls,
    sendAllPollsUnlocked,
    getPoll,
    getPollUnlocked,
    getVote,
    getVoteUnlocked,
    getPollResults,
    getPollResultsUnlocked
  }
}
