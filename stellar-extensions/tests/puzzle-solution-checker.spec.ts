import {
  calculatePartialCredit,
  checkSubmission,
  runCodeSubmission,
} from '../backend/src/puzzle-solution-checker/puzzle-solution-checker';

describe('Puzzle solution checker', () => {
  it('matches exact text submissions', () => {
    expect(checkSubmission({ solution: 'Soroban' }, 'Soroban').isCorrect).toBe(true);
  });

  it('matches case-insensitive text submissions', () => {
    expect(
      checkSubmission(
        { solution: 'Stellar', caseInsensitive: true },
        'stellar',
      ).isCorrect,
    ).toBe(true);
  });

  it('trims text submissions by default', () => {
    expect(checkSubmission({ solution: 'NFT' }, '  NFT  ').isCorrect).toBe(true);
  });

  it('can preserve whitespace when configured', () => {
    expect(
      checkSubmission(
        { solution: 'NFT', trimWhitespace: false },
        ' NFT ',
      ).isCorrect,
    ).toBe(false);
  });

  it('validates multiple choice answers', () => {
    expect(
      checkSubmission(
        { solution: 'XLM', solutionType: 'multiple_choice' },
        'XLM',
      ).isCorrect,
    ).toBe(true);
  });

  it('matches SHA-256 and regex solutions', () => {
    const hash = require('crypto')
      .createHash('sha256')
      .update('stellar', 'utf8')
      .digest('hex');
    expect(
      checkSubmission(
        { solution: hash, solutionType: 'sha256', caseInsensitive: true },
        'stellar',
      ).isCorrect,
    ).toBe(true);
    expect(
      checkSubmission(
        { solution: '0b3e1a7e2c2c0f7f7a0b', solutionType: 'regex' },
        'answer 0b3e1a7e2c2c0f7f7a0b',
      ).isCorrect,
    ).toBe(true);
  });

  it('matches numeric solutions exactly', () => {
    expect(
      checkSubmission(
        { solution: '97.5', solutionType: 'numeric_exact' },
        '97.5',
      ).isCorrect,
    ).toBe(true);
  });

  it('executes code and compares output', () => {
    expect(
      checkSubmission(
        { solution: '42', solutionType: 'code' },
        '40 + 2',
      ).isCorrect,
    ).toBe(true);
  });

  it('reports code execution failures', () => {
    expect(runCodeSubmission('throw new Error("bad")', 'ok').isCorrect).toBe(false);
  });

  it('protects code execution with a timeout', () => {
    const result = runCodeSubmission('while (true) {}', 'ok', 20);
    expect(result.timedOut).toBe(true);
    expect(result.score).toBe(0);
  });

  it('calculates partial credit for close submissions', () => {
    expect(calculatePartialCredit('stellar', 'stelar')).toBeGreaterThan(0);
    expect(calculatePartialCredit('stellar', 'stelar')).toBeLessThan(1);
  });

  it('gives no partial credit for empty or unrelated submissions', () => {
    expect(calculatePartialCredit('', 'stellar')).toBe(0);
    expect(calculatePartialCredit('completely unrelated', 'stellar')).toBe(0);
  });

  it.each([null, undefined, '', '   '])(
    'rejects empty or null submission %#',
    (submission) => {
      expect(checkSubmission({ solution: 'NFT' }, submission)).toEqual(
        expect.objectContaining({ isCorrect: false, score: 0, timedOut: false }),
      );
    },
  );
});
