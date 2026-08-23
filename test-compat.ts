import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as nativeDescribe,
  expect as nativeExpect,
  expectTypeOf,
  it as nativeIt,
  jest,
  onTestFinished,
  setDefaultTimeout,
  setSystemTime,
  test as nativeTest,
  vi as nativeVi,
  xdescribe,
  xit,
  xtest,
} from "bun:test";

const expect: any = nativeExpect;
const describe = nativeDescribe.serial;
const it = nativeIt.serial;
const test = nativeTest.serial;

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  onTestFinished,
  setDefaultTimeout,
  setSystemTime,
  test,
  xdescribe,
  xit,
  xtest,
};

type NativeVi = typeof nativeVi;
const nativeMock = nativeVi.mock;
const nativeUseFakeTimers = nativeVi.useFakeTimers;
const nativeUseRealTimers = nativeVi.useRealTimers;
const nativeAdvanceTimersByTime = nativeVi.advanceTimersByTime;

type CompatVi = Omit<NativeVi, "mock"> & {
  mock: (moduleId: string, factory: (...args: unknown[]) => unknown) => void | Promise<void>;
  hoisted<T>(factory: () => T): T;
  mocked<T>(value: T): T;
  advanceTimersByTimeAsync(milliseconds: number): Promise<NativeVi>;
  setSystemTime(now?: Date | number | string): void;
  setConfig(config: { testTimeout?: number; hookTimeout?: number }): void;
  waitFor<T>(assertion: () => T | Promise<T>, options?: { timeout?: number; interval?: number }): Promise<T>;
  stubGlobal(name: PropertyKey, value: unknown): void;
  unstubAllGlobals(): void;
};

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
const OriginalDate = globalThis.Date;
let fakeNow: number | undefined;

function stubGlobal(name: PropertyKey, value: unknown): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function unstubAllGlobals(): void {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<PropertyKey, unknown>)[name];
  }
  originalGlobals.clear();
}

function installFakeDate(now: number): void {
  const FakeDate = class extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof OriginalDate>) {
      super(args[0] === undefined ? now : args[0]);
    }

    static now(): number {
      return now;
    }
  };
  Object.setPrototypeOf(FakeDate, OriginalDate);
  globalThis.Date = FakeDate as DateConstructor;
}

function restoreRealDate(): void {
  fakeNow = undefined;
  globalThis.Date = OriginalDate;
}

function useFakeTimers(...args: Parameters<NativeVi["useFakeTimers"]>): NativeVi {
  nativeUseFakeTimers.call(nativeVi, ...args);
  return nativeVi;
}

function useRealTimers(): NativeVi {
  nativeUseRealTimers.call(nativeVi);
  restoreRealDate();
  return nativeVi;
}

function advanceTimersByTime(milliseconds: number): NativeVi {
  if (fakeNow != null) {
    fakeNow += milliseconds;
    installFakeDate(fakeNow);
  }
  nativeAdvanceTimersByTime.call(nativeVi, milliseconds);
  return nativeVi;
}

async function advanceTimersByTimeAsync(milliseconds: number): Promise<NativeVi> {
  for (let j = 0; j < 64; j += 1) await Promise.resolve();
  if (milliseconds <= 10_000) {
    for (let i = 0; i < milliseconds; i += 1) {
      advanceTimersByTime(1);
      for (let j = 0; j < 8; j += 1) await Promise.resolve();
    }
  } else {
    advanceTimersByTime(milliseconds);
  }
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 16; j += 1) await Promise.resolve();
  }
  return nativeVi;
}

async function waitFor<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 50;
  const startedAt = Number(process.hrtime.bigint() / 1_000_000n);
  const deadline = startedAt + timeout;
  let lastError: unknown;

  while (Number(process.hrtime.bigint() / 1_000_000n) <= deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
    }
    if (nativeVi.isFakeTimers()) {
      nativeAdvanceTimersByTime.call(nativeVi, 1);
      await Promise.resolve();
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  }
  throw lastError;
}

function mockModule(moduleId: string, factory: (...args: unknown[]) => unknown): void | Promise<void> {
  return nativeMock(moduleId, () => factory(() => import(moduleId)));
}

export const vi = Object.assign(nativeVi, {
  mock: mockModule,
  useFakeTimers,
  useRealTimers,
  advanceTimersByTime,
  hoisted<T>(factory: () => T): T {
    return factory();
  },
  mocked<T>(value: T): T {
    return value;
  },
  advanceTimersByTimeAsync,
  setSystemTime(now?: Date | number | string): void {
    if (nativeVi.isFakeTimers()) {
      fakeNow = now == null ? Date.now() : new OriginalDate(now).getTime();
      installFakeDate(fakeNow);
      jest.setSystemTime(fakeNow);
    } else {
      setSystemTime(now == null ? undefined : new OriginalDate(now));
    }
  },
  setConfig(_config: { testTimeout?: number; hookTimeout?: number }): void {},
  waitFor,
  stubGlobal,
  unstubAllGlobals,
}) as CompatVi;
