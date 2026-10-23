# Type stubs

Hand-written declarations for the packages this project depends on, so the app
can be typechecked where `npm install` cannot run — the npm registry is
unreachable from the environment this was built in.

**These are not a substitute for the real types.** They declare the parts of
`react`, `react-dom`, `lucide-react` and `recharts` that this codebase uses,
and nothing else. A type error the real `@types/react` would catch and these
do not is entirely possible. Where the two disagree, the real types are right.

`npm run typecheck` uses the real types when `node_modules` is present and
these when it is not, and says which. Run the real one before shipping.

Two things learned the hard way, both still here:

* `FC<P>` threads `key` through props. The real types do; an early version of
  this stub did not, and every keyed element failed to typecheck here while
  building cleanly against the real thing.
* `React` is declared as a namespace as well as a module, because the app uses
  `React.FC` and `React.ReactNode` that way and that is how `@types/react`
  exposes them.
