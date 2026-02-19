declare module 'pngjs' {
  import { Transform } from 'stream';

  interface PNGOptions {
    width?: number;
    height?: number;
    checkCRC?: boolean;
  }

  class PNG extends Transform {
    constructor(options?: PNGOptions);
    width: number;
    height: number;
    data: Uint8Array;
    on(event: 'parsed', listener: (this: PNG) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export { PNG };
}
