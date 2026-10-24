module.exports = function createTranslationsModule(runtime) {
  async function handleTranslation(translation) {
    const context = runtime.languages.get(translation.languageId)
    if (!context) return runtime.sendError(new Error('Select or join a language first'))
    return runtime.enqueueLanguage(context, () => handleTranslationUnlocked(context, translation))
  }

  async function handleTranslationUnlocked(context, translation) {
    if (translation.cmd === 'save') {
      return await saveTranslationUnlocked(context, translation)
    } else if (translation.cmd === 'get-for-edit') {
      return await getTranslationForEditUnlocked(context, translation)
    } else if (translation.cmd === 'remove') {
      return await removeTranslationUnlocked(context, translation)
    }
  }

  async function saveTranslationUnlocked(context, translation) {
    const translations = translation.translations.map(({ translation, description, media }) => {
      return { translation, description, media: runtime.normalizeMediaList(media) }
    })

    if (translation.translationID === '' || !translation.translationID) {
      translation.translationID = guid()
    }

    try {
      const { base } = context
      await base.ready()
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const actor = accountKeyPair.publicKey.toLowerCase()
      if (
        !(await runtime.hasLanguageRole(context, actor, 'administrator')) &&
        !(await runtime.hasLanguageRole(context, actor, 'word-creator'))
      ) {
        throw new Error('Only a language word creator or administrator can save translations')
      }
      const author = runtime.keyId(base.local.key)

      const saveOperation = runtime.signedLanguageDataOperation(
        'save-translation',
        {
          translationID: translation.translationID,
          translations,
          author
        },
        accountKeyPair
      )
      await base.append(runtime.encodePayload(saveOperation), { optimistic: true })

      const linkOperation = runtime.signedLanguageDataOperation(
        'link-translation',
        {
          translationID: translation.translationID,
          words: translation.wordsForTranslation,
          language: translation.languageOfWordForTranslation
        },
        accountKeyPair
      )
      await base.append(runtime.encodePayload(linkOperation), { optimistic: true })

      await base.update()
    } catch (error) {
      runtime.sendError(error)
    }
  }

  function guid() {
    const bytes = runtime.crypto.randomBytes(16)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  async function getTranslationForEditUnlocked(context, translation) {
    try {
      const { base } = context
      const entry = await base.view.get(`translations/${translation.translationID}`)
      if (entry) {
        const translationData = JSON.parse(entry.value)
        const wordsEntry = await base.view.get(`translations-to-words/${translation.translationID}`)
        if (wordsEntry) {
          const words = JSON.parse(wordsEntry.value)
          let language = null
          for (const word of words) {
            const idsReadStream = base.view.createReadStream({
              gte: `words/${word}`,
              lte: `words/${word}/\xff`
            })
            for await (const { key, value } of idsReadStream) {
              const ids = JSON.parse(value)
              if (ids.includes(translation.translationID)) {
                language = key.slice(key.lastIndexOf('/') + 1)
                break
              }
            }
            if (language) {
              break
            }
          }

          runtime.pipe.write(
            JSON.stringify({
              type: 'translation-for-edit',
              data: {
                translationID: translation.translationID,
                translations: translationData.translations,
                languageID: context.id,
                languageOfWordForTranslation: language,
                wordsForTranslation: words
              }
            })
          )
        }
      }
    } catch (error) {
      runtime.sendError(error)
    }
  }

  async function removeTranslationUnlocked(context, translation) {
    try {
      const { base } = context
      const accountKeyPair = await runtime.ensureAccountSigningKeyPair()
      const actor = accountKeyPair.publicKey.toLowerCase()
      if (
        !(await runtime.hasLanguageRole(context, actor, 'administrator')) &&
        !(await runtime.hasLanguageRole(context, actor, 'word-creator'))
      ) {
        throw new Error('Only a language word creator or administrator can remove translations')
      }
      const linkOperation = runtime.signedLanguageDataOperation(
        'link-translation',
        {
          translationID: translation.translationID,
          words: [],
          language: translation.languageOfWordForTranslation
        },
        accountKeyPair
      )
      await base.append(runtime.encodePayload(linkOperation), { optimistic: true })
      const removeOperation = runtime.signedLanguageDataOperation(
        'remove-translation',
        {
          translationID: translation.translationID
        },
        accountKeyPair
      )
      await base.append(runtime.encodePayload(removeOperation), { optimistic: true })
      await base.update()
    } catch (error) {
      runtime.sendError(error)
    }
  }

  async function handleSearch(search) {
    const context = runtime.languages.get(search.activeLanguageId)
    return runtime.enqueueLanguage(context, () => handleSearchUnlocked(context, search))
  }

  async function handleSearchUnlocked(context, search) {
    try {
      const wordsStream = context.base.view.createReadStream({
        gte: `words/${search.word}`,
        lte: `words/${search.word}/\xff`
      })

      const results = []
      for await (const { key, value } of wordsStream) {
        const ids = JSON.parse(value)
        const language = key.slice(key.lastIndexOf('/') + 1)
        for (const id of ids) {
          const entry = await context.base.view.get(`translations/${id}`)
          if (entry) {
            const translation = JSON.parse(entry.value)
            for (const trans of translation.translations) {
              results.push({
                translationID: translation.translationID,
                translation: trans.translation,
                description: trans.description,
                media: trans.media,
                language
              })
            }
          }
        }
      }

      runtime.pipe.write(
        JSON.stringify({ type: 'found-translations', languageId: context.id, data: results })
      )

      console.log('sent ', results.length, ' translations: ', JSON.stringify(results))
    } catch (error) {
      runtime.sendError(error)
    }
  }

  return {
    handleTranslation,
    handleTranslationUnlocked,
    saveTranslationUnlocked,
    guid,
    getTranslationForEditUnlocked,
    removeTranslationUnlocked,
    handleSearch,
    handleSearchUnlocked
  }
}
