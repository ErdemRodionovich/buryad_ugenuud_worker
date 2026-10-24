module.exports = function createLanguageAdminModule(runtime) {
  async function applyLanguageAdminOperation(view, op, author) {
    if (op.type === 'language-member') {
      const member = op.member
      const avatar = member?.avatar
      const validAvatar =
        avatar === null ||
        (avatar &&
          runtime.supportedAvatarTypes.has(avatar.mime) &&
          typeof avatar.data === 'string' &&
          avatar.data.length > 0 &&
          avatar.data.length <= Math.ceil((runtime.maxLanguageAvatarBytes * 4) / 3) + 4 &&
          avatar.data.length % 4 === 0 &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(avatar.data) &&
          runtime.b4a.from(avatar.data, 'base64').byteLength <= runtime.maxLanguageAvatarBytes)
      if (
        !member ||
        !/^[0-9a-f]{64}$/i.test(member.accountKey || '') ||
        typeof member.nickname !== 'string' ||
        !member.nickname.trim() ||
        member.nickname.length > 40 ||
        !validAvatar ||
        !Number.isSafeInteger(member.joinedAt) ||
        !runtime.verifyAccountSignature(
          runtime.languageMemberPayload(member),
          member.accountKey,
          op.signature
        )
      ) {
        return true
      }
      const accountKey = member.accountKey.toLowerCase()
      await view.put(`members/${accountKey}`, JSON.stringify({ ...member, accountKey }))
      return true
    }

    if (op.type === 'set-language-role') {
      if (
        !/^[0-9a-f]{64}$/i.test(op.target || '') ||
        !runtime.languageRoles.has(op.role) ||
        typeof op.enabled !== 'boolean' ||
        !runtime.verifyAccountSignature(runtime.languageRolePayload(op), op.actor, op.signature)
      ) {
        return true
      }
      const metaEntry = await view.get('language/meta')
      const meta = metaEntry ? JSON.parse(metaEntry.value) : null
      const actorIsAdmin =
        (await view.get(runtime.languageRoleKey(op.actor, 'administrator'))) !== null ||
        meta?.ownerAccountKey === op.actor ||
        (!meta?.ownerAccountKey && meta?.creator === author)
      if (!actorIsAdmin) return true
      if (meta?.ownerAccountKey === op.target && op.role === 'administrator' && !op.enabled) {
        return true
      }
      const key = runtime.languageRoleKey(op.target.toLowerCase(), op.role)
      if (op.enabled) await view.put(key, 'true')
      else await view.del(key)
      return true
    }

    if (op.type === 'save-translation-api-details') {
      const metaEntry = await view.get('language/meta')
      const meta = metaEntry ? JSON.parse(metaEntry.value) : null
      if (
        runtime.verifyAccountSignature(
          { type: op.type, data: op.data, actor: op.actor },
          op.actor,
          op.signature
        ) &&
        ((await view.get(runtime.languageRoleKey(op.actor, 'administrator'))) !== null ||
          meta?.ownerAccountKey === op.actor ||
          (!meta?.ownerAccountKey && meta?.creator === author))
      ) {
        await view.put('language/translation_api_details', JSON.stringify(op.data))
      }
      return true
    }

    return false
  }

  async function hasLanguageRole(context, accountKey, role) {
    if (!accountKey) return false
    const meta = await runtime.metaOfLanguage(context)
    if (role === 'administrator') {
      return Boolean(
        (await context.base.view.get(runtime.languageRoleKey(accountKey, role))) ||
        meta?.ownerAccountKey === accountKey ||
        (!meta?.ownerAccountKey && meta?.creator === runtime.keyId(context.base.local.key))
      )
    }
    return (await context.base.view.get(runtime.languageRoleKey(accountKey, role))) !== null
  }

  function sendLanguageRoles(context) {
    return runtime.enqueueLanguage(context, () => sendLanguageRolesUnlocked(context))
  }

  async function sendLanguageRolesUnlocked(context) {
    await context.base.ready()
    const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
    const accountKey = accountKeyPair?.publicKey.toLowerCase() || null
    const rolesByUser = new Map()
    for await (const { key } of context.base.view.createReadStream({
      gte: 'roles/',
      lte: 'roles/\xff'
    })) {
      const [, userKey, role] = key.split('/')
      if (!rolesByUser.has(userKey)) rolesByUser.set(userKey, [])
      rolesByUser.get(userKey).push(role)
    }
    const meta = await runtime.metaOfLanguage(context)
    if (meta?.ownerAccountKey) {
      const ownerRoles = rolesByUser.get(meta.ownerAccountKey) || []
      if (!ownerRoles.includes('administrator')) ownerRoles.push('administrator')
      rolesByUser.set(meta.ownerAccountKey, ownerRoles)
    } else if (meta?.creator === runtime.keyId(context.base.local.key) && accountKey) {
      const legacyOwnerRoles = rolesByUser.get(accountKey) || []
      if (!legacyOwnerRoles.includes('administrator')) legacyOwnerRoles.push('administrator')
      rolesByUser.set(accountKey, legacyOwnerRoles)
    }
    runtime.pipe.write(
      JSON.stringify({
        type: 'language-roles',
        languageId: context.id,
        accountKey,
        roles: [...rolesByUser].map(([userKey, userRoles]) => ({ userKey, roles: userRoles }))
      })
    )
  }

  async function registerLanguageMember(context) {
    await context.base.ready()
    if (runtime.userBaseReady) await runtime.userBaseReady
    if (!runtime.userBase) throw new Error('User profile is not ready')
    const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
    const accountKey = accountKeyPair.publicKey.toLowerCase()
    if (await context.base.view.get(`members/${accountKey}`)) return

    const profileEntry = await runtime.userBase.view.get(runtime.profileKey)
    const profile = profileEntry
      ? JSON.parse(profileEntry.value)
      : { nickname: '', avatar: null, languageAvatar: null }
    const nickname = String(profile.nickname || '').trim()
    if (!nickname) throw new Error('Set a nickname before joining a language')
    const avatar = profile.languageAvatar || null
    if (!runtime.isValidAvatar(avatar, runtime.maxLanguageAvatarBytes)) {
      throw new Error('Save your profile again to create a language avatar of 80 KiB or smaller')
    }

    await writeLanguageMember(context, accountKeyPair, {
      accountKey,
      nickname,
      avatar,
      joinedAt: Date.now()
    })
  }

  async function writeLanguageMember(context, accountKeyPair, member) {
    const accountKey = accountKeyPair.publicKey.toLowerCase()
    const payload = runtime.languageMemberPayload(member)
    await context.base.append(
      runtime.encodePayload({
        type: 'language-member',
        member,
        signature: runtime.keyId(
          runtime.crypto.sign(
            runtime.encodePayload(payload),
            runtime.b4a.from(accountKeyPair.secretKey, 'hex')
          )
        )
      }),
      { optimistic: true }
    )
    await context.base.update()
    if (!(await context.base.view.get(`members/${accountKey}`))) {
      throw new Error('Language membership was rejected by the language database')
    }
  }

  async function refreshLanguageMemberProfiles(nickname, avatar) {
    if (runtime.languages.size === 0) return
    const accountKeyPair = await runtime.getAccountSigningKeyPair()
    if (!accountKeyPair) return
    const accountKey = accountKeyPair.publicKey.toLowerCase()

    for (const context of runtime.languages.values()) {
      await runtime.enqueueLanguage(context, async () => {
        const entry = await context.base.view.get(`members/${accountKey}`)
        if (!entry) return
        const current = JSON.parse(entry.value)
        await writeLanguageMember(context, accountKeyPair, {
          accountKey,
          nickname,
          avatar,
          joinedAt: current.joinedAt
        })
      })
    }
  }

  function sendLanguageMembers(context) {
    return runtime.enqueueLanguage(context, async () => {
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const accountKey = accountKeyPair.publicKey.toLowerCase()
      if (!(await hasLanguageRole(context, accountKey, 'administrator'))) {
        throw new Error('Only a language administrator can view joined users')
      }
      await sendLanguageMembersUnlocked(context)
    })
  }

  async function sendLanguageMembersUnlocked(context) {
    await context.base.ready()
    const members = []
    for await (const { value } of context.base.view.createReadStream({
      gte: 'members/',
      lte: 'members/\xff'
    })) {
      members.push(JSON.parse(value))
    }
    runtime.pipe.write(
      JSON.stringify({ type: 'language-members', languageId: context.id, members })
    )
  }

  function setLanguageRole(operation) {
    const context = runtime.languages.get(operation.languageId || runtime.activeLanguageId)
    if (!context) throw new Error('Select or join a language first')
    const target = String(operation.target || '')
      .trim()
      .toLowerCase()
    const role = operation.role
    if (!/^[0-9a-f]{64}$/.test(target)) {
      throw new Error('Account key must be 64 hexadecimal characters')
    }
    if (!runtime.languageRoles.has(role)) throw new Error('Choose a valid language role')
    if (typeof operation.enabled !== 'boolean') throw new Error('Role enabled state is required')
    return runtime.enqueueLanguage(context, async () => {
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const actor = accountKeyPair.publicKey.toLowerCase()
      if (!(await hasLanguageRole(context, actor, 'administrator'))) {
        throw new Error('Only a language administrator can assign roles')
      }
      const roleData = {
        type: 'set-language-role',
        actor,
        target,
        role,
        enabled: operation.enabled
      }
      await context.base.append(
        runtime.encodePayload({
          ...roleData,
          signature: runtime.keyId(
            runtime.crypto.sign(
              runtime.encodePayload(runtime.languageRolePayload(roleData)),
              runtime.b4a.from(accountKeyPair.secretKey, 'hex')
            )
          )
        }),
        { optimistic: true }
      )
      await context.base.update()
      const assigned = (await context.base.view.get(runtime.languageRoleKey(target, role))) !== null
      if (assigned !== operation.enabled) {
        throw new Error('Role assignment was rejected by the language database')
      }
      await sendLanguageRolesUnlocked(context)
    })
  }

  function saveTranslationAPI_Details(details) {
    const context = runtime.languages.get(details.languageId || runtime.activeLanguageId)
    if (!context) return runtime.sendError(new Error('Select or join a language first'))
    return runtime.enqueueLanguage(context, () =>
      saveTranslationAPI_DetailsUnlocked(details, context)
    )
  }

  async function saveTranslationAPI_DetailsUnlocked(details, context) {
    try {
      const { base } = context
      const { yKey, yFolderID, gKey, gProjectID } = details
      await base.ready()
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const actor = accountKeyPair.publicKey.toLowerCase()
      if (!(await hasLanguageRole(context, actor, 'administrator'))) {
        throw new Error('Only a language administrator can save translation API details')
      }
      const operation = {
        type: 'save-translation-api-details',
        actor,
        data: { yKey, yFolderID, gKey, gProjectID }
      }
      await base.append(
        runtime.encodePayload({
          ...operation,
          signature: runtime.keyId(
            runtime.crypto.sign(
              runtime.encodePayload({ type: operation.type, data: operation.data, actor }),
              runtime.b4a.from(accountKeyPair.secretKey, 'hex')
            )
          )
        }),
        { optimistic: true }
      )
      await base.update()
    } catch (error) {
      runtime.sendError(error)
    }
  }

  async function sendTranslationAPI_Details(context) {
    return runtime.enqueueLanguage(context, () => sendTranslationAPI_DetailsUnlocked(context))
  }

  async function sendTranslationAPI_DetailsUnlocked(context) {
    await context.base.ready()
    const detailsEntry = await context.base.view.get('language/translation_api_details')
    if (detailsEntry) {
      const details = JSON.parse(detailsEntry.value)
      runtime.pipe.write(
        JSON.stringify({
          type: 'translation-api-details',
          data: {
            ...details,
            languageId: context.id
          }
        })
      )
    }
  }

  return {
    applyLanguageAdminOperation,
    hasLanguageRole,
    sendLanguageRoles,
    sendLanguageRolesUnlocked,
    registerLanguageMember,
    writeLanguageMember,
    refreshLanguageMemberProfiles,
    sendLanguageMembers,
    sendLanguageMembersUnlocked,
    setLanguageRole,
    saveTranslationAPI_Details,
    saveTranslationAPI_DetailsUnlocked,
    sendTranslationAPI_Details,
    sendTranslationAPI_DetailsUnlocked
  }
}
