// Framework-agnostic error carrying an HTTP status + message. Express adapters
// map it to a response; a future Hono adapter maps it the same way.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message: string) => new HttpError(401, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}