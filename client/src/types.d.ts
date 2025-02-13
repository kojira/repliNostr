declare interface Window {
  __ENV: {
    BASE_URL: string;
    ASSET_URL: string;
  }
}

interface ImportMetaEnv {
  readonly VITE_BASE_URL: string;
  readonly VITE_ASSET_URL: string;
  readonly VITE_ASSET_PREFIX: string;
  readonly VITE_PUBLIC_PATH: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
