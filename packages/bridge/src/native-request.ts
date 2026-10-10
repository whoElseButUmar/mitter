/** A missing native acknowledgement is not proof that a mutation failed.
 * Only this typed transport error may enter the bounded, idempotent delivery
 * retry. Policy, schema, disk and file-hash errors never use that path. */
export class NativeRequestTimeout extends Error {
  readonly code='NATIVE_REQUEST_TIMEOUT';
  constructor(readonly method:string){
    super(`${method} acknowledgement timed out. Checking the saved local batch before proceeding.`);
    this.name='NativeRequestTimeout';
  }
}
