module.exports = function createProfileModule(runtime) {
  function userOpen(store) {
    return new runtime.Hyperbee(store.get({ name: 'view' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'utf-8'
    })
  }

  async function userApply(batch, view, host) {
    for (const node of batch) {
      const op = runtime.decodePayload(node.value)
      if (!op) continue
      const author = runtime.keyId(node.from.key)
      const initialized = await view.get('user/initialized')

      if (op.type === 'user-init' && !initialized) {
        if (!/^[0-9a-f]{64}$/i.test(op.signerKey || '')) continue
        await view.put('user/initialized', 'true')
        await view.put('user/owner', author)
        await view.put(
          `devices/${author}`,
          JSON.stringify({ active: true, owner: true, signerKey: op.signerKey })
        )
        await view.put(
          runtime.profileKey,
          JSON.stringify({ nickname: '', avatar: null, languageAvatar: null })
        )
        await host.ackWriter(node.from.key)
        continue
      }

      const device = await view.get(`devices/${author}`)
      if (!device || JSON.parse(device.value).active !== true) continue
      await host.ackWriter(node.from.key)

      if (op.type === 'user-account-signing-key') {
        if (
          !(await view.get('user/account-signing-key')) &&
          runtime.isValidAccountSigningKeyPair(op.keyPair)
        ) {
          await view.put('user/account-signing-key', JSON.stringify(op.keyPair))
        }
      } else if (op.type === 'user-profile') {
        if (
          typeof op.profile?.nickname === 'string' &&
          op.profile.nickname.trim() &&
          op.profile.nickname.length <= 40 &&
          runtime.isValidAvatar(op.profile.avatar, runtime.maxUserAvatarBytes) &&
          runtime.isValidAvatar(op.profile.languageAvatar, runtime.maxLanguageAvatarBytes)
        ) {
          await view.put(runtime.profileKey, JSON.stringify(op.profile))
        }
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
          !runtime.isValidPairingRequest(request) ||
          !runtime.verifyPairingRequest(request) ||
          !Number.isSafeInteger(op.approvedAt)
        ) {
          continue
        }
        if (request.deviceKey === author || (await view.get(`devices/${request.deviceKey}`))) {
          continue
        }
        await host.addWriter(runtime.b4a.from(request.deviceKey, 'hex'), {
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

  function enqueueUser(operation) {
    const previous = runtime.userOperationQueue
    let release
    runtime.userOperationQueue = new Promise((resolve) => {
      release = resolve
    })
    return previous.then(operation).finally(release)
  }

  async function getAccountSigningKeyPair() {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User profile is not ready')
    await runtime.userBase.update()
    const entry = await runtime.userBase.view.get('user/account-signing-key')
    if (!entry) return null
    const keyPair = JSON.parse(entry.value)
    if (!runtime.isValidAccountSigningKeyPair(keyPair)) {
      throw new Error('Stored account signing key is invalid')
    }
    return keyPair
  }

  async function ensureAccountSigningKeyPair() {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User profile is not ready')
    const device = await runtime.userBase.view.get(
      `devices/${runtime.keyId(runtime.userBase.local.key)}`
    )
    if (!device || JSON.parse(device.value).active !== true) {
      throw new Error('This device is not paired to an active user')
    }

    let keyPair = await getAccountSigningKeyPair()
    if (keyPair) return keyPair

    await enqueueUser(async () => {
      keyPair = await getAccountSigningKeyPair()
      if (keyPair) return
      const candidate = runtime.crypto.keyPair()
      await runtime.userBase.append(
        runtime.encodePayload({
          type: 'user-account-signing-key',
          keyPair: {
            publicKey: runtime.keyId(candidate.publicKey),
            secretKey: runtime.keyId(candidate.secretKey)
          }
        }),
        { optimistic: true }
      )
      await runtime.userBase.update()
      keyPair = await getAccountSigningKeyPair()
      if (!keyPair) throw new Error('Account signing key was not saved')
    })
    return keyPair
  }

  async function readUserLanguages() {
    const entries = []
    for await (const { value } of runtime.userBase.view.createReadStream({
      gte: 'languages/',
      lte: 'languages/\xff'
    })) {
      entries.push(JSON.parse(value))
    }
    return entries
  }

  async function sendProfile() {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    const device = await runtime.userBase.view.get(
      `devices/${runtime.keyId(runtime.userBase.local.key)}`
    )
    if (!device || JSON.parse(device.value).active !== true) return
    const entry = await runtime.userBase.view.get(runtime.profileKey)
    const profile = entry
      ? JSON.parse(entry.value)
      : { nickname: '', avatar: null, languageAvatar: null }
    runtime.pipe.write(JSON.stringify({ type: 'profile', data: profile }))
  }

  async function saveProfile(data) {
    const nickname = String(data.nickname || '').trim()
    if (!nickname) throw new Error('Nickname is required')
    if (nickname.length > 40) throw new Error('Nickname must be 40 characters or fewer')

    let avatar = null
    if (data.avatar) {
      const { data: encoded, mime } = data.avatar
      if (!runtime.supportedAvatarTypes.has(mime)) {
        throw new Error('Avatar must be a PNG, JPEG, WebP, or GIF image')
      }
      avatar = { data: encoded, mime }
      if (!runtime.isValidAvatar(avatar, runtime.maxUserAvatarBytes)) {
        throw new Error('Avatar must be a valid image of 2 MiB or smaller')
      }
    }

    let languageAvatar = null
    if (data.languageAvatar) {
      languageAvatar = data.languageAvatar
      if (!runtime.isValidAvatar(languageAvatar, runtime.maxLanguageAvatarBytes)) {
        throw new Error('Language avatar must be a valid image of 80 KiB or smaller')
      }
    }
    if (languageAvatar && !avatar) {
      throw new Error('A full-size profile avatar is required for a language avatar')
    }
    if (avatar && !languageAvatar) {
      throw new Error('A compressed language avatar is required when an avatar is set')
    }

    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    await enqueueUser(async () => {
      await runtime.userBase.append(
        runtime.encodePayload({
          type: 'user-profile',
          profile: { nickname, avatar, languageAvatar }
        }),
        { optimistic: true }
      )
      await runtime.userBase.update()
      await sendProfile()
    })
    await runtime.refreshLanguageMemberProfiles(nickname, languageAvatar)
  }

  async function addLanguageToUserRegistry(language) {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    const metadata = { key: language.key }
    if (language.storageFolder && language.storageFolder !== language.key) {
      metadata.storageFolder = language.storageFolder
    }
    for (const field of ['name', 'description', 'creator']) {
      if (typeof language[field] === 'string') metadata[field] = language[field]
    }
    await enqueueUser(async () => {
      const entry = await runtime.userBase.view.get(`languages/${metadata.key}`)
      const current = entry ? JSON.parse(entry.value) : {}
      const next = { ...current, ...metadata }
      if (JSON.stringify(current) === JSON.stringify(next)) return
      await runtime.userBase.append(
        runtime.encodePayload({ type: 'user-language-add', language: next }),
        {
          optimistic: true
        }
      )
      await runtime.userBase.update()
    })
  }

  async function initializeUserBase() {
    await runtime.registryStore.ready()
    await runtime.localStateView.ready()
    await runtime.userStore.ready()
    const keyEntry = await runtime.localStateView.get('user/base')
    const bootstrap = keyEntry?.value
    if (bootstrap && !/^[0-9a-f]{64}$/i.test(bootstrap)) {
      throw new Error('Stored user Autobase key is invalid')
    }
    const storageEntry = await runtime.localStateView.get('user/base-storage')
    if (storageEntry && storageEntry.value !== bootstrap) {
      throw new Error('Stored user Autobase storage key does not match its base key')
    }
    const pairedStorage = Boolean(storageEntry)
    if (runtime.userBaseStore !== runtime.userStore) await runtime.userBaseStore.close()
    runtime.userBaseStore =
      bootstrap && pairedStorage
        ? new runtime.Corestore(runtime.path.join(runtime.userBaseDirectory, bootstrap))
        : runtime.userStore
    await runtime.userBaseStore.ready()

    const deviceKeyPair = await runtime.userStore.createKeyPair('user-device')
    const openBase = (store) =>
      new runtime.Autobase(store, bootstrap ? runtime.b4a.from(bootstrap, 'hex') : null, {
        optimistic: true,
        apply: userApply,
        open: userOpen,
        keyPair: deviceKeyPair
      })
    runtime.userBase = openBase(runtime.userBaseStore)
    await runtime.userBase.ready()

    if (!bootstrap) {
      await runtime.localStateView.put('user/base', runtime.keyId(runtime.userBase.key))
    }

    if (!bootstrap && !(await runtime.userBase.view.get('user/initialized'))) {
      await runtime.userBase.append(
        runtime.encodePayload({
          type: 'user-init',
          signerKey: runtime.keyId(deviceKeyPair.publicKey)
        }),
        { optimistic: true }
      )
      await runtime.userBase.update()
    }

    for (const connection of runtime.connections) runtime.userBase.replicate(connection)
    runtime.swarm.join(runtime.userBase.discoveryKey, { client: true, server: true })
    runtime.userBase.on('update', () => {
      runtime.refreshUserState().catch(runtime.sendError)
    })
  }

  function syncUserLanguages() {
    const next = runtime.userSyncQueue.then(syncUserLanguagesUnlocked)
    runtime.userSyncQueue = next.catch(runtime.sendError)
    return runtime.userSyncQueue
  }

  async function syncUserLanguagesUnlocked() {
    const ownDevice = await runtime.userBase.view.get(
      `devices/${runtime.keyId(runtime.userBase.local.key)}`
    )
    if (!ownDevice || JSON.parse(ownDevice.value).active !== true) return
    for (const metadata of await readUserLanguages()) {
      if (!/^[0-9a-f]{64}$/i.test(metadata.key || '')) {
        console.log('skipping language: ', JSON.stringify(metadata))
        continue
      }
      const existing = [...runtime.languages.values()].find(
        (language) => language.key === metadata.key
      )
      if (existing) {
        for (const field of ['name', 'description', 'creator']) {
          if (typeof metadata[field] === 'string') existing[field] = metadata[field]
        }
        continue
      }
      const context = await runtime.openLanguage(metadata, runtime.b4a.from(metadata.key, 'hex'))
      if (!runtime.activeLanguageId) runtime.activeLanguageId = context.id
    }
    runtime.sendLanguages()
  }

  function handleProfile(operation) {
    if (operation.cmd === 'get') return sendProfile()
    if (operation.cmd === 'save') return saveProfile(operation)
    throw new Error('Unknown profile command')
  }

  return {
    userOpen,
    userApply,
    enqueueUser,
    getAccountSigningKeyPair,
    ensureAccountSigningKeyPair,
    readUserLanguages,
    sendProfile,
    saveProfile,
    addLanguageToUserRegistry,
    initializeUserBase,
    syncUserLanguages,
    syncUserLanguagesUnlocked,
    handleProfile
  }
}
