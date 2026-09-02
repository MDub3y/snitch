/** An error whose message is safe and useful to show the user directly. */
export class SnitchError extends Error {
  constructor(message: string) {
    super(message);
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
