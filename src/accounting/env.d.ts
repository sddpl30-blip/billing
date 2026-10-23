/**
 * The engine itself needs no host globals. Two things around it do: the
 * self-test prints and sets an exit code. The browser repository reaches
 * localStorage through `globalThis`, so no `window` declaration is needed —
 * and adding "DOM" to `lib` is deliberately avoided, since that would make
 * every DOM global available to the engine and let one creep in unnoticed.
 */
declare const console: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
declare const process: { exitCode?: number } | undefined;
