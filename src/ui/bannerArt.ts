/**
 * The Golden Snitch banner. The left wing is authored once and mirrored so
 * the art stays perfectly symmetric; animation frames go from wings wrapped
 * around the ball to full span via a center-out reveal.
 */

const MIRROR: Record<string, string> = {
  '/': '\\',
  '\\': '/',
  '(': ')',
  ')': '(',
  d: 'b',
  b: 'd',
  '`': "'",
  "'": '`',
  ',': '.',
  '.': ',',
};
const mirror = (line: string): string =>
  [...line]
    .reverse()
    .map((ch) => MIRROR[ch] ?? ch)
    .join('');

export const WING_COLS = 29;
export const BALL_COLS = 18;
export const BANNER_WIDTH = WING_COLS * 2 + BALL_COLS; // 76

const WING = [
  String.raw` ,g$$g,_`,
  String.raw` d$$$$$$$gg,_`,
  String.raw` '$$$$$$$$$$$$gg,_`,
  String.raw`  'Y$P''Y$$$$$$$$$$gg,_`,
  String.raw`    ''  ,g$g, 'Y$$$$$$$$g,_`,
  String.raw`        '$$$$g, 'Y$$$$$$$$$g`,
  String.raw`         'Y$$$$g, 'Y$$$$$$$$`,
  String.raw`           'Y$P' ,g, Y$$$$$$`,
  String.raw`             '' ,$$$gd$$$$P'`,
  String.raw`                'Y$$$$$P''`,
];

const WRAPPED_WING = [
  '',
  '',
  `                        ,g$`,
  `                       d$P'`,
  `                      d$'`,
  `                      $$`,
  `                      Y$,`,
  `                       Y$b,`,
  `                        'Y$b,`,
  '',
];

const BALL = [
  '',
  '',
  `      _.-==-._`,
  `    ,'========'.`,
  `   /============\\`,
  `  |==============|`,
  `   \\============/`,
  `    '.========.'`,
  `      '-====-'`,
  '',
];

function compose(wing: string[]): string[] {
  return wing.map((line, i) => {
    const left = (line ?? '').padEnd(WING_COLS).slice(0, WING_COLS);
    const ball = (BALL[i] ?? '').padEnd(BALL_COLS).slice(0, BALL_COLS);
    return left + ball + mirror(left);
  });
}

const FULL = compose(WING);
const WRAPPED = compose(WRAPPED_WING);
const CENTER = BANNER_WIDTH / 2;

/** Only the columns within `half` of the center are visible — a partial spread. */
function reveal(half: number): string[] {
  return FULL.map((row) => [...row].map((ch, col) => (Math.abs(col - CENTER + 0.5) <= half ? ch : ' ')).join(''));
}

/** Frame 0 is wings-wrapped; the last frame is the full span. */
export const BANNER_FRAMES: string[][] = [WRAPPED, reveal(13), reveal(19), reveal(26), reveal(33), FULL];

export const WORDMARK = 'S  N  I  T  C  H';
