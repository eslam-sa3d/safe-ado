/** Minimal stand-in for `vi` so the test fakes (test/fakeAdo.ts, test/sdkMock.ts) run in a browser preview. */
type AnyFn = (...args: any[]) => any;

function fn<T extends AnyFn>(impl?: T) {
  let current: AnyFn = impl ?? (() => undefined);
  const mock: any = (...args: any[]) => current(...args);
  mock.mockClear = () => mock;
  mock.mockImplementation = (f: AnyFn) => ((current = f), mock);
  mock.mockImplementationOnce = (f: AnyFn) => ((current = f), mock);
  mock.mockReturnValueOnce = (v: unknown) => ((current = () => v), mock);
  mock.mockRejectedValueOnce = (v: unknown) => ((current = () => Promise.reject(v)), mock);
  return mock as T & Record<string, AnyFn>;
}

export const vi = { fn, stubGlobal: (k: string, v: unknown) => ((globalThis as any)[k] = v) };
