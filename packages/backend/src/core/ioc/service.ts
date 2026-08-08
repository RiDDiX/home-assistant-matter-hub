export abstract class Service {
  readonly construction: Promise<void> = new Promise((resolve, reject) => {
    setImmediate(() => {
      const init = this.initialize?.bind(this) ?? (async () => {});
      init().then(resolve, reject);
    });
  });

  constructor(readonly serviceName: string) {}

  protected initialize?(): Promise<void>;
  dispose?(): Promise<void>;
}
