/*
 * Airlines whose mark is simply their name, drawn as type rather than picture.
 *
 * A wordmark reduced to a 28px tile gets about four pixels a letter, and no
 * amount of source resolution fixes that: jetBlue came out an unreadable blue
 * smear whichever artwork it was reduced from. Set in type it stays sharp, and
 * on an LED sign that is what the real thing would do anyway.
 *
 * The panel's own glcdfont is no use here, being fixed at 6 columns a
 * character: "jetBlue" would need 42 columns and has 28, so it breaks across
 * two lines and stops looking like the mark. Hence the narrow proportional face
 * below - 2 to 4 columns a glyph - which fits it on one line with a column to
 * spare.
 *
 * The face is grown one carrier at a time, so it holds only the letters the
 * entries above actually use. A wordmark naming a character with no glyph is
 * skipped entirely and the carrier falls back to its artwork, rather than
 * rendering a name with a hole in it.
 */
const WORDMARKS = {
  JBU: 'jetBlue',
};

/*
 * Rows 0-6 are cap and ascender height, 2-6 the x-height band, 7-8 descenders.
 * Written as pictures so the letterforms can be read and edited by eye; the
 * column count of each glyph is its advance width.
 */
const WORDMARK_ROWS = 9;

const WORDMARK_FONT = {
  j: ['-#',
      '--',
      '-#',
      '-#',
      '-#',
      '-#',
      '-#',
      '-#',
      '#-'],

  e: ['----',
      '----',
      '-##-',
      '#--#',
      '####',
      '#---',
      '-##-',
      '----',
      '----'],

  t: ['#-',
      '#-',
      '##',
      '#-',
      '#-',
      '#-',
      '-#',
      '--',
      '--'],

  B: ['###-',
      '#--#',
      '#--#',
      '###-',
      '#--#',
      '#--#',
      '###-',
      '----',
      '----'],

  l: ['#',
      '#',
      '#',
      '#',
      '#',
      '#',
      '#',
      '-',
      '-'],

  u: ['----',
      '----',
      '#--#',
      '#--#',
      '#--#',
      '#--#',
      '-###',
      '----',
      '----'],
};
