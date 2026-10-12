// @ts-check
export class DriveError extends Error {
  /** @param {string} message @param {number|null} [code] the HTTP status, when Google answered with an error */
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}
