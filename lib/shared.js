module.exports = function createSharedModule(runtime) {
  function encodePayload(data) {
    if (data === undefined || data === null) {
      throw new Error('Cannot encode null or undefined payload')
    }

    // Convert object to JSON string, then to binary buffer
    const jsonString = JSON.stringify(data)
    return runtime.b4a.from(jsonString, 'utf-8')
  }

  function decodePayload(buffer) {
    if (!buffer || buffer.byteLength === 0) return null

    try {
      const jsonString = runtime.b4a.toString(buffer, 'utf-8')
      return JSON.parse(jsonString)
    } catch (err) {
      console.error('Failed to decode block node:', err.message)
      return null // Return null to safely ignore malformed nodes without crashing Autobase
    }
  }

  function keyId(key) {
    return runtime.b4a.toString(key, 'hex')
  }

  function isValidAccountSigningKeyPair(keyPair) {
    if (
      !keyPair ||
      !/^[0-9a-f]{64}$/i.test(keyPair.publicKey || '') ||
      !/^[0-9a-f]{128}$/i.test(keyPair.secretKey || '')
    ) {
      return false
    }
    const challenge = encodePayload({ type: 'account-signing-key-check' })
    return runtime.crypto.verify(
      challenge,
      runtime.crypto.sign(challenge, runtime.b4a.from(keyPair.secretKey, 'hex')),
      runtime.b4a.from(keyPair.publicKey, 'hex')
    )
  }

  function pollCreationPayload(poll) {
    const payload = {
      type: 'create-poll',
      pollId: poll.id,
      creator: poll.creator,
      question: poll.question,
      questionMedia: poll.questionMedia,
      options: poll.options,
      createdAt: poll.createdAt
    }
    if (poll.kind) payload.kind = poll.kind
    if (poll.translationDetails) payload.translationDetails = poll.translationDetails
    return payload
  }

  function pollClosePayload(pollId, creator) {
    return { type: 'close-poll', pollId, creator }
  }

  const languageRoles = new Set([
    'administrator',
    'vote-closer',
    'word-creator',
    'banned-create-vote',
    'banned-comment'
  ])

  function languageRoleKey(accountKey, role) {
    return `roles/${accountKey}/${role}`
  }

  function languageRolePayload(operation) {
    return {
      type: 'set-language-role',
      actor: operation.actor,
      target: operation.target,
      role: operation.role,
      enabled: operation.enabled
    }
  }

  function languageMetaPayload(metadata) {
    return {
      type: 'language-meta',
      name: metadata.name,
      description: metadata.description,
      creator: metadata.creator,
      ownerAccountKey: metadata.ownerAccountKey
    }
  }

  function languageMemberPayload(member) {
    return {
      type: 'language-member',
      accountKey: member.accountKey,
      nickname: member.nickname,
      avatar: member.avatar,
      joinedAt: member.joinedAt
    }
  }

  function verifyAccountSignature(payload, actor, signature) {
    return (
      /^[0-9a-f]{64}$/i.test(actor || '') &&
      /^[0-9a-f]{128}$/i.test(signature || '') &&
      runtime.crypto.verify(
        encodePayload(payload),
        runtime.b4a.from(signature, 'hex'),
        runtime.b4a.from(actor, 'hex')
      )
    )
  }

  function signedLanguageDataOperation(type, data, keyPair) {
    const actor = keyId(runtime.b4a.from(keyPair.publicKey, 'hex'))
    const payload = { type, data, actor }
    return {
      ...payload,
      signature: keyId(
        runtime.crypto.sign(encodePayload(payload), runtime.b4a.from(keyPair.secretKey, 'hex'))
      )
    }
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
    runtime.pipe.write(JSON.stringify({ type: 'error', data: error.message || String(error) }))
  }

  function isValidAvatar(avatar, maxBytes) {
    return (
      avatar === null ||
      Boolean(
        avatar &&
        runtime.supportedAvatarTypes.has(avatar.mime) &&
        typeof avatar.data === 'string' &&
        avatar.data.length > 0 &&
        avatar.data.length <= Math.ceil((maxBytes * 4) / 3) + 4 &&
        avatar.data.length % 4 === 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(avatar.data) &&
        runtime.b4a.from(avatar.data, 'base64').byteLength <= maxBytes
      )
    )
  }

  return {
    encodePayload,
    decodePayload,
    keyId,
    isValidAccountSigningKeyPair,
    pollCreationPayload,
    pollClosePayload,
    languageRoles,
    languageRoleKey,
    languageRolePayload,
    languageMetaPayload,
    languageMemberPayload,
    verifyAccountSignature,
    signedLanguageDataOperation,
    enqueueLanguage,
    sendError,
    isValidAvatar
  }
}
