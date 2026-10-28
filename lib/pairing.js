module.exports = function createPairingModule(runtime) {
  function pairingRequestPayload(request) {
    const payload = {
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
    return payload
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
      request.app === runtime.pairingCodeApp &&
      request.version === runtime.pairingCodeVersion &&
      request.type === 'request' &&
      /^[0-9a-f]{64}$/i.test(request.deviceKey || '') &&
      /^[0-9a-f]{64}$/i.test(request.signerKey || '') &&
      /^[0-9a-f]{64}$/i.test(request.pairingSecretHash || '') &&
      (request.deviceName === undefined ||
        (typeof request.deviceName === 'string' &&
          request.deviceName.length > 0 &&
          request.deviceName.length <= 100)) &&
      (request.devicePlatform === undefined ||
        ['android', 'ios', 'ios-simulator', 'linux', 'darwin', 'win32'].includes(
          request.devicePlatform
        )) &&
      (request.pairingSecret === undefined ||
        (/^[0-9a-f]{64}$/i.test(request.pairingSecret) &&
          runtime.keyId(runtime.crypto.hash(runtime.b4a.from(request.pairingSecret, 'hex'))) ===
            request.pairingSecretHash)) &&
      /^[0-9a-f]{32}$/i.test(request.requestId || '') &&
      Number.isSafeInteger(request.createdAt) &&
      request.expiresAt === request.createdAt + runtime.pairingCodeTtl &&
      /^[0-9a-f]{128}$/i.test(request.signature || '')
    )
  }

  function verifyPairingRequest(request) {
    return runtime.crypto.verify(
      runtime.encodePayload(pairingRequestPayload(request)),
      runtime.b4a.from(request.signature, 'hex'),
      runtime.b4a.from(request.signerKey, 'hex')
    )
  }

  function isValidPairingApproval(approval) {
    return Boolean(
      approval &&
      approval.app === runtime.pairingCodeApp &&
      approval.version === runtime.pairingCodeVersion &&
      approval.type === 'approval' &&
      /^[0-9a-f]{64}$/i.test(approval.userKey || '') &&
      /^[0-9a-f]{64}$/i.test(approval.deviceKey || '') &&
      /^[0-9a-f]{32}$/i.test(approval.requestId || '') &&
      /^[0-9a-f]{64}$/i.test(approval.approvedBy || '') &&
      /^[0-9a-f]{64}$/i.test(approval.signerKey || '') &&
      Number.isSafeInteger(approval.issuedAt) &&
      approval.expiresAt === approval.issuedAt + runtime.pairingCodeTtl &&
      /^[0-9a-f]{128}$/i.test(approval.signature || '')
    )
  }

  function verifyPairingApproval(approval) {
    return runtime.crypto.verify(
      runtime.encodePayload(pairingApprovalPayload(approval)),
      runtime.b4a.from(approval.signature, 'hex'),
      runtime.b4a.from(approval.signerKey, 'hex')
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

  async function sendPairingStatus() {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) return
    const deviceKey = runtime.keyId(runtime.userBase.local.key)
    const entry = await runtime.userBase.view.get(`devices/${deviceKey}`)
    const device = entry ? JSON.parse(entry.value) : null
    const pendingApproval = await runtime.localStateView.get('pairing/pending-approval')
    const devices = []
    for await (const { key, value } of runtime.userBase.view.createReadStream({
      gte: 'devices/',
      lte: 'devices/\xff'
    })) {
      devices.push({
        key: key.slice('devices/'.length),
        ...JSON.parse(value)
      })
    }
    runtime.pipe.write(
      JSON.stringify({
        type: 'pairing-status',
        data: {
          userKey: runtime.keyId(runtime.userBase.key),
          deviceKey,
          paired: device?.active === true,
          pending: Boolean(pendingApproval),
          devices
        }
      })
    )
  }

  async function createPairingRequest() {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    const deviceKeyPair = await runtime.userStore.createKeyPair('user-device')
    const createdAt = Date.now()
    const request = {
      app: runtime.pairingCodeApp,
      version: runtime.pairingCodeVersion,
      type: 'request',
      deviceKey: runtime.keyId(runtime.userBase.local.key),
      signerKey: runtime.keyId(deviceKeyPair.publicKey),
      deviceName: getDeviceName(),
      devicePlatform: runtime.devicePlatform,
      pairingSecret: runtime.crypto.randomBytes(32).toString('hex'),
      requestId: runtime.crypto.randomBytes(16).toString('hex'),
      createdAt,
      expiresAt: createdAt + runtime.pairingCodeTtl
    }
    request.pairingSecretHash = runtime.keyId(
      runtime.crypto.hash(runtime.b4a.from(request.pairingSecret, 'hex'))
    )
    request.signature = runtime.b4a.toString(
      runtime.crypto.sign(
        runtime.encodePayload(pairingRequestPayload(request)),
        deviceKeyPair.secretKey
      ),
      'hex'
    )
    await runtime.localStateView.put('pairing/request', request)
    runtime.pipe.write(JSON.stringify({ type: 'pairing-request', data: JSON.stringify(request) }))
    await startPairingSession('requester', request)
  }

  function getDeviceName() {
    const hostname = runtime.os.hostname().trim().slice(0, 100)
    return hostname || runtime.devicePlatform || 'Device'
  }

  async function approvePairingRequest(data) {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    const request = parsePairingCode(data.code, 'request')
    const now = Date.now()
    if (request.createdAt > now || request.expiresAt <= now) {
      throw new Error('Pairing request has expired or has an invalid date')
    }
    const currentDevice = await runtime.userBase.view.get(
      `devices/${runtime.keyId(runtime.userBase.local.key)}`
    )
    if (!currentDevice || JSON.parse(currentDevice.value).active !== true) {
      throw new Error('Only a paired device can approve a pairing request')
    }
    if (request.deviceKey === runtime.keyId(runtime.userBase.local.key)) {
      throw new Error('This device is already paired')
    }
    const existingDeviceEntry = await runtime.userBase.view.get(`devices/${request.deviceKey}`)
    if (existingDeviceEntry && JSON.parse(existingDeviceEntry.value).active === true) {
      throw new Error('This device is already paired')
    }

    const approvedAt = Date.now()
    const approvedRequest = { ...request }
    delete approvedRequest.pairingSecret
    await runtime.enqueueUser(async () => {
      if (request.expiresAt <= Date.now()) {
        throw new Error('Pairing request expired before approval')
      }
      await runtime.userBase.append(
        runtime.encodePayload({ type: 'user-device-add', request: approvedRequest, approvedAt }),
        {
          optimistic: true
        }
      )
      await runtime.userBase.update()
    })

    const deviceKeyPair = await runtime.userStore.createKeyPair('user-device')
    const approval = {
      app: runtime.pairingCodeApp,
      version: runtime.pairingCodeVersion,
      type: 'approval',
      userKey: runtime.keyId(runtime.userBase.key),
      deviceKey: request.deviceKey,
      requestId: request.requestId,
      approvedBy: runtime.keyId(runtime.userBase.local.key),
      signerKey: runtime.keyId(deviceKeyPair.publicKey),
      issuedAt: approvedAt,
      expiresAt: approvedAt + runtime.pairingCodeTtl
    }
    approval.signature = runtime.b4a.toString(
      runtime.crypto.sign(
        runtime.encodePayload(pairingApprovalPayload(approval)),
        deviceKeyPair.secretKey
      ),
      'hex'
    )
    await runtime.localStateView.put(`pairing/approved/${request.requestId}`, { request, approval })
    runtime.pipe.write(JSON.stringify({ type: 'pairing-approval', data: JSON.stringify(approval) }))
    await startPairingSession('approver', request, approval)
    await sendPairingStatus()
  }

  function sendPairingConnectionStatus(requestId, status, role) {
    runtime.pipe.write(
      JSON.stringify({
        type: 'pairing-connection-status',
        data: { requestId, status, role }
      })
    )
  }

  function pairingTopic(request) {
    return runtime.crypto.hash(runtime.b4a.from(request.pairingSecret, 'hex'))
  }

  function pairingChallengePayload(requestId, challenge) {
    return {
      app: runtime.pairingCodeApp,
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
    if (runtime.pairingSessions.get(session.request.requestId) !== session) return
    runtime.pairingSessions.delete(session.request.requestId)
    clearTimeout(session.expirationTimer)
    if (status === 'expired') {
      if (session.role === 'requester') {
        await runtime.localStateView.del('pairing/request')
      } else {
        await runtime.localStateView.del(`pairing/approved/${session.request.requestId}`)
      }
    }
    if (status) sendPairingConnectionStatus(session.request.requestId, status, session.role)
    if (session.stream && !session.stream.destroyed) session.stream.destroy()
    await session.swarm.leave(session.topic)
    await session.swarm.destroy()
  }

  async function startPairingSession(role, request, approval = null) {
    const existing = runtime.pairingSessions.get(request.requestId)
    if (existing) await stopPairingSession(existing)
    const expiresAt = Math.min(request.expiresAt, approval?.expiresAt || request.expiresAt)
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      sendPairingConnectionStatus(request.requestId, 'expired', role)
      return
    }

    const swarm = new runtime.Hyperswarm()
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
    runtime.pairingSessions.set(request.requestId, session)
    session.expirationTimer = setTimeout(() => {
      stopPairingSession(session, 'expired').catch(runtime.sendError)
    }, remaining)
    swarm.on('error', (error) => {
      sendPairingConnectionStatus(request.requestId, 'error', role)
      runtime.sendError(error)
    })
    swarm.on('connection', (socket) => {
      if (runtime.pairingSessions.get(request.requestId) !== session || session.completed) {
        socket.destroy()
        return
      }
      if (session.stream) {
        socket.destroy()
        return
      }
      session.stream = new runtime.FramedStream(socket, { bits: 16 })
      session.stream.on('error', (error) => {
        if (!session.completed) {
          session.stream = null
          sendPairingConnectionStatus(request.requestId, 'waiting', role)
          runtime.sendError(error)
        }
      })
      session.stream.on('close', () => {
        session.stream = null
        session.challenge = null
        if (!session.completed && runtime.pairingSessions.get(request.requestId) === session) {
          sendPairingConnectionStatus(request.requestId, 'waiting', role)
        }
      })
      session.stream.on('data', (data) => {
        handlePairingTransportMessage(session, data).catch((error) => {
          sendPairingConnectionStatus(request.requestId, 'error', role)
          runtime.sendError(error)
          if (session.stream && !session.stream.destroyed) session.stream.destroy()
        })
      })
      sendPairingConnectionStatus(request.requestId, 'connected', role)
      if (role === 'requester') {
        writePairingMessage(session, {
          type: 'request',
          data: {
            ...pairingRequestPayload(request),
            deviceName: request.deviceName,
            devicePlatform: request.devicePlatform,
            pairingSecret: request.pairingSecret
          },
          signature: request.signature
        }).catch(runtime.sendError)
      }
    })

    swarm.join(session.topic, { client: true, server: true })
    sendPairingConnectionStatus(request.requestId, 'waiting', role)
  }

  async function handlePairingTransportMessage(session, bytes) {
    if (bytes.byteLength > 8192) throw new Error('Pairing message is too large')
    let message
    try {
      message = JSON.parse(runtime.b4a.toString(bytes, 'utf-8'))
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
        request.deviceName !== session.request.deviceName ||
        request.devicePlatform !== session.request.devicePlatform ||
        request.pairingSecret !== session.request.pairingSecret ||
        request.pairingSecretHash !== session.request.pairingSecretHash ||
        request.signature !== session.request.signature
      ) {
        throw new Error('Direct pairing request did not match the approved request')
      }
      if (session.request.expiresAt <= Date.now()) throw new Error('Pairing request has expired')
      if (session.challenge) throw new Error('Pairing request challenge is already active')
      session.challenge = runtime.crypto.randomBytes(32).toString('hex')
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
      runtime.crypto.verify(
        runtime.encodePayload(pairingChallengePayload(message.requestId, message.challenge)),
        runtime.b4a.from(message.signature, 'hex'),
        runtime.b4a.from(message.signerKey, 'hex')
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
      await runtime.localStateView.del(`pairing/approved/${session.request.requestId}`)
      return stopPairingSession(session, 'complete')
    }

    if (
      session.role === 'requester' &&
      message?.type === 'challenge' &&
      message.requestId === session.request.requestId &&
      /^[0-9a-f]{64}$/i.test(message.challenge || '')
    ) {
      const deviceKeyPair = await runtime.userStore.createKeyPair('user-device')
      if (runtime.keyId(deviceKeyPair.publicKey) !== session.request.signerKey) {
        throw new Error('This device signing key no longer matches the pairing request')
      }
      const signature = runtime.b4a.toString(
        runtime.crypto.sign(
          runtime.encodePayload(pairingChallengePayload(message.requestId, message.challenge)),
          deviceKeyPair.secretKey
        ),
        'hex'
      )
      await writePairingMessage(session, {
        type: 'proof',
        requestId: message.requestId,
        challenge: message.challenge,
        signerKey: runtime.keyId(deviceKeyPair.publicKey),
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
        await writePairingMessage(session, {
          type: 'complete',
          requestId: session.request.requestId
        })
      }
      return stopPairingSession(session, 'complete')
    }

    throw new Error('Unexpected message from pairing peer')
  }

  async function resumePairingSessions() {
    const requestEntry = await runtime.localStateView.get('pairing/request')
    const request = requestEntry?.value
    if (
      request &&
      isValidPairingRequest(request) &&
      verifyPairingRequest(request) &&
      request.expiresAt > Date.now()
    ) {
      runtime.pipe.write(JSON.stringify({ type: 'pairing-request', data: JSON.stringify(request) }))
      await startPairingSession('requester', request)
    } else if (request) {
      await runtime.localStateView.del('pairing/request')
    }

    for await (const { key, value } of runtime.localStateView.createReadStream({
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
        runtime.pipe.write(
          JSON.stringify({ type: 'pairing-approval', data: JSON.stringify(approval) })
        )
        await startPairingSession('approver', approvedRequest, approval)
      } else {
        await runtime.localStateView.del(key)
      }
    }
  }

  async function completePairing(data) {
    if (runtime.userBaseReady) await runtime.userBaseReady
    const approval = parsePairingCode(data.code, 'approval')
    const now = Date.now()
    if (approval.issuedAt > now || approval.expiresAt <= now) {
      throw new Error('Pairing approval has expired or has an invalid date')
    }
    const requestEntry = await runtime.localStateView.get('pairing/request')
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
    if (runtime.keyId(runtime.userBase.key) === approval.userKey) {
      const currentDevice = await runtime.userBase.view.get(
        `devices/${runtime.keyId(runtime.userBase.local.key)}`
      )
      if (currentDevice && JSON.parse(currentDevice.value).active === true) {
        throw new Error('This device is already using that user profile')
      }
    }

    await runtime.localStateView.put('pairing/pending-approval', approval)
    await runtime.swarm.leave(runtime.userBase.discoveryKey)
    await runtime.localStateView.put('user/base-storage', approval.userKey)
    await runtime.localStateView.put('user/base', approval.userKey)
    await runtime.userBase.close()
    if (runtime.userBaseStore === runtime.userStore) {
      runtime.userStore = new runtime.Corestore(runtime.userStoragePath)
      await runtime.userStore.ready()
    }
    runtime.userBase = null
    runtime.userBaseStore = runtime.userStore
    runtime.userBaseReady = runtime.initializeUserBase()
    await runtime.userBaseReady
    await refreshUserState()
  }

  async function refreshUserState() {
    if (runtime.deviceDataResetting) return
    if (!runtime.userBase) return
    const deviceKey = runtime.keyId(runtime.userBase.local.key)
    const deviceEntry = await runtime.userBase.view.get(`devices/${deviceKey}`)
    const device = deviceEntry ? JSON.parse(deviceEntry.value) : null
    if (device?.active !== true) {
      if (device?.active === false) {
        await clearRevokedDeviceData()
        return
      }
      await sendPairingStatus()
      return
    }

    await publishDeviceInfo(deviceKey)

    const pendingEntry = await runtime.localStateView.get('pairing/pending-approval')
    if (pendingEntry) {
      const approval = pendingEntry.value
      const approver = await runtime.userBase.view.get(`devices/${approval.approvedBy}`)
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
      await runtime.localStateView.del('pairing/pending-approval')
      await runtime.localStateView.del('pairing/request')
    }

    await runtime.syncUserLanguages()
    await runtime.sendProfile()
    await sendPairingStatus()
  }

  async function publishDeviceInfo(deviceKey) {
    const deviceName = getDeviceName()
    const devicePlatform = runtime.devicePlatform
    await runtime.enqueueUser(async () => {
      const currentEntry = await runtime.userBase.view.get(`devices/${deviceKey}`)
      if (!currentEntry || JSON.parse(currentEntry.value).active !== true) return
      const currentDevice = JSON.parse(currentEntry.value)
      if (
        currentDevice.deviceName === deviceName &&
        currentDevice.devicePlatform === devicePlatform
      ) {
        return
      }

      await runtime.userBase.append(
        runtime.encodePayload({
          type: 'user-device-info',
          deviceName,
          devicePlatform
        }),
        { optimistic: true }
      )
      await runtime.userBase.update()
    })
  }

  async function clearRevokedDeviceData() {
    if (runtime.deviceDataResetting) return
    runtime.deviceDataResetting = true

    for (const session of [...runtime.pairingSessions.values()]) {
      await runtime.stopPairingSession(session)
    }

    await runtime.swarm.destroy()
    if (runtime.userBase) await runtime.userBase.close()
    for (const context of runtime.languages.values()) {
      await context.base.close()
      await context.store.close()
    }
    runtime.languages.clear()
    if (runtime.userBaseStore !== runtime.userStore) await runtime.userBaseStore.close()
    await runtime.userStore.close()
    await runtime.localStateView.close()
    await runtime.registryStore.close()
    await runtime.fs.promises.rm(runtime.appStorageDirectory, { recursive: true })
    runtime.pipe.write(JSON.stringify({ type: 'device-data-reset' }))
  }

  async function revokePairedDevice(data) {
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User Autobase is not ready')
    if (!/^[0-9a-f]{64}$/i.test(data.deviceKey || '')) {
      throw new Error('Device key is invalid')
    }

    const deviceKey = data.deviceKey.toLowerCase()
    const localDeviceKey = runtime.keyId(runtime.userBase.local.key)
    if (deviceKey === localDeviceKey) {
      throw new Error('This device cannot revoke its own access')
    }

    await runtime.enqueueUser(async () => {
      const currentDevice = await runtime.userBase.view.get(`devices/${localDeviceKey}`)
      if (!currentDevice || JSON.parse(currentDevice.value).active !== true) {
        throw new Error('Only an authorized device can revoke access')
      }
      const targetDevice = await runtime.userBase.view.get(`devices/${deviceKey}`)
      if (!targetDevice || JSON.parse(targetDevice.value).active !== true) {
        throw new Error('This device is not currently authorized')
      }

      await runtime.userBase.append(
        runtime.encodePayload({
          type: 'user-device-revoke',
          deviceKey
        }),
        { optimistic: true }
      )
      await runtime.userBase.update()

      const revokedDevice = await runtime.userBase.view.get(`devices/${deviceKey}`)
      if (!revokedDevice || JSON.parse(revokedDevice.value).active === true) {
        throw new Error('Device access could not be revoked')
      }
    })
    await sendPairingStatus()
  }

  function handlePairing(operation) {
    if (operation.cmd === 'status') return sendPairingStatus()
    if (operation.cmd === 'create-request') return createPairingRequest()
    if (operation.cmd === 'approve') return approvePairingRequest(operation)
    if (operation.cmd === 'complete') return completePairing(operation)
    if (operation.cmd === 'revoke') return revokePairedDevice(operation)
    throw new Error('Unknown pairing command')
  }

  return {
    pairingRequestPayload,
    pairingApprovalPayload,
    isValidPairingRequest,
    verifyPairingRequest,
    isValidPairingApproval,
    verifyPairingApproval,
    parsePairingCode,
    sendPairingStatus,
    createPairingRequest,
    approvePairingRequest,
    revokePairedDevice,
    clearRevokedDeviceData,
    sendPairingConnectionStatus,
    pairingTopic,
    pairingChallengePayload,
    writePairingMessage,
    stopPairingSession,
    startPairingSession,
    handlePairingTransportMessage,
    resumePairingSessions,
    completePairing,
    refreshUserState,
    handlePairing
  }
}
