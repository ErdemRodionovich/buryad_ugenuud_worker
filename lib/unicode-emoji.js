const emojiGroups = require('unicode-emoji-json/data-by-group.json')
const emojiComponents = require('unicode-emoji-json/data-emoji-components.json')

const skinTones = Object.entries(emojiComponents)
  .filter(([name]) => name.endsWith('_skin_tone'))
  .map(([, emoji]) => emoji)
const skinToneBases = new Set(
  emojiGroups
    .flatMap((group) => group.emojis)
    .filter(({ emoji, skin_tone_support }) => skin_tone_support && [...emoji].length === 1)
    .map(({ emoji }) => emoji)
)
const supportedEmojis = new Set()

function addSkinToneVariants(characters, index, value) {
  if (index === characters.length) {
    supportedEmojis.add(value)
    return
  }

  const character = characters[index]
  addSkinToneVariants(characters, index + 1, value + character)
  if (skinToneBases.has(character)) {
    for (const tone of skinTones) {
      addSkinToneVariants(characters, index + 1, value + character + tone)
    }
  }
}

for (const { emojis } of emojiGroups) {
  for (const { emoji, skin_tone_support } of emojis) {
    supportedEmojis.add(emoji)
    if (skin_tone_support) {
      addSkinToneVariants([...emoji], 0, '')
    }
  }
}

module.exports = function isUnicodeEmoji(value) {
  return typeof value === 'string' && supportedEmojis.has(value)
}
