/** A typed failure from the server (`mres ok:false`, `err`, HTTP error body) or from the client itself. */
export class EmberError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "EmberError";
  }
}

export const isEmberError = (e: unknown): e is EmberError => e instanceof EmberError;
