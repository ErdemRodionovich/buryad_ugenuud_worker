module.exports = function createLanguageModule(runtime) {
  const isUnicodeEmoji = require('./unicode-emoji')

  function languageApply(batch, view, host) {
    return (async () => {
      for (const node of batch) {
        const op = runtime.decodePayload(node.value)
        if (!op) continue
        const author = runtime.keyId(node.from.key)

        if (op.type === 'language-join') {
          await host.addWriter(runtime.b4a.from(op.writer, 'hex'), {
            indexer: false,
            isIndexer: false
          })
          await host.ackWriter(node.from.key)
        } else {
          await host.ackWriter(node.from.key)
        }

        if (await runtime.applyLanguageAdminOperation(view, op, author)) continue

        if (op.type === 'language-meta') {
          if (await view.get('language/meta')) continue
          const metadata = {
            name: op.name,
            description: op.description,
            creator: op.creator,
            ownerAccountKey: op.ownerAccountKey
          }
          if (
            op.creator !== author ||
            !runtime.verifyAccountSignature(
              runtime.languageMetaPayload(metadata),
              op.ownerAccountKey,
              op.signature
            )
          ) {
            continue
          }
          await view.put('language/meta', JSON.stringify(metadata))
        } else if (op.type === 'create-poll') {
          const signedPoll = {
            ...op.data,
            id: op.id,
            creator: op.creator
          }
          const hasValidCreatorKey = /^[0-9a-f]{64}$/i.test(op.creator || '')
          const hasValidSignature = /^[0-9a-f]{128}$/i.test(op.creatorSignature || '')
          const validSignature =
            hasValidCreatorKey &&
            hasValidSignature &&
            runtime.crypto.verify(
              runtime.encodePayload(runtime.pollCreationPayload(signedPoll)),
              runtime.b4a.from(op.creatorSignature, 'hex'),
              runtime.b4a.from(op.creator, 'hex')
            )
          if (!validSignature) {
            console.error(
              'Rejected poll creation with an invalid account signature:',
              JSON.stringify({
                id: op.id,
                author: author.slice(0, 12),
                hasValidCreatorKey,
                hasValidSignature,
                dataIdMatches: op.data?.id === op.id,
                dataCreatorMatches: op.data?.creator === op.creator,
                questionIsString: typeof op.data?.question === 'string',
                optionsIsArray: Array.isArray(op.data?.options),
                questionMediaIsArray: Array.isArray(op.data?.questionMedia)
              })
            )
            continue
          }
          const creatorIsBanned =
            (await view.get(
              runtime.languageRoleKey(op.creator.toLowerCase(), 'banned-create-vote')
            )) !== null
          const metaEntry = await view.get('language/meta')
          const meta = metaEntry ? JSON.parse(metaEntry.value) : null
          const creatorIsAdmin =
            (await view.get(runtime.languageRoleKey(op.creator.toLowerCase(), 'administrator'))) !==
              null ||
            meta?.ownerAccountKey === op.creator ||
            (!meta?.ownerAccountKey && meta?.creator === author)
          if (creatorIsBanned && !creatorIsAdmin) {
            continue
          }
          await view.put(
            `polls/${op.id}`,
            JSON.stringify({
              ...signedPoll,
              creator: op.creator.toLowerCase(),
              accountCreator: true,
              closed: false
            })
          )
        } else if (op.type === 'cast-vote') {
          const voter = /^[0-9a-f]{64}$/i.test(op.voter || '') ? op.voter.toLowerCase() : author
          const voteKey = `votes/${op.pollId}/${voter}`
          const pollEntry = await view.get(`polls/${op.pollId}`)
          const isClosed = await view.get(`polls/${op.pollId}/closed`)
          if (pollEntry && !isClosed && !(await view.get(voteKey))) {
            await view.put(voteKey, JSON.stringify(op.data))
          }
        } else if (op.type === 'poll-comment') {
          const comment = op.data
          const actor = String(op.actor || '').toLowerCase()
          if (
            !comment ||
            typeof comment.pollId !== 'string' ||
            typeof comment.commentId !== 'string' ||
            !Number.isSafeInteger(comment.createdAt) ||
            !comment.commentId.startsWith(`${comment.createdAt}-${actor}-`) ||
            !/^[0-9a-f]{16}$/i.test(
              comment.commentId.slice(`${comment.createdAt}-${actor}-`.length)
            ) ||
            typeof comment.text !== 'string' ||
            !comment.text.trim() ||
            !Array.isArray(comment.media) ||
            !runtime.verifyAccountSignature(
              { type: op.type, data: comment, actor: op.actor },
              op.actor,
              op.signature
            )
          ) {
            continue
          }
          const pollEntry = await view.get(`polls/${comment.pollId}`)
          const pollIsClosed = await view.get(`polls/${comment.pollId}/closed`)
          if (
            !pollEntry ||
            pollIsClosed ||
            (await view.get(`comments/${comment.pollId}/${comment.commentId}`))
          ) {
            continue
          }
          let media
          try {
            media = runtime.normalizeMediaList(comment.media)
          } catch {
            continue
          }
          const banned = (await view.get(runtime.languageRoleKey(actor, 'banned-comment'))) !== null
          const metaEntry = await view.get('language/meta')
          const meta = metaEntry ? JSON.parse(metaEntry.value) : null
          const administrator =
            (await view.get(runtime.languageRoleKey(actor, 'administrator'))) !== null ||
            meta?.ownerAccountKey === actor ||
            (!meta?.ownerAccountKey && meta?.creator === author)
          if (banned && !administrator) continue

          await view.put(
            `comments/${comment.pollId}/${comment.commentId}`,
            JSON.stringify({ ...comment, text: comment.text.trim(), media, author: actor })
          )
        } else if (op.type === 'poll-comment-remove') {
          const removal = op.data
          const actor = String(op.actor || '').toLowerCase()
          if (
            !removal ||
            typeof removal.pollId !== 'string' ||
            typeof removal.commentId !== 'string' ||
            !runtime.verifyAccountSignature(
              { type: op.type, data: removal, actor: op.actor },
              op.actor,
              op.signature
            )
          ) {
            continue
          }
          const pollEntry = await view.get(`polls/${removal.pollId}`)
          const commentEntry = await view.get(`comments/${removal.pollId}/${removal.commentId}`)
          if (!pollEntry || !commentEntry) continue
          const metaEntry = await view.get('language/meta')
          const meta = metaEntry ? JSON.parse(metaEntry.value) : null
          const administrator =
            (await view.get(runtime.languageRoleKey(actor, 'administrator'))) !== null ||
            meta?.ownerAccountKey === actor ||
            (!meta?.ownerAccountKey && meta?.creator === author)
          if (!administrator) continue

          const reactionPrefix = `comment-reactions/${removal.pollId}/${removal.commentId}/`
          const reactionKeys = []
          const reactions = view.createReadStream({
            gte: reactionPrefix,
            lte: `${reactionPrefix}\xff`
          })
          for await (const { key } of reactions) reactionKeys.push(key)
          for (const key of reactionKeys) await view.del(key)
          await view.del(`comments/${removal.pollId}/${removal.commentId}`)
        } else if (op.type === 'poll-comment-reaction') {
          const reaction = op.data
          const actor = String(op.actor || '').toLowerCase()
          if (
            !reaction ||
            typeof reaction.pollId !== 'string' ||
            typeof reaction.commentId !== 'string' ||
            !isUnicodeEmoji(reaction.emoji) ||
            typeof reaction.enabled !== 'boolean' ||
            !runtime.verifyAccountSignature(
              { type: op.type, data: reaction, actor: op.actor },
              op.actor,
              op.signature
            )
          ) {
            continue
          }
          const pollEntry = await view.get(`polls/${reaction.pollId}`)
          const pollIsClosed = await view.get(`polls/${reaction.pollId}/closed`)
          const commentEntry = await view.get(`comments/${reaction.pollId}/${reaction.commentId}`)
          if (!pollEntry || pollIsClosed || !commentEntry) continue

          const banned = (await view.get(runtime.languageRoleKey(actor, 'banned-comment'))) !== null
          const metaEntry = await view.get('language/meta')
          const meta = metaEntry ? JSON.parse(metaEntry.value) : null
          const administrator =
            (await view.get(runtime.languageRoleKey(actor, 'administrator'))) !== null ||
            meta?.ownerAccountKey === actor ||
            (!meta?.ownerAccountKey && meta?.creator === author)
          if (banned && !administrator) continue

          const emojiKey = [...reaction.emoji]
            .map((character) => character.codePointAt(0).toString(16))
            .join('-')
          await view.put(
            `comment-reactions/${reaction.pollId}/${reaction.commentId}/${emojiKey}/${actor}`,
            JSON.stringify({ ...reaction, actor })
          )
        } else if (op.type === 'close-poll') {
          const entry = await view.get(`polls/${op.pollId}`)
          if (entry) {
            const poll = JSON.parse(entry.value)
            const actor = op.actor || op.creator
            const signedPayload = op.actor
              ? { type: 'close-poll', pollId: op.pollId, actor }
              : runtime.pollClosePayload(op.pollId, op.creator)
            const signedByActor = runtime.verifyAccountSignature(signedPayload, actor, op.signature)
            const metaEntry = await view.get('language/meta')
            const meta = metaEntry ? JSON.parse(metaEntry.value) : null
            const hasAccountAuthorization =
              poll.accountCreator === true &&
              signedByActor &&
              (actor === poll.creator ||
                (await view.get(runtime.languageRoleKey(actor, 'administrator'))) !== null ||
                (await view.get(runtime.languageRoleKey(actor, 'vote-closer'))) !== null ||
                meta?.ownerAccountKey === actor ||
                (!meta?.ownerAccountKey && meta?.creator === author))
            if (hasAccountAuthorization) {
              await view.put(`polls/${op.pollId}/closed`, 'true')
            }
          }
        } else if (op.type === 'save-translation') {
          if (await isAuthorizedWordOperation(view, op, author)) {
            await view.put(`translations/${op.data.translationID}`, JSON.stringify(op.data))
          }
        } else if (op.type === 'remove-translation') {
          if (await isAuthorizedWordOperation(view, op, author)) {
            await view.del(`translations/${op.data.translationID}`)
          }
        } else if (op.type === 'link-translation') {
          if (await isAuthorizedWordOperation(view, op, author)) {
            await linkTranslation(view, op.data)
          }
        }
      }
    })()
  }

  async function isAuthorizedWordOperation(view, operation, author) {
    if (
      !runtime.verifyAccountSignature(
        { type: operation.type, data: operation.data, actor: operation.actor },
        operation.actor,
        operation.signature
      )
    ) {
      return false
    }
    const metaEntry = await view.get('language/meta')
    const meta = metaEntry ? JSON.parse(metaEntry.value) : null
    return (
      (await view.get(runtime.languageRoleKey(operation.actor, 'administrator'))) !== null ||
      (await view.get(runtime.languageRoleKey(operation.actor, 'word-creator'))) !== null ||
      meta?.ownerAccountKey === operation.actor ||
      (!meta?.ownerAccountKey && meta?.creator === author)
    )
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
      await view.put(
        `translations-to-words/${translation.translationID}`,
        JSON.stringify(translation.words)
      )
    } else {
      await view.del(`translations-to-words/${translation.translationID}`)
    }
  }

  function languageOpen(store) {
    return new runtime.Hyperbee(store.get({ name: 'view' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
  }

  async function openLanguage(metadata, bootstrap, keyPair = null) {
    const languageKey = metadata.key || (keyPair && runtime.keyId(keyPair.publicKey))
    if (!languageKey) throw new Error('Language key is required')
    let storageFolder = languageKey
    if (
      metadata.storageFolder &&
      runtime.fs.existsSync(runtime.path.join(runtime.languageDirectory, metadata.storageFolder))
    ) {
      storageFolder = metadata.storageFolder
    }
    const languageStore = new runtime.Corestore(
      runtime.path.join(runtime.languageDirectory, storageFolder)
    )
    const baseOptions = {
      optimistic: true,
      apply: languageApply,
      open: languageOpen
    }
    if (keyPair) baseOptions.keyPair = keyPair
    const base = new runtime.Autobase(languageStore, bootstrap, baseOptions)
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

    context.key = runtime.b4a.toString(base.key, 'hex')
    context.id = context.key
    context.storageFolder = storageFolder
    const metaEntry = await metaOfLanguage(context)
    if (metaEntry) {
      Object.assign(context, metaEntry)
      await runtime.addLanguageToUserRegistry(context)
    }
    runtime.languages.set(context.id, context)

    for (const connection of runtime.connections) context.base.replicate(connection)
    runtime.swarm.join(base.discoveryKey, { client: true, server: true })
    if (bootstrap && !(await base.local.getUserData('language/joined'))) {
      await base.append(
        runtime.encodePayload({ type: 'language-join', writer: runtime.keyId(base.local.key) }),
        {
          optimistic: true
        }
      )
      await base.local.setUserData('language/joined', runtime.b4a.from('1'))
    }
    base.on('update', () => {
      runtime
        .enqueueLanguage(context, async () => {
          await refreshLanguageMetadata(context)
          if (runtime.activeLanguageId === context.id) {
            await runtime.sendLanguageRolesUnlocked(context)
            const accountKeyPair = await runtime.getAccountSigningKeyPair()
            const accountKey = accountKeyPair?.publicKey.toLowerCase()
            if (await runtime.hasLanguageRole(context, accountKey, 'administrator')) {
              await runtime.sendLanguageMembersUnlocked(context)
            }
            await runtime.sendAllPollsUnlocked(context)
          }
        })
        .catch(runtime.sendError)
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
      await runtime.addLanguageToUserRegistry(context)
    }
    sendLanguages().catch(runtime.sendError)
  }

  async function loadLanguages() {
    runtime.userBaseReady = runtime.initializeUserBase()
    await runtime.userBaseReady
    await runtime.refreshUserState()
    if (runtime.activeLanguageId) {
      await runtime.sendAllPolls(runtime.languages.get(runtime.activeLanguageId))
    }
  }

  async function sendLanguages() {
    try {
      const accountKeyPair = await runtime.getAccountSigningKeyPair()
      const accountKey = accountKeyPair?.publicKey.toLowerCase() || null
      const data = []
      for (const { base, store, ...metadata } of runtime.languages.values()) {
        const { id, key, storageFolder, name, description, creator } = metadata
        const isOwner = accountKey
          ? await runtime.hasLanguageRole({ ...metadata, base }, accountKey, 'administrator')
          : creator === runtime.keyId(base.local.key)
        data.push({ id, key, storageFolder, name, description, creator, isOwner })
      }
      runtime.pipe.write(
        JSON.stringify({ type: 'languages', active: runtime.activeLanguageId, data })
      )
    } catch (error) {
      runtime.sendError(error)
    }
  }

  async function createLanguage(data) {
    const name = String(data.name || '').trim()
    const description = String(data.description || '').trim()
    if (!name) throw new Error('Language name is required')
    const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
    const keyPair = runtime.crypto.keyPair()
    const context = await openLanguage({}, null, keyPair)
    const metadata = {
      name,
      description,
      creator: runtime.keyId(context.base.local.key),
      ownerAccountKey: accountKeyPair.publicKey.toLowerCase()
    }
    const metaPayload = runtime.languageMetaPayload(metadata)
    await context.base.append(
      runtime.encodePayload({
        ...metaPayload,
        signature: runtime.keyId(
          runtime.crypto.sign(
            runtime.encodePayload(metaPayload),
            runtime.b4a.from(accountKeyPair.secretKey, 'hex')
          )
        )
      })
    )
    Object.assign(context, metadata)
    await context.base.update()
    await context.base.flush()
    await context.base.local.setUserData('language/joined', runtime.b4a.from('1'))
    await runtime.registerLanguageMember(context)
    context.name = name
    context.description = description
    runtime.languages.set(context.id, context)
    runtime.activeLanguageId = context.id
    await runtime.addLanguageToUserRegistry(context)
    await sendLanguages()
    await runtime.sendLanguageRoles(context)
    runtime.pipe.write(
      JSON.stringify({ type: 'language-created', data: { id: context.id, key: context.key } })
    )
  }

  async function joinLanguage(data) {
    const key = String(data.key || '')
      .trim()
      .toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new Error('Language key must be 64 hexadecimal characters')
    }
    if ([...runtime.languages.values()].some((language) => language.key === key)) {
      throw new Error('This language is already joined')
    }
    const context = await openLanguage(
      {
        key
      },
      runtime.b4a.from(key, 'hex')
    )
    runtime.languages.set(context.id, context)
    await runtime.registerLanguageMember(context)
    runtime.activeLanguageId = context.id
    await runtime.addLanguageToUserRegistry(context)
    await sendLanguages()
    await runtime.sendLanguageRoles(context)
    await runtime.sendAllPolls(context)
  }

  function selectLanguage(id) {
    if (!runtime.languages.has(id)) throw new Error('Language not found')
    runtime.activeLanguageId = id
    sendLanguages().catch(runtime.sendError)
    runtime.sendLanguageRoles(runtime.languages.get(id)).catch(runtime.sendError)
    runtime.sendTranslationAPI_Details(runtime.languages.get(id))
    return runtime.sendAllPolls(runtime.languages.get(id))
  }

  function handleLanguage(operation) {
    if (operation.cmd === 'create') return createLanguage(operation)
    if (operation.cmd === 'join') return joinLanguage(operation)
    if (operation.cmd === 'select') return selectLanguage(operation.id)
    if (operation.cmd === 'list') return sendLanguages()
    if (operation.cmd === 'get-members') {
      const context = runtime.languages.get(operation.languageId || runtime.activeLanguageId)
      if (!context) throw new Error('Select or join a language first')
      return runtime.sendLanguageMembers(context)
    }
    if (operation.cmd === 'set-role') return runtime.setLanguageRole(operation)
    if (operation.cmd === 'saveAPI_Details') return runtime.saveTranslationAPI_Details(operation)
    throw new Error('Unknown language command')
  }

  return {
    languageApply,
    isAuthorizedWordOperation,
    linkTranslation,
    languageOpen,
    openLanguage,
    metaOfLanguage,
    refreshLanguageMetadata,
    loadLanguages,
    sendLanguages,
    createLanguage,
    joinLanguage,
    selectLanguage,
    handleLanguage
  }
}
