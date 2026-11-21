import { createHash } from 'crypto';
import vm from 'vm';

export type SolutionType =
  | 'plain'
  | 'sha256'
  | 'regex'
  | 'numeric_exact'
  | 'multiple_choice'
  | 'code';

export interface SolutionSpec {
  solution: string;
  solutionType?: SolutionType;
  caseInsensitive?: boolean;
  trimWhitespace?: boolean;
  timeoutMs?: number;
}

export interface SubmissionResult {
  isCorrect: boolean;
  score: number;
  timedOut: boolean;
  feedback: string;
}

function normalize(value: string, spec: SolutionSpec): string {
  let normalized = spec.trimWhitespace === false ? value : value.trim();
  if (spec.caseInsensitive) normalized = normalized.toLowerCase();
  return normalized;
}

export function runCodeSubmission(
  code: string,
  expected: string,
  timeoutMs = 100,
): SubmissionResult {
  try {
    const script = new vm.Script(code);
    const context: Record<string, unknown> = {};
    const output = script.runInNewContext(context, { timeout: timeoutMs });
    const outputText =
      typeof output === 'string' ? output : JSON.stringify(output);
    const isCorrect = normalize(outputText, { solution: expected }).trim() ===
      normalize(expected, { solution: expected }).trim();
    return {
      isCorrect,
      score: isCorrect ? 1 : 0,
      timedOut: false,
      feedback: isCorrect ? 'Correct answer!' : 'Incorrect code output.',
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (/timed out/i.test(error.message) || /timeout/i.test(error.message));
    return {
      isCorrect: false,
      score: 0,
      timedOut,
      feedback: timedOut ? 'Code execution timed out.' : 'Code execution failed.',
    };
  }
}

export function calculatePartialCredit(submission: unknown, expected: string): number {
  if (typeof submission !== 'string' || !submission.trim() || !expected) return 0;
  const a = submission.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (a === b) return 1;
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0) as number[]);
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  const similarity = 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
  return Math.max(0, Math.round(similarity * 100) / 100);
}

export function checkSubmission(
  spec: SolutionSpec,
  submission: unknown,
): SubmissionResult {
  if (
    submission === null ||
    submission === undefined ||
    (typeof submission === 'string' && submission.trim() === '')
  ) {
    return {
      isCorrect: false,
      score: 0,
      timedOut: false,
      feedback: 'Submission is empty.',
    };
  }

  const type = spec.solutionType ?? 'plain';
  if (type === 'code') {
    return runCodeSubmission(
      String(submission),
      spec.solution,
      spec.timeoutMs ?? 100,
    );
  }

  const submitted = String(submission);
  let isCorrect = false;

  switch (type) {
    case 'sha256':
      isCorrect =
        createHash('sha256').update(normalize(submitted, spec), 'utf8').digest('hex') ===
        spec.solution.toLowerCase();
      break;
    case 'regex':
      isCorrect = new RegExp(spec.solution).test(normalize(submitted, spec));
      break;
    case 'numeric_exact': {
      const submittedNumber = Number(submitted.trim());
      isCorrect =
        Number.isFinite(submittedNumber) &&
        submittedNumber === Number(spec.solution);
      break;
    }
    case 'multiple_choice':
    case 'plain':
      isCorrect =
        normalize(submitted, spec) === normalize(spec.solution, spec);
      break;
  }

  const score = isCorrect ? 1 : calculatePartialCredit(submitted, spec.solution);
  return {
    isCorrect,
    score,
    timedOut: false,
    feedback: isCorrect ? 'Correct answer!' : 'Incorrect answer.',
  };
}
