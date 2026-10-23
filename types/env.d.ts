// Vite's build-time environment, as this app reads it.
//
// `import.meta.env` is injected by Vite. Declared here so a plain `tsc` run
// typechecks the files that read it, rather than failing on an import.meta
// property that only exists under the bundler.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_DATA_SOURCE?: 'server' | 'demo';
  readonly MODE?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
