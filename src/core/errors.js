// @ts-check
// Errors that code elsewhere tells apart.

/** The file is no longer the one that the document was read from or last written to (B: model.Changed). */
export class Changed extends Error {}
/** There is no such file or folder. */
export class NotFound extends Error {}
/** The name is taken. */
export class Exists extends Error {}
