/// <reference types="vite/client" />

/** Project name from `PROJECT_NAME`, injected at build time by vite.config.ts. */
declare const __PROJECT_NAME__: string;

/** True in the server-less build hosted on GitHub Pages (`STATIC_DEMO=true`). */
declare const __STATIC_DEMO__: boolean;
