export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'not signed in') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, extra) => new HttpError(409, 'conflict', msg, extra);
export const tooLarge = (msg) => new HttpError(413, 'too_large', msg);
