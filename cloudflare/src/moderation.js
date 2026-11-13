import blockedWordsText from './blocked-words.txt';

// Port of QuestionModeration.java. Spaced-letter matching applies only to words of
// at least four letters to reduce collisions with short variables and abbreviations.
const BETWEEN_LETTERS = '[\\p{P}\\p{S}\\p{Cf}]*';
const BETWEEN_SPACED_LETTERS = '[\\p{P}\\p{S}\\p{Cf}\\p{Z}\\s]*';
const SUBSTITUTIONS = { a: '[a4@]', e: '[e3]', i: '[i1!|]', o: '[o0]', s: '[s5$]', t: '[t7+]' };

function normalize(text) {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '');
}

function wordPattern(word) {
  const letters = [...normalize(word)];
  const separator = letters.length >= 4 ? BETWEEN_SPACED_LETTERS : BETWEEN_LETTERS;
  const body = letters
    .map(letter => SUBSTITUTIONS[letter] ?? letter.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&'))
    .join(separator);
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u');
}

const blockedWords = blockedWordsText
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
  .map(wordPattern);
if (!blockedWords.length) throw new Error('Question moderation rules are empty.');

export function blocks(text) {
  const normalized = normalize(text);
  return blockedWords.some(pattern => pattern.test(normalized));
}
