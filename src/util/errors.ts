import { redactSecrets } from './redact.js';

/** An error whose message is safe and useful to show the user directly. */
export class SnitchError extends Error {
  constructor(message: string) {
    // API error bodies can echo credentials back; scrub before anything renders.
    super(redactSecrets(message));
    this.name = 'SnitchError';
  }
}

export class ApiError extends SnitchError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
